import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { PreviewBundle, Snapshot } from '@ce/contracts';
import { WorkBudget } from '../src/execution/budget.js';
import { runValidation } from '../src/validation/run.js';
import { evaluateCandidate } from '../src/recalculation/candidate.js';
import { simulate } from '../src/recalculation/simulate.js';
import { applicationFixture, fixtureClosure } from './helpers/application-fixture.js';

type Fixture = ReturnType<typeof applicationFixture>;
async function apply(f: Fixture, overrides: object = {}) {
  const modulePath = '../src/recalculation/apply-candidate.js';
  const { applyCandidate } = await import(modulePath) as typeof import('../src/recalculation/apply-candidate.js');
  return applyCandidate(f.snapshot, f.preview, { ...f.options, ...overrides });
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function materialize(base: Snapshot, output: Awaited<ReturnType<typeof apply>>, versionId: string): Snapshot {
  const patches = new Map(output.factPatches.map(f => [f.factKey, f]));
  return { ...base, versionId, content: { ...base.content, facts: [...base.content.facts.map(f => patches.get(f.factKey) ?? f), ...output.factPatches.filter(p => !base.content.facts.some(f => f.factKey === p.factKey))] } };
}
describe('application prerequisite', () => {
  it('constructs real available proposals with A as ancestor of D', () => {
    const f = applicationFixture(); expect(f.preview.proposals.map(p => p.state)).toEqual(['available', 'available']);
    expect(f.preview.proposals[1]!.predecessorIds).toEqual([f.preview.proposals[0]!.id]);
  });
});
describe('pure application candidates', () => {
  it('returns only changed facts and two complete version-correct validations, preserving the original', async () => {
    const f = applicationFixture(); freeze(f.snapshot); freeze(f.preview); const previous = JSON.stringify(f);
    const result = await apply(f); expect(Object.keys(result).sort()).toEqual(['beforeValidation', 'factPatches', 'validation']);
    expect(result.factPatches.map(p => p.normalizedValue)).toEqual([{ numerator: '12', denominator: '1' }, { numerator: '24', denominator: '1' }]);
    expect(result.beforeValidation.run).toMatchObject({ id: f.options.beforeRunId, versionId: f.snapshot.versionId, status: 'completed', summary: { complete: true } });
    expect(result.validation.run).toMatchObject({ id: f.options.runId, versionId: f.options.newVersionId, status: 'completed', summary: { complete: true } });
    expect(result.validation.results.every(r => r.status === 'pass' && r.versionId === f.options.newVersionId)).toBe(true);
    expect(JSON.stringify(f)).toBe(previous); expect(() => JSON.stringify(result)).not.toThrow();
  });
  it('attaches exact derivation links and propagates them in validation fact reads and future previews', async () => {
    const f = applicationFixture(), result = await apply(f), first = result.factPatches[0]!;
    expect(first.derivation).toEqual({ receiptId: f.options.receiptId, previewId: f.preview.preview.id, proposalId: f.preview.proposals[0]!.id, baseVersionId: f.snapshot.versionId });
    const read = result.validation.results.find(r => r.code === 'D')!.factReads.find(r => r.factKey === first.factKey)!;
    expect(read.derivation).toEqual(first.derivation); expect(read.sourceLocator).toEqual(first.sourceLocator);
    const after = materialize(f.snapshot, result, f.options.newVersionId);
    expect(evaluateCandidate(after, after.content.directions[0]!).before?.derivation).toEqual(first.derivation);
    const next = simulate(after, { previewId: randomUUID() }); expect(next.proposals[0]!.before?.derivation).toEqual(first.derivation);
    const conflicted = { ...after, content: { ...after.content, directions: [...after.content.directions, { ...after.content.directions[0]!, id: 'f'.repeat(64) }] } };
    const blocked = simulate(conflicted, { previewId: randomUUID() }).proposals.find(p => p.targetKey === first.factKey)!;
    expect(blocked.state).toBe('blocked'); expect(blocked.before?.derivation).toEqual(first.derivation);
  });
  it('keeps no-op original lexical text, derivation and identity despite differing decimal padding', async () => {
    const f = applicationFixture({ a: '12', d: '24.000' });
    const prior = { receiptId: randomUUID(), previewId: randomUUID(), proposalId: randomUUID(), baseVersionId: randomUUID() };
    f.snapshot = { ...f.snapshot, content: { ...f.snapshot.content, facts: f.snapshot.content.facts.map(item => item.rowCode === '0010' ? { ...item, derivation: prior } : item) } };
    const result = await apply(f); expect(result.factPatches).toEqual([]);
    const unchanged = materialize(f.snapshot, result, f.options.newVersionId);
    for (const original of f.snapshot.content.facts) expect(unchanged.content.facts.find(item => item.factKey === original.factKey)).toBe(original);
    expect(result.validation.results[0]!.factReads.find(item => item.factKey === f.cells[0]!.factKey)).toMatchObject({ originalText: '12', derivation: prior });
    expect(f.snapshot.content.facts.find(item => item.rowCode === '0040')!.originalText).toBe('24.000');
  });
  it.each([{ a: null }, { implicit: true }, { boolean: true }])('supports explicit/implicit absence and exact booleans: %j', async options => {
    const f = applicationFixture(options), result = await apply(f); expect(result.factPatches).toHaveLength(2);
    expect(result.factPatches[0]!.normalizedValue).toEqual(options.boolean ? true : { numerator: '12', denominator: '1' });
  });
  it('keeps a no-op ancestor unchanged while applying its changed descendant', async () => {
    const f = applicationFixture({ a: '12.000' }), result = await apply(f);
    expect(result.factPatches).toHaveLength(1); expect(result.factPatches[0]!.factKey).toBe(f.cells[3]!.factKey);
    const after = materialize(f.snapshot, result, f.options.newVersionId);
    expect(after.content.facts.find(item => item.factKey === f.cells[0]!.factKey)).toBe(f.snapshot.content.facts[0]);
    expect(result.validation.results.every(r => r.status === 'pass')).toBe(true);
  });
  it('allows a closed proper subset without applying descendants', async () => {
    const f = applicationFixture(), selectedIds = [f.preview.proposals[0]!.id];
    const result = await apply(f, { selectedIds, closureHash: fixtureClosure(f.preview, selectedIds) });
    expect(result.factPatches).toHaveLength(1); expect(result.validation.results.find(r => r.code === 'D')!.status).toBe('fail');
  });
  it.each(['1=2', '1/0=1', 'abs(1)=1', '1=1 @'])('retains unrelated ordinary rule outcome for %s and completes the candidate', async extraRule => {
    const result = await apply(applicationFixture({ extraRule })); expect(result.validation.run.status).toBe('completed');
    expect(result.validation.results.find(r => r.code === 'other')!.status).not.toBe('pass');
  });
  it('reuses a complete exact base validation by reference', async () => {
    const f = applicationFixture(); const beforeValidation = runValidation(f.snapshot, { runId: f.options.beforeRunId, startedAt: f.options.startedAt });
    const result = await apply(f, { beforeValidation }); expect(result.beforeValidation).toBe(beforeValidation);
  });
  it.each(['incomplete', 'wrong-version', 'wrong-profile', 'wrong-id'])('does not reuse a %s base run', async mismatch => {
    const f = applicationFixture(); const original = runValidation(f.snapshot, { runId: f.options.beforeRunId, startedAt: f.options.startedAt });
    const beforeValidation = { ...original, run: { ...original.run, ...(mismatch === 'incomplete' ? { status: 'incomplete', summary: { ...original.run.summary, complete: false } } : mismatch === 'wrong-version' ? { versionId: randomUUID() } : mismatch === 'wrong-id' ? { id: randomUUID() } : { profileId: 'other' }) } };
    const result = await apply(f, { beforeValidation }); expect(result.beforeValidation).not.toBe(beforeValidation);
    expect(result.beforeValidation.run).toMatchObject({ id: f.options.beforeRunId, versionId: f.snapshot.versionId, profileId: f.snapshot.content.profileId, status: 'completed' });
  });
  it('rejects empty, unknown and duplicate selection IDs', async () => {
    const f = applicationFixture();
    for (const selectedIds of [[], [randomUUID()], [f.options.selectedIds[0]!, f.options.selectedIds[0]!]]) await expect(apply(f, { selectedIds })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('requires all ancestors explicitly and rejects a forged closure hash', async () => {
    const f = applicationFixture(), selectedIds = [f.preview.proposals[1]!.id];
    await expect(apply(f, { selectedIds, closureHash: fixtureClosure(f.preview, selectedIds, [f.preview.proposals[0]!.id]) })).rejects.toMatchObject({ code: 'SELECTION_NOT_CLOSED' });
    await expect(apply(f, { closureHash: '0'.repeat(64) })).rejects.toMatchObject({ code: 'SELECTION_NOT_CLOSED' });
  });
  it.each(['discarded', 'obsolete', 'applied'])('does not apply preview state %s', async state => {
    const f = applicationFixture(); f.preview = { ...f.preview, preview: { ...f.preview.preview, state } } as PreviewBundle;
    await expect(apply(f)).rejects.toMatchObject({ code: 'PREVIEW_NOT_APPLICABLE' });
  });
  it('rejects stale base, wrong profile and wrong policy', async () => {
    for (const [field, value, code] of [['baseVersionId', randomUUID(), 'STALE_VERSION'], ['profileId', 'other', 'PROFILE_MISMATCH'], ['policyId', 'other', 'PROFILE_MISMATCH']]) {
      const f = applicationFixture(); f.preview = { ...f.preview, preview: { ...f.preview.preview, [field!]: value } } as PreviewBundle;
      await expect(apply(f)).rejects.toMatchObject({ code });
    }
  });
  it('re-evaluates selected preconditions and rejects changed preview values', async () => {
    const f = applicationFixture({ guarded: true }); f.snapshot = { ...f.snapshot, content: { ...f.snapshot.content, contexts: f.snapshot.content.contexts.map(c => ({ ...c, filingIndicators: { READY: false } })) } };
    await expect(apply(f)).rejects.toMatchObject({ code: 'PREVIEW_NOT_APPLICABLE' });
    const g = applicationFixture(); g.preview = { ...g.preview, proposals: g.preview.proposals.map((p, index) => index ? p : { ...p, after: { ...p.after!, normalizedValue: { numerator: '999', denominator: '1' } } }) } as PreviewBundle;
    await expect(apply(g)).rejects.toMatchObject({ code: 'PREVIEW_NOT_APPLICABLE' });
  });
  it('rejects selected producer conflicts, even if a forged proposal claims availability', async () => {
    const f = applicationFixture(); const direction = f.snapshot.content.directions[0]!;
    f.snapshot = { ...f.snapshot, content: { ...f.snapshot.content, directions: [...f.snapshot.content.directions, { ...direction, id: 'f'.repeat(64) }] } };
    await expect(apply(f)).rejects.toMatchObject({ code: 'PREVIEW_NOT_APPLICABLE' });
  });
  it('shares cumulative counters across base validation, candidates and full revalidation without resetting', async () => {
    const f = applicationFixture(), budget = new WorkBudget(); await apply(f, { budget }); const total = budget.counts.reads; expect(total).toBeGreaterThan(0);
    const beforeValidation = runValidation(f.snapshot, { runId: f.options.beforeRunId, startedAt: f.options.startedAt });
    const reused = new WorkBudget(); await apply(f, { budget: reused, beforeValidation }); expect(reused.counts.reads).toBeLessThan(total);
    const stages: number[] = [];
    await expect(apply(f, { limits: { reads: total - 1 }, progress: (stage: number) => stages.push(stage) })).rejects.toMatchObject({ code: 'RESOURCE_LIMIT' });
    expect(stages).toEqual([0, 1, 2]); // Exhausted during after-validation, after the base and patches completed.
    expect((await apply(f, { limits: { reads: total } })).validation.run.summary.complete).toBe(true);
  });
  it.each([[{ limits: { reads: 0 } }, 'RESOURCE_LIMIT'], [{ cancelled: () => true }, 'CANCELLED'], [{ limits: { milliseconds: 0 } }, 'DEADLINE_EXCEEDED']] as const)('returns no publishable result on technical termination %j', async (override, code) => {
    const f = applicationFixture(), original = JSON.stringify(f.snapshot); await expect(apply(f, override)).rejects.toMatchObject({ code }); expect(JSON.stringify(f.snapshot)).toBe(original);
  });
  it('checks cancellation requested by progress before returning a publishable result', async () => {
    const f = applicationFixture(); let stop = false;
    await expect(apply(f, { cancelled: () => stop, progress: () => { stop = true; } })).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});
