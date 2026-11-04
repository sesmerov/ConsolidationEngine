import { TestBed } from '@angular/core/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonHarness } from '@angular/material/button/testing';
import { MatCheckboxHarness } from '@angular/material/checkbox/testing';
import { HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportPageComponent } from './import-page.component';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import type { ImportInspectionDTO, JobDTO } from '@ce/contracts';

const workspace = { id: 'workspace', name: 'COREP', state: 'ready' as const, currentVersionId: 'v1', versionIds: ['v1'], contexts: [], counts: { snapshots: 1, coordinates: 1, facts: 1, sources: 1 }, sessionBytes: 100 };
const form = { entityId: 'Entidad de prueba', referenceDate: '2024-02-29', submissionDate: '2024-03-31', currency: 'EUR', scaleExponent: '3', displayDecimals: '2', presented: 'false' };
function ready(overrides: Partial<ImportInspectionDTO> = {}): ImportInspectionDTO { return { id: 'inspection', workspaceId: workspace.id, baseVersionId: 'v1', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900_000).toISOString(), state: 'ready', inspectionHash: 'a'.repeat(64),
  profiles: [{ profileId: 'eba-corep-of-4.0-ca1-v1', languageProfileId: 'ce-dpmxl-0.9-extended-v2', mappingSha256: 'b'.repeat(64) }],
  context: [{ sourceFileId: 'file', origin: 'form', declaration: { entityId: form.entityId, referenceDate: form.referenceDate, submissionDate: form.submissionDate, contextId: 'corep', framework: 'COREP', moduleVersion: 'COREP_OF_4.0', currency: 'EUR', scaleExponent: 3, displayDecimals: 2, filingIndicators: { 'C_01.00': false } } }],
  reports: [{ sourceFileId: 'file', displayName: 'COREP completo.xlsx', sha256: 'c'.repeat(64), profileId: 'eba-corep-of-4.0-ca1-v1', tables: ['C_01.00'], selectedSheets: ['CA1'], excludedSheets: Array.from({ length: 190 }, (_, index) => 'Hoja ' + (index + 1)), coordinates: 110, values: 4 }], diagnostics: [], requiresPartialCoverageAcceptance: true, ...overrides }; }
