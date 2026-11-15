import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { OperationAttemptStore } from '../core/operation-attempt.store';
import { ExportStore } from './export.store';
const workspaceId = '00000000-0000-4000-8000-000000000091', original = '00000000-0000-4000-8000-000000000092', current = '00000000-0000-4000-8000-000000000093', jobId = '00000000-0000-4000-8000-000000000094', artifactId = '00000000-0000-4000-8000-000000000095';
const workspace = { id: workspaceId, name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: current, versionIds: [original, current], contexts: [], counts: { snapshots: 2, coordinates: 1, facts: 1, sources: 2 }, sessionBytes: 100 };
const job = { jobId, workspaceId, kind: 'export' as const, status: 'queued' as const, progress: { completed: 0, total: 1, complete: false }, diagnostics: [], pollAfterMs: 60000 };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; return { promise: new Promise<T>((yes, no) => { resolve = yes; reject = no; }), resolve, reject }; }
async function tick() { for (let i = 0; i < 5; i++) { await Promise.resolve(); TestBed.tick(); } }
describe('one download intent and recoverable lifecycle', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>, session: SessionStore, store: ExportStore;
  beforeEach(async () => {
    sessionStorage.clear(); api = {
      runs: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), exportSummary: vi.fn().mockImplementation((_w, versionId, kind = 'report', runId) => Promise.resolve({ versionId, reports: [], profileId: 'profile', createdAt: '2026-11-08T00:00:00Z', intent: { workspaceId, versionId, kind, ...(runId ? { runId } : {}) }, intentFingerprint: 'a'.repeat(64) })),
      exportReport: vi.fn().mockResolvedValue(job), exportResults: vi.fn().mockResolvedValue(job), downloadExport: vi.fn().mockResolvedValue(new Blob(['zip'])),
      exportArtifactSummary: vi.fn().mockResolvedValue({ id: artifactId, jobId, intent: { workspaceId, versionId: original, kind: 'report' }, intentFingerprint: 'a'.repeat(64), size: 3, sha256: 'b'.repeat(64), status: 'ready', filename: 'report.zip', mimeType: 'application/zip' }),
      operationReceipt: vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 404 })), operation: vi.fn(), job: vi.fn(), cancelJob: vi.fn(),
    };
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: api }] }); session = TestBed.inject(SessionStore); session.workspace.set(workspace); session.etag.set('"v-' + current + '"'); store = TestBed.inject(ExportStore); await tick();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:download'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  });
  afterEach(() => { TestBed.resetTestingModule(); sessionStorage.clear(); vi.restoreAllMocks(); });
  it('locks only uncertain acceptance, then permits another intent without auto-downloading the old job', async () => {
    store.selectVersion(original); const accepted = deferred<typeof job>(); api['exportReport']!.mockReturnValueOnce(accepted.promise);
    const starting = store.activate(); expect(store.state()).toBe('accepting'); expect(store.choiceLocked()).toBe(true); store.selectVersion(current); expect(session.exportVersionId()).toBe(original);
    accepted.resolve(job); await starting; expect(store.choiceLocked()).toBe(false); store.selectVersion(current); await tick();
    session.trackJob({ ...job, status: 'succeeded', resultRef: { type: 'export', id: artifactId }, progress: { completed: 1, total: 1, complete: true } }); await tick();
    expect(api['downloadExport']).not.toHaveBeenCalled(); expect(session.exportVersionId()).toBe(current); expect(store.ready()).toBeNull();
    store.selectVersion(original); await tick(); expect(store.ready()?.id).toBe(artifactId); await store.activate(); expect(api['downloadExport']).toHaveBeenCalledTimes(1); expect(api['exportReport']).toHaveBeenCalledTimes(1);
  });
  it('persists the original intent before POST and reuses the same key/body/ETag after a lost response', async () => {
    store.selectVersion(original); api['exportReport']!.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 })); await store.activate();
    expect(store.state()).toBe('uncertain'); const saved = TestBed.inject(OperationAttemptStore).get('export', workspaceId); expect(saved?.intent.versionId).toBe(original); const originalArgs = api['exportReport']!.mock.calls[0];
    store.selectVersion(current); expect(session.exportVersionId()).toBe(original); await store.activate(); expect(api['operationReceipt']).toHaveBeenCalledWith(saved?.key); expect(api['exportReport']!.mock.calls[1]).toEqual(originalArgs);
  });
  it('retries a failed transfer of the same artifact without another ZIP preparation', async () => {
    store.selectVersion(original); await store.activate(); api['downloadExport']!.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    session.trackJob({ ...job, status: 'succeeded', resultRef: { type: 'export', id: artifactId }, progress: { completed: 1, total: 1, complete: true } }); await tick(); expect(store.state()).toBe('failed');
    await store.activate(); expect(api['exportReport']).toHaveBeenCalledTimes(1); expect(api['downloadExport']).toHaveBeenCalledTimes(2); expect(store.state()).toBe('ready');
  });
  it('forgets an expired artifact and prepares a new download only after an explicit next click',async()=>{
    store.selectVersion(original);await store.activate();const key=api['exportReport']!.mock.calls[0]![3];api['downloadExport']!.mockRejectedValueOnce(new HttpErrorResponse({status:410,error:{error:{code:'ARTIFACT_EXPIRED',message:'Archivo caducado.'}}}));
    session.trackJob({...job,status:'succeeded',resultRef:{type:'export',id:artifactId},progress:{completed:1,total:1,complete:true}});await tick();expect(store.state()).toBe('expired');expect(store.ready()).toBeNull();expect(api['exportReport']).toHaveBeenCalledOnce();
    await store.activate();expect(api['exportReport']).toHaveBeenCalledTimes(2);expect(api['exportReport']!.mock.calls[1]![3]).not.toBe(key);
  });
  it('aborts an in-flight transfer when intent changes and never clicks a stale response', async () => {
    store.selectVersion(original); await store.activate(); const transfer = deferred<Blob>(); api['downloadExport']!.mockReturnValueOnce(transfer.promise);
    session.trackJob({ ...job, status: 'succeeded', resultRef: { type: 'export', id: artifactId }, progress: { completed: 1, total: 1, complete: true } }); await tick();
    const signal = api['downloadExport']!.mock.calls[0]![2] as AbortSignal; expect(store.state()).toBe('transferring'); store.selectVersion(current); expect(signal.aborted).toBe(true); transfer.resolve(new Blob(['zip'])); await tick(); expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
  it('rejects an artifact whose declared intent does not match the accepted request', async () => {
    store.selectVersion(original); await store.activate(); api['exportArtifactSummary']!.mockResolvedValueOnce({ id: artifactId, jobId, intent: { workspaceId, versionId: current, kind: 'report' }, intentFingerprint: 'a'.repeat(64), size: 3, sha256: 'b'.repeat(64), status: 'ready', filename: 'report.zip' });
    session.trackJob({ ...job, status: 'succeeded', resultRef: { type: 'export', id: artifactId }, progress: { completed: 1, total: 1, complete: true } }); await tick(); expect(store.state()).toBe('failed'); expect(api['downloadExport']).not.toHaveBeenCalled();
  });
  it('recovers a known successful attempt after reload without another preparation or automatic transfer', async () => {
    TestBed.inject(OperationAttemptStore).save({ operation: 'export', intent: { workspaceId, versionId: original, kind: 'report' }, key: '00000000-0000-4000-8000-000000000096', etag: '"original-cas"', operationId: jobId, jobId });
    TestBed.resetTestingModule(); api['operation']!.mockResolvedValue({ operationId: jobId, workspaceId, jobId, responseStatus: 202, phase: 'succeeded', reservation: { kind: 'export', intent: { workspaceId, versionId: original, kind: 'report' }, reservedExportId: artifactId, intentFingerprint: 'a'.repeat(64) } });
    api['job']!.mockResolvedValue({ ...job, status: 'succeeded', resultRef: { type: 'export', id: artifactId }, progress: { completed: 1, total: 1, complete: true } });
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: api }] }); session = TestBed.inject(SessionStore); session.workspace.set(workspace); session.etag.set('"new-cas"'); store = TestBed.inject(ExportStore); await tick();
    expect(session.exportVersionId()).toBe(original); expect(store.ready()?.id).toBe(artifactId); expect(api['exportReport']).not.toHaveBeenCalled(); expect(api['downloadExport']).not.toHaveBeenCalled();
  });
  it('retries metadata of an already published artifact without regenerating it', async () => {
    store.selectVersion(original); await store.activate(); api['exportArtifactSummary']!.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    session.trackJob({ ...job, status: 'succeeded', resultRef: { type: 'export', id: artifactId }, progress: { completed: 1, total: 1, complete: true } }); await tick(); expect(store.state()).toBe('failed');
    await store.activate(); expect(api['exportReport']).toHaveBeenCalledTimes(1); expect(api['exportArtifactSummary']).toHaveBeenCalledTimes(2); expect(api['downloadExport']).toHaveBeenCalledTimes(1);
  });
  it('makes a new explicit attempt with a new key after terminal cancellation', async () => {
    store.selectVersion(original); await store.activate(); session.trackJob({ ...job, status: 'cancelled' }); await tick(); expect(store.state()).toBe('cancelled'); expect(store.ready()).toBeNull();
    await store.activate(); expect(api['exportReport']).toHaveBeenCalledTimes(2); expect(api['exportReport']!.mock.calls[0]![3]).not.toBe(api['exportReport']!.mock.calls[1]![3]); expect(api['downloadExport']).not.toHaveBeenCalled();
  });
});
