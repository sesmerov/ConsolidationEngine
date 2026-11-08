import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { registerJobRoute } from '../../apps/api/src/routes/jobs.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import type { RecalculationReservationDTO } from '@ce/contracts';
import { content, controlledFactory, nextTurn } from '../helpers/foundation.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup(maxBytes?: number) {
  const controlled = controlledFactory();
  const app = await createApp({ mode: 'development', workerFactory: controlled.factory, ...(maxBytes ? { store: new WorkspaceStore({ maxBytes }) } : {}) }); apps.push(app);
  for (const suffix of ['receipt-probe', 'other-probe']) registerJobRoute(app, {
    path: `/workspaces/:workspaceId/${suffix}`, kind: 'import',
    bodySchema: { type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' } } },
    prepare: request => ({ input: request.body as { label: string } }),
  });
  const reservation: RecalculationReservationDTO = { kind: 'recalculation', inputVersionId: randomUUID(), effectiveVersionId: randomUUID(), reservedPreviewId: randomUUID() };
  let reusableId: string | undefined;
  registerJobRoute(app, { path: '/workspaces/:workspaceId/reserved-probe', kind: 'import',
    bodySchema: { type: 'object', additionalProperties: false, properties: {} },
    prepare: () => ({ input: {} }), reuse: () => reusableId,
    accept: ({ jobId }) => { reusableId = jobId; return { reservation, resultRef: { type: 'unpublished', id: 'never-show-before-success' } }; },
    respond: (job, receipt) => ({ operationId: receipt.operationId, jobId: job.jobId, ...receipt.reservation }),
  });
  let failResponse = true;
  registerJobRoute(app, { path: '/workspaces/:workspaceId/response-failure-probe', kind: 'import',
    bodySchema: { type: 'object', additionalProperties: false, properties: {} }, prepare: () => ({ input: {} }),
    respond: job => { if (failResponse) { failResponse = false; throw new Error('controlled response failure'); } return job; },
  });
  const baseHeaders = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:4200' };
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers: baseHeaders });
  const headers = { ...baseHeaders, 'x-ce-session': bootstrap.json().sessionToken as string };
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Receipts' } })).json();
  const key = randomUUID(), jobHeaders = { ...headers, 'idempotency-key': key, 'if-match': '"empty"' };
  const url = `/api/v1/workspaces/${workspace.id}/receipt-probe`;
  const start = (extra: Record<string, string> = {}, label = 'private business input', target = url) => app.inject({ method: 'POST', url: target, headers: { ...jobHeaders, ...extra }, payload: { label } });
  return { app, controlled, headers, baseHeaders, workspace, key, jobHeaders, url, start, reservation };
}

