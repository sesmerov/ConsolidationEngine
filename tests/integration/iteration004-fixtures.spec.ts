import { describe, expect, it } from 'vitest';
import { prepareDirectionProjection, readDirectionRows } from '@ce/engine';
import { conflictSnapshot, iterationContexts, selectionSnapshot, validateIteration } from '../helpers/iteration004-fixtures.js';

describe('iteration 004 synthetic scenario definitions', () => {
  it.each([2, 3, 51] as const)('creates %i actual competing producers', count => {
    const snapshot = conflictSnapshot(count), run = validateIteration(snapshot);
    expect(run.results).toHaveLength(count);
    const projection = prepareDirectionProjection(snapshot, run.results, { reviewId: '00000000-0000-4000-8000-000000000004' });
    expect(projection.conflictGroupCount).toBe(1);
    expect(projection.counts.conflicted).toBe(count);
  });
  it('creates 51 distinct selectable targets and a cross-page dependency', () => {
    const snapshot = selectionSnapshot(), run = validateIteration(snapshot);
    expect(run.results).toHaveLength(51);
    const projection = prepareDirectionProjection(snapshot, run.results, { reviewId: '00000000-0000-4000-8000-000000000004' });
    expect(projection.counts.included).toBe(51);
    expect(readDirectionRows(projection, { offset: 50, limit: 50 }).items[0]?.code).toBe('PROPOSAL_051');
  });
  it('keeps compatible context business identities and independent conflicts', () => {
    const contexts = iterationContexts(), snapshot = conflictSnapshot(2, contexts);
    expect(contexts[0]?.entityId).toBe(contexts[1]?.entityId);
    expect(contexts[0]?.referenceDate).toBe(contexts[1]?.referenceDate);
    expect(contexts[0]?.canonicalContextKey).not.toBe(contexts[1]?.canonicalContextKey);
    const projection = prepareDirectionProjection(snapshot, validateIteration(snapshot).results, { reviewId: '00000000-0000-4000-8000-000000000004' });
    expect(projection.conflictGroupCount).toBe(2);
  });
});
