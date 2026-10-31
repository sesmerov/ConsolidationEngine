import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { JobDTO, JsonValue } from '@ce/contracts';
import { canonicalStateBytes, immutable } from '../../apps/api/src/session/canonical-state.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { content } from '../helpers/foundation.js';

interface Counter { readonly bytes: number; prepare(roots: readonly unknown[]): { readonly bytes: number; commit(): void } }
let RetainedSize: new () => Counter;
const freeze = Object.freeze;
function transition(counter: Counter, previous: readonly unknown[], next: readonly unknown[]): void {
  const before = canonicalStateBytes(previous), expected = canonicalStateBytes(next), prepared = counter.prepare(next);
  expect(counter.bytes).toBe(before); expect(prepared.bytes).toBe(expected); expect(counter.bytes).toBe(before);
  prepared.commit(); expect(counter.bytes).toBe(expected);
}

describe('incremental retained bytes against the original complete oracle', () => {
  beforeAll(async () => {
    // A missing module is reported as preparation failure, never as verified arithmetic behavior.
    const modulePath = '../../apps/api/src/session/retained-size.js';
    ({ RetainedSize } = await import(modulePath));
  });
  it('counts shared branches once while counting every parent edge and scalar occurrence', () => {
    const counter = new RetainedSize(), leaf = freeze({ amount: '123456789012345678901234567890', enabled: true });
    const branches = freeze([leaf, leaf, 'same', 'same']), left = freeze({ one: leaf, two: branches }), right = freeze({ repeated: leaf, also: branches });
    const states = [[], [left], [left, right], [left, right, leaf, branches, left], [right, branches], [leaf], []];
    for (let index = 1; index < states.length; index++) transition(counter, states[index - 1]!, states[index]!);
    expect(counter.bytes).toBe(0);
  });
  it('distinguishes equal objects with different identity and releases the last incoming reference', () => {
    const counter = new RetainedSize(), first = freeze({ value: 'á😀' }), equal = freeze({ value: 'á😀' }), repeated = freeze([first, first, equal]);
    const states = [[], [first], [first, first], [first, equal], [repeated, first], [repeated], [equal], []];
    for (let index = 1; index < states.length; index++) transition(counter, states[index - 1]!, states[index]!);
    expect(canonicalStateBytes([first, equal])).toBe(2 * canonicalStateBytes([first]));
  });
  it('keeps a prepared replacement invisible until commit and rejects an obsolete prepared transaction', () => {
    const counter = new RetainedSize(), shared = freeze({ payload: 'x'.repeat(250) }), initial = [freeze({ a: shared })]; transition(counter, [], initial);
    const abandoned = counter.prepare([freeze({ other: shared }), freeze({ unique: 1 })]); expect(counter.bytes).toBe(canonicalStateBytes(initial));
    const committed = [freeze({ third: shared }), '😀']; transition(counter, initial, committed);
    expect(() => abandoned.commit()).toThrow(); expect(counter.bytes).toBe(canonicalStateBytes(committed));
    transition(counter, committed, []);
  });
  it('preparing an oversized candidate and abandoning it does not retain any branch or scalar', () => {
    const counter = new RetainedSize(), kept = freeze({ value: 'kept' }), initial = [kept]; transition(counter, [], initial);
    const oversized = counter.prepare([kept, freeze({ value: 'x'.repeat(10_000), deep: freeze([kept]) })]);
    expect(oversized.bytes).toBe(canonicalStateBytes([kept, freeze({ value: 'x'.repeat(10_000), deep: freeze([kept]) })]));
    expect(counter.bytes).toBe(canonicalStateBytes(initial)); transition(counter, initial, [kept, 1]); transition(counter, [kept, 1], []);
  });
  it('matches Unicode, JSON escapes, finite numeric spellings, null and null-prototype objects', () => {
    const counter = new RetainedSize(), value = freeze(Object.assign(Object.create(null), { '😀"\\\n': 'é😀\u0000\r\n\t"\\\ud800', null: null, bool: false }));
    const numbers = freeze([0, -0, 1e-7, 1e21, Number.MAX_VALUE, Number.MIN_VALUE, -123.5]);
    const roots = [value, numbers, null, true, false, 'same', 'same', 0, -0, 1e21]; transition(counter, [], roots); transition(counter, roots, [numbers]); transition(counter, [numbers], []);
  });
  it('matches sparse-array punctuation without treating holes as explicit undefined values', () => {
    const counter = new RetainedSize(), sparse = new Array(4); sparse[2] = freeze({ one: 1 }); const frozen = freeze(sparse), roots = [frozen, frozen];
    expect(() => canonicalStateBytes(roots)).not.toThrow(); transition(counter, [], roots); transition(counter, roots, []);
    expect(() => canonicalStateBytes([freeze([undefined])])).toThrow(TypeError);
  });
  it('matches the oracle through a deterministic series of overlapping additions, replacements and removals', () => {
    const counter = new RetainedSize(), leaves = Array.from({ length: 7 }, (_, index) => freeze({ value: 'á'.repeat(index), index }));
    const branches = Array.from({ length: 11 }, (_, index) => freeze({ one: leaves[index % 7], two: freeze([leaves[(index + 1) % 7], leaves[index % 7]]), label: String(index) }));
    let roots: readonly unknown[] = [];
    for (let step = 0; step < 70; step++) {
      const next = step % 5 === 0 ? roots.slice(1) : step % 5 === 1 ? [...roots, branches[step % branches.length]]
        : step % 5 === 2 ? [...roots, branches[step % branches.length], leaves[step % leaves.length]]
          : step % 5 === 3 ? [branches[(step + 3) % branches.length], ...roots.slice(1)] : [...roots.slice(0, 3), 'scalar-' + step];
      transition(counter, roots, next); roots = next;
    }
    transition(counter, roots, []);
  });
});

