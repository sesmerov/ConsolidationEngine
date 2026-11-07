import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { conflictSnapshot, iterationContexts, iterationSnapshot, validateIteration } from '../../../tests/helpers/iteration004-fixtures.js';
import { prepareDirectionProjection, compileDirectionConfiguration } from '../src/recalculation/direction-review.js';
import * as index from '../src/recalculation/direction-review-index.js';
import { WorkBudget } from '../src/execution/budget.js';

function prepare(snapshot = conflictSnapshot()) {
  return { snapshot, projection: prepareDirectionProjection(snapshot, validateIteration(snapshot).results, { reviewId: randomUUID() }) };
}
function groups(projection: index.DirectionReviewProjection, offset = 0, limit = 50) {
  return index.readDirectionGroups(projection, { offset, limit });
}
function candidates(projection: index.DirectionReviewProjection, groupId: string, offset = 0, limit = 50) {
  return index.readDirectionCandidates(projection, groupId, { offset, limit });
}
function resolve(projection: index.DirectionReviewProjection, groupId: string, winnerInstanceId: string | null) {
  return index.editDirectionProjection(projection, [{ op: 'resolveGroup', groupId, winnerInstanceId }]);
}

describe('persistent direction conflict groups', () => {
  it.each([2, 3, 51] as const)('retains all %i eligible producers after choosing, changing and omitting a winner', count => {
    const { snapshot, projection } = prepare(conflictSnapshot(count));
    const beforeFacts = structuredClone(snapshot.content.facts);
    const row = index.readDirectionRows(projection, { offset: 0, limit: 1 }).items[0]!;
    const last = index.readDirectionRows(projection, { offset: count - 1, limit: 1 }).items[0]!;
    const chosen = resolve(projection, row.groupId!, last.instanceId!);
    // A second resolve must work directly, without making a conflict again through set/suggest.
    const changed = resolve(chosen, row.groupId!, row.instanceId!);
    const omitted = resolve(changed, row.groupId!, null);
    const recovered = resolve(omitted, row.groupId!, last.instanceId!);
    expect(groups(projection)).toMatchObject({ total: 1, items: [{ state: 'conflicted', candidateCount: count, activeCount: count }] });
    expect(groups(chosen).items[0]).toMatchObject({ state: 'resolved', candidateCount: count, activeCount: 1, selectedCandidate: { instanceId: last.instanceId } });
    expect(groups(omitted).items[0]).toMatchObject({ state: 'omitted', candidateCount: count, activeCount: 0 });
    expect(candidates(recovered, row.groupId!, count - 1, 1)).toMatchObject({ total: count, items: [{ instanceId: last.instanceId, selected: true }] });
    expect(candidates(recovered, row.groupId!).items.filter(candidate => candidate.selected).length).toBe(count > 50 ? 0 : 1);
    expect(compileDirectionConfiguration(snapshot, recovered).directions).toHaveLength(1);
    expect(snapshot.content.facts).toEqual(beforeFacts);
    expect(projection.counts.conflicted).toBe(count);
    expect(chosen.rows).toBe(projection.rows);
    expect(chosen.candidates).toBe(projection.candidates);
  });

  it('observes only actual conflicts and keeps groups pending when their producers move away', () => {
    const { projection } = prepare(iterationSnapshot([
      { code: 'A', expression: '{tT,r0010,c0010}=1' },
      { code: 'B', expression: '{tT,r0010,c0010}={tT,r0020,c0010}' },
    ], ['0010', '0020']));
    expect(groups(projection).total).toBe(0);
    const rows = index.readDirectionRows(projection, { offset: 0, limit: 10 }).items;
    const conflicted = index.editDirectionProjection(projection, [{ op: 'set', instanceId: rows[1]!.instanceId!, choice: 'left' }]);
    const group = groups(conflicted).items[0]!;
    const one = resolve(conflicted, group.groupId, rows[1]!.instanceId!);
    const moved = index.editDirectionProjection(one, [{ op: 'set', instanceId: rows[1]!.instanceId!, choice: 'right' }]);
    expect(groups(moved).items[0]).toMatchObject({ groupId: group.groupId, state: 'pending', activeCount: 0 });
    expect(candidates(moved, group.groupId).items[1]).toMatchObject({ availability: 'assignedElsewhere', assignedTargetLabel: 'T · r0020 · c0010' });
    expect(() => resolve(moved, group.groupId, rows[1]!.instanceId!)).toThrow('GROUP_CANDIDATE_ASSIGNED_ELSEWHERE');
    const recovered = resolve(moved, group.groupId, rows[0]!.instanceId!);
    expect(recovered.counts.included).toBe(2);
    expect(index.readDirectionRows(recovered, { offset: 0, limit: 10 }).items[1]?.selectedSide).toBe('right');
  });

  it('deduplicates same-cell options in the index, retaining the active side or canonical left', () => {
    const { projection: base } = prepare(iterationSnapshot([
      { code: 'A', expression: '{tT,r0010,c0010}=1' },
      { code: 'B', expression: '{tT,r0010,c0010}={tT,r0020,c0010}' },
    ], ['0010', '0020']));
    // Index-level fixture only: actual self-reference remains ineligible under resolveDirection.
    const rows = base.rows.map((row, i) => i ? { ...row, options: row.options.map(option => ({ ...option, group: row.options[0]!.group, label: row.options[0]!.label })) } : row);
    const active = index.indexProjection({ reviewId: base.reviewId, baseVersionId: base.baseVersionId,
      rows, groups: base.groups, byInstance: base.byInstance, byGroup: base.byGroup }, ['A', 'R'], new WorkBudget());
    const row = index.readDirectionRows(active, { offset: 1, limit: 1 }).items[0]!;
    const group = groups(active).items[0]!;
    expect(candidates(active, group.groupId)).toMatchObject({ total: 2, items: [{ targetSide: 'left' }, { targetSide: 'right' }] });
    const kept = resolve(active, group.groupId, row.instanceId!);
    expect(groups(kept).items[0]?.selectedCandidate?.targetSide).toBe('right');
    const cleared = index.editDirectionProjection(kept, [{ op: 'omitAll' }]);
    expect(groups(cleared).items[0]?.state).toBe('omitted');
    expect(candidates(cleared, group.groupId).items[1]?.targetSide).toBe('left');
  });

  it('isolates compatible contexts and keeps deterministic group and candidate order across edits', () => {
    const { projection } = prepare(conflictSnapshot(3, iterationContexts()));
    const list = groups(projection);
    expect(list.total).toBe(2);
    expect(new Set(list.items.map(group => group.contextLabel)).size).toBe(2);
    const first = list.items[0]!, winner = candidates(projection, first.groupId).items[2]!;
    const changed = resolve(projection, first.groupId, winner.instanceId);
    expect(groups(changed).items.map(group => group.groupId)).toEqual(list.items.map(group => group.groupId));
    expect(groups(changed).items[1]?.state).toBe('conflicted');
    expect(candidates(changed, first.groupId).items.map(item => item.code)).toEqual(['CANDIDATE_001', 'CANDIDATE_002', 'CANDIDATE_003']);
    expect(() => index.readDirectionCandidate(changed, first.groupId, candidates(changed, list.items[1]!.groupId).items[0]!.instanceId)).toThrow('UNKNOWN_CANDIDATE');
  });

  it('fails interrupted edits atomically and preserves observed decisions through omitAll', () => {
    const { projection } = prepare();
    const group = groups(projection).items[0]!;
    const original = JSON.stringify(projection);
    expect(() => index.editDirectionProjection(projection, [{ op: 'resolveGroup', groupId: group.groupId, winnerInstanceId: null }],
      { budget: new WorkBudget({ cancelled: () => true }) })).toThrow();
    expect(JSON.stringify(projection)).toBe(original);
    expect(groups(index.editDirectionProjection(projection, [{ op: 'omitAll' }])).items[0]).toMatchObject({ state: 'omitted', candidateCount: 3 });
    expect(() => groups(projection, -1)).toThrow('INVALID_PAGE');
    expect(() => candidates(projection, group.groupId, 0, 201)).toThrow('INVALID_PAGE');
  });

  it('rejects overlapping winning candidates across two observed destinations atomically', () => {
    const { projection } = prepare(iterationSnapshot([
      { code: 'A', expression: '{tT,r0010,c0010}=1' },
      { code: 'B', expression: '{tT,r0020,c0010}=2' },
      { code: 'C', expression: '{tT,r0010,c0010}={tT,r0020,c0010}' },
    ], ['0010', '0020']));
    const candidate = index.readDirectionRows(projection, { offset: 2, limit: 1 }).items[0]!;
    const first = index.editDirectionProjection(projection, [{ op: 'set', instanceId: candidate.instanceId!, choice: 'left' }]);
    const second = index.editDirectionProjection(first, [{ op: 'set', instanceId: candidate.instanceId!, choice: 'right' }]);
    const cleared = index.editDirectionProjection(second, [{ op: 'omitAll' }]);
    const list = groups(cleared).items;
    expect(list).toHaveLength(2);
    expect(() => index.editDirectionProjection(cleared, list.map(group => ({ op: 'resolveGroup' as const, groupId: group.groupId,
      winnerInstanceId: candidate.instanceId! })))).toThrow('OVERLAPPING_OPERATIONS');
    expect(cleared.counts.included).toBe(0);
  });
});
