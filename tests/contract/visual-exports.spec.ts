import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JsonValue } from '@ce/contracts';
import { downloadIntentKey } from '@ce/contracts';
import { runValidation } from '@ce/engine';
import { createApp, type AppOptions } from '../../apps/api/src/app.js';
import { execute } from '../../apps/api/src/workers/export.worker.js';
import { publicDiagnostic } from '../../apps/api/src/public-diagnostic.js';
import type { WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { cleanupVisualExports, visualDemo, visualLegacy, visualDirectory, visualHash, reimportVisual, visualBusiness } from '../helpers/visual-export-harness.js';
import { ControlledWorker, nextTurn } from '../helpers/foundation.js';
import { readZipParts } from '../helpers/xlsx-fixtures.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); await cleanupVisualExports(); });
async function setup(options: AppOptions = {}) {
  const app = await createApp(options); apps.push(app); const host = '127.0.0.1:3000';
  const headers = { host, 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host } })).json().sessionToken as string };
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Visual export contract' } })).json();
  return { app, headers, workspace, base: `/api/v1/workspaces/${workspace.id}` };
}
it('describes the exact historical report profile without exposing facts, contexts or private metadata', async () => {
  const { app, headers, workspace, base } = await setup();
  const corep = await visualDemo('corep'), types = await visualDemo('types'), finrep = await visualDemo('finrep');
  const first = app.ce.store.publish(workspace.id, undefined, corep.snapshot.content);
  const second = app.ce.store.publish(workspace.id, first.versionId, types.snapshot.content);
  const third = app.ce.store.publish(workspace.id, second.versionId, finrep.snapshot.content);
  for (const [snapshot, profileId, selectedSheets] of [[first, 'eba-corep-of-4.0-ca1-v1', ['CA1']], [second, 'ce-demo-types-1', ['Datos']], [third, 'eba-finrep-4.0-f0101-v1', ['1.1']]] as const) {
    const response = await app.inject({ url: `${base}/versions/${snapshot.versionId}/export-summary`, headers });
    expect(response.statusCode, response.body).toBe(200);
    const summary = response.json(), source = snapshot.content.sources.find(source => source.kind === 'report')!;
    expect(Object.keys(summary).sort()).toEqual(['createdAt', 'intent', 'intentFingerprint', 'profileId', 'reports', 'versionId']);
    const intent = { workspaceId: workspace.id, versionId: snapshot.versionId, kind: 'report' as const };
    expect(summary.intent).toEqual(intent);
    expect(summary.intentFingerprint).toBe(createHash('sha256').update(downloadIntentKey(intent)).digest('hex'));
    expect(summary).toMatchObject({ versionId: snapshot.versionId, profileId: snapshot.content.profileId, createdAt: snapshot.createdAt,
      reports: [{ sourceFileId: source.id, displayName: source.displayName, profileId, contextCount: 1, contextOrigin: 'workbook', selectedSheets, excludedSheets: [], commonEntityId: snapshot.content.contexts[0]!.entityId, commonReferenceDate: snapshot.content.contexts[0]!.referenceDate }] });
    expect(Object.keys(summary.reports[0]).every(key => ['sourceFileId', 'displayName', 'profileId', 'contextCount', 'contextOrigin', 'selectedSheets', 'excludedSheets', 'commonEntityId', 'commonReferenceDate', 'scaleExponent', 'displayDecimals'].includes(key))).toBe(true);
    expect(response.body).not.toContain('mappingSha256'); expect(response.body).not.toContain('contextIds');
  }
  expect(app.ce.store.current(workspace.id)?.versionId).toBe(third.versionId);
});
function transport() {
  const requests: WorkerRequest[] = [], workers: ControlledWorker[] = [];
  return { requests, workers, factory(request: WorkerRequest) { requests.push(structuredClone(request)); const worker = new ControlledWorker(); workers.push(worker); return worker; },
    async finish(index = requests.length - 1) {
      const request = requests[index]!;
      try { workers[index]!.complete(await execute(request.input, { job: request.job, cancelled: () => false, progress: () => {} })); }
      catch (error) { workers[index]!.emit('message', { type: 'failure', diagnostic: publicDiagnostic(error) }); }
      await nextTurn();
    } };
}
it.each(['corep', 'types'] as const)('exports historical %s through HTTP and the actual writer, with exact metadata, replay and untouched originals', async kind => {
  const control = transport(), { app, headers, workspace, base } = await setup({ workerFactory: control.factory }), imported = await visualDemo(kind);
  const snapshot = app.ce.store.publish(workspace.id, undefined, imported.snapshot.content), bundle = runValidation(snapshot, { runId: randomUUID(), startedAt: snapshot.createdAt });
  app.ce.store.putRecords([{ key: `validation:${workspace.id}:${bundle.run.id}`, value: bundle as unknown as JsonValue }]);
  const newer = app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'newer' });
  const etag = app.ce.store.etag(workspace.id), key = randomUUID(), payload = { kind: 'report', versionId: snapshot.versionId };
  const start = (body: unknown, requestKey = key, match = etag) => app.inject({ method: 'POST', url: base + '/exports', headers: { ...headers, 'if-match': match, 'idempotency-key': requestKey }, payload: body });
  const accepted = await start(payload); expect(accepted.statusCode, accepted.body).toBe(202); await nextTurn();
  expect(control.requests[0]!.snapshot).toBeUndefined(); expect(control.requests[0]!.job.baseVersionId).toBe(newer.versionId);
  expect(JSON.stringify(control.requests[0]!.input)).not.toMatch(/"(?:ast|analyses|catalog)":/);
  await control.finish(); await vi.waitFor(() => expect(app.ce.store.job(workspace.id, accepted.json().jobId).status).toBe('succeeded'));
  const job = app.ce.store.job(workspace.id, accepted.json().jobId); await app.ce.jobs.settle(job.jobId);
  const download = await app.inject({ url: `${base}/exports/${job.resultRef!.id}`, headers }); expect(download.statusCode).toBe(200);
  const directory = await visualDirectory(), zipPath = path.join(directory, 'report.zip'); await writeFile(zipPath, download.rawPayload);
  const parts = await readZipParts(zipPath), log = JSON.parse(parts.find(part => part.name === 'changes.json')!.data.toString('utf8'));
  expect(log.versionId).toBe(snapshot.versionId); expect(log.reportSourceBindings).toEqual(snapshot.content.reportSourceBindings); expect(log.changes).toEqual([]);
  expect(JSON.stringify(log)).not.toMatch(/"(?:ast|analyses|path)":/);
  const report = parts.find(part => part.name.startsWith('reports/'))!, location = path.join(directory, 'report.xlsx'); await writeFile(location, report.data);
  const restored = await reimportVisual(imported.files[0]!, [location]); expect(visualBusiness(restored)).toEqual(visualBusiness(snapshot.content));
  expect(log.reports[0]).toMatchObject({ size: report.data.length, sha256: visualHash(report.data) });
  expect(await readdir(app.ce.files.workspacePath(workspace.id))).toHaveLength(1); expect(app.ce.files.usage(workspace.id)).toMatchObject({ reservedBytes: 0, retainedBytes: download.rawPayload.length });
  // A retry preserves the original request precondition; another ETag is a different fingerprint.
  expect((await start(payload, key, '"stale"')).statusCode).toBe(409);
  const replay = await start(payload, key, etag); expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(job.jobId); expect(control.requests).toHaveLength(1);
  const results = await start({ kind: 'results', versionId: snapshot.versionId, runId: bundle.run.id }, randomUUID()); expect(results.statusCode).toBe(202); await nextTurn(); await control.finish();
  await vi.waitFor(() => expect(app.ce.store.job(workspace.id, results.json().jobId).status).toBe('succeeded'));
  const resultsJob = app.ce.store.job(workspace.id, results.json().jobId), resultsDownload = await app.inject({ url: `${base}/exports/${resultsJob.resultRef!.id}`, headers });
  expect(resultsDownload.headers['content-disposition']).toContain('results.zip'); const resultsPath = path.join(directory, 'results.zip'); await writeFile(resultsPath, resultsDownload.rawPayload);
  const resultsParts = await readZipParts(resultsPath), data = JSON.parse(resultsParts.find(part => part.name === 'results.json')!.data.toString('utf8'));
  expect(data.results).toEqual(bundle.results); expect(data.reportSourceBindings).toEqual(snapshot.content.reportSourceBindings); expect(data.versionId).toBe(snapshot.versionId);
  expect(app.ce.store.current(workspace.id)).toBe(newer);
  for (const source of imported.files) expect(visualHash(await readFile(source.path))).toBe(source.sha256);
});
it('rejects client writer overrides and missing visual ownership without creating a job or file', async () => {
  const { app, headers, workspace, base } = await setup(), imported = await visualDemo('corep');
  const { reportSourceBindings: _bindings, ...withoutBindings } = imported.snapshot.content;
  const snapshot = app.ce.store.publish(workspace.id, undefined, withoutBindings), requestHeaders = { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() };
  const payload = { kind: 'report', versionId: snapshot.versionId };
  expect((await app.inject({ method: 'POST', url: base + '/exports', headers: requestHeaders, payload: { ...payload, profileId: 'ce-report-1' } })).statusCode).toBe(400);
  const response = await app.inject({ method: 'POST', url: base + '/exports', headers: requestHeaders, payload });
  expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('EXPORT_NOT_AVAILABLE');
  expect(app.ce.store.listRecords('job:')).toEqual([]); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]); expect(app.ce.files.usage(workspace.id).reservedBytes).toBe(0);
});
it('releases visual output and its lease when the actual writer exceeds measured size', async () => {
  const control = transport(), { app, headers, workspace, base } = await setup({ workerFactory: control.factory, reportExportLimits: { maxReportBytes: 512 } }), imported = await visualDemo('corep');
  const snapshot = app.ce.store.publish(workspace.id, undefined, imported.snapshot.content);
  const accepted = await app.inject({ method: 'POST', url: base + '/exports', headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { kind: 'report', versionId: snapshot.versionId } });
  expect(accepted.statusCode).toBe(202); await nextTurn(); await control.finish();
  await vi.waitFor(() => expect(app.ce.store.job(workspace.id, accepted.json().jobId).status).toBe('failed'));
  const job = app.ce.store.job(workspace.id, accepted.json().jobId); await app.ce.jobs.settle(job.jobId); expect(job.diagnostics[0]!.code).toBe('EXPORT_LIMIT');
  expect(app.ce.store.listRecords('export:')).toEqual([]); expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]);
  expect(app.ce.files.usage(workspace.id)).toMatchObject({ reservedBytes: 0, retainedBytes: 0 }); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
});
it('requires a token and current ETag and cancels a visual export without publishing or retaining files', async () => {
  const control = transport(), { app, headers, workspace, base } = await setup({ workerFactory: control.factory }), imported = await visualDemo('types');
  const snapshot = app.ce.store.publish(workspace.id, undefined, imported.snapshot.content), payload = { kind: 'report', versionId: snapshot.versionId };
  const requestHeaders = { ...headers, 'idempotency-key': randomUUID() }, url = base + '/exports';
  expect((await app.inject({ method: 'POST', url, headers: { host: headers.host, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload })).statusCode).toBe(403);
  expect((await app.inject({ method: 'POST', url, headers: requestHeaders, payload })).statusCode).toBe(428);
  expect((await app.inject({ method: 'POST', url, headers: { ...requestHeaders, 'if-match': '"stale"' }, payload })).statusCode).toBe(412);
  expect(control.requests).toEqual([]);
  const accepted = await app.inject({ method: 'POST', url, headers: { ...requestHeaders, 'if-match': app.ce.store.etag(workspace.id) }, payload }); expect(accepted.statusCode).toBe(202); await nextTurn();
  const cancelled = await app.inject({ method: 'DELETE', url: `${base}/jobs/${accepted.json().jobId}`, headers }); expect(cancelled.json().status).toBe('cancelled');
  expect(control.workers[0]!.terminated).toBe(true); expect(app.ce.store.listRecords('export:')).toEqual([]);
  expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]); expect(app.ce.files.usage(workspace.id)).toMatchObject({ reservedBytes: 0, retainedBytes: 0 }); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
});
it('exports genuinely incomplete typed validation with its exact partial results and diagnostic', async () => {
  const control = transport(), { app, headers, workspace, base } = await setup({ workerFactory: control.factory }), imported = await visualDemo('types');
  const snapshot = app.ce.store.publish(workspace.id, undefined, imported.snapshot.content); let cancelled = false;
  const bundle = runValidation(snapshot, { runId: randomUUID(), startedAt: snapshot.createdAt, cancelled: () => cancelled, progress: completed => { cancelled = completed >= 1; } });
  expect(bundle.run.status).toBe('incomplete'); expect(bundle.results.length).toBeGreaterThan(0); expect(bundle.results.length).toBeLessThan(8);
  app.ce.store.putRecords([{ key: `validation:${workspace.id}:${bundle.run.id}`, value: bundle as unknown as JsonValue }]);
  const accepted = await app.inject({ method: 'POST', url: base + '/exports', headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { kind: 'results', versionId: snapshot.versionId, runId: bundle.run.id } });
  expect(accepted.statusCode).toBe(202); await nextTurn(); await control.finish(); await vi.waitFor(() => expect(app.ce.store.job(workspace.id, accepted.json().jobId).status).toBe('succeeded'));
  const job = app.ce.store.job(workspace.id, accepted.json().jobId), response = await app.inject({ url: `${base}/exports/${job.resultRef!.id}`, headers });
  const location = path.join(await visualDirectory(), 'partial.zip'); await writeFile(location, response.rawPayload);
  const data = JSON.parse((await readZipParts(location)).find(part => part.name === 'results.json')!.data.toString('utf8'));
  expect(data.run).toEqual(bundle.run); expect(data.run.summary.complete).toBe(false); expect(data.results).toEqual(bundle.results); expect(data.run.diagnostics).toContainEqual(expect.objectContaining({ code: 'CANCELLED' }));
  expect(app.ce.store.current(workspace.id)).toBe(snapshot);
});
it('counts all legacy contexts and omits differing common values without sending or truncating a context list', async () => {
  const { app, headers, workspace, base } = await setup(), legacy = await visualLegacy();
  const template = legacy.snapshot.content.contexts[0]!;
  const contexts = Array.from({ length: 1001 }, (_, index) => ({ ...template, contextId: 'context_' + index, entityId: index === 1000 ? 'OTHER' : template.entityId }));
  const snapshot = app.ce.store.publish(workspace.id, undefined, { ...legacy.snapshot.content, contexts, coordinates: [], facts: [] });
  const response = await app.inject({ url: `${base}/versions/${snapshot.versionId}/export-summary`, headers });
  expect(response.statusCode, response.body).toBe(200);
  const report = response.json().reports[0];
  expect(report).toMatchObject({ profileId: 'ce-report-1', contextOrigin: 'workbook', contextCount: 1001, commonReferenceDate: template.referenceDate, selectedSheets: ['Instructions', 'Contexts', 'Coordinates', 'Facts'], excludedSheets: [] });
  expect(report).not.toHaveProperty('commonEntityId'); expect(report).not.toHaveProperty('contextIds'); expect(response.body.length).toBeLessThan(2000);
});
it('requires authentication and ownership and rejects query parameters on the summary', async () => {
  const { app, headers, workspace, base } = await setup(), imported = await visualDemo('types');
  const snapshot = app.ce.store.publish(workspace.id, undefined, imported.snapshot.content), url = `${base}/versions/${snapshot.versionId}/export-summary`;
  expect((await app.inject({ url, headers: { host: headers.host } })).statusCode).toBe(403);
  expect((await app.inject({ url: url + '?mapping=other', headers })).statusCode).toBe(400);
  expect((await app.inject({ url: `${base}/versions/${randomUUID()}/export-summary`, headers })).statusCode).toBe(404);
  expect((await app.inject({ url: `/api/v1/workspaces/${randomUUID()}/versions/${snapshot.versionId}/export-summary`, headers })).statusCode).toBe(404);
});