/** Test-only root observation: this is the original public accounting definition, not counter internals. */
function checkStore(store: WorkspaceStore): number {
  const state = store as unknown as { workspace?: unknown; snapshots: Map<string, unknown>; records: Map<string, unknown> };
  const roots = [...(state.workspace ? [state.workspace] : []), ...state.snapshots.values(), ...[...state.records].map(([key, value]) => ({ key, value }))];
  const expected = canonicalStateBytes(roots); expect(store.bytes).toBe(expected);
  if (store.currentWorkspaceId) expect(store.get(store.currentWorkspaceId).sessionBytes).toBe(expected); return expected;
}
function job(workspaceId: string, baseVersionId?: string): JobDTO {
  return { jobId: randomUUID(), workspaceId, kind: 'validate', status: 'queued', ...(baseVersionId ? { baseVersionId } : {}), progress: { completed: 0, total: 0, complete: false }, diagnostics: [], pollAfterMs: 1000 };
}
describe('WorkspaceStore accounting transactions preserve the complete oracle', () => {
  it('can begin and complete closing an empty workspace exactly at its byte quota', () => {
    const name = 'Exact empty quota', sizing = new WorkspaceStore(); sizing.create(name);
    const maximum = checkStore(sizing), store = new WorkspaceStore({ maxBytes: maximum }), workspace = store.create(name);
    expect(checkStore(store)).toBe(maximum);
    store.beginClose(workspace.id); const closing = checkStore(store); expect(closing).toBeLessThanOrEqual(maximum);
    store.beginClose(workspace.id); expect(checkStore(store)).toBe(closing);
    store.close(workspace.id); expect(checkStore(store)).toBeLessThanOrEqual(maximum); expect(store.currentWorkspaceId).toBeUndefined();
  });
  it('can release a ready workspace whose records fill the remaining quota exactly', () => {
    const maximum = 16_384, store = new WorkspaceStore({ maxBytes: maximum }), workspace = store.create('Exact ready quota');
    store.publish(workspace.id, undefined, content()); checkStore(store);
    store.putInternalRecord('padding', ''); const used = checkStore(store); expect(used).toBeLessThan(maximum);
    store.putInternalRecord('padding', 'x'.repeat(maximum - used)); expect(checkStore(store)).toBe(maximum);
    store.beginClose(workspace.id); expect(checkStore(store)).toBeLessThanOrEqual(maximum);
    store.close(workspace.id); expect(checkStore(store)).toBeLessThan(used); expect(store.listRecords('')).toEqual([]); expect(store.currentWorkspaceId).toBeUndefined();
  });
  it('matches shared snapshots, records, replacement, delete, beginClose and session reset after every transition', () => {
    const store = new WorkspaceStore(); checkStore(store); const workspace = store.create('Exact accounting'); checkStore(store);
    const first = store.publish(workspace.id, undefined, content()); checkStore(store);
    store.putRecords([{ key: 'cache:one', value: first.content as unknown as JsonValue }, { key: 'cache:two', value: first.content.facts as unknown as JsonValue }]); checkStore(store);
    const second = store.publish(workspace.id, first.versionId, { ...first.content, configVersion: 'two' }); expect(second.content.facts).toBe(first.content.facts); checkStore(store);
    store.putInternalRecord('cache:one', immutable({ leaf: second.content.facts, scalar: '😀' })); checkStore(store);
    store.deleteInternalRecord('cache:two'); checkStore(store); store.deleteInternalRecord('missing'); checkStore(store);
    store.beginClose(workspace.id); checkStore(store); store.close(workspace.id); checkStore(store);
    expect(store.listRecords('')).toEqual([]); const replacement = store.create('Fresh'); checkStore(store); expect(replacement.versionIds).toEqual([]);
  });
  it('matches job reservations, retained input, repeated progress and terminal release', () => {
    const store = new WorkspaceStore(), workspace = store.create('Jobs'), first = store.publish(workspace.id, undefined, content()); checkStore(store);
    const queued = job(workspace.id, first.versionId); store.registerJob(queued, [{ key: 'cache:job', value: first.content.facts as unknown as JsonValue }], first.content as unknown as JsonValue); checkStore(store);
    for (let completed = 0; completed < 8; completed++) { store.updateJob({ ...queued, status: 'running', startedAt: '2026-11-01T00:00:00.000Z', progress: { completed, total: 8, complete: false } }); checkStore(store); }
    store.updateJob({ ...store.job(workspace.id, queued.jobId), status: 'cancelled', endedAt: '2026-11-01T00:00:01.000Z' }); const terminal = checkStore(store);
    expect(store.listRecords('reserve:')).toEqual([]); expect(store.listRecords('operation:')).toEqual([]);
    store.updateJob({ ...queued, status: 'running' }); expect(checkStore(store)).toBe(terminal);
  });
  it('rolls back over-quota records, internal records and publication with no counter drift', () => {
    const store = new WorkspaceStore({ maxBytes: 20_000 }), workspace = store.create('Quota'), first = store.publish(workspace.id, undefined, content());
    const queued = job(workspace.id, first.versionId); store.registerJob(queued); store.updateJob({ ...queued, status: 'running' }); const before = checkStore(store), huge = { text: 'x'.repeat(50_000), shared: first.content.facts };
    for (const attempt of [() => store.putRecords([{ key: 'too-large', value: huge as unknown as JsonValue }]), () => store.putInternalRecord('too-large', huge),
      () => store.publishJobResult(queued, { complete: true, snapshotContent: { ...first.content, configVersion: 'rejected' }, records: [{ key: 'too-large', value: huge as unknown as JsonValue }] })]) {
      expect(attempt).toThrowError(expect.objectContaining({ code: 'SESSION_LIMIT' })); expect(checkStore(store)).toBe(before); expect(store.getRecord('too-large')).toBeUndefined(); expect(store.current(workspace.id)).toBe(first);
    }
    store.putRecords([{ key: 'small', value: { value: 1 } }]); checkStore(store);
    store.updateJob({ ...queued, status: 'failed' }); checkStore(store);
  });
  it('keeps the old counter visible inside a publication guard and can retry after the guard rejects', () => {
    const store = new WorkspaceStore(), workspace = store.create('Guard'), first = store.publish(workspace.id, undefined, content()), queued = job(workspace.id, first.versionId);
    store.registerJob(queued, [], first.content as unknown as JsonValue); store.updateJob({ ...queued, status: 'running' }); const before = checkStore(store), marker = new Error('controlled commit guard');
    const output = { complete: true, snapshotContent: { ...first.content, configVersion: 'next' }, records: [{ key: 'validation:done', value: { complete: true } }] };
    expect(() => store.publishJobResult(queued, output, () => { expect(checkStore(store)).toBe(before); throw marker; })).toThrow(marker);
    expect(checkStore(store)).toBe(before); expect(store.current(workspace.id)).toBe(first); expect(store.getRecord('validation:done')).toBeUndefined();
    store.publishJobResult(queued, output); checkStore(store); expect(store.current(workspace.id)!.parentVersionId).toBe(first.versionId); expect(store.job(workspace.id, queued.jobId).status).toBe('succeeded');
  });
  it('rejects snapshot-count overflow without preventing the next valid accounting transition', () => {
    const store = new WorkspaceStore({ maxSnapshots: 1 }), workspace = store.create('One version'), first = store.publish(workspace.id, undefined, content()), before = checkStore(store);
    expect(() => store.publish(workspace.id, first.versionId, { ...first.content, configVersion: 'rejected' })).toThrowError(expect.objectContaining({ code: 'SESSION_LIMIT' })); expect(checkStore(store)).toBe(before);
    store.putInternalRecord('after-rejection', { value: true }); checkStore(store); store.close(workspace.id); checkStore(store);
  });
  it.each([['undefined root', undefined], ['undefined property', { value: undefined }], ['undefined array item', [undefined]], ['NaN', NaN], ['Infinity', Infinity], ['negative Infinity', -Infinity], ['BigInt', 1n], ['symbol', Symbol('unsupported')], ['function', () => {}], ['Date', new Date(0)]])('rejects non-JSON %s at the ownership boundary without counter mutation', (_label, value) => {
    const store = new WorkspaceStore(), workspace = store.create('Invalid input'); store.publish(workspace.id, undefined, content()); const before = checkStore(store);
    expect(() => canonicalStateBytes([value])).toThrow(TypeError); expect(() => store.putInternalRecord('invalid', value)).toThrow(TypeError); expect(checkStore(store)).toBe(before); expect(store.getRecord('invalid')).toBeUndefined();
  });
  it('rejects cyclic input before publication and keeps subsequent valid writes correct', () => {
    const cycle: { self?: unknown } = {}; cycle.self = cycle;
    const store = new WorkspaceStore(), workspace = store.create('Cycle'), before = checkStore(store);
    expect(() => store.putInternalRecord('cycle', cycle)).toThrow(TypeError); expect(checkStore(store)).toBe(before);
    store.putInternalRecord('valid', { value: null }); checkStore(store); store.close(workspace.id); checkStore(store);
  });
});
