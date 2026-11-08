import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { JsonValue } from '@ce/contracts';
import { runValidation } from '@ce/engine';
import { createApp } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { export: new URL('../../apps/api/dist/workers/export.worker.js', import.meta.url) } }); apps.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' }; headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Download intent SYNTHETIC' } })).json();
  const files = await Promise.all([['eba-subset.xlsx', 'catalog'], ['report-42.xlsx', 'report']].map(async ([name, kind]) => {
    const location = path.resolve('tests/fixtures/generated', name!), bytes = await readFile(location);
    return { path: location, id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), displayName: name!, kind: kind as 'catalog' | 'report', size: bytes.length, importedAt: '2026-10-31T00:00:00.000Z' };
  }));
  const content = await importWorkspace(files, { cancelled: () => false, progress: () => {} } as unknown as OperationContext);
  const original = app.ce.store.publish(workspace.id, undefined, content), runId = randomUUID();
  const bundle = runValidation(original, { runId, startedAt: '2026-10-31T00:00:00.000Z' });
  app.ce.store.putRecords([{ key: validationKey(workspace.id, runId), value: bundle as unknown as JsonValue }]);
  const current = app.ce.store.publish(workspace.id, original.versionId, { ...content, configVersion: 'configuration-only' }, [], 'configuration');
  const etag = app.ce.store.etag(workspace.id), intent = { workspaceId: workspace.id, versionId: original.versionId, kind: 'results', runId };
  const body = { versionId: original.versionId, kind: 'results', runId }, key = randomUUID();
  const start = (payload = body, idempotencyKey = key, match = etag) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': match, 'idempotency-key': idempotencyKey }, payload });
  const poll = async (id: string) => { for (let i = 0; i < 400; i++) { const job = (await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${id}`, headers })).json(); if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Export timeout'); };
  return { app, headers, workspace, original, current, body, intent, key, etag, start, poll };
}

it('binds summary, recovered receipt and real artifact to the exact historical intent', async () => {
  const { app, headers, workspace, original, intent, key, start, poll } = await setup();
  const summary = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/versions/${original.versionId}/export-summary?kind=results&runId=${intent.runId}`, headers });
  expect(summary.statusCode).toBe(200); expect(summary.json().intent).toEqual(intent); expect(summary.json().intentFingerprint).toMatch(/^[a-f0-9]{64}$/);
  const accepted = await start(); expect(accepted.statusCode).toBe(202); const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded');
  const receipt = (await app.inject({ url: `/api/v1/operation-receipts/${key}`, headers })).json();
  expect(receipt.reservation).toMatchObject({ kind: 'export', intent, intentFingerprint: summary.json().intentFingerprint, reservedExportId: job.resultRef.id });
  const artifact = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/exports/${job.resultRef.id}`, headers: { ...headers, accept: 'application/json' } });
  expect(artifact.statusCode).toBe(200); expect(artifact.json()).toMatchObject({ id: job.resultRef.id, intent, intentFingerprint: summary.json().intentFingerprint, filename: 'results.zip', status: 'ready' });
  const bytes = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/exports/${job.resultRef.id}`, headers: { ...headers, accept: 'application/zip' } });
  expect(bytes.statusCode).toBe(200); expect(bytes.rawPayload.byteLength).toBe(artifact.json().size); expect(createHash('sha256').update(bytes.rawPayload).digest('hex')).toBe(artifact.json().sha256);
  expect(artifact.json()).not.toHaveProperty('fileId'); expect(JSON.stringify(artifact.json())).not.toMatch(/\.cache|outputPath|sessionToken/);
});

it('rejects results of another version even when the validation basis is shared', async () => {
  const { app, workspace, original, current, body, start } = await setup(); expect(current.validationBasisId).toBe(original.validationBasisId);
  const mismatch = await start({ ...body, versionId: current.versionId }); expect(mismatch.statusCode).toBe(412); expect(app.ce.files.usage(workspace.id).reservedBytes).toBe(0);
});

it('recovers the same intent after a new current version and rejects changed kind or ETag under its key', async () => {
  const { app, headers, workspace, current, body, key, etag, start, poll } = await setup(); const accepted = await start(), job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded');
  app.ce.store.publish(workspace.id, current.versionId, { ...current.content, configVersion: 'later' }, [], 'configuration');
  expect((await start(body, key, etag)).json().resultRef).toEqual(job.resultRef);
  expect((await start(body, key, app.ce.store.etag(workspace.id))).statusCode).toBe(409);
  const changed = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': etag, 'idempotency-key': key }, payload: { kind: 'report', versionId: body.versionId } });
  expect(changed.statusCode).toBe(409);
});
