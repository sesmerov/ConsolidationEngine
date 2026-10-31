import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, type AppOptions } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { ApiError } from '../../apps/api/src/errors.js';
import { publicDiagnostic } from '../../apps/api/src/public-diagnostic.js';
import { execute, type ExportInput } from '../../apps/api/src/workers/export.worker.js';
import type { OperationContext, WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { ControlledWorker, nextTurn } from '../helpers/foundation.js';
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });
function transport() {
  const workers: ControlledWorker[] = [], requests: WorkerRequest[] = [];
  return { workers, requests, factory(request: WorkerRequest) { requests.push(structuredClone(request)); const worker = new ControlledWorker(); workers.push(worker); return worker; },
    async finish() { const request = requests[0]!; const output = await execute(request.input, { job: request.job, cancelled: () => false, progress: () => {} }); workers[0]!.complete(structuredClone(output)); await nextTurn(); } };
}
async function setup(options: AppOptions = {}) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { export: new URL('../../apps/api/dist/workers/export.worker.js', import.meta.url) }, ...options }); apps.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:3000' } })).json().sessionToken };
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Export lifecycle SYNTHETIC' } })).json();
  const files = await Promise.all((['eba-subset.xlsx', 'report-42.xlsx'] as const).map(async (name, index) => { const location = path.resolve('tests/fixtures/generated', name), bytes = await readFile(location); return { path: location, id: randomUUID(), kind: index === 0 ? 'catalog' as const : 'report' as const, displayName: name, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: '2026-10-31T00:00:00.000Z' }; }));
  const content = await importWorkspace(files, { cancelled: () => false, progress: () => {} } as unknown as OperationContext), snapshot = app.ce.store.publish(workspace.id, undefined, content);
  const etag = app.ce.store.etag(workspace.id), key = randomUUID();
  const start = (requestKey = key, match = etag) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': match, 'idempotency-key': requestKey }, payload: { versionId: snapshot.versionId, kind: 'report' } });
  const poll = async (jobId: string) => { for (let index = 0; index < 300; index++) { const response = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers }); const job = response.json(); if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Export did not settle'); };
  const clean = async () => { expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.listRecords('export:')).toEqual([]); expect(app.ce.files.usage(workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 }); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]); };
  return { app, headers, workspace, snapshot, files, start, poll, clean };
}
describe('report export publication and owned-file lifecycle', () => {
  it('projects historical data without AST/runs, reserves N+3 files and retains only one downloadable ZIP with replay', async () => {
    const control = transport(), fixture = await setup({ workerFactory: control.factory }); const { app, workspace, start, snapshot, poll, headers } = fixture;
    const accepted = await start(); expect(accepted.statusCode).toBe(202); await nextTurn();
    const request = control.requests[0]!, input = request.input as unknown as ExportInput; expect(request.snapshot).toBeUndefined(); expect(input.kind).toBe('report');
    expect(JSON.stringify(input.data)).not.toMatch(/"(?:ast|catalog|analyses|validation|results)":/); expect(input.data.versionId).toBe(snapshot.versionId);
    if (input.kind !== 'report') throw new Error('Wrong export kind'); expect(input.paths.reports).toHaveLength(1); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toHaveLength(4);
    expect(app.ce.files.usage(workspace.id).reservedBytes).toBe(200 * 1024 * 1024); await control.finish(); const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded');
    const names = await readdir(app.ce.files.workspacePath(workspace.id)); expect(names).toEqual([input.fileId]); expect(app.ce.files.usage(workspace.id)).toMatchObject({ reservedBytes: 0 });
    const download = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/exports/${job.resultRef.id}`, headers }); expect(download.statusCode).toBe(200); expect(download.headers['content-disposition']).toBe('attachment; filename="report.zip"');
    expect(app.ce.files.usage(workspace.id).retainedBytes).toBe(download.rawPayload.length);
    app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'later' });
    const replay = await start(); expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(job.jobId); expect(control.requests).toHaveLength(1); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual(names);
    for (const file of fixture.files) expect(createHash('sha256').update(await readFile(file.path)).digest('hex')).toBe(file.sha256);
  });
  it('removes every staged file and reservation when a measured report limit fails inside a real worker', async () => {
    const fixture = await setup({ reportExportLimits: { maxReportBytes: 512 } }); const accepted = await fixture.start(); expect(accepted.statusCode).toBe(202);
    const job = await fixture.poll(accepted.json().jobId); expect(job.status).toBe('failed'); expect(job.diagnostics[0].code).toBe('EXPORT_LIMIT'); await fixture.clean();
  });
  it('cancels before publication without publishing a partial ZIP or retaining files', async () => {
    const control = transport(), fixture = await setup({ workerFactory: control.factory }); const accepted = await fixture.start(); expect(accepted.statusCode).toBe(202); await nextTurn();
    const response = await fixture.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${fixture.workspace.id}/jobs/${accepted.json().jobId}`, headers: fixture.headers }); expect(response.json().status).toBe('cancelled'); expect(control.workers[0]!.terminated).toBe(true); await fixture.clean();
  });
  it('releases allocated files when atomic job acceptance rejects quota', async () => {
    const fixture = await setup(); vi.spyOn(fixture.app.ce.store, 'registerJob').mockImplementation(() => { throw new ApiError('SESSION_LIMIT'); });
    const response = await fixture.start(); expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('SESSION_LIMIT'); expect(fixture.app.ce.store.listRecords('job:')).toEqual([]); expect(fixture.app.ce.store.listRecords('idempotency:')).toEqual([]); await fixture.clean();
  });
  it('rejects the accumulated disk reservation before accepting a job', async () => {
    const fixture = await setup({ fileLimitBytes: 100 * 1024 * 1024 }); const response = await fixture.start(); expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('SESSION_LIMIT'); expect(fixture.app.ce.store.listRecords('job:')).toEqual([]); await fixture.clean();
  });
  it('preserves allowlisted provenance failure diagnostics after 202 without exposing arbitrary worker text', async () => {
    const control = transport(), fixture = await setup({ workerFactory: control.factory }); const response = await fixture.start(); expect(response.statusCode).toBe(202); await nextTurn();
    control.workers[0]!.emit('message', { type: 'failure', diagnostic: { ...publicDiagnostic(new ApiError('EXPORT_NOT_AVAILABLE', { reason: 'INCOMPLETE_VERSION_HISTORY' })), stack: 'PRIVATE_STACK', path: 'C:\\private\\secret' } });
    const job = await fixture.poll(response.json().jobId); expect(job.status).toBe('failed'); expect(job.diagnostics[0]).toEqual({ code: 'EXPORT_NOT_AVAILABLE', message: 'El historial de versiones o aplicaciones está incompleto para esta exportación.' }); expect(JSON.stringify(job)).not.toMatch(/PRIVATE_STACK|secret/); await fixture.clean();
  });
});
