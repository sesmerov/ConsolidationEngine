import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../../apps/api/src/app.js';
import { resolveDirection, simulate } from '@ce/engine';
import type { JsonValue } from '@ce/contracts';
import { selectionSnapshot, validateIteration } from '../helpers/iteration004-fixtures.js';
import { ApiError } from '../../apps/api/src/errors.js';
import type { WorkerOperation } from '../../apps/api/src/workers/protocol.js';
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function setup(options: AppOptions = {}) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: {
    'select-proposals': new URL('../../apps/api/dist/workers/select-proposals.worker.js', import.meta.url), preview: new URL('../../apps/api/dist/workers/preview.worker.js', import.meta.url),
  }, ...options }); apps.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' }; headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const w = app.ce.store.create('selection synthetic'), input = selectionSnapshot(51), validation = validateIteration(input);
  const directions = validation.results.filter(r => r.instanceId).map(r => resolveDirection(input, { instanceId: r.instanceId!, variantIds: r.variantIds, binding: r.binding!, targetSide: 'left' }).resolved!.direction);
  const snapshot = app.ce.store.publish(w.id, undefined, { ...input.content, directions, directionDecisionState: { schemaVersion: 1, mode: 'reviewed', source: 'replace', originDefault: 'automatic', originExceptions: [], unselectedDefault: 'omitted', unselectedExceptions: [] } });
  const bundle = simulate(snapshot, { previewId: randomUUID() }); app.ce.store.putRecords([{ key: `preview:${w.id}:${bundle.preview.id}`, value: bundle as unknown as JsonValue }]);
  const base = `/api/v1/workspaces/${w.id}/previews/${bundle.preview.id}/selection-state`;
  const get = (suffix = '') => app.inject({ url: base + suffix, headers });
  const post = (suffix: string, payload: unknown, key = randomUUID(), etag = app.ce.store.etag(w.id)) => app.inject({ method: 'POST', url: base + suffix, headers: { ...headers, 'idempotency-key': key, 'if-match': etag }, payload });
  const poll = async (id: string) => { for (let n = 0; n < 500; n++) { const j = (await app.inject({ url: `/api/v1/workspaces/${w.id}/jobs/${id}`, headers })).json(); if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 10)); } throw Error('timeout'); };
  return { app, w, snapshot, bundle, headers, base, get, post, poll };
}
it('never initializes a historical preview from GET; explicit empty preparation and replay are atomic', async () => {
  const f = await setup(), bytes = f.app.ce.store.bytes;
  expect((await f.get()).statusCode).toBe(404); expect(f.app.ce.store.bytes).toBe(bytes);
  const key = randomUUID(), body = { baseVersionId: f.snapshot.versionId, seed: 'empty' }, accepted = await f.post('', body, key);
  expect(accepted.statusCode).toBe(202); const job = await f.poll(accepted.json().jobId); expect(job.status).toBe('succeeded');
  const summary = (await f.get()).json(); expect(summary).toMatchObject({ revision: 1, state: 'ready', selectedCount: 0, availableCount: 51 });
  expect((await f.post('', body, key)).json().jobId).toBe(job.jobId); expect((await f.get()).json()).toEqual(summary);
  expect((await f.post('', body)).statusCode).toBe(409);
});
it('persists edits across reads, rejects old revisions and cursors, and invalidates on a new base', async () => {
  const f = await setup(); const prep = await f.post('', { baseVersionId: f.snapshot.versionId, seed: 'empty' }); await f.poll(prep.json().jobId);
  const first = (await f.get()).json(), edit = { selectionId: first.id, expectedRevision: first.revision, operations: [{ op: 'selectMatching', filter: {} }] };
  const key = randomUUID(), accepted = await f.post('/edits', edit, key); expect(accepted.statusCode).toBe(202); expect((await f.poll(accepted.json().jobId)).status).toBe('succeeded');
  const second = (await f.get()).json(); expect(second).toMatchObject({ revision: 2, selectedCount: 51 });
  const page = (await f.get('/rows?limit=50')).json(); expect(page.items).toHaveLength(50); expect(page.total).toBe(51); expect(page.filterCounts.selectedOutsidePage).toBe(1);
  expect((await f.post('/edits', edit)).json().error.code).toBe('STALE_PROPOSAL_SELECTION');
  expect((await f.post('/edits', edit, key)).json().jobId).toBe(accepted.json().jobId);
  const clear = await f.post('/edits', { selectionId: second.id, expectedRevision: 2, operations: [{ op: 'clear' }] }); await f.poll(clear.json().jobId);
  expect((await f.get('/rows?limit=50&cursor=' + encodeURIComponent(page.nextCursor))).statusCode).toBe(400);
  expect((await f.get()).json().selectedCount).toBe(0);
  f.app.ce.store.publish(f.w.id, f.snapshot.versionId, f.snapshot.content);
  expect((await f.get()).json().state).toBe('obsolete');
});
it('cancellation of an unpublished preparation leaves no invented projection and allows an explicit retry', async () => {
  const f = await setup({ workerFactory: () => Object.assign(new EventEmitter(), { terminate: async () => 0 }) });
  const payload = { baseVersionId: f.snapshot.versionId, seed: 'empty' }, initial = await f.post('', payload);
  expect(initial.statusCode).toBe(202);
  expect((await f.get()).json()).toMatchObject({ revision: 0, state: 'preparing', pendingJobId: initial.json().jobId });
  expect((await f.get()).json()).not.toHaveProperty('selectedCount');
  const cancelled = await f.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${f.w.id}/jobs/${initial.json().jobId}`, headers: f.headers });
  expect(cancelled.json().status).toBe('cancelled');
  expect((await f.get()).json()).toMatchObject({ revision: 0, state: 'failed' });
  expect(f.app.ce.store.current(f.w.id)).toBe(f.snapshot);
  expect((await f.post('', payload)).statusCode).toBe(202);
});
it.each(['cancelled', 'timed_out'] as const)('restores the published revision after an edit is %s', async terminal => {
  let number = 0;
  const f = await setup({ ...(terminal === 'timed_out' ? { deadlineMs: 500 } : {}), workerFactory: request => {
    const worker = Object.assign(new EventEmitter(), { terminate: async () => 0 });
    if (++number === 1) queueMicrotask(() => { void (async () => {
      const operation: WorkerOperation = await import(request.moduleUrl!);
      const output = await operation.execute(request.input, { job: request.job, cancelled: () => false, progress: () => {} }); worker.emit('message', { type: 'result', output });
    })(); });
    return worker;
  } });
  const prep = await f.post('', { baseVersionId: f.snapshot.versionId, seed: 'empty' }); expect((await f.poll(prep.json().jobId)).status).toBe('succeeded');
  const before = (await f.get()).json(), request = await f.post('/edits', { selectionId: before.id, expectedRevision: before.revision, operations: [{ op: 'selectMatching', filter: {} }] }); expect(request.statusCode).toBe(202);
  expect((await f.get()).json()).toMatchObject({ state: 'updating', revision: 1, selectedCount: 0 });
  if (terminal === 'cancelled') await f.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${f.w.id}/jobs/${request.json().jobId}`, headers: f.headers });
  expect((await f.poll(request.json().jobId)).status).toBe(terminal); expect((await f.get()).json()).toEqual(before); expect(f.app.ce.store.current(f.w.id)).toBe(f.snapshot);
});
it('rejects unknown or duplicate IDs before a job and rolls back a candidate rejected by the state quota', async () => {
  const f = await setup(), prep = await f.post('', { baseVersionId: f.snapshot.versionId, seed: 'empty' }); await f.poll(prep.json().jobId);
  const before = (await f.get()).json(), payload = (operations: object[]) => ({ selectionId: before.id, expectedRevision: 1, operations });
  const unknown = await f.post('/edits', payload([{ op: 'set', proposalId: randomUUID(), selected: true }])); expect(unknown.statusCode).toBe(400);
  const id = f.bundle.proposals[0]!.id;
  expect((await f.post('/edits', payload([{ op: 'set', proposalId: id, selected: true }, { op: 'set', proposalId: id, selected: false }]))).statusCode).toBe(400);
  const quota = vi.spyOn(f.app.ce.store, 'assertTransientCapacity').mockImplementation(() => { throw new ApiError('SESSION_LIMIT'); });
  const edit = await f.post('/edits', payload([{ op: 'selectMatching', filter: {} }])); expect(edit.statusCode).toBe(202);
  const job = await f.poll(edit.json().jobId); quota.mockRestore(); expect(job.status).toBe('failed'); expect(job.diagnostics[0].code).toBe('SESSION_LIMIT');
  expect((await f.get()).json()).toEqual(before); expect(f.app.ce.store.current(f.w.id)).toBe(f.snapshot);
});
