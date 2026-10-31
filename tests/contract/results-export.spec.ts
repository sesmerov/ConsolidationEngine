import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JsonValue } from '@ce/contracts';
import { runValidation } from '@ce/engine';
import { createApp } from '../../apps/api/src/app.js';
import type { AppOptions } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import type { OperationContext, WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { controlledFactory, nextTurn } from '../helpers/foundation.js';
const applications: Awaited<ReturnType<typeof createApp>>[] = [], directories: string[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map((app) => app.close())); for (const directory of directories.splice(0)) { if (!path.relative(path.resolve('.cache'), directory).startsWith('export-contract-')) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); } });
async function setup(options: AppOptions = {}) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { export: new URL('../../apps/api/dist/workers/export.worker.js', import.meta.url) }, ...options }); applications.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' }; headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Exportación SYNTHETIC' } })).json();
  const files = await Promise.all([['eba-subset.xlsx', 'catalog'], ['report-42.xlsx', 'report']].map(async ([name, kind]) => {
    const location = path.resolve('tests/fixtures/generated', name!), bytes = await readFile(location); return { path: location, id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), displayName: name!, kind: kind as 'catalog' | 'report', size: bytes.length, importedAt: '2026-10-31T00:00:00.000Z' }; }));
  const content = await importWorkspace(files, { cancelled: () => false, progress: () => {} } as unknown as OperationContext);
  const snapshot = app.ce.store.publish(workspace.id, undefined, content), runId = randomUUID(); const bundle = runValidation(snapshot, { runId, startedAt: '2026-10-31T00:00:00.000Z' });
  app.ce.store.putRecords([{ key: validationKey(workspace.id, runId), value: bundle as unknown as JsonValue }]);
  const body = { versionId: snapshot.versionId, runId, kind: 'results' }, etag = app.ce.store.etag(workspace.id);
  const start = (payload: unknown = body, key = randomUUID(), match = etag) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': match, 'idempotency-key': key }, payload });
  const poll = async (jobId: string) => { for (let i = 0; i < 400; i++) { const job = (await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers })).json(); if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Export did not finish'); };
  const download = (id: string) => app.inject({ url: `/api/v1/workspaces/${workspace.id}/exports/${id}`, headers });
  return { app, headers, workspace, snapshot, bundle, body, etag, start, poll, download };
}
it('downloads a real ZIP with exact JSON, literal XLSX and reconciled counts without changing the snapshot', async () => {
  const { app, workspace, snapshot, bundle, start, poll, download } = await setup(); const accepted = await start(); expect(accepted.statusCode).toBe(202);
  const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded'); const response = await download(job.resultRef.id);
  expect(response.statusCode).toBe(200); expect(response.headers['content-type']).toBe('application/zip'); expect(response.headers['content-disposition']).toBe('attachment; filename="results.zip"');
  const directory = await mkdtemp(path.resolve('.cache/export-contract-')); directories.push(directory); const location = path.join(directory, 'results.zip'); await writeFile(location, response.rawPayload);
  const entries = await readZipParts(location); expect(entries.map((entry) => entry.name)).toEqual(['results.json', 'results.xlsx']);
  const data = JSON.parse(entries[0]!.data.toString('utf8')); expect(data.run).toEqual(bundle.run); expect(data.results).toEqual(bundle.results); expect(data.synthetic).toBe(true);
  expect(data.results.find((row: { status: string }) => row.status === 'pass').factReads).toHaveLength(2); expect(entries[0]!.data.toString('utf8')).not.toMatch(/"ast"|ce-session-|"stack"/i);
  expect(app.ce.files.usage(workspace.id)).toMatchObject({ retainedBytes: response.rawPayload.byteLength, reservedBytes: 0 }); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toHaveLength(1);
  expect(app.ce.store.current(workspace.id)).toBe(snapshot);
});
it('exports a historical run using the current ETag and sends no current snapshot to the worker', async () => {
  const requests: WorkerRequest[] = []; const { app, workspace, snapshot, body, start, poll } = await setup({ workerFactory: (request) => {
    requests.push(request); const worker = new Worker(new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), { workerData: request, stdout: true, stderr: true }); worker.stdout.resume(); worker.stderr.resume(); return worker;
  } });
  const current = app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'new' });
  expect((await start()).statusCode).toBe(412); const accepted = await start(body, randomUUID(), app.ce.store.etag(workspace.id)); expect(accepted.statusCode).toBe(202); expect((await poll(accepted.json().jobId)).status).toBe('succeeded');
  expect(requests).toHaveLength(1); expect(requests[0]!.snapshot).toBeUndefined(); expect(requests[0]!.job.baseVersionId).toBe(current.versionId);
  expect((requests[0]!.input as { data: { versionId: string } }).data.versionId).toBe(snapshot.versionId);
});
it('replays the same artifact after a version change and rejects reuse with another body', async () => {
  const { app, workspace, snapshot, body, start, poll, download } = await setup(); const key = randomUUID(); const first = await start(body, key); const job = await poll(first.json().jobId); expect(job.status).toBe('succeeded');
  const before = app.ce.files.usage(workspace.id); app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'new' });
  const replay = await start(body, key); expect(replay.statusCode).toBe(202); expect(replay.json().resultRef).toEqual(job.resultRef); expect(app.ce.files.usage(workspace.id)).toEqual(before);
  expect((await start({ ...body, versionId: app.ce.store.current(workspace.id)!.versionId }, key)).statusCode).toBe(409); expect((await download(job.resultRef.id)).statusCode).toBe(200);
});
it('rejects per-content overflow before publishing an artifact or retaining a reservation', async () => {
  const { app, workspace, snapshot, start } = await setup({ exportLimits: { maxContentBytes: 512 } }); const response = await start();
  expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('EXPORT_LIMIT'); expect(app.ce.files.usage(workspace.id)).toMatchObject({ reservedBytes: 0, retainedBytes: 0 }); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
});
it('counts retained artifacts against the accumulated disk budget and keeps earlier downloads', async () => {
  const total = 1024 * 1024; const { app, workspace, start, poll, download } = await setup({ exportLimits: { maxContentBytes: 512 * 1024, maxTotalBytes: total }, fileLimitBytes: 2 * total + 1 });
  const first = await start(); expect(first.statusCode).toBe(202); const job = await poll(first.json().jobId); expect(job.status).toBe('succeeded');
  const second = await start(); expect(second.statusCode).toBe(413); expect(second.json().error.code).toBe('SESSION_LIMIT'); expect(app.ce.files.usage(workspace.id).reservedBytes).toBe(0);
  expect((await download(job.resultRef.id)).statusCode).toBe(200); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toHaveLength(1);
});
it('cleans all reserved files when an accepted export is cancelled before publication', async () => {
  const control = controlledFactory(); const { app, headers, workspace, snapshot, start } = await setup({ workerFactory: control.factory });
  const accepted = await start(); expect(accepted.statusCode).toBe(202); await nextTurn(); expect(app.ce.files.usage(workspace.id).reservedBytes).toBeGreaterThan(0);
  const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${accepted.json().jobId}`, headers }); expect(cancelled.json().status).toBe('cancelled');
  expect(app.ce.files.usage(workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 }); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
});
it('rejects a run/version mismatch and closed-body extensions without creating files', async () => {
  const { app, workspace, snapshot, body, start } = await setup(); const current = app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'new' });
  const mismatch = await start({ ...body, versionId: current.versionId }, randomUUID(), app.ce.store.etag(workspace.id)); expect(mismatch.statusCode).toBe(412);
  const injected = await start({ ...body, outputPath: 'outside.xlsx' }, randomUUID(), app.ce.store.etag(workspace.id)); expect(injected.statusCode).toBe(400); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]);
});
it('waits for an export preparation to close its files before removing the workspace', async () => {
  const { app, headers, workspace, etag, start } = await setup();
  const openFile = app.ce.files.openFile.bind(app.ce.files);
  let resume!: () => void; const paused = new Promise<void>((resolve) => { resume = resolve; });
  let entered!: () => void; const opened = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(app.ce.files, 'openFile').mockImplementationOnce(async (...args) => { const file = await openFile(...args); entered(); await paused; return file; });
  const remove = vi.spyOn(app.ce.files, 'removeWorkspace');
  const exporting = start().then((response) => response); await opened;
  const closing = app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers: { ...headers, 'if-match': etag } }).then((response) => response);
  try {
    await vi.waitFor(() => expect(() => app.ce.store.assertAccepting(workspace.id)).toThrow());
    expect(remove).not.toHaveBeenCalled();
  } finally { resume(); await Promise.all([exporting, closing]); }
  expect((await closing).statusCode).toBe(204); expect((await exporting).statusCode).toBe(409);
  expect((await exporting).json().error.code).toBe('WORKSPACE_BUSY');
  expect(await readdir(app.ce.files.directory)).toEqual(['.ce-session.json']);
});
it('waits for pending export preparation before server shutdown removes session files', async () => {
  const { app, workspace, start } = await setup(); const openFile = app.ce.files.openFile.bind(app.ce.files);
  let resume!: () => void; const paused = new Promise<void>((resolve) => { resume = resolve; });
  let entered!: () => void; const opened = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(app.ce.files, 'openFile').mockImplementationOnce(async (...args) => { const file = await openFile(...args); entered(); await paused; return file; });
  const remove = vi.spyOn(app.ce.files, 'close'); const exporting = start().then((response) => response); await opened;
  const closing = app.close();
  try {
    await vi.waitFor(() => expect(() => app.ce.store.assertAccepting(workspace.id)).toThrow());
    expect(remove).not.toHaveBeenCalled();
  } finally { resume(); await Promise.all([exporting, closing]); }
  expect((await exporting).statusCode).toBe(409); expect((await exporting).json().error.code).toBe('WORKSPACE_BUSY');
  expect(remove).toHaveBeenCalledOnce(); await expect(readdir(app.ce.files.directory)).rejects.toMatchObject({ code: 'ENOENT' });
});
