import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import type { AppOptions } from '../../apps/api/src/app.js';
import { createApp } from '../../apps/api/src/app.js';
import type { WorkerOutput, WorkerRequest, WorkerOperation } from '../../apps/api/src/workers/protocol.js';
import type { JobDTO, SnapshotContent } from '@ce/contracts';
import { expect } from 'vitest';

export const inspectionTick = () => new Promise<void>(resolve => setImmediate(resolve));
export class InspectionControlledWorker extends EventEmitter {
  terminated = false;
  async terminate() { this.terminated = true; this.emit('exit', 0); return 0; }
  complete(output: WorkerOutput) { this.emit('message', { type: 'result', output }); }
}
export interface InspectionView {
  id: string; baseVersionId?: string; state: string; createdAt: string; expiresAt: string;
  inspectionHash: string; requiresPartialCoverageAcceptance: boolean;
  commitJobId?: string; committedVersionId?: string;
}
export const lifecycleContext = { source: 'form', declaration: { entityId: 'SYNTHETIC_LIFECYCLE', referenceDate: '2025-12-31',
  submissionDate: '2025-12-31', currency: 'EUR', scaleExponent: 0, displayDecimals: 2, filingIndicators: { 'C_01.00': true } },
  reportProfiles:[{reportIndex:0,sha256:'f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7',profileId:'eba-corep-of-4.0-ca1-v1'}] };
const fixtures = Promise.all([
  readFile(new URL('../fixtures/generated/eba-subset.xlsx', import.meta.url)),
  readFile(new URL('../fixtures/eba/official-annexes-4.0.xlsx', import.meta.url)),
]);
export async function inspectionMultipart(context: unknown = lifecycleContext, boundary = 'inspection-' + randomUUID()) {
  const [catalog, report] = await fixtures, parts: Buffer[] = [];
  for (const [name, filename, bytes] of [['catalog', 'catalog.xlsx', catalog!], ['reports', 'corep.xlsx', report!]] as const) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), bytes, Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="context"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(context)}\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), contentType: 'multipart/form-data; boundary=' + boundary, fileBytes: catalog!.length + report!.length };
}
function emptyContent(): SnapshotContent {
  return { profileId: 'ce-dpmxl-0.9-closed-v1', catalogVersion: 'empty', reportVersion: 'PREVIOUS_SNAPSHOT_SENTINEL', configVersion: 'empty',
    contexts: [], coordinates: [], facts: [], directions: [], sources: [], catalog: { records: [], variants: [], analyses: [],
      coverage: { rows: 0, variants: 0, applicableVariants: 0, supportedVariants: 0, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } };
}
/** Real HTTP and real operation execute functions; only worker scheduling/errors are controlled. */
export async function inspectionHarness(options: AppOptions & { empty?: boolean; realWorker?: boolean } = {}) {
  let now = Date.UTC(2026, 10, 4), closed = false;
  const requests: WorkerRequest[] = [], workers: InspectionControlledWorker[] = [];
  const { empty = false, realWorker = false, ...appOptions } = options;
  const setupOptions: AppOptions & { inspectionNow: () => number } = { ...appOptions, inspectionNow: () => now,
    ...(realWorker ? { workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
      workerModules: { ...appOptions.workerModules, ['inspect-import' as 'import']: new URL('../../apps/api/dist/workers/inspect-import.worker.js', import.meta.url) } }
      : { workerFactory(request) { requests.push(structuredClone(request)); const worker = new InspectionControlledWorker(); workers.push(worker); return worker; } }) };
  const app = await createApp(setupOptions);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:3000' } })).json().sessionToken as string };
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Inspection lifecycle SYNTHETIC' } })).json() as { id: string };
  const base = empty ? undefined : app.ce.store.publish(workspace.id, undefined, emptyContent());
  const originalETag = app.ce.store.etag(workspace.id), originalVersions = [...app.ce.store.get(workspace.id).versionIds];
  const prefix = `/api/v1/workspaces/${workspace.id}/import-inspections`;
  const start = async (key = randomUUID(), match = app.ce.store.etag(workspace.id), context: unknown = lifecycleContext) => {
    const multipart = await inspectionMultipart(context);
    return app.inject({ method: 'POST', url: prefix, headers: { ...headers, 'if-match': match, 'idempotency-key': key, 'content-type': multipart.contentType }, payload: multipart.payload });
  };
  const get = (id: string) => app.inject({ url: prefix + '/' + id, headers });
  const active = () => app.inject({ url: prefix, headers });
  async function settle(jobId: string): Promise<JobDTO> {
    for (let i = 0; i < 2000; i++) {
      const response = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers });
      const job = response.json() as JobDTO;
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('Inspection lifecycle Job did not settle');
  }
  async function compute(index: number): Promise<WorkerOutput> {
    const request = requests[index]!;
    // Variable import keeps the pre-implementation baseline behavioural (404), not a missing-module import failure.
    const moduleUrl = request.moduleUrl!.replace(/\.js$/, '.ts');
    const operation = await import(moduleUrl) as WorkerOperation;
    return operation.execute(request.input, { job: request.job, ...(request.snapshot ? { snapshot: request.snapshot } : {}),
      cancelled: () => Atomics.load(new Int32Array(request.cancellation), 0) !== 0, progress: () => {} });
  }
  async function finish(index: number): Promise<JobDTO> {
    workers[index]!.complete(await compute(index)); await inspectionTick(); return settle(requests[index]!.job.jobId);
  }
  async function ready(): Promise<InspectionView> {
    const accepted = await start(); expect(accepted.statusCode, accepted.body).toBe(202); await inspectionTick();
    const job = realWorker ? await settle(accepted.json().jobId) : await finish(requests.length - 1);
    expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); expect(job.resultRef?.type).toBe('import-inspection');
    const response = await get(job.resultRef!.id); expect(response.statusCode).toBe(200); return response.json() as InspectionView;
  }
  const commit = (inspection: InspectionView, key = randomUUID(), match = app.ce.store.etag(workspace.id), acceptedExcludedSheets = inspection.requiresPartialCoverageAcceptance) => app.inject({
    method: 'POST', url: `${prefix}/${inspection.id}/commit`, headers: { ...headers, 'if-match': match, 'idempotency-key': key },
    payload: { inspectionHash: inspection.inspectionHash, acceptedExcludedSheets } });
  const discard = (id: string) => app.inject({ method: 'DELETE', url: `${prefix}/${id}`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id) } });
  const cancel = (jobId: string) => app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers });
  async function clean() {
    expect(app.ce.store.current(workspace.id)).toBe(base); expect(app.ce.store.get(workspace.id).versionIds).toEqual(originalVersions);
    expect(app.ce.store.etag(workspace.id)).toBe(originalETag); expect(app.ce.store.get(workspace.id).activeJobId).toBeUndefined();
    expect(app.ce.store.listRecords('reserve:')).toEqual([]); expect(app.ce.store.listRecords('operation:')).toEqual([]);
    expect(app.ce.files.usage(workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 });
    expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]);
  }
  return { app, headers, workspace, base, originalETag, originalVersions, prefix, requests, workers, start, get, active, settle, compute, finish, ready, commit, discard, cancel, clean,
    now: () => now, advance: (milliseconds: number) => { now += milliseconds; }, close: async () => { if (!closed) { closed = true; await app.close(); } } };
}
