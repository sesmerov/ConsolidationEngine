import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportsComponent } from './exports.component';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
const workspaceId = '00000000-0000-4000-8000-000000000091', original = '00000000-0000-4000-8000-000000000092', current = '00000000-0000-4000-8000-000000000093';
const workspace = { id: workspaceId, name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: current, versionIds: [original, current], contexts: [], counts: { snapshots: 2, coordinates: 1, facts: 1, sources: 2 }, sessionBytes: 100 };
const run = { id: 'old-run', versionId: original, profileId: 'profile', status: 'completed' as const, startedAt: '2026-10-31T00:00:00.000Z' };
describe('explicit version exports and download lifecycle', () => {
  let http: HttpTestingController, session: SessionStore;
  beforeEach(() => { TestBed.configureTestingModule({ imports: [ExportsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('ephemeral'); session.workspace.set(workspace); session.etag.set('"v-' + current + '"'); });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); vi.restoreAllMocks(); });
  async function render(items: object[] = [run], nextCursor: string | null = null) { const fixture = TestBed.createComponent(ExportsComponent); fixture.detectChanges(); http.expectOne(request => request.url.endsWith('/runs')).flush({ items, total: items.length, nextCursor, revision: 'r' }); await Promise.resolve(); TestBed.tick(); fixture.detectChanges(); return fixture; }
  it('exports the explicitly selected historical report using current CAS and a fixed safe download filename', async () => {
    const fixture = await render(), component = fixture.componentInstance; session.selectExportVersion(original); TestBed.tick();
    const starting = component.start(), request = http.expectOne(request => request.url.endsWith('/exports'));
    expect(request.request.body).toEqual({ versionId: original, kind: 'report' }); expect(request.request.headers.get('If-Match')).toBe('"v-' + current + '"'); expect(request.request.headers.get('X-CE-Session')).toBe('ephemeral');
    request.flush({ jobId: 'export-job', workspaceId, kind: 'export', status: 'queued', progress: { completed: 0, total: 4, complete: false }, diagnostics: [], pollAfterMs: 60000 }); await starting;
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic'), revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {}); const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    session.trackJob({ jobId: 'export-job', workspaceId, kind: 'export', status: 'succeeded', progress: { completed: 4, total: 4, complete: true }, diagnostics: [], resultRef: { type: 'export', id: 'artifact' }, pollAfterMs: 1000 }); TestBed.tick();
    const download = http.expectOne(request => request.url.endsWith('/exports/artifact')); expect(download.request.headers.has('If-Match')).toBe(false); download.flush(new Blob(['zip'], { type: 'application/zip' })); await Promise.resolve();
    expect(createUrl).toHaveBeenCalled(); expect(names).toEqual(['report.zip']); expect(component.ready()?.versionId).toBe(original); expect(session.versionId()).toBe(current); await new Promise(resolve => setTimeout(resolve, 1)); expect(revoke).toHaveBeenCalledWith('blob:synthetic');
  });
  it('selects a run of the chosen version and disables results until paginated history contains one', async () => {
    const fixture = await render([], 'more'), component = fixture.componentInstance; component.kind.set('results'); session.selectExportVersion(original); TestBed.tick(); expect(component.canStart()).toBe(false);
    const loading = component.loadHistory(true); http.expectOne(request => request.url.endsWith('/runs') && request.params.get('cursor') === 'more').flush({ items: [run], total: 1, nextCursor: null, revision: 'r' }); await loading; TestBed.tick();
    expect(component.selectedRunId()).toBe(run.id); const starting = component.start(); const request = http.expectOne(request => request.url.endsWith('/exports')); expect(request.request.body).toEqual({ versionId: original, runId: run.id, kind: 'results' });
    request.flush({ error: { code: 'STALE_VERSION', message: 'La versión ha cambiado.' } }, { status: 412, statusText: 'Precondition Failed' }); await starting; expect(component.error()).toBe('La versión ha cambiado.'); expect(component.ready()).toBeNull();
  });
  it('retains the original export request on an uncertain response even if the UI chooses another version', async () => {
    const component = (await render()).componentInstance; session.selectExportVersion(original); const firstStart = component.start(), first = http.expectOne(request => request.url.endsWith('/exports')); const body = first.request.body, key = first.request.headers.get('Idempotency-Key'); first.error(new ProgressEvent('error')); await firstStart;
    session.selectExportVersion(current); const retrying = component.retry(), retry = http.expectOne(request => request.url.endsWith('/exports')); expect(retry.request.body).toEqual(body); expect(retry.request.headers.get('Idempotency-Key')).toBe(key); expect(retry.request.headers.get('If-Match')).toBe('"v-' + current + '"');
    retry.flush({ jobId: 'same-export', workspaceId, kind: 'export', status: 'queued', progress: { completed: 0, total: 4, complete: false }, diagnostics: [], pollAfterMs: 60000 }); await retrying; expect(session.job()?.jobId).toBe('same-export');
  });
  it('clears export selection on confirmed close and ignores a late accepted job from that workspace', async () => {
    const component = (await render()).componentInstance; session.selectExportVersion(original); const starting = component.start(), pending = http.expectOne(request => request.url.endsWith('/exports'));
    const closing = session.close(); http.expectOne(request => request.url.endsWith('/workspaces/' + workspaceId)).flush(null, { status: 204, statusText: 'No Content' }); await closing; TestBed.tick();
    pending.flush({ jobId: 'late', workspaceId, kind: 'export', status: 'queued', progress: { completed: 0, total: 4, complete: false }, diagnostics: [] }); await starting; expect(session.workspace()).toBeNull(); expect(session.selectedExportVersionId()).toBeNull(); expect(session.job()).toBeNull(); expect(component.ready()).toBeNull();
  });
  it('keeps a cancelled export incomplete and never starts a download', async () => {
    const component = (await render()).componentInstance, starting = component.start(); http.expectOne(request => request.url.endsWith('/exports')).flush({ jobId: 'cancelled-export', workspaceId, kind: 'export', status: 'cancelled', progress: { completed: 0, total: 4, complete: false }, diagnostics: [{ code: 'CANCELLED', message: 'Trabajo cancelado.' }] }); await starting; TestBed.tick();
    expect(component.ready()).toBeNull(); expect(component.error()).toBe('Trabajo cancelado.'); http.expectNone(request => request.url.includes('/exports/'));
  });
});
