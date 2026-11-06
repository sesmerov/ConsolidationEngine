import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { reviewHarness } from '../helpers/direction-review-harness.js';

it('shares one draft between tabs, fixes the ready deadline, releases the expired projection and allows a new preparation', async () => {
  const h = await reviewHarness({ controlled: true }), prepared = await h.prepare();
  expect(prepared.statusCode, prepared.body).toBe(202);
  const preparing = (await h.get()).json().active;
  expect(preparing).toMatchObject({ state: 'preparing', jobId: prepared.json().jobId });
  expect(JSON.stringify(h.scheduled[0]!.request.input)).not.toMatch(/"(?:factReads|ast|expression|metadataReads|originalFields)":/);
  expect((await h.finish(preparing.jobId)).status).toBe('succeeded');
  const suffix = '/' + preparing.id, ready = (await h.get(suffix)).json();
  expect(Date.parse(ready.expiresAt) - Date.parse(ready.readyAt)).toBe(900_000);
  h.advance(899_999);
  const beforeExpiry = await h.edit(ready.id, 1, [{ op: 'omitAll' }]);
  expect(beforeExpiry.json().summary).toMatchObject({ expiresAt: ready.expiresAt, revision: 2 });
  expect((await h.edit(ready.id, 1, [{ op: 'omitAll' }])).json().error.code).toBe('STALE_DIRECTION_REVIEW');
  expect((await h.get()).json().active.id).toBe(ready.id);
  const retained = h.store.bytes;
  h.advance(1);
  expect((await h.get(suffix)).json().state).toBe('expired');
  expect((await h.get(suffix + '/rows')).json().error.code).toBe('DIRECTION_REVIEW_EXPIRED');
  expect((await h.commit(ready.id, 2)).statusCode).toBe(410);
  expect((await h.get()).json()).toEqual({ active: null });
  expect(h.store.bytes).toBeLessThan(retained);
  expect((await h.ready()).id).not.toBe(ready.id);
});

it('protects an accepted commit across expiry and returns the same receipt after cancellation or a lost reply after publication', async () => {
  const h = await reviewHarness({ controlled: true }), view = await h.ready(), tag = h.etag();
  await h.edit(view.id, 1, [{ op: 'omitAll' }]);
  h.advance(899_990);
  const key = randomUUID(), accepted = await h.commit(view.id, 2, false, key);
  expect(accepted.statusCode).toBe(202);
  const id = accepted.json().jobId;
  const slotCount = h.scheduled.length;
  expect((await h.commit(view.id, 2)).statusCode).toBe(409);
  expect(h.scheduled).toHaveLength(slotCount);
  h.advance(20);
  expect((await h.get()).json().active).toMatchObject({ id: view.id, state: 'committing', jobId: id });
  const job = await h.finish(id);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
  expect((await h.cancel(id)).json().status).toBe('succeeded');
  expect((await h.commit(view.id, 2, false, key, tag)).json().newVersionId).toBe(job.newVersionId);
  expect((await h.get()).json().latestCommit).toMatchObject({ reviewId: view.id, newVersionId: job.newVersionId, included: 0 });
  expect(h.store.get(h.workspace.id).versionIds).toEqual([h.snapshot.versionId, job.newVersionId]);
  expect(h.store.listRecords('operation:')).toEqual([]); expect(h.store.listRecords('reserve:')).toEqual([]);
});

it.each([false, true])('restores the sealed draft after cancellation only before its deadline (expired=%s)', async expired => {
  const h = await reviewHarness({ controlled: true }), view = await h.ready();
  const edited = (await h.edit(view.id, 1, [{ op: 'omitAll' }])).json().summary;
  const started = await h.commit(view.id, edited.revision);
  if (expired) h.advance(900_001);
  expect((await h.cancel(started.json().jobId)).json().status).toBe('cancelled');
  expect((await h.get('/' + view.id)).json().state).toBe(expired ? 'expired' : 'ready');
  if (!expired) expect((await h.get()).json().active.counts).toEqual(edited.counts);
  expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
  expect(h.store.listRecords('reserve:')).toEqual([]);
});

