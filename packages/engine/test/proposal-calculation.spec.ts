import { describe, expect, it } from 'vitest';
import type { ProposalCalculationDTO, ProposalDTO, ReportedFact, RuleVariant, Snapshot } from '@ce/contracts';
import { parseRule, resolveDirection, runValidation, simulate, WorkLimitError } from '../src/index.js';
import { stableId } from '../src/resolver/instances.js';
import { coordinate, fact, ref, report } from './helpers/report-fixture.js';

const startedAt = '2026-11-04T00:00:00.000Z', previewId = '00000000-0000-4000-8000-000000000221';
const cells = ['0010', '0020', '0030', '0040'].map(row => coordinate({ row, decimals: '2' }));
const [a, b, c, d] = cells;
interface RuleInput { code: string; expression: string; precondition?: string }
function calculation(proposal: ProposalDTO): ProposalCalculationDTO {
  const value = proposal.calculation;
  expect(value, 'A simulated calculation must retain its actual pre-patch evidence').toBeDefined(); return value!;
}
function configured(rules: readonly RuleInput[], values: readonly (string | null | undefined)[] = ['0', '1', '3', '0'], overrides: (fact: ReportedFact, index: number) => ReportedFact = value => value): Snapshot {
  const variants: RuleVariant[] = rules.map((rule, i) => ({ variantId: stableId([rule.code, rule.expression, rule.precondition ?? null]), ...rule,
    framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: ['T'], active: true, referenceWindow: {}, severityOriginal: 'error', severity: 'error',
    sourceRecords: [rule.code + '-row'], sourceLocators: [{ sheet: 'Rules', row: i + 2, column: 'G' }] }));
  const input = report(cells, values.flatMap((value, index) => value === undefined ? [] : [overrides(fact(cells[index]!, value, index + 2), index)]));
  const base: Snapshot = { versionId: '00000000-0000-4000-8000-000000000222', contentHash: 'a'.repeat(64), createdAt: startedAt,
    content: { profileId: 'ce-dpmxl-0.9-closed-v1', catalogVersion: 'c', reportVersion: 'r', configVersion: 'none', contexts: input.contexts, coordinates: cells, facts: input.facts, directions: [], sources: [],
      catalog: { records: variants.map(v => ({ id: v.sourceRecords[0]!, code: v.code, variantId: v.variantId, originalFields: { Expression: v.expression }, sourceLocator: v.sourceLocators[0]!, diagnostics: [] })),
        variants, analyses: variants.map(v => ({ variantId: v.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId: 'ce-dpmxl-0.9-closed-v1', ...parseRule(v.expression) })),
        coverage: { rows: variants.length, variants: variants.length, applicableVariants: variants.length, supportedVariants: variants.length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } } };
  const validation = runValidation(base, { runId: 'before', startedAt, now: () => 0 });
  const directions = validation.results.map(result => {
    if (!result.instanceId || !result.binding) throw new Error('Synthetic rule requires a real structural instance');
    const resolved = resolveDirection(base, { instanceId: result.instanceId, variantIds: result.variantIds, binding: result.binding, targetSide: 'left' });
    if (!resolved.resolved) throw new Error(JSON.stringify(resolved.diagnostics)); return resolved.resolved.direction;
  });
  return { ...base, content: { ...base.content, directions } };
}

describe('proposal calculation evidence from the simulation overlay', () => {
  it('captures rounded predecessor inputs and effective source/precondition values before the consumer patch', () => {
    const rules = [
      { code: 'A', expression: `with {interval:true}: ${ref(a!)}=${ref(b!)}/${ref(c!)}` },
      { code: 'D', expression: `with {interval:true}: ${ref(d!)}=${ref(a!)}*2`, precondition: `with {interval:false}: ${ref(a!)}>0` },
    ];
    const base = configured(rules), original = JSON.stringify(base);
    const bundle = simulate(base, { previewId, now: () => 0 }), first = bundle.proposals.find(p => p.code === 'A')!, second = bundle.proposals.find(p => p.code === 'D')!;
    expect(first.state).toBe('available'); expect(second.state).toBe('available');
    const firstCalculation = calculation(first), secondCalculation = calculation(second);
    expect(firstCalculation.expression).toBe(rules[0]!.expression);
    expect(firstCalculation.sourceValue).toMatchObject({ kind: 'number', nominal: { numerator: '1', denominator: '3' } });
    expect(first.after?.normalizedValue).toEqual({ numerator: '33', denominator: '100' });
    expect(secondCalculation.expression).toBe(rules[1]!.expression); expect(secondCalculation.precondition).toBe(rules[1]!.precondition);
    expect(secondCalculation.preconditionValue).toMatchObject({ kind: 'boolean', value: true });
    expect(secondCalculation.sourceValue).toMatchObject({ kind: 'number', nominal: { numerator: '33', denominator: '50' } });
    expect(secondCalculation.reads).toHaveLength(1);
    expect(secondCalculation.reads[0]).toMatchObject({ fromProposalId: first.id, fact: { factKey: a!.factKey, presence: 'value', originalText: '0.33', normalizedValue: { numerator: '33', denominator: '100' }, sourceLocator: base.content.facts[0]!.sourceLocator } });
    expect(secondCalculation.reads[0]!.fact.derivation).toBeUndefined();
    expect(firstCalculation.reads.map(read => read.fact.factKey).sort()).toEqual([b!.factKey, c!.factKey].sort());
    expect(firstCalculation.reads.every(read => read.fromProposalId === undefined)).toBe(true);
    expect(JSON.stringify(base)).toBe(original); expect(base.content.facts[0]!.normalizedValue).toEqual({ numerator: '0', denominator: '1' });
  });

  it.each([[undefined, 'implicit_null'], [null, 'explicit_null']] as const)('keeps %s presence separately from an effective default', (missing, presence) => {
    const base = configured([{ code: 'DEFAULT', expression: `with {default:0,interval:true}: ${ref(a!)}=${ref(b!)}+1` }], ['0', missing, '3', '0']);
    const result = simulate(base, { previewId, now: () => 0 }).proposals[0]!;
    expect(result.state).toBe('available');
    const detail = calculation(result);
    expect(detail.sourceValue).toMatchObject({ kind: 'number', nominal: { numerator: '1', denominator: '1' } });
    expect(detail.reads).toHaveLength(1); expect(detail.reads[0]!.fact.presence).toBe(presence);
    expect(detail.reads[0]!.fact.normalizedValue).toBeUndefined(); expect(detail.reads[0]!.fact.originalText).toBeUndefined();
    expect(detail.reads[0]!.fromProposalId).toBeUndefined();
  });

  it('keeps only actually evaluated precondition reads when it blocks the calculation', () => {
    const rule = { code: 'PRECONDITION', expression: `${ref(a!)}=${ref(b!)}/${ref(c!)}`, precondition: `${ref(b!)}<0` };
    const result = simulate(configured([rule]), { previewId, now: () => 0 }).proposals[0]!;
    expect(result.state).toBe('blocked'); const detail = calculation(result);
    expect(detail.preconditionValue).toMatchObject({ kind: 'boolean', value: false }); expect(detail.sourceValue).toBeUndefined();
    expect(detail.reads.map(read => read.fact.factKey)).toEqual([b!.factKey]);
  });

  it('retains reads of a failed source without inventing an effective value', () => {
    const result = simulate(configured([{ code: 'ZERO', expression: `${ref(a!)}=${ref(b!)}/${ref(c!)}` }], ['0', '1', '0', '0']), { previewId, now: () => 0 }).proposals[0]!;
    expect(result.state).toBe('blocked'); const detail = calculation(result);
    expect(detail.sourceValue).toBeUndefined(); expect(detail.reads.map(read => read.fact.factKey).sort()).toEqual([b!.factKey, c!.factKey].sort());
  });

  it('does not fabricate calculation evidence for graph-blocked proposals', () => {
    const base = configured([{ code: 'A', expression: `${ref(a!)}=${ref(d!)}+1` }, { code: 'D', expression: `${ref(d!)}=${ref(a!)}+1` }]);
    const bundle = simulate(base, { previewId, now: () => 0 });
    expect(bundle.proposals).toHaveLength(2); expect(bundle.proposals.every(row => row.state === 'blocked')).toBe(true);
    expect(bundle.proposals.every(row => row.calculation === undefined)).toBe(true);
  });

  it('preserves an existing applied derivation without attributing it to this simulation', () => {
    const derivation = { receiptId: '00000000-0000-4000-8000-000000000223', previewId: '00000000-0000-4000-8000-000000000224', proposalId: '00000000-0000-4000-8000-000000000225', baseVersionId: '00000000-0000-4000-8000-000000000226' };
    const base = configured([{ code: 'A', expression: `${ref(a!)}=${ref(b!)}+1` }], ['0', '1', '3', '0'], (value, index) => index === 1 ? { ...value, derivation } : value);
    const detail = calculation(simulate(base, { previewId, now: () => 0 }).proposals[0]!);
    expect(detail.reads[0]!.fact.derivation).toEqual(derivation); expect(detail.reads[0]!.fromProposalId).toBeUndefined();
  });

  it('continues to abort instead of returning partial evidence when its work budget is exhausted', () => {
    const base = configured([{ code: 'A', expression: `${ref(a!)}=${ref(b!)}+1` }]), original = JSON.stringify(base);
    expect(() => simulate(base, { previewId, now: () => 0, limits: { reads: 0 } })).toThrow(WorkLimitError);
    expect(JSON.stringify(base)).toBe(original);
  });
});
