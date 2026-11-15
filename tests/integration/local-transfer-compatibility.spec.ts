import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalExportTransfers } from '../../apps/api/src/local/local-export-transfers.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { SessionFiles } from '../../apps/api/src/storage/session-files.js';
import { JobManager } from '../../apps/api/src/jobs/job-manager.js';
import { downloadIntentKey, isCompleteTransferManifest, type JobDTO, type JsonValue } from '@ce/contracts';
import { exportKey } from '../../apps/api/src/workers/export.worker.js';
import { zipBytes } from '../helpers/xlsx-fixtures.js';
import { readFile } from 'node:fs/promises';
import { LocalUploadBatches } from '../../apps/api/src/local/local-upload-batches.js';
import { execute as sealLocally } from '../../apps/api/src/workers/local-seal-upload.worker.js';
import { createApp } from '../../apps/api/src/app.js';

describe('local and hosted-compatible download manifest protocol', () => {
  const owned: SessionFiles[] = []; afterEach(async () => { for (const files of owned.splice(0)) await files.close(); });
  it('reassembles the same retained ZIP from ordered parts and rejects a foreign session', async () => {
    const store = new WorkspaceStore(), workspace = store.create('SYNTHETIC'), files = await SessionFiles.create(store.sessionId); owned.push(files); await files.createWorkspace(workspace.id);
    const bytes = zipBytes([{ name: 'synthetic.txt', data: Buffer.alloc(4 * 1024 * 1024, 29) }]), written = await files.write(workspace.id, bytes), id = randomUUID(), jobId = randomUUID(), now = new Date().toISOString(), intent = { workspaceId: workspace.id, versionId: randomUUID(), kind: 'report' as const };
    // Authority record fixture: real local export jobs are covered in results-export/apply-export; this exercises transfer parity only.
    const job: JobDTO = { jobId, workspaceId: workspace.id, kind: 'export', status: 'succeeded', startedAt: now, endedAt: now, progress: { completed: 1, total: 1, complete: true }, diagnostics: [], pollAfterMs: 1000 };
    store.registerJob({ ...job, status: 'queued' }); store.updateJob(job);
    store.putRecords([{ key: exportKey(workspace.id, id), value: { id, jobId, workspaceId: workspace.id, versionId: intent.versionId, fileId: written.id, size: written.size, sha256: written.sha256, filename: 'report.zip', mimeType: 'application/zip', intent, intentFingerprint: createHash('sha256').update(downloadIntentKey(intent)).digest('hex') } }]);
    const service = new LocalExportTransfers(store, files, new JobManager(store)), owner = { sessionId: store.sessionId, workspaceId: workspace.id }, manifest = await service.manifest(owner, id);
    expect(isCompleteTransferManifest(manifest)).toBe(true); expect(manifest.parts).toHaveLength(2); expect(manifest.intent).toEqual(intent);
    const parts: Uint8Array[] = []; for (const part of manifest.parts) parts.push(await service.part(owner, id, part.index)); expect(Buffer.concat(parts).equals(bytes)).toBe(true); expect(await service.manifest(owner, id)).toEqual(manifest);
    await expect(service.part({ ...owner, sessionId: randomUUID() }, id, 0)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('uses the same reserved upload/part/seal contract locally for real FINREP input', async () => {
    const store = new WorkspaceStore(), workspace = store.create('SYNTHETIC'), files = await SessionFiles.create(store.sessionId); owned.push(files); await files.createWorkspace(workspace.id);
    const service = new LocalUploadBatches(store, files), owner = { sessionId: store.sessionId, workspaceId: workspace.id }, inputs = await Promise.all(['catalog','report'].map(async role => ({ role: role as 'catalog'|'report', bytes: await readFile(`tests/fixtures/generated/demo-finrep-${role}.xlsx`) })));
    const declaration = { baseVersionId: null, files: inputs.map(file => ({ clientFileId: file.role, role: file.role, name: file.role + '.xlsx', byteLength: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') })) }, key = randomUUID(), etag = store.etag(workspace.id);
    const batch = await service.create(owner, declaration, etag, key); expect(await service.create(owner, declaration, etag, key)).toEqual(batch);
    expect(files.usage(workspace.id).reservedBytes).toBe(inputs.reduce((sum, file) => sum + file.bytes.length, 0));
    for (const input of inputs) { const file = batch.files.find(file => file.role === input.role)!; const part = await service.putPart(owner, batch.id, file.id, 0, input.bytes, file.sha256); expect(await service.putPart(owner, batch.id, file.id, 0, input.bytes, file.sha256)).toEqual(part); }
    await expect(service.get({ ...owner, sessionId: randomUUID() }, batch.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    const jobId = randomUUID(), acceptance = await service.prepareSeal(owner, batch.id, jobId), now = new Date().toISOString();
    const job: JobDTO = { jobId, workspaceId: workspace.id, kind: 'seal-upload', status: 'running', startedAt: now, deadline: new Date(Date.now() + 60_000).toISOString(), progress: { completed: 0, total: 2, complete: false }, diagnostics: [], pollAfterMs: 1000 };
    store.registerJob({ ...job, status: 'queued' }, acceptance.initialRecords); store.updateJob(job);
    const output = await sealLocally(acceptance.input!, { job, cancelled: () => false, progress: () => {} }), publication = await acceptance.preparePublication!(job, output);
    store.publishJobResult(job, publication.output, () => publication.assertCommit?.()); await acceptance.finalize?.();
    expect((await service.get(owner, batch.id)).state).toBe('sealed'); expect(files.usage(workspace.id).reservedBytes).toBe(0);
    const staged = await service.stageForInspection(owner, batch.id, { source: 'workbook' }); expect(staged.files).toHaveLength(2);
    for (const file of staged.files) expect(createHash('sha256').update(await readFile(file.path)).digest('hex')).toBe(file.sha256);
    await service.cancel(owner, batch.id); expect((await service.get(owner, batch.id)).state).toBe('retained');
  });
  it('runs the shared HTTP protocol with real isolated seal/inspect/import workers and compact inspection pages', async () => {
    const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: {
      'seal-upload': new URL('../../apps/api/dist/workers/local-seal-upload.worker.js', import.meta.url), 'inspect-import': new URL('../../apps/api/dist/workers/inspect-import.worker.js', import.meta.url), import: new URL('../../apps/api/dist/workers/import.worker.js', import.meta.url),
    } });
    try {
      const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:3000' } }), headers = { host: '127.0.0.1:3000', 'x-ce-session': bootstrap.json().sessionToken as string };
      const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'SYNTHETIC' } })).json() as { id: string }, prefix = `/api/v1/workspaces/${workspace.id}`, etag = app.ce.store.etag(workspace.id);
      const inputs = await Promise.all(['catalog','report'].map(async role => ({ role: role as 'catalog'|'report', bytes: await readFile(`tests/fixtures/generated/demo-finrep-${role}.xlsx`) })));
      const creation = await app.inject({ method: 'POST', url: prefix + '/upload-batches', headers: { ...headers, 'if-match': etag, 'idempotency-key': randomUUID() }, payload: { baseVersionId: null, files: inputs.map(file => ({ clientFileId: file.role, role: file.role, name: file.role + '.xlsx', byteLength: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex') })) } }); expect(creation.statusCode, creation.body).toBe(201);
      const batch = creation.json() as { id: string; files: { id: string; role: string; sha256: string }[] };
      for (const input of inputs) { const file = batch.files.find(file => file.role === input.role)!; const part = await app.inject({ method: 'POST', url: `${prefix}/upload-batches/${batch.id}/files/${file.id}/parts/0`, headers: { ...headers, 'content-type': 'application/octet-stream', 'x-ce-part-sha256': file.sha256 }, payload: input.bytes }); expect(part.statusCode, part.body).toBe(200); }
      const finish = async (jobId: string): Promise<JobDTO> => { for (let i = 0; i < 3000; i++) { const job = (await app.inject({ url: `${prefix}/jobs/${jobId}`, headers })).json<JobDTO>(); if (['succeeded','failed','cancelled','timed_out'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Worker did not finish'); };
      const start = async (url: string, body: object, key = randomUUID()) => { const response = await app.inject({ method: 'POST', url, headers: { ...headers, 'if-match': etag, 'idempotency-key': key }, payload: body }); expect(response.statusCode, response.body).toBe(202); const job = await finish(response.json().jobId); expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return job; };
      await start(`${prefix}/upload-batches/${batch.id}/seal`, { baseVersionId: null }); const inspectionKey = randomUUID(), inspectBody = { uploadBatchId: batch.id, context: { source: 'workbook' } };
      const inspected = await start(prefix + '/import-inspections', inspectBody, inspectionKey), inspectionId = inspected.resultRef!.id;
      const summaryResponse = await app.inject({ url: `${prefix}/import-inspections/${inspectionId}?compact=true`, headers }); expect(summaryResponse.statusCode, summaryResponse.body).toBe(200); const summary = summaryResponse.json(); expect(summary.reportCount).toBe(1); expect(summary.reports).toBeUndefined();
      const reports = await app.inject({ url: `${prefix}/import-inspections/${inspectionId}/items?section=reports&limit=50`, headers }); expect(reports.statusCode, reports.body).toBe(200); expect(reports.json().items[0].profileId).toBe('eba-finrep-4.0-f0101-v1'); expect(reports.json()).not.toHaveProperty('versionId');
      const imported = await start(`${prefix}/import-inspections/${inspectionId}/commit`, { inspectionHash: summary.inspectionHash, acceptedExcludedSheets: true }); expect(imported.newVersionId).toBe(app.ce.store.current(workspace.id)?.versionId);
      // The replay precedes stale base/file lookups after commitment has released the catalog's local file.
      const replay = await start(prefix + '/import-inspections', inspectBody, inspectionKey); expect(replay.jobId).toBe(inspected.jobId);
    } finally { await app.close(); }
  }, 60_000);
});