it('cancels preparation, invalidates ready drafts on replacement and frees every job and review on close', async () => {
  const h = await reviewHarness({ controlled: true });
  const accepted = await h.prepare(), id = accepted.json().jobId;
  expect(accepted.statusCode, accepted.body).toBe(202);
  await h.cancel(id);
  expect((await h.get()).json().active).toBeNull();
  const view = await h.ready();
  const replaced = await h.app.inject({ method: 'PUT', url: h.base + '/directions', headers: { ...h.headers, 'if-match': h.etag() }, payload: { directions: [] } });
  expect(replaced.statusCode).toBe(200);
  expect((await h.get('/' + view.id)).json().state).toBe('obsolete');
  const next = await h.prepare(randomUUID(), h.etag(), h.validate());
  expect(next.statusCode).toBe(202);
  const closed = await h.app.inject({ method: 'DELETE', url: h.base, headers: { ...h.headers, 'if-match': h.etag() } });
  expect(closed.statusCode, closed.body).toBe(204);
  expect(h.store.listRecords('')).toEqual([]); expect(h.store.currentWorkspaceId).toBeUndefined();
  expect(h.scheduled.at(-1)!.worker.terminated).toBe(true);
});

it('aborts the entire worker when the global expansion budget is exhausted', async () => {
  const h = await reviewHarness({ directionReviewLimits: { instances: 0 } });
  const accepted = await h.prepare(); expect(accepted.statusCode).toBe(202);
  const job = await h.finish(accepted.json().jobId);
  expect(job).toMatchObject({ status: 'failed', diagnostics: [{ code: 'RESOURCE_LIMIT' }] });
  expect((await h.get()).json().active).toBeNull(); expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
});

it('rejects pressure on admission and PATCH without publishing or changing the revision', async () => {
  const capacity = 2 * 1024 * 1024;
  const h = await reviewHarness({ store: new WorkspaceStore({ maxBytes: capacity }), controlled: true });
  function fill() {
    h.store.putInternalRecord('test-pressure', '');
    h.store.putInternalRecord('test-pressure', 'x'.repeat(capacity - h.store.bytes));
  }
  fill();
  expect((await h.prepare()).json().error.code).toBe('SESSION_LIMIT');
  expect(h.store.get(h.workspace.id).activeJobId).toBeUndefined();
  h.store.deleteInternalRecord('test-pressure');
  const view = await h.ready(); fill();
  const tooLarge = await h.edit(view.id, 1, [{ op: 'omitAll' }]);
  expect(tooLarge.json().error.code).toBe('SESSION_LIMIT');
  h.store.deleteInternalRecord('test-pressure');
  expect((await h.get('/' + view.id)).json()).toMatchObject({ revision: 1, counts: view.counts });
  expect((await h.edit(view.id, 1, [{ op: 'omitAll' }])).json().appliedRevision).toBe(2);
});

it('retains the previous version and no receipt if the new snapshot exceeds the publication quota', async () => {
  const h = await reviewHarness({ store: new WorkspaceStore({ maxSnapshots: 1 }), controlled: true });
  const view = await h.ready();
  await h.edit(view.id, 1, [{ op: 'omitAll' }]);
  const res = await h.commit(view.id, 2);
  if (res.statusCode === 202) {
    expect(await h.finish(res.json().jobId)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'SESSION_LIMIT' }] });
  } else expect(res.json().error.code).toBe('SESSION_LIMIT');
  expect((await h.get()).json()).toMatchObject({ active: { state: 'ready', revision: 2 } });
  expect((await h.get()).json().latestCommit).toBeUndefined();
  expect(h.store.get(h.workspace.id).versionIds).toEqual([h.snapshot.versionId]);
  expect(h.store.listRecords('reserve:')).toEqual([]);
});
