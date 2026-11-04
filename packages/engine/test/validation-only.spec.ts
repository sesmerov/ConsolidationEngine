import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { LANGUAGE_PROFILE_V2, type RecalculationPolicyReason, type Snapshot } from '@ce/contracts';
import { applyCandidate, getRecalculationPolicy, resolveDirection, runValidation, selectionClosureHash, simulate } from '../src/index.js';
import { applicationFixture } from './helpers/application-fixture.js';
const startedAt = '2026-11-04T00:00:00.000Z';
function fixture(expression: string, precondition?: string): Snapshot {
  const { snapshot } = applicationFixture({ extraRule: expression });
  return { ...snapshot, content: { ...snapshot.content, profileId: LANGUAGE_PROFILE_V2, catalog: { ...snapshot.content.catalog,
    variants: snapshot.content.catalog.variants.map(v => v.code === 'other' && precondition ? { ...v, precondition } : v) } } };
}
function other(snapshot: Snapshot) { return snapshot.content.catalog.variants.find(v => v.code === 'other')!; }
const reasonCases: readonly [string, readonly RecalculationPolicyReason[]][] = [
  ['if true then true else false endif', ['CONDITIONAL']],
  ['"x"="x"', ['TEXT']],
  ['#2025-01-01#=#2025-01-01#', ['DATE']],
  ['if true then "x"="x" else #2025-01-01#=#2025-01-01# endif', ['CONDITIONAL', 'TEXT', 'DATE']],
  ['with {default:"x"}: true', ['TEXT']],
  ['with {default:#2025-01-01#}: true', ['DATE']],
  ['isnull(if false then "" endif)', ['CONDITIONAL', 'TEXT']],
  ['{tT,r0010,c0010}=(if true then {tT,r0020,c0010}+{tT,r0030,c0010} else 0 endif)', ['CONDITIONAL']],
];
describe('v2 validation-only policy is structural and enforced before graph/application', () => {
  it.each(['{tT,r0020,c0010}>0', '{tT,r0020,c0010}<0', '{tT,r0020,c0010}>=0', '{tT,r0020,c0010}<=0', '{tT,r0020,c0010}!=0', 'isnull({tT,r0090,c0010})'])('identifies non-equality %s specifically in v2 while preserving v1 diagnostics', expression => {
    for (const snapshot of [fixture(expression), applicationFixture({ extraRule: expression }).snapshot]) {
      const variant = other(snapshot), row = runValidation(snapshot, { runId: randomUUID(), startedAt }).results.find(r => r.code === 'other')!;
      for (const targetSide of ['left', 'right'] as const) {
        const resolution = resolveDirection(snapshot, { instanceId: row.instanceId!, variantIds: [variant.variantId], binding: row.binding!, targetSide });
        expect(resolution.resolved).toBeUndefined();
        expect(resolution.diagnostics).toEqual([expect.objectContaining({ code: snapshot.content.profileId === LANGUAGE_PROFILE_V2 ? 'NOT_EQUALITY' : 'INVALID_DIRECTION' })]);
      }
    }
  });
  it.each(reasonCases)('classifies every branch and option of %s', (expression, reasons) => {
    const snapshot = fixture(expression), variant = other(snapshot), result = getRecalculationPolicy(snapshot, { variantIds: [variant.variantId], binding: { contextId: 'demo' } });
    expect(result.policy).toEqual({ mode: 'validation_only', profileId: LANGUAGE_PROFILE_V2, reasons });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'RULE_VALIDATION_ONLY' }));
    const run = runValidation(snapshot, { runId: randomUUID(), startedAt }).results.find(r => r.code === 'other')!;
    expect(['pass', 'fail', 'not_evaluable']).toContain(run.status);
    for (const targetSide of ['left', 'right'] as const) {
      const resolution = resolveDirection(snapshot, { instanceId: run.instanceId ?? 'unresolved', variantIds: [variant.variantId], binding: run.binding ?? { contextId: 'demo' }, targetSide });
      expect(resolution.resolved).toBeUndefined(); expect(resolution.diagnostics).toContainEqual(expect.objectContaining({ code: 'RULE_VALIDATION_ONLY' }));
    }
  });
  it.each(['text', 'date'] as const)('detects %s reference types even without literals or visible values', kind => {
    const initial = fixture('isnull({tT,r0090,c0010})'), cell = initial.content.coordinates.find(c => c.rowCode === '0090')!;
    const snapshot: Snapshot = { ...initial, content: { ...initial.content, coordinates: initial.content.coordinates.map(c => c === cell ? { ...c, dataType: kind, unit: '', decimals: '' } : c), facts: initial.content.facts.filter(f => f.factKey !== cell.factKey) } };
    const policy = getRecalculationPolicy(snapshot, { variantIds: [other(snapshot).variantId], binding: { contextId: 'demo' } });
    expect(policy.policy).toEqual({ mode: 'validation_only', profileId: LANGUAGE_PROFILE_V2, reasons: [kind === 'text' ? 'TEXT' : 'DATE'] });
    expect(runValidation(snapshot, { runId: randomUUID(), startedAt }).results.find(r => r.code === 'other')!.status).toBe('pass');
  });
  it.each(['"x"="x"', '#2025-01-01#=#2025-01-01#', 'if true then true else false endif'])('includes formal precondition %s in the absolute policy', precondition => {
    const snapshot = fixture('{tT,r0090,c0010}={tT,r0020,c0010}', precondition);
    const result = getRecalculationPolicy(snapshot, { variantIds: [other(snapshot).variantId], binding: { contextId: 'demo' } }); expect(result.policy.mode).toBe('validation_only');
  });
  it('rejects a mixed internally configured operation entirely before creating proposals, preserving numeric-only branches', () => {
    const snapshot = fixture('{tT,r0090,c0010}=(if true then 1 else 2 endif)'), variant = other(snapshot), original = JSON.stringify(snapshot);
    const row = runValidation(snapshot, { runId: randomUUID(), startedAt }).results.find(r => r.code === 'other')!;
    const forced = { ...snapshot.content.directions[0]!, variantIds: [variant.variantId], instanceId: row.instanceId!, binding: row.binding! };
    expect(() => simulate({ ...snapshot, content: { ...snapshot.content, directions: [...snapshot.content.directions, forced] } }, { previewId: randomUUID() }))
      .toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'RULE_VALIDATION_ONLY' })]) }));
    expect(simulate(snapshot, { previewId: randomUUID() }).proposals).toHaveLength(2); expect(JSON.stringify(snapshot)).toBe(original);
  });
  it('revalidates the complete catalog after numeric patches without making a conditional a producer', () => {
    const source = applicationFixture({ extraRule: 'if {tT,r0010,c0010}>11 then true else false endif' });
    const snapshot = { ...source.snapshot, content: { ...source.snapshot.content, profileId: LANGUAGE_PROFILE_V2 } };
    const bundle = simulate(snapshot, { previewId: randomUUID() }), selectedIds = bundle.proposals.map(p => p.id);
    expect(bundle.proposals.map(p => p.code).sort()).toEqual(['A', 'D']);
    const result = applyCandidate(snapshot, bundle, { ...source.options, selectedIds, closureHash: selectionClosureHash(bundle.preview, selectedIds) });
    expect(result.beforeValidation.results.find(r => r.code === 'other')!.status).toBe('fail');
    expect(result.validation.results.find(r => r.code === 'other')!.status).toBe('pass');
  });
  it('does not let fabricated proposal metadata attach a conditional rule to a numeric application', () => {
    const source = applicationFixture({ extraRule: 'if true then true else false endif' }), snapshot = { ...source.snapshot, content: { ...source.snapshot.content, profileId: LANGUAGE_PROFILE_V2 } };
    const bundle = simulate(snapshot, { previewId: randomUUID() }), excluded = other(snapshot);
    const changed = { ...bundle, proposals: bundle.proposals.map((p, index) => index ? p : { ...p, variantIds: [excluded.variantId], code: excluded.code }) };
    const selectedIds = changed.proposals.map(p => p.id);
    expect(() => applyCandidate(snapshot, changed, { ...source.options, selectedIds, closureHash: selectionClosureHash(changed.preview, selectedIds) })).toThrow();
  });
});
