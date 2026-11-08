import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { recalculationHarness } from '../helpers/recalculation-operation-harness.js';
import { bothSidesSnapshot, collidingTargetsSnapshot, pendingDecisionsSnapshot, noCandidatesSnapshot } from '../helpers/iteration005-fixtures.js';

it('reads current state without preparing, publishing or treating unknown counts as zero', async () => {
  const h = await recalculationHarness(), before = h.store.bytes;
  const state = await h.getCurrent('/recalculation-state');
  expect(state.statusCode, state.body).toBe(200);
  expect(state.json()).toMatchObject({ state: 'preparation_required', counts: null, currentVersionId: h.snapshot.versionId,
    validationBasisId: h.snapshot.validationBasisId, compatibleRun: { id: h.input.runId } });
  expect(h.scheduled).toHaveLength(0); expect(h.store.bytes).toBe(before);
  h.store.publish(h.workspace.id, h.snapshot.versionId, h.snapshot.content);
  expect((await h.getCurrent('/recalculation-state')).json()).toMatchObject({ state: 'needs_validation', counts: null });
});

it('enforces closed schemas, session, ETag and exact bases before accepting work', async () => {
  const h = await recalculationHarness(), path = '/recalculation-reviews', input = h.currentInput();
  expect((await h.app.inject({ url: h.base + '/recalculation-state', headers: { host: h.headers.host } })).statusCode).toBe(403);
  expect((await h.postCurrent(path, input, randomUUID(), null)).statusCode).toBe(428);
  for (const body of [{ ...input, validationBasisId: 'x' }, { ...input, acceptPartial: true }, { ...input, ast: {} }]) {
    expect((await h.postCurrent(path, body)).statusCode).toBe(400);
  }
  expect((await h.prepareCurrent({ ...input, validationBasisId: randomUUID() })).statusCode).toBe(409);
  const review = await h.readyCurrent();
  for (const body of [{ ...input, runId: review.runId, reviewId: review.id, expectedRevision: 1, acceptPartial: true },
    { ...input, runId: review.runId, reviewId: review.id, expectedRevision: 0 }]) {
    expect((await h.postCurrent('/recalculation-operations', body)).statusCode).toBe(400);
  }
  expect((await h.operate({ ...review, revision: 2 })).statusCode).toBe(409);
});

it('pages global pending decisions before hydration and binds cursors to scope and revision', async () => {
  const h = await recalculationHarness({ content: pendingDecisionsSnapshot(51).content }), review = await h.readyCurrent();
  const path = '/recalculation-reviews/' + review.id + '/rows';
  const first = (await h.getCurrent(path + '?scope=pending&limit=50')).json();
  expect(first.total).toBe(51); expect(first.items).toHaveLength(50);
  const second = (await h.getCurrent(path + '?scope=pending&limit=50&cursor=' + encodeURIComponent(first.nextCursor))).json();
  expect(second.items).toHaveLength(1); expect(second.items[0].code).toBe('DECISION_051');
  expect((await h.getCurrent(path + '?scope=resolved&cursor=' + encodeURIComponent(first.nextCursor))).statusCode).toBe(400);
  expect((await h.getCurrent(path + '?scope=pending&limit=51')).statusCode).toBe(400);
  expect((await h.operate(review)).statusCode).toBe(409);
  await h.edit(review.id, 1, [{ op: 'set', instanceId: second.items[0].instanceId, choice: 'omit' }]);
  const resolved = (await h.getCurrent(path + '?scope=resolved')).json();
  expect(resolved.total).toBe(1); expect(resolved.items[0].state).toBe('omitted');
  expect((await h.getCurrent(path + '?scope=pending')).json().total).toBe(50);
  expect((await h.getCurrent(path + '?scope=pending&cursor=' + encodeURIComponent(first.nextCursor))).statusCode).toBe(400);
});

it('requires an explicit side and producer, retaining resolved groups in the global scope', async () => {
  const h = await recalculationHarness({ content: collidingTargetsSnapshot(51).content }), review = await h.readyCurrent();
  const path = '/recalculation-reviews/' + review.id + '/groups';
  const group = (await h.getCurrent(path + '?scope=pending')).json().items[0];
  const first = (await h.getCurrent(path + '/' + group.groupId + '/candidates?limit=50')).json();
  const last = (await h.getCurrent(path + '/' + group.groupId + '/candidates?limit=50&cursor=' + encodeURIComponent(first.nextCursor))).json().items[0];
  expect(last.code).toBe('PRODUCER_051'); expect((await h.operate(review)).statusCode).toBe(409);
  await h.edit(review.id, 1, [{ op: 'resolveGroup', groupId: group.groupId, winnerInstanceId: last.instanceId }]);
  expect((await h.getCurrent(path + '?scope=pending')).json().total).toBe(0);
  expect((await h.getCurrent(path + '?scope=resolved')).json().items[0].selectedCandidate.code).toBe('PRODUCER_051');
});

it.each([{ content: bothSidesSnapshot().content, state: 'pending' }, { content: noCandidatesSnapshot().content, state: 'no_candidates' }])(
  'classifies review as $state without publishing a configuration', async ({ content, state }) => {
    const h = await recalculationHarness({ content }); await h.readyCurrent();
    expect((await h.getCurrent('/recalculation-state')).json().state).toBe(state);
    expect(h.store.get(h.workspace.id).versionIds).toEqual([h.snapshot.versionId]);
  });

it('keeps reserved IDs distinct from a published result and recovers the exact acceptance by key', async () => {
  const h = await recalculationHarness(), review = await h.readyCurrent(), key = randomUUID(), tag = h.etag();
  const originalBody = { ...h.currentInput(), runId: review.runId, reviewId: review.id, expectedRevision: review.revision };
  const response = await h.operate(review, key), accepted = response.json(); expect(response.statusCode, response.body).toBe(202);
  expect(Object.keys(accepted).sort()).toEqual(['effectiveVersionId', 'inputVersionId', 'jobId', 'operationId', 'reservedPreviewId']);
  expect((await h.getCurrent('/jobs/' + accepted.jobId)).json().resultRef).toBeUndefined();
  expect((await h.getCurrent('/previews/' + accepted.reservedPreviewId)).statusCode).toBe(404);
  expect((await h.getCurrent('/api/v1/operation-receipts/' + key)).json()).toMatchObject({ operationId: accepted.operationId,
    reservation: { kind: 'recalculation', inputVersionId: h.snapshot.versionId, effectiveVersionId: accepted.effectiveVersionId, reservedPreviewId: accepted.reservedPreviewId } });
  const job = await h.finish(accepted.jobId); expect(job.status).toBe('succeeded');
  expect((await h.postCurrent('/recalculation-operations', originalBody, key, tag)).json()).toEqual(accepted);
  expect((await h.getCurrent('/api/v1/operations/' + accepted.operationId)).json()).toMatchObject({ phase: 'succeeded', resultRef: { type: 'preview', id: accepted.reservedPreviewId } });
});
