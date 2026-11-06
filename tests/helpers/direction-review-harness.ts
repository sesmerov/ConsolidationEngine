import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, onTestFinished } from 'vitest';
import { isTerminalJob } from '@ce/contracts';
import type { JobDTO, JsonValue, SnapshotContent } from '@ce/contracts';
import { runValidation } from '@ce/engine';
import { createApp, type AppOptions } from '../../apps/api/src/app.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import type { WorkerOperation, WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { ControlledWorker } from './foundation.js';
import { visualDemo } from './visual-export-harness.js';

export async function reviewHarness(options: AppOptions & { controlled?: boolean; content?: SnapshotContent } = {}) {
  const { controlled, content, ...appOptions } = options;
  let now = Date.UTC(2026, 10, 6);
  const scheduled: { worker: ControlledWorker; request: WorkerRequest }[] = [];
  const workerModules = {
    'prepare-directions': new URL('../../apps/api/dist/workers/prepare-directions.worker.js', import.meta.url),
    'commit-directions': new URL('../../apps/api/dist/workers/commit-directions.worker.js', import.meta.url),
  };
  const app = await createApp({ directionReviewNow: () => now, workerModules,
    workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
    ...(controlled ? { workerFactory(request: WorkerRequest) {
      const worker = new ControlledWorker();
      scheduled.push({ worker, request }); return worker;
    } } : {}), ...appOptions });
  onTestFinished(() => app.close());
  const host = '127.0.0.1:3000';
  const boot = await app.inject({ url: '/api/v1/bootstrap', headers: { host } });
  const headers = { host, 'x-ce-session': boot.json().sessionToken as string };
  const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Revisión SYNTHETIC' } });
  expect(created.statusCode).toBe(201);
  const workspace = created.json() as { id: string };
  const snapshot = app.ce.store.publish(workspace.id, undefined, content ?? (await visualDemo('corep')).snapshot.content);
  function validate() {
    const base = app.ce.store.current(workspace.id)!;
    const bundle = runValidation(base, { runId: randomUUID(), startedAt: new Date(now).toISOString() });
    expect(bundle.run.status).toBe('completed');
    app.ce.store.putRecords([{ key: validationKey(workspace.id, bundle.run.id), value: bundle as unknown as JsonValue }]);
    return { runId: bundle.run.id, baseVersionId: base.versionId };
  }
  const input = validate();
  const base = '/api/v1/workspaces/' + workspace.id, url = base + '/direction-reviews';
  const etag = () => app.ce.store.etag(workspace.id);
  function mutation(method: 'POST' | 'PATCH' | 'DELETE', suffix: string, payload?: object, key?: string, match: string | null = etag()) {
    return app.inject({ method, url: url + suffix, headers: { ...headers,
      ...(match === null ? {} : { 'if-match': match }), ...(key ? { 'idempotency-key': key } : {}) }, ...(payload ? { payload } : {}) });
  }
  const get = (suffix = '') => app.inject({ url: url + suffix, headers });
  const prepare = (key = randomUUID(), match: string | null = etag(), body = input) => mutation('POST', '', body, key, match);
  const edit = (id: string, expectedRevision: number, operations: object[], mutationId = randomUUID()) =>
    mutation('PATCH', '/' + id, { expectedRevision, mutationId, operations });
  const commit = (id: string, expectedRevision: number, acceptPartial = false, key = randomUUID(), match: string | null = etag()) =>
    mutation('POST', '/' + id + '/commit', { expectedRevision, acceptPartial }, key, match);
  const cancel = (id: string) => app.inject({ method: 'DELETE', url: base + '/jobs/' + id, headers });
  async function poll(id: string): Promise<JobDTO> {
    let job: JobDTO;
    do {
      const response = await app.inject({ url: base + '/jobs/' + id, headers });
      expect(response.statusCode).toBe(200); job = response.json();
      if (!isTerminalJob(job.status)) await delay(10);
    } while (!isTerminalJob(job.status));
    return job;
  }
  async function finish(id: string) {
    const slot = scheduled.find(entry => entry.request.job.jobId === id);
    if (slot) {
      const { request } = slot;
      const operation: WorkerOperation = await import(request.moduleUrl!);
      const output = await operation.execute(request.input, { job: request.job, snapshot: request.snapshot, cancelled: () => false, progress: () => {} });
      slot.worker.emit('message', { type: 'result', output });
    }
    return poll(id);
  }
  async function ready() {
    const res = await prepare();
    expect(res.statusCode, res.body).toBe(202);
    const job = await finish(res.json().jobId);
    expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
    const detail = await get('/' + job.resultRef!.id);
    expect(detail.json()).toMatchObject({ state: 'ready', revision: 1 });
    return detail.json();
  }
  return { app, store: app.ce.store, input, headers, base, workspace, snapshot, scheduled, url, validate, get, prepare, mutation, edit,
    commit, cancel, etag, finish, ready, advance: (ms: number) => { now += ms; } };
}
