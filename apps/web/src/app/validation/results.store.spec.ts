import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { ResultsStore } from './results.store';
import { SessionStore } from '../core/session.store';
import type { JobDTO, ValidationResultsPageDTO } from '@ce/contracts';
const workspace = { id: 'workspace', name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: 'version', versionIds: ['version'], contexts: [], counts: { snapshots: 1, coordinates: 6, facts: 5, sources: 2 }, sessionBytes: 100 };
const run = { id: 'restored', versionId: 'version', profileId: 'profile', status: 'completed', startedAt: '2026-10-31T00:00:00.000Z' };
let http: HttpTestingController, session: SessionStore;
beforeEach(() => { TestBed.configureTestingModule({ providers: [ResultsStore, provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); session.workspace.set(workspace); });
afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
it('restores retained validation references and its newest results without browser persistence', async () => {
  const store = TestBed.inject(ResultsStore); TestBed.tick(); http.expectOne(request => request.url.endsWith('/runs')).flush({ items: [run], total: 1, nextCursor: null, revision: 'rev' }); await Promise.resolve();
  const results = http.expectOne(request => request.url.endsWith('/runs/restored/results'));
  expect(String(results.request.params.get('includeConfiguredDirections'))).toBe('false');
  results.flush({ items: [], total: 0, nextCursor: null, versionId: 'version', run: { ...run, summary: { byStatus: { pass: 0, fail: 0 } } } }); await Promise.resolve();
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
  const page: ValidationResultsPageDTO = { items: [], total: 0, nextCursor: null, versionId: 'version',
    run: { ...run, status: 'completed', validationBasisId: 'basis', diagnostics: [], resultIds: [],
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