describe('recoverable operation receipts', () => {
  it('recovers a lost acceptance by key and operation ID, withholding unpublished results', async () => {
    const h = await setup(), accepted = await h.start(); expect(accepted.statusCode).toBe(202); await nextTurn();
    const id = accepted.json().jobId;
    const receipt = await h.app.inject({ url: `/api/v1/operation-receipts/${h.key}`, headers: h.headers });
    expect(receipt.statusCode).toBe(200);
    expect(receipt.json()).toEqual({ operationId: id, workspaceId: h.workspace.id, jobId: id, responseStatus: 202, phase: 'running' });
    const operation = await h.app.inject({ url: `/api/v1/operations/${id}`, headers: h.headers });
    expect(operation.json()).toEqual(receipt.json());
    for (const secret of ['private business input', h.key, h.headers['x-ce-session'], 'fingerprint', 'bodyHash']) expect(receipt.body).not.toContain(secret);
    h.controlled.workers[0]!.complete({ snapshotContent: content(), resultRef: { type: 'probe', id: 'published' } });
    const complete = await h.app.inject({ url: `/api/v1/operations/${id}`, headers: h.headers });
    expect(complete.json()).toMatchObject({ phase: 'succeeded', resultRef: { type: 'probe', id: 'published' }, newVersionId: h.app.ce.store.get(h.workspace.id).currentVersionId });
    expect((await h.start()).json().jobId).toBe(id);
    expect(h.controlled.workers).toHaveLength(1);
  });

  it('rejects changed body, path or expected base for the same key without starting another worker', async () => {
    const h = await setup(); await h.start(); await nextTurn();
    h.controlled.workers[0]!.complete({ snapshotContent: content() });
    for (const response of [
      await h.start({}, 'different'),
      await h.start({}, 'private business input', `/api/v1/workspaces/${h.workspace.id}/other-probe`),
      await h.start({ 'if-match': h.app.ce.store.etag(h.workspace.id) }),
    ]) { expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('IDEMPOTENCY_CONFLICT'); }
    expect(h.controlled.workers).toHaveLength(1);
  });

  it('authorizes both recovery routes, treats foreign/missing references alike, and revokes on close', async () => {
    const h = await setup(), other = await setup(), accepted = await h.start(); await nextTurn();
    const id = accepted.json().jobId;
    for (const url of [`/api/v1/operations/${id}`, `/api/v1/operation-receipts/${h.key}`]) {
      expect((await h.app.inject({ url, headers: h.baseHeaders })).statusCode).toBe(403);
      expect((await other.app.inject({ url, headers: other.headers })).statusCode).toBe(404);
    }
    expect((await h.app.inject({ url: `/api/v1/operations/${randomUUID()}`, headers: h.headers })).statusCode).toBe(404);
    expect((await h.app.inject({ url: '/api/v1/operation-receipts/not-a-key', headers: h.headers })).statusCode).toBe(400);
    await h.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${h.workspace.id}`, headers: { ...h.headers, 'if-match': '"empty"' } });
    expect((await h.app.inject({ url: `/api/v1/operations/${id}`, headers: h.headers })).statusCode).toBe(404);
    expect((await h.app.inject({ url: `/api/v1/operation-receipts/${h.key}`, headers: h.headers })).statusCode).toBe(404);
  });

  it('recovers reserved identities without claiming publication and reuses equivalent accepted work', async () => {
    const h = await setup(), url = `/api/v1/workspaces/${h.workspace.id}/reserved-probe`;
    const first = await h.app.inject({ method: 'POST', url, headers: h.jobHeaders, payload: {} }); await nextTurn();
    expect(first.statusCode).toBe(202); expect(first.json()).toMatchObject(h.reservation);
    const before = await h.app.inject({ url: `/api/v1/operations/${first.json().operationId}`, headers: h.headers });
    expect(before.json().reservation).toEqual(h.reservation);
    expect(before.json()).not.toHaveProperty('resultRef'); expect(before.json()).not.toHaveProperty('newVersionId');
    const anotherKey = randomUUID();
    const reuse = await h.app.inject({ method: 'POST', url, headers: { ...h.jobHeaders, 'idempotency-key': anotherKey }, payload: {} });
    expect(reuse.json()).toEqual(first.json()); expect(h.controlled.workers).toHaveLength(1);
    expect((await h.app.inject({ url: `/api/v1/operation-receipts/${anotherKey}`, headers: h.headers })).json().reservation).toEqual(h.reservation);
    expect(h.app.ce.store.get(h.workspace.id).versionIds).toEqual([]);
  });

  it('rolls back both receipt indexes when job registration exceeds the retained quota', async () => {
    const h = await setup(5000), before = h.app.ce.store.bytes;
    const failed = await h.start();
    expect(failed.statusCode).toBe(413); expect(failed.json().error.code).toBe('SESSION_LIMIT');
    expect(h.controlled.workers).toHaveLength(0);
    for (const prefix of ['idempotency:', 'operation-receipt:', 'job:', 'reserve:']) expect(h.app.ce.store.listRecords(prefix)).toEqual([]);
    expect(h.app.ce.store.bytes).toBe(before);
    expect((await h.app.inject({ url: `/api/v1/operation-receipts/${h.key}`, headers: h.headers })).statusCode).toBe(404);
  });

  it('retains the acceptance receipt when response projection fails after the job was registered', async () => {
    const h = await setup(), url = `/api/v1/workspaces/${h.workspace.id}/response-failure-probe`;
    const failedResponse = await h.app.inject({ method: 'POST', url, headers: h.jobHeaders, payload: {} }); await nextTurn();
    expect(failedResponse.statusCode).toBe(500);
    const recovered = await h.app.inject({ url: `/api/v1/operation-receipts/${h.key}`, headers: h.headers });
    expect(recovered.statusCode).toBe(200); expect(recovered.json().phase).toBe('running');
    const retry = await h.app.inject({ method: 'POST', url, headers: h.jobHeaders, payload: {} });
    expect(retry.statusCode).toBe(202); expect(retry.json().jobId).toBe(recovered.json().jobId);
    expect(h.controlled.workers).toHaveLength(1);
  });
});
