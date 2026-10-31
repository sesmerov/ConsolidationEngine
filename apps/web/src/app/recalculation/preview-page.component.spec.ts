import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewPageComponent } from './preview-page.component';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
const workspaceId = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2', versionId = 'bfda41bd-2a55-4a80-9f22-2fc1aa89894c', id = '5976e981-9b8d-4e80-af2a-b1ffeced4b55';
const workspace = { id: workspaceId, name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: versionId, versionIds: [versionId], contexts: [], counts: { snapshots: 1, coordinates: 6, facts: 5, sources: 2 }, sessionBytes: 100 };
const preview = { id, baseVersionId: versionId, profileId: 'profile', policyId: 'half-even-v1', createdAt: '2026-10-31T00:00:00.000Z', state: 'ready', proposalIds: ['a', 'b'], graphSummary: { nodes: 2, edges: 1, order: ['da', 'db'], conflicts: [], cycles: [], blocked: 0 }, diagnostics: [] };
const coordinate = { factKey: 'cell', contextId: 'demo', tableCode: 'T', rowCode: '0010', columnCode: '0010', sheetCode: '', dataType: 'number', decimals: '2', unit: 'EUR', sourceLocator: {} };
const a = { id: 'a', previewId: id, directionId: 'da', instanceId: 'ia', variantIds: [], binding: {}, code: 'SYNTHETIC_A', targetKey: 'cell', state: 'available', before: { coordinate, presence: 'explicit_null', sourceLocator: { sheet: 'Facts', row: 2, column: 'G' } }, after: { normalizedValue: { numerator: '33', denominator: '100' }, originalText: '0.33', decimals: '2', unit: 'EUR' }, exactNominal: { numerator: '1', denominator: '3' }, derivedInterval: { lo: { numerator: '1', denominator: '3' }, hi: { numerator: '1', denominator: '3' } }, readKeys: [], predecessorIds: [], metadataReads: [], sources: [], diagnostics: [] };
const b = { ...a, id: 'b', directionId: 'db', code: 'SYNTHETIC_B', predecessorIds: ['a'] };
const page = { items: [a, b], total: 2, nextCursor: null, versionId };
describe('preview explanation and explicit closure', () => {
  let http: HttpTestingController, session: SessionStore;
  beforeEach(() => { TestBed.configureTestingModule({ imports: [PreviewPageComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('memory-only'); session.workspace.set(workspace); session.etag.set('"v-' + versionId + '"'); });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  async function render(state = 'ready') {
    const fixture = TestBed.createComponent(PreviewPageComponent); fixture.detectChanges();
    http.expectOne(request => request.url.endsWith('/previews')).flush({ items: [{ ...preview, state }], total: 1, nextCursor: null, revision: 'rev' }); await Promise.resolve();
    http.expectOne(request => request.url.endsWith('/previews/' + id)).flush({ ...preview, state });
    http.expectOne(request => request.url.endsWith('/proposals')).flush(state === 'ready' ? page : { ...page, items: page.items.map(row => ({ ...row, state: 'obsolete' })) });
    await Promise.resolve(); await Promise.resolve(); fixture.detectChanges(); return fixture;
  }
  it('restores retained preview and explains original null, exact and quantized values without implicitly selecting ancestors', async () => {
    const fixture = await render(); const text = (fixture.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('Nulo explícito'); expect(text).toContain('1/3'); expect(text).toContain('0.33'); expect(text).toContain('half-even-v1'); expect(text).toContain('SYNTHETIC_A');
    const selecting = fixture.componentInstance.store.toggle('b', true);
    const request = http.expectOne(request => request.url.endsWith('/selection')); expect(request.request.body).toEqual({ selectedIds: ['b'] }); expect(request.request.headers.has('If-Match')).toBe(false);
    request.flush({ selectedIds: ['b'], requiredIds: ['a'], complete: false, closureHash: 'hash', state: 'ready' }); await selecting; fixture.detectChanges();
    expect(fixture.componentInstance.store.selected()).toEqual(['b']); expect((fixture.nativeElement as HTMLElement).textContent).toContain('Faltan 1');
    http.expectNone(request => request.url.endsWith('/applications')); expect(Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(button => button.textContent?.includes('Aplicar cambios seleccionados'))!.disabled).toBe(true);
  });
  it('ignores a late selection response after a newer explicit selection', async () => {
    const fixture = await render(), store = fixture.componentInstance.store;
    const first = store.toggle('b', true), older = http.expectOne(request => request.url.endsWith('/selection'));
    const second = store.toggle('a', true), newer = http.expectOne(request => request.url.endsWith('/selection'));
    newer.flush({ selectedIds: ['a', 'b'], requiredIds: [], complete: true, closureHash: 'new', state: 'ready' }); await second;
    older.flush({ selectedIds: ['b'], requiredIds: ['a'], complete: false, closureHash: 'old', state: 'ready' }); await first;
    expect(store.selection()?.closureHash).toBe('new'); expect(store.selected()).toEqual(['a', 'b']);
  });
  it('retains an obsolete preview as information and never enables discard or application', async () => {
    const fixture = await render('obsolete'); expect((fixture.nativeElement as HTMLElement).textContent).toContain('obsoleta');
    expect(fixture.componentInstance.store.canDiscard()).toBe(false);
    await fixture.componentInstance.store.discard(); http.expectNone(request => request.method === 'DELETE');
  });
  it('confirms discard explicitly, sends CAS and preserves values when the server rejects stale state', async () => {
    const fixture = await render(); const buttons = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    buttons().find(button => button.textContent === 'Descartar previsualización')!.click(); fixture.detectChanges(); http.expectNone(request => request.method === 'DELETE');
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Confirmar descarte');
    const discarding = fixture.componentInstance.store.discard(), request = http.expectOne(request => request.method === 'DELETE');
    expect(request.request.headers.get('If-Match')).toBe('"v-' + versionId + '"'); expect(request.request.body).toBeNull();
    request.flush({ error: { message: 'La versión ha cambiado.' } }, { status: 412, statusText: 'Precondition Failed' }); await discarding;
    expect(fixture.componentInstance.store.preview()?.state).toBe('ready'); expect(fixture.componentInstance.store.page()?.items).toHaveLength(2);
  });
  it('discards late responses from a previous workspace and clears its retained references', async () => {
    const fixture = TestBed.createComponent(PreviewPageComponent); fixture.detectChanges(); const stale = http.expectOne(request => request.url.endsWith('/previews'));
    session.workspace.set(null); TestBed.tick(); stale.flush({ items: [preview], total: 1, nextCursor: null, revision: 'old' }); await Promise.resolve();
    expect(fixture.componentInstance.store.history()).toEqual([]); expect(fixture.componentInstance.store.preview()).toBeNull(); http.expectNone(request => request.url.endsWith('/previews/' + id));
  });
  it('keeps a selected proposal outside the current filter while selecting its predecessor explicitly', async () => {
    const fixture = await render(), store = fixture.componentInstance.store;
    const selecting = store.toggle('b', true); http.expectOne(request => request.url.endsWith('/selection')).flush({ selectedIds: ['b'], requiredIds: ['a'], complete: false, closureHash: 'old', state: 'ready' }); await selecting;
    store.code.set('SYNTHETIC_A'); const loading = store.load(); http.expectOne(request => request.url.endsWith('/previews/' + id)).flush(preview);
    http.expectOne(request => request.url.endsWith('/proposals') && request.params.get('code') === 'SYNTHETIC_A').flush({ ...page, items: [a], total: 1 }); await loading;
    const completed = store.toggle('a', true), request = http.expectOne(request => request.url.endsWith('/selection')); expect(request.request.body).toEqual({ selectedIds: ['a', 'b'] });
    request.flush({ selectedIds: ['a', 'b'], requiredIds: [], complete: true, closureHash: 'new', state: 'ready' }); await completed;
    expect(store.selected()).toEqual(['a', 'b']); expect(store.selection()?.complete).toBe(true);
    expect(store.selectedProposals()).toEqual([b, a]); fixture.detectChanges();
    const confirmation = (fixture.nativeElement as HTMLElement).querySelector('ce-apply')!.textContent!; expect(confirmation).toContain('SYNTHETIC_A'); expect(confirmation).toContain('SYNTHETIC_B'); expect(confirmation).toContain('0.33');
  });
  it('starts against current CAS and shows no fabricated preview for a cancelled job', async () => {
    const fixture = TestBed.createComponent(PreviewPageComponent); fixture.detectChanges(); http.expectOne(request => request.url.endsWith('/previews')).flush({ items: [], total: 0, nextCursor: null, revision: 'rev' }); await Promise.resolve();
    const starting = fixture.componentInstance.store.execute(), request = http.expectOne(request => request.method === 'POST' && request.url.endsWith('/previews'));
    expect(request.request.body).toEqual({ baseVersionId: versionId }); expect(request.request.headers.get('If-Match')).toBe('"v-' + versionId + '"'); expect(request.request.headers.has('Idempotency-Key')).toBe(true);
    request.flush({ jobId: 'job', workspaceId, kind: 'preview', status: 'cancelled', progress: { completed: 0, total: 2, complete: false }, diagnostics: [] }); await starting; TestBed.tick();
    expect(fixture.componentInstance.store.preview()).toBeNull(); expect(fixture.componentInstance.store.history()).toEqual([]);
  });
  it('restores an applied receipt after reload, keeps no-op counts and pages all comparisons without posting', async () => {
    const receiptId = '789588af-2da5-4ef9-b2f6-f34d39e4e7ad', applied = { ...preview, state: 'applied', appliedReceiptId: receiptId };
    const receipt = { id: receiptId, previewId: id, acceptedIds: ['a', 'b'], baseVersionId: versionId, newVersionId: 'next', beforeValidationRunId: 'before', validationRunId: 'after', appliedAt: preview.createdAt, closureHash: 'hash' };
    const summary = { complete: true, rows: 2, variants: 2, applicableVariants: 2, duplicateRows: 0, instances: 2, byStatus: { pass: 0, fail: 1, error: 1, not_applicable: 0, not_evaluable: 0 } };
    const row = { id: 'result', runId: 'after', versionId: 'next', code: 'SYNTHETIC_REMAINING', severity: 'error', status: 'fail', values: {}, factReads: [], metadataReads: [], sources: [], diagnostics: [], variantIds: [], sourceRecordIds: [], tables: [], coverageOnly: false, expression: '1=2' };
    const detail = { receipt, changeCount: 1, beforeSummary: summary, afterSummary: summary };
    const comparison = { receipt, beforeSummary: summary, afterSummary: summary, items: [{ key: 'first', after: row }], total: 2, nextCursor: 'next-page' };
    const fixture = TestBed.createComponent(PreviewPageComponent); fixture.detectChanges();
    http.expectOne(request => request.url.endsWith('/previews')).flush({ items: [applied], total: 1, nextCursor: null, revision: 'r' }); await Promise.resolve();
    http.expectOne(request => request.url.endsWith('/previews/' + id)).flush(applied); http.expectOne(request => request.url.endsWith('/proposals')).flush({ ...page, items: page.items.map(row => ({ ...row, state: 'applied' })) });
    await Promise.resolve(); await Promise.resolve();
    http.expectOne(request => request.url.endsWith('/applications/' + receiptId)).flush(detail); http.expectOne(request => request.url.endsWith('/comparison')).flush(comparison);
    await Promise.resolve(); await Promise.resolve(); fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent!; expect(text).toContain('Aplicación completada'); expect(text).toContain('Valores modificados: 1'); expect(text).toContain('Propuestas sin cambio de valor: 1'); expect(text).toContain('SYNTHETIC_REMAINING'); expect(fixture.componentInstance.store.selected()).toEqual([]);
    const loading = fixture.componentInstance.store.loadApplication(true); http.expectOne(request => request.url.endsWith('/applications/' + receiptId)).flush(detail);
    http.expectOne(request => request.url.endsWith('/comparison') && request.params.get('cursor') === 'next-page').flush({ ...comparison, items: [{ key: 'second', after: { ...row, id: 'second', code: 'SYNTHETIC_ERROR', status: 'error' } }], nextCursor: null }); await loading;
    expect(fixture.componentInstance.store.comparison()?.items.map(row => row.key)).toEqual(['first', 'second']); http.expectNone(request => request.method === 'POST');
  });
  it('ignores late receipt and comparison responses after closing the workspace', async () => {
    const fixture = await render(), store = fixture.componentInstance.store;
    store.preview.set({ ...store.preview()!, state: 'applied', appliedReceiptId: 'receipt' }); const loading = store.loadApplication();
    const detail = http.expectOne(request => request.url.endsWith('/applications/receipt')), comparison = http.expectOne(request => request.url.endsWith('/comparison'));
    session.workspace.set(null); TestBed.tick(); detail.flush({ receipt: { id: 'receipt' } }); comparison.flush({ items: [], receipt: { id: 'receipt' } }); await loading;
    expect(store.application()).toBeNull(); expect(store.comparison()).toBeNull();
  });
});
