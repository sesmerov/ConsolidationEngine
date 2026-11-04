import { describe, expect, it } from 'vitest';
import type { DirectionDTO, RuleVariant, Snapshot } from '@ce/contracts';
import * as engine from '../src/index.js';
import { stableId } from '../src/resolver/instances.js';
import { coordinate, fact, ref, report } from './helpers/report-fixture.js';

const V1 = 'ce-dpmxl-0.9-closed-v1', V2 = 'ce-dpmxl-0.9-closed-v2';
const startedAt = '2026-11-04T00:00:00.000Z';
const previewId = '00000000-0000-4000-8000-000000000201';
function fixture(boolean = false): Snapshot {
  const cells = ['0010', '0020', '0030'].map(row => coordinate({ row, ...(boolean ? { dataType: 'boolean' } : {}) }));
  const expression = boolean ? `${ref(cells[0]!)}=not(${ref(cells[1]!)})` : `${ref(cells[0]!)}=${ref(cells[1]!)}+1`;
  const variant: RuleVariant = { variantId: stableId(['NUMERIC', expression]), code: 'NUMERIC', expression, framework: 'COREP', modules: ['COREP_OF_4.2'],
    crossModule: false, tables: ['T'], active: true, referenceWindow: {}, severityOriginal: 'error', severity: 'error',
    sourceRecords: ['source-row'], sourceLocators: [{ sheet: 'Rules', row: 2, column: 'G' }] };
  const input = report(cells, cells.map((cell, i) => fact(cell, boolean ? false : String([1, 5, 8][i]))));
  return { versionId: '00000000-0000-4000-8000-000000000202', contentHash: 'a'.repeat(64), createdAt: startedAt,
    content: { profileId: V1, catalogVersion: 'c', reportVersion: 'r', configVersion: 'none', contexts: input.contexts, coordinates: cells, facts: input.facts, directions: [], sources: [],
      catalog: { records: [{ id: 'source-row', code: variant.code, variantId: variant.variantId, originalFields: { Expression: expression }, sourceLocator: variant.sourceLocators[0]!, diagnostics: [] }],
        variants: [variant], analyses: [{ variantId: variant.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId: V1, ...engine.parseRule(expression) }],
        coverage: { rows: 1, variants: 1, applicableVariants: 1, supportedVariants: 1, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } } };
}
function configured(base = fixture()): Snapshot {
  const result = engine.runValidation(base, { runId: 'before', startedAt, now: () => 0 }).results[0]!;
  if (!result.instanceId || !result.binding) throw new Error('Fixture requires a real numeric/boolean instance');
  const resolved = engine.resolveDirection(base, { instanceId: result.instanceId, variantIds: result.variantIds, binding: result.binding, targetSide: 'left' });
  if (!resolved.resolved) throw new Error(JSON.stringify(resolved.diagnostics));
  return { ...base, content: { ...base.content, directions: [resolved.resolved.direction] } };
}
function profile(base: Snapshot, profileId = V2): Snapshot { return { ...base, content: { ...base.content, profileId } }; }
function policy(base: Snapshot, direction?: DirectionDTO, limits?: { milliseconds?: number; reads?: number }) {
  const classify = (engine as unknown as { getRecalculationPolicy?: (snapshot: Snapshot, input: { variantIds: readonly string[]; binding?: DirectionDTO['binding']; instanceId?: string }, options?: { budget: engine.WorkBudget }) => { policy: { mode: string; profileId: string; reasons: readonly string[] }; diagnostics: readonly { code: string }[] } }).getRecalculationPolicy;
  expect(classify, 'Server policy must be exported independently of UI decisions').toBeTypeOf('function');
  const selected = direction ?? base.content.directions[0];
  return classify!(base, { variantIds: selected?.variantIds ?? base.content.catalog.variants.map(v => v.variantId), ...(selected ? { binding: selected.binding, instanceId: selected.instanceId } : { binding: { contextId: 'demo' } }) },
    { budget: new engine.WorkBudget({ now: () => 0, ...(limits ? { limits } : {}) }) });
}

describe('versioned language profiles and closed recalculation policy', () => {
  it('validates, simulates and applies a numeric v2 snapshot without treating v2 as a profile mismatch', () => {
    const base = profile(configured());
    const before = engine.runValidation(base, { runId: 'before', startedAt, now: () => 0 });
    expect(before.run.status).toBe('completed'); expect(before.results[0]!.status).toBe('fail');
    const bundle = engine.simulate(base, { previewId, now: () => 0 });
    expect(bundle.proposals).toHaveLength(1); expect(bundle.proposals[0]!.after?.normalizedValue).toEqual({ numerator: '6', denominator: '1' });
    const selectedIds = bundle.proposals.map(row => row.id);
    const applied = engine.applyCandidate(base, bundle, { receiptId: '00000000-0000-4000-8000-000000000203', newVersionId: '00000000-0000-4000-8000-000000000204',
      beforeRunId: '00000000-0000-4000-8000-000000000205', runId: '00000000-0000-4000-8000-000000000206', startedAt, selectedIds,
      closureHash: engine.selectionClosureHash(bundle.preview, selectedIds), now: () => 0 });
    expect(applied.factPatches).toHaveLength(1); expect(applied.validation.results[0]!.status).toBe('pass');
    expect(base.content.facts[0]!.normalizedValue).toEqual({ numerator: '1', denominator: '1' });
  });

  it('preserves numeric and boolean v1 recalculations and existing blocked numeric directions', () => {
    expect(engine.simulate(configured(fixture(true)), { previewId, now: () => 0 }).proposals[0]!.after?.normalizedValue).toBe(true);
    const base = configured();
    const invalid = { ...base, content: { ...base.content, directions: [{ ...base.content.directions[0]!, targetKey: 'invalid-target' }] } };
    expect(engine.simulate(invalid, { previewId, now: () => 0 }).proposals[0]!.state).toBe('blocked');
    expect(engine.simulate(base, { previewId, now: () => 0 }).proposals[0]!.state).toBe('available');
  });

  it('does not permit boolean recalculation in v2 even though its boolean validation is supported', () => {
    const base = profile(configured(fixture(true))), direction = base.content.directions[0]!;
    expect(engine.resolveDirection(base, direction).resolved).toBeUndefined();
    expect(() => engine.simulate(base, { previewId, now: () => 0 })).toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION' }));
  });

  it('rejects new values or coordinate types anywhere in a v1 snapshot, including unreferenced coordinates', () => {
    const base = configured(), last = base.content.coordinates[2]!;
    const typed = { ...base, content: { ...base.content, coordinates: [...base.content.coordinates.slice(0, 2), { ...last, dataType: 'text', unit: '', decimals: '' }],
      facts: [...base.content.facts.slice(0, 2), { ...base.content.facts[2]!, normalizedValue: { kind: 'text', value: 'hidden' }, originalText: 'hidden' }] } } as Snapshot;
    const run = engine.runValidation(typed, { runId: 'invalid', startedAt, now: () => 0 });
    expect(run.run.status).toBe('incomplete'); expect(run.run.diagnostics.length).toBeGreaterThan(0);
    expect(() => engine.simulate(typed, { previewId, now: () => 0 })).toThrow();
  });

  it.each([['text', '5', 'TEXT'], ['date', '2025-12-31', 'DATE']] as const)('classifies resolved %s references without literals and rejects them before building any graph', (kind, value, reason) => {
    const base = profile(configured());
    const typed = { ...base, content: { ...base.content, coordinates: base.content.coordinates.map((cell, i) => i === 1 ? { ...cell, dataType: kind, unit: '', decimals: '' } : cell),
      facts: base.content.facts.map((reported, i) => i === 1 ? { ...reported, normalizedValue: { kind, value }, originalText: value } : reported) } } as Snapshot;
    expect(policy(typed).policy).toEqual({ mode: 'validation_only', profileId: V2, reasons: [reason] });
    const resolution = engine.resolveDirection(typed, typed.content.directions[0]!);
    expect(resolution.resolved).toBeUndefined(); expect(resolution.diagnostics.some(d => d.code === 'RULE_VALIDATION_ONLY')).toBe(true);
    expect(() => engine.simulate(typed, { previewId, now: () => 0 })).toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION' }));
  });

  it('classifies typed references in the formal precondition even when the calculated expression is numeric', () => {
    const base = profile(configured()), source = base.content.coordinates[2]!;
    const typed = { ...base, content: { ...base.content, coordinates: base.content.coordinates.map(cell => cell === source ? { ...cell, dataType: 'text', unit: '', decimals: '' } : cell),
      facts: base.content.facts.filter(value => value.factKey !== source.factKey),
      catalog: { ...base.content.catalog, variants: base.content.catalog.variants.map(variant => ({ ...variant, precondition: `isnull(${ref(source)})` })) } } } as Snapshot;
    expect(policy(typed).policy).toEqual({ mode: 'validation_only', profileId: V2, reasons: ['TEXT'] });
    expect(() => engine.simulate(typed, { previewId, now: () => 0 })).toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION' }));
  });

  it('does not infer policy from administrative dates, descriptions, result status or equality alone', () => {
    const base = profile(configured()), variant = base.content.catalog.variants[0]!;
    const described = { ...base, content: { ...base.content, catalog: { ...base.content.catalog,
      records: [{ ...base.content.catalog.records[0]!, originalFields: { Description: 'if text date', From: '2025-01-01' } }],
      variants: [{ ...variant, referenceWindow: { from: '2025-01-01', to: '2026-12-31' } }] } } };
    expect(policy(described).policy).toEqual({ mode: 'standard', profileId: V2, reasons: [] });
    const inequality = { ...base, content: { ...base.content, catalog: { ...base.content.catalog, variants: [{ ...variant, expression: variant.expression.replace('=', '>') }] } } };
    expect(policy(inequality).policy.mode).toBe('standard');
    expect(engine.resolveDirection(inequality, inequality.content.directions[0]!).resolved).toBeUndefined();
  });

  it('fails closed for unresolved references, pending conditional syntax and exhausted policy budgets', () => {
    const base = profile(configured()), variant = base.content.catalog.variants[0]!;
    for (const expression of ['{tT,r9999,c0010}=1', 'if true then true else false endif']) {
      const unsupported = { ...base, content: { ...base.content, catalog: { ...base.content.catalog, variants: [{ ...variant, expression }] } } };
      expect(policy(unsupported).policy.mode).toBe('undetermined');
      expect(() => engine.simulate(unsupported, { previewId, now: () => 0 })).toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION' }));
    }
    const exhausted = policy(base, undefined, { milliseconds: 0 });
    expect(exhausted.policy.mode).toBe('undetermined'); expect(exhausted.diagnostics.some(d => d.code === 'DEADLINE_EXCEEDED')).toBe(true);
  });

  it('does not reuse policy across snapshot/profile identities and rejects a crossed preview profile', () => {
    const base = configured(), next = profile(base);
    expect(policy(base).policy.profileId).toBe(V1); expect(policy(next).policy.profileId).toBe(V2);
    const bundle = engine.simulate(base, { previewId, now: () => 0 });
    expect(() => engine.applyCandidate(next, bundle, { receiptId: '00000000-0000-4000-8000-000000000203', newVersionId: '00000000-0000-4000-8000-000000000204',
      beforeRunId: '00000000-0000-4000-8000-000000000205', runId: '00000000-0000-4000-8000-000000000206', startedAt,
      selectedIds: bundle.proposals.map(p => p.id), closureHash: engine.selectionClosureHash(bundle.preview, bundle.proposals.map(p => p.id)), now: () => 0 })).toThrow(expect.objectContaining({ code: 'PROFILE_MISMATCH' }));
  });
});
