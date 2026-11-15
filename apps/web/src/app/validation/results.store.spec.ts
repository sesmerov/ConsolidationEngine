import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ResultsStore } from './results.store';
import { SessionStore } from '../core/session.store';
import type { JobDTO, CompactResultsPageDTO } from '@ce/contracts';
const workspace = { id: 'workspace', name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: 'version', versionIds: ['version'], contexts: [], counts: { snapshots: 1, coordinates: 6, facts: 5, sources: 2 }, sessionBytes: 100 };
const run = { id: 'restored', versionId: 'version', profileId: 'profile', status: 'completed', startedAt: '2026-10-31T00:00:00.000Z' };
let http: HttpTestingController, session: SessionStore;
beforeEach(() => { TestBed.configureTestingModule({ providers: [ResultsStore, provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); session.workspace.set(workspace); });
afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
it('restores retained validation references and its newest results without browser persistence', async () => {
  const store = TestBed.inject(ResultsStore); TestBed.tick(); http.expectOne(request => request.url.endsWith('/runs')).flush({ items: [run], total: 1, nextCursor: null, revision: 'rev' }); await Promise.resolve();
  const results = http.expectOne(request => request.url.endsWith('/runs/restored/results'));
  expect(results.request.params.get('compact')).toBe('true'); expect(results.request.params.has('includeConfiguredDirections')).toBe(false);
  results.flush({ workspaceId:'workspace',items: [], total: 0, nextCursor: null, versionId: 'version', run: { ...run, workspaceId:'workspace',validationBasisId:'basis',diagnosticsCount:0,summary: { byStatus: { pass: 0, fail: 0 } } } }); await Promise.resolve();
  expect(store.selectedRunId()).toBe('restored'); expect(store.page()?.run.id).toBe('restored'); expect(store.history()[0]!.id).toBe('restored');
});
it('does not expose stale history after the workspace closes during its request', async () => {
  const store = TestBed.inject(ResultsStore); TestBed.tick(); const request = http.expectOne(request => request.url.endsWith('/runs'));
  session.workspace.set(null); TestBed.tick(); request.flush({ items: [run], total: 1, nextCursor: null, revision: 'rev' }); await Promise.resolve();
  expect(store.history()).toEqual([]); expect(store.selectedRunId()).toBeNull(); http.expectNone(request => request.url.endsWith('/results'));
});
it('paginates summaries without dropping the selected historical execution', async () => {
  const store = TestBed.inject(ResultsStore); TestBed.tick(); store.selectedRunId.set('older');
  http.expectOne(request => request.url.endsWith('/runs')).flush({ items: [run], total: 2, nextCursor: 'cursor', revision: 'rev' }); await Promise.resolve();
  const loading = store.loadHistory(true), request = http.expectOne(request => request.url.endsWith('/runs')); expect(request.request.params.get('cursor')).toBe('cursor');
  request.flush({ items: [{ ...run, id: 'older' }], total: 2, nextCursor: null, revision: 'rev' }); await loading;
  expect(store.history().map(row => row.id)).toEqual(['restored', 'older']); expect(store.selectedRunId()).toBe('older');
});
it('exposes a confirmed completion independently of directions and rejects failed, incomplete or mismatched jobs', () => {
  const store = TestBed.inject(ResultsStore); TestBed.tick();
  http.expectOne(request => request.url.endsWith('/runs')).flush({ items: [], total: 0, nextCursor: null, revision: 'rev' });
  const page: CompactResultsPageDTO = { workspaceId:'workspace',items: [], total: 0, nextCursor: null, versionId: 'version',
    run: { ...run, workspaceId:'workspace',status: 'completed', validationBasisId: 'basis', diagnosticsCount: 0,
      summary: { complete: true, rows: 0, variants: 0, instances: 0, duplicateRows: 0, applicableVariants: 0,
        byStatus: { pass: 0, fail: 0, error: 0, not_applicable: 0, not_evaluable: 0 } } } };
  const job: JobDTO = { jobId: 'job', workspaceId: 'workspace', baseVersionId: 'version', kind: 'validate', status: 'succeeded',
    progress: { completed: 1, total: 1, complete: true }, resultRef: { type: 'validation', id: run.id }, diagnostics: [], pollAfterMs: 500 };
  store.page.set(page); session.job.set(job);
  expect(store.completedValidation()).toBe(page.run);
  expect(store.resultPresentation()).toEqual({ jobId: 'job', workspaceId: 'workspace', versionId: 'version' });
  session.job.set({ ...job, status: 'failed' }); expect(store.completedValidation()).toBeNull();
  session.job.set({ ...job, progress: { ...job.progress, complete: false } }); expect(store.completedValidation()).toBeNull();
  session.job.set({ ...job, resultRef: { type: 'validation', id: 'other' } }); expect(store.completedValidation()).toBeNull();
  session.job.set(job); store.page.set({ ...page, run: { ...page.run, summary: { ...page.run.summary, complete: false } } });
  expect(store.completedValidation()).toBeNull();
});
it('does not fetch large rows automatically and rejects a response from another workspace', async () => {
  const store=TestBed.inject(ResultsStore); TestBed.tick(); http.expectOne(request=>request.url.endsWith('/runs')).flush({items:[],total:0,nextCursor:null,revision:'r'});
  store.selectedRunId.set('restored'); const loading=store.load();
  const descriptor={valueRef:'large-row',sha256:'a'.repeat(64),byteLength:200_000,mediaType:'application/json'};
  http.expectOne(request=>request.url.endsWith('/results')).flush({workspaceId:'workspace',versionId:'version',items:[descriptor],total:2,nextCursor:'next',run:{...run,workspaceId:'workspace',diagnosticsCount:0}}); await loading;
  expect(store.page()?.items).toEqual([descriptor]); expect(store.pagination.rangeLabel()).toBe('1–1 de 2'); http.expectNone(request=>request.url.includes('/values/'));
  const next=store.load(1); http.expectOne(request=>request.url.endsWith('/results')).flush({workspaceId:'foreign',versionId:'version',items:[descriptor],total:2,nextCursor:null,run:{...run,workspaceId:'foreign'}}); await next;
  expect(store.error()).toBeTruthy(); expect(store.page()?.workspaceId).toBe('workspace');
});
it('loads execution notices only on demand and rejects a later page from another version',async()=>{
  const store=TestBed.inject(ResultsStore);TestBed.tick();http.expectOne(request=>request.url.endsWith('/runs')).flush({items:[],total:0,nextCursor:null,revision:'r'});await Promise.resolve();
  store.selectedRunId.set('restored');TestBed.tick();store.page.set({workspaceId:'workspace',versionId:'version',items:[],total:0,nextCursor:null,run:{...run,status:'completed',workspaceId:'workspace',validationBasisId:'basis',diagnosticsCount:3,summary:{complete:true,rows:0,variants:0,instances:0,duplicateRows:0,applicableVariants:0,byStatus:{pass:0,fail:0,error:0,not_applicable:0,not_evaluable:0}}}});
  http.expectNone(request=>request.url.endsWith('/diagnostics'));
  const descriptor={valueRef:'notice',sha256:'a'.repeat(64),byteLength:200_000,mediaType:'application/json' as const},first=store.loadDiagnostics();
  http.expectOne(request=>request.url.endsWith('/runs/restored/diagnostics')).flush({workspaceId:'workspace',versionId:'version',items:[{code:'NOTICE',message:'Explicación conservada'},descriptor],total:3,nextCursor:'next'});await first;
  expect(store.diagnosticPage()?.items).toHaveLength(2);expect(store.diagnosticsPagination.rangeLabel()).toBe('1–2 de 3');http.expectNone(request=>request.url.includes('/values/'));
  const next=store.loadDiagnostics(1),request=http.expectOne(request=>request.url.endsWith('/diagnostics'));expect(request.request.params.get('cursor')).toBe('next');request.flush({workspaceId:'workspace',versionId:'different',items:[],total:0,nextCursor:null});await next;
  expect(store.diagnosticsError()).toContain('no corresponden');expect(store.diagnosticPage()?.versionId).toBe('version');
  session.workspace.set(null);TestBed.tick();expect(store.diagnosticPage()).toBeNull();
});