const job = (kind: 'inspect-import' | 'import', id = 'job'): JobDTO => ({ jobId: id, workspaceId: workspace.id, kind, status: 'queued', progress: { completed: 0, total: 1, complete: false }, diagnostics: [], pollAfterMs: 60_000 });
describe('visual workbook inspection before publication', () => {
  const api = {
    capabilities: vi.fn().mockResolvedValue({ knownDifferences: [] }),
    rules: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null, sources: [], coverage: {}, dataSummary: {} }),
    activeImportInspection: vi.fn().mockResolvedValue({ active: null }),
    inspectImport: vi.fn(), importInspection: vi.fn(), commitImportInspection: vi.fn(), discardImportInspection: vi.fn(), importFiles: vi.fn(), job: vi.fn(), workspace: vi.fn(),
  };
  beforeEach(() => { vi.clearAllMocks(); api.activeImportInspection.mockResolvedValue({ active: null }); api.importInspection.mockResolvedValue(ready()); api.inspectImport.mockResolvedValue(job('inspect-import')); api.commitImportInspection.mockResolvedValue(job('import', 'commit-job')); api.discardImportInspection.mockResolvedValue(ready({ state: 'discarded', profiles: [], context: [], reports: [] })); api.job.mockResolvedValue(job('import', 'commit-job')); TestBed.configureTestingModule({ imports: [ImportPageComponent], providers: [{ provide: ApiClient, useValue: api }] }); const session = TestBed.inject(SessionStore); session.workspace.set(workspace); session.etag.set('"v-v1"'); });
  afterEach(() => TestBed.resetTestingModule());
  async function render() { const fixture = TestBed.createComponent(ImportPageComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture; }
  it('offers inspection as the main operation and never publishes simply by selecting files', async () => {
    const fixture = await render(); fixture.componentInstance.catalog.set(new File(['rules'], 'rules.xlsx')); fixture.componentInstance.reports.set([new File(['corep'], 'corep.xlsx')]); fixture.detectChanges();
    const loader = TestbedHarnessEnvironment.loader(fixture); expect(await loader.hasHarness(MatButtonHarness.with({ text: 'Inspeccionar archivos' }))).toBe(true);
    expect(api.importFiles).not.toHaveBeenCalled(); expect(api.commitImportInspection).not.toHaveBeenCalled();
  });
  it('offers workbook or form context and keeps the previous format in an advanced option', async () => {
    const fixture = await render(), element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('#context-source')).not.toBeNull();
    expect([...element.querySelectorAll('summary')].some(summary => summary.textContent?.includes('Formato anterior ce-report-1'))).toBe(true);
    expect(element.querySelector('#context-entity')).toBeNull();
  });
  it('recovers the active server inspection when the workspace opens', async () => {
    await render(); expect(api.activeImportInspection).toHaveBeenCalledWith(workspace.id);
  });
  it('sends business context only, waits for the worker and keeps all 190 exclusions unaccepted', async () => {
    const fixture = await render(), store = fixture.componentInstance.store; store.catalog.set(new File(['rules'], 'rules.xlsx')); store.reports.set([new File(['corep'], 'corep.xlsx')]); store.contextSource.set('form'); store.contextForm.set(form); fixture.detectChanges(); await fixture.whenStable();
    await store.inspect(); expect(api.inspectImport).toHaveBeenCalledOnce(); expect(api.inspectImport.mock.calls[0]?.[4]).toEqual({ source: 'form', declaration: { entityId: form.entityId, referenceDate: form.referenceDate, submissionDate: form.submissionDate, currency: 'EUR', scaleExponent: 3, displayDecimals: 2, filingIndicators: { 'C_01.00': false } } });
    expect(TestBed.inject(SessionStore).versionId()).toBe('v1'); expect(store.inspection()).toBeNull();
    TestBed.inject(SessionStore).job.set({ ...job('inspect-import'), status: 'succeeded', resultRef: { type: 'import-inspection', id: 'inspection' } }); fixture.detectChanges(); await vi.waitFor(() => expect(store.inspection()?.id).toBe('inspection')); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement; expect(element.textContent).toContain('1 hoja incluida: CA1 · 190 hojas excluidas'); expect(element.querySelectorAll('.excluded-sheets li')).toHaveLength(190); expect(element.textContent).toContain('No presentada');
    const checkbox = await TestbedHarnessEnvironment.loader(fixture).getHarness(MatCheckboxHarness.with({ label: 'Acepto importar únicamente las hojas incluidas y excluir las demás' })); expect(await checkbox.isChecked()).toBe(false); expect(store.canCommit()).toBe(false); expect(api.commitImportInspection).not.toHaveBeenCalled();
  });
  it('requires explicit partial-coverage acceptance and commits the exact inspection with current CAS', async () => {
    const inspection = ready(); api.activeImportInspection.mockResolvedValue({ active: inspection }); const fixture = await render(), store = fixture.componentInstance.store, loader = TestbedHarnessEnvironment.loader(fixture);
    const confirm = await loader.getHarness(MatButtonHarness.with({ text: 'Confirmar carga' })); expect(await confirm.isDisabled()).toBe(true);
    await (await loader.getHarness(MatCheckboxHarness.with({ label: 'Acepto importar únicamente las hojas incluidas y excluir las demás' }))).check(); expect(await confirm.isDisabled()).toBe(false); await confirm.click();
    const call = api.commitImportInspection.mock.calls[0]!; expect(call.slice(0, 4)).toEqual([workspace.id, inspection.id, { inspectionHash: inspection.inspectionHash, acceptedExcludedSheets: true }, '"v-v1"']); expect(call[4]).toMatch(/^[0-9a-f-]{36}$/); expect(store.inspection()?.state).toBe('committing'); expect(TestBed.inject(SessionStore).versionId()).toBe('v1');
  });
  it('uses workbook context and sends false acceptance for an extract without exclusions', async () => {
    const inspection = ready(); api.activeImportInspection.mockResolvedValue({ active: { ...inspection, context: inspection.context.map(context => ({ ...context, origin: 'workbook' })), reports: inspection.reports.map(report => ({ ...report, excludedSheets: [] })), requiresPartialCoverageAcceptance: false } });
    const fixture = await render(), store = fixture.componentInstance.store; expect(store.contextSource()).toBe('workbook'); expect(store.contextForm().referenceDate).toBe('2024-02-29'); expect(store.canCommit()).toBe(true);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Contexto leído del libro'); await store.commit(); expect(api.commitImportInspection.mock.calls[0]?.[2]).toEqual({ inspectionHash: inspection.inspectionHash, acceptedExcludedSheets: false });
  });
  it('invalidates edits without discarding silently and retains valid context/files after explicit discard', async () => {
    api.activeImportInspection.mockResolvedValue({ active: ready() }); const fixture = await render(), store = fixture.componentInstance.store; store.acceptedExcludedSheets.set(true); store.updateContext('currency', 'USD'); fixture.detectChanges(); await fixture.whenStable();
    expect(store.reviewDirty()).toBe(true); expect(store.acceptedExcludedSheets()).toBe(false); expect(store.canCommit()).toBe(false); expect(api.discardImportInspection).not.toHaveBeenCalled();
    const file = new File(['new'], 'corep.xlsx'); store.reports.set([file]); fixture.detectChanges(); await store.discardInspection(); expect(store.inspection()?.state).toBe('discarded'); expect(store.contextForm().currency).toBe('USD'); expect(store.reports()[0]).toBe(file); expect(TestBed.inject(SessionStore).versionId()).toBe('v1');
  });
  it('treats a newly selected File as an edit even when its visible name is unchanged', async () => {
    api.activeImportInspection.mockResolvedValue({ active: ready() }); const fixture = await render(), store = fixture.componentInstance.store;
    store.catalog.set(new File(['new bytes'], 'rules.xlsx')); fixture.detectChanges(); await fixture.whenStable(); expect(store.reviewDirty()).toBe(true); expect(store.canCommit()).toBe(false);
  });
  it.each([410, 412])('keeps valid fields and the accepted data after commit rejection %s', async status => {
    api.activeImportInspection.mockResolvedValue({ active: ready() }); api.commitImportInspection.mockRejectedValueOnce(new HttpErrorResponse({ status, error: { error: { message: status === 410 ? 'La inspección ha caducado.' : 'La base ha cambiado.' } } }));
    api.workspace.mockResolvedValue(new HttpResponse({ body: { ...workspace, currentVersionId: 'v2', versionIds: ['v1', 'v2'] }, headers: new HttpHeaders({ ETag: '"v-v2"' }) }));
    const fixture = await render(), store = fixture.componentInstance.store; store.acceptedExcludedSheets.set(true); await store.commit(); fixture.detectChanges(); expect(store.inspection()?.state).toBe(status === 410 ? 'expired' : 'invalidated'); expect(store.contextForm()).toEqual(form); expect(store.canCommit()).toBe(false); expect(store.acceptedExcludedSheets()).toBe(false); expect(api.importFiles).not.toHaveBeenCalled();
  });
  it('does not enable an inspection whose TTL has passed, even before a server response', async () => {
    api.activeImportInspection.mockResolvedValue({ active: ready({ expiresAt: new Date(Date.now() - 1).toISOString() }) }); const fixture = await render(), store = fixture.componentInstance.store; store.acceptedExcludedSheets.set(true); expect(store.locallyExpired()).toBe(true); expect(store.canCommit()).toBe(false); expect(store.contextForm()).toEqual(form); await store.commit(); expect(api.commitImportInspection).not.toHaveBeenCalled();
  });
  it('replays an uncertain commit with the original hash, acceptance, key and CAS after navigation/base changes', async () => {
    api.activeImportInspection.mockResolvedValue({ active: ready() }); api.commitImportInspection.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 })); const fixture = await render(), store = fixture.componentInstance.store; store.acceptedExcludedSheets.set(true); await store.commit(); const original = [...api.commitImportInspection.mock.calls[0]!]; expect(store.uncertainCommit()).toBe(true);
    fixture.destroy(); const restored = await render(); expect(restored.componentInstance.store).toBe(store); TestBed.inject(SessionStore).workspace.set({ ...workspace, currentVersionId: 'v2', versionIds: ['v1', 'v2'] }); TestBed.inject(SessionStore).etag.set('"v-v2"'); TestBed.tick(); await store.retryCommit(); expect(api.commitImportInspection.mock.calls[1]).toEqual(original); expect(api.activeImportInspection).toHaveBeenCalledOnce();
  });
  it('recovers a committing inspection and follows its existing job without posting again', async () => {
    api.activeImportInspection.mockResolvedValue({ active: ready({ state: 'committing', commitJobId: 'commit-job' }) }); const fixture = await render(); expect(api.job).toHaveBeenCalledWith(workspace.id, 'commit-job'); expect(TestBed.inject(SessionStore).job()?.jobId).toBe('commit-job'); expect(fixture.componentInstance.store.canCommit()).toBe(false); expect(api.commitImportInspection).not.toHaveBeenCalled();
  });
  it('ignores an active inspection response arriving after close and clears form/file references', async () => {
    let resolve!: (value: { active: ImportInspectionDTO }) => void; api.activeImportInspection.mockReturnValueOnce(new Promise(done => { resolve = done; })); const fixture = TestBed.createComponent(ImportPageComponent); fixture.detectChanges(); const store = fixture.componentInstance.store; store.contextForm.set(form); store.catalog.set(new File(['x'], 'private.xlsx'));
    TestBed.inject(SessionStore).workspace.set(null); TestBed.tick(); resolve({ active: ready() }); await Promise.resolve(); expect(store.inspection()).toBeNull(); expect(store.catalog()).toBeNull(); expect(store.contextForm().entityId).toBe(''); expect(api.commitImportInspection).not.toHaveBeenCalled();
  });
  it('does not let a late worker inspection approve inputs changed since the request', async () => {
    const fixture = await render(), store = fixture.componentInstance.store; store.catalog.set(new File(['rules'], 'rules.xlsx')); store.reports.set([new File(['corep'], 'corep.xlsx')]); store.contextSource.set('form'); store.contextForm.set(form); fixture.detectChanges(); await fixture.whenStable(); await store.inspect();
    store.updateContext('currency', 'USD'); fixture.detectChanges(); await fixture.whenStable(); TestBed.inject(SessionStore).job.set({ ...job('inspect-import'), status: 'succeeded', resultRef: { type: 'import-inspection', id: 'inspection' } }); fixture.detectChanges(); await vi.waitFor(() => expect(store.inspection()?.id).toBe('inspection'));
    expect(store.contextForm().currency).toBe('USD'); expect(store.reviewDirty()).toBe(true); expect(store.canCommit()).toBe(false);
  });
  it('localizes a worker rejection to the file and cell while retaining the current data', async () => {
    api.inspectImport.mockResolvedValueOnce({ ...job('inspect-import'), status: 'failed', diagnostics: [{ code: 'FORMULA_NOT_ALLOWED', message: 'La celda contiene una fórmula.', fileName: 'corep.xlsx', locator: { sheet: 'CA1', column: 'E', row: 5 } }] });
    const fixture = await render(), store = fixture.componentInstance.store; store.catalog.set(new File(['rules'], 'rules.xlsx')); store.reports.set([new File(['corep'], 'corep.xlsx')]); fixture.detectChanges(); await fixture.whenStable(); await store.inspect(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(TestBed.inject(SessionStore).versionId()).toBe('v1'); expect((fixture.nativeElement as HTMLElement).querySelector('#report-files')?.getAttribute('aria-invalid')).toBe('true'); expect((fixture.nativeElement as HTMLElement).querySelector('#reports-server-errors')?.textContent).toContain('CA1 E5'); expect(api.importInspection).not.toHaveBeenCalled(); expect(api.commitImportInspection).not.toHaveBeenCalled();
  });
  it('recovers a lost inspection POST without overwriting the current form or silently accepting another candidate', async () => {
    const fixture = await render(), store = fixture.componentInstance.store; store.catalog.set(new File(['rules'], 'rules.xlsx')); store.reports.set([new File(['corep'], 'corep.xlsx')]); store.contextSource.set('form'); store.contextForm.set({ ...form, currency: 'USD' }); fixture.detectChanges(); await fixture.whenStable();
    api.inspectImport.mockRejectedValueOnce(new HttpErrorResponse({ status: 409 })); api.activeImportInspection.mockResolvedValueOnce({ active: ready() }); await store.inspect();
    expect(store.inspection()?.id).toBe('inspection'); expect(store.contextForm().currency).toBe('USD'); expect(store.reviewDirty()).toBe(true); expect(store.canCommit()).toBe(false); expect(api.discardImportInspection).not.toHaveBeenCalled();
  });
});
