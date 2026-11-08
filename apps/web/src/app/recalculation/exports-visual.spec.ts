import { TestBed } from '@angular/core/testing';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportsComponent } from './exports.component';
import { ResultsExportComponent } from '../validation/results-export.component';
import { ExportStore } from './export.store';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { DownloadIntent } from '@ce/contracts';

const workspace = { id: 'workspace', name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: 'current', versionIds: ['original', 'current'], contexts: [], counts: { snapshots: 2, coordinates: 110, facts: 15, sources: 2 }, sessionBytes: 100 };
const run = { id: 'run-original', versionId: 'original', profileId: 'ce-dpmxl-0.9-typed-v2', status: 'incomplete' as const, startedAt: '2026-11-04T00:00:00.000Z', resultIds: [], diagnostics: [], summary: { complete: false, rows: 8, variants: 8, applicableVariants: 8, instances: 3, duplicateRows: 0, byStatus: { pass: 3, fail: 0, not_evaluable: 0, not_applicable: 0, error: 0 } } };
const summary = (versionId: string) => ({ versionId, intent: { workspaceId: workspace.id, versionId, kind: 'report' } as DownloadIntent, intentFingerprint: 'a'.repeat(64), profileId: 'ce-dpmxl-0.9-typed-v2', createdAt: '2026-11-04T00:00:00.000Z', reports: [{ sourceFileId: 'report', displayName: versionId === 'original' ? 'tipos.xlsx' : 'corep.xlsx', profileId: versionId === 'original' ? 'ce-demo-types-1' : 'eba-corep-of-4.0-ca1-v1', contextCount: 1, commonEntityId: 'SYNTHETIC', commonReferenceDate: '2025-12-31', contextOrigin: 'workbook', selectedSheets: versionId === 'original' ? ['Datos'] : ['CA1'], excludedSheets: versionId === 'original' ? [] : ['CA2'], ...(versionId === 'original' ? {} : { scaleExponent: 0, displayDecimals: 2 }) }] });
describe('visual export content and exact artifact identity', () => {
  const api = { runs: vi.fn(), exportSummary: vi.fn(), exportReport: vi.fn(), exportResults: vi.fn(), downloadExport: vi.fn() };
  beforeEach(() => {
    sessionStorage.clear(); vi.resetAllMocks(); api.runs.mockResolvedValue({ items: [run], total: 1, nextCursor: null, revision: 'r' }); api.exportSummary.mockImplementation((_workspace: string, versionId: string, kind = 'report', runId?: string) => Promise.resolve({ ...summary(versionId), intent: { workspaceId: workspace.id, versionId, kind, ...(runId ? { runId } : {}) }, intentFingerprint: 'a'.repeat(64) }));
    TestBed.configureTestingModule({ imports: [ExportsComponent, ResultsExportComponent], providers: [{ provide: ApiClient, useValue: api }] }); const session = TestBed.inject(SessionStore); session.workspace.set(workspace); session.etag.set('"v-current"');
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); sessionStorage.clear(); });
  async function renderExports() { const fixture = TestBed.createComponent(ExportsComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture; }
  it('keeps a voluntary historical selection after the application milestone, with only one download action', async () => {
    const view = TestBed.inject(WorkspaceViewStore), session = TestBed.inject(SessionStore);
    session.selectExportVersion('original');
    view.reconcile(workspace.id, 'current'); view.published(workspace.id, 'original', 'current', 'application-job', 'exports', 'receipt'); view.visit('exports');
    const activate = vi.spyOn(TestBed.inject(ExportStore), 'activate').mockResolvedValue();
    const fixture = await renderExports(), element = fixture.nativeElement as HTMLElement, button = element.querySelector<HTMLButtonElement>('button[data-download-action]');
    expect(view.recommended()).toBeNull(); expect(element.querySelectorAll('[data-download-action]')).toHaveLength(1); expect(element.querySelector('[data-applied-download]')).toBeNull();
    expect(activate).not.toHaveBeenCalled(); button!.click(); expect(activate).toHaveBeenCalledExactlyOnceWith();
    expect(session.exportVersionId()).toBe('original');
  });
  async function renderResults() { const fixture = TestBed.createComponent(ResultsExportComponent); fixture.componentRef.setInput('run', run); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture; }
  it('describes the selected historical profile instead of the current workspace profile', async () => {
    TestBed.inject(SessionStore).selectExportVersion('original'); const fixture = await renderExports(), element = fixture.nativeElement as HTMLElement;
    const content = element.querySelector('[aria-label="Contenido de la versión elegida"]'); expect(content).not.toBeNull();
    expect(content!.textContent).toContain('Versión 1'); expect(content!.textContent).toContain('histórica'); expect(content!.textContent).toContain('Demostración de texto y fechas'); expect(content!.textContent).not.toContain('COREP de fondos propios');
    expect(api.exportSummary).toHaveBeenCalledWith('workspace', 'original', 'report', undefined); expect(TestBed.inject(SessionStore).versionId()).toBe('current');
  });
  it('explains that excluded FINREP sheets are preserved without claiming they were validated', async () => {
    api.exportSummary.mockResolvedValue({ ...summary('current'), reports: [{ ...summary('current').reports[0], displayName: 'finrep.xlsx', profileId: 'eba-finrep-4.0-f0101-v1', selectedSheets: ['1.1'], excludedSheets: ['1.2', '1.3'] }] });
    const fixture = await renderExports(), content = (fixture.nativeElement as HTMLElement).textContent!;
    expect(content).toContain('FINREP · F 01.01');
    expect(content).toContain('2 hojas excluidas del cálculo');
    expect(content).toContain('Se conservan en el Excel FINREP exportado, sin considerarlas validadas');
    expect(content).not.toContain('Su contenido no se incluye');
  });
  it('navigates to the exact incomplete execution without preparing or transferring a package in Validar', async () => {
    const view = TestBed.inject(WorkspaceViewStore); view.reconcile(workspace.id, 'current');
    const fixture = await renderResults(), buttons = (fixture.nativeElement as HTMLElement).querySelectorAll('button');
    expect(buttons).toHaveLength(1); expect(buttons[0]!.textContent).toContain('Ir a Descargar resultados'); buttons[0]!.click();
    expect(view.downloadIntentEntry()?.intent).toEqual({ workspaceId: workspace.id, versionId: 'original', kind: 'results', runId: run.id });
    expect(api.exportResults).not.toHaveBeenCalled(); expect(api.downloadExport).not.toHaveBeenCalled();
    const exports = await renderExports(); expect(exports.nativeElement.textContent).toContain('Ejecución incompleta: el paquete conserva ese estado'); expect(exports.nativeElement.textContent).toContain('Versión 1');
  });
  it('renders compact counts and exclusions without expanding a large legacy context collection', async () => {
    api.exportSummary.mockResolvedValue({ ...summary('current'), reports: [{ sourceFileId: 'legacy', displayName: 'historico.xlsx', profileId: 'ce-report-1', contextCount: 100000, contextOrigin: 'workbook', selectedSheets: ['Contexts', 'Coordinates', 'Facts'], excludedSheets: ['Otra hoja'] }] });
    const fixture = await renderExports(), element = fixture.nativeElement as HTMLElement, content = element.querySelector('[aria-label="Contenido de la versión elegida"]')!;
    expect(content.textContent).toContain('1 informe'); expect(content.textContent).toContain('Formato anterior'); expect(content.textContent).toContain('100000 contextos'); expect(content.textContent).toContain('Varias entidades'); expect(content.textContent).toContain('Varias fechas');
    expect(content.querySelectorAll('tr')).toHaveLength(2); expect(content.querySelector('details')?.open).toBe(false); expect(content.textContent).toContain('Hojas excluidas de historico.xlsx'); expect(content.textContent).toContain('Otra hoja');
  });
  it('ignores a late summary for the previously selected version', async () => {
    let complete!: (value: ReturnType<typeof summary>) => void; api.exportSummary.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const fixture = await renderExports(); TestBed.inject(SessionStore).selectExportVersion('original'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    complete(summary('current')); await Promise.resolve(); fixture.detectChanges();
    const content = (fixture.nativeElement as HTMLElement).querySelector('[aria-label="Contenido de la versión elegida"]')!; expect(content.textContent).toContain('Demostración de texto y fechas'); expect(content.textContent).not.toContain('COREP de fondos propios');
  });
  it('recovers a failed metadata request without changing the selected historical version', async () => {
    api.exportSummary.mockRejectedValueOnce(new Error('Offline')); TestBed.inject(SessionStore).selectExportVersion('original'); const fixture = await renderExports(), element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('contenido de esta versión'); const retry = [...element.querySelectorAll('button')].find(button => button.textContent?.includes('Volver a consultar contenido'))!; retry.click(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(element.textContent).toContain('Demostración de texto y fechas'); expect(TestBed.inject(SessionStore).exportVersionId()).toBe('original'); expect(api.exportReport).not.toHaveBeenCalled();
  });
  it('rejects metadata returned for a different version and suppresses completion after workspace close', async () => {
    api.exportSummary.mockResolvedValueOnce(summary('original')); const fixture = await renderExports(); expect(fixture.componentInstance.store.summary()).toBeNull(); expect(fixture.componentInstance.store.summaryError()).not.toBeNull();
    let complete!: (value: ReturnType<typeof summary>) => void; api.exportSummary.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const loading = fixture.componentInstance.store.loadSummary(true); TestBed.inject(SessionStore).workspace.set(null); fixture.detectChanges(); complete(summary('current')); await loading; expect(fixture.componentInstance.store.summary()).toBeNull();
  });
  it('omits empty exclusions and keeps an existing report context available', async () => {
    TestBed.inject(SessionStore).selectExportVersion('original'); const fixture = await renderExports(), element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('details.excluded-sheets')).toBeNull(); expect(element.querySelector('details.trace-details')).not.toBeNull();
    api.exportSummary.mockResolvedValueOnce({ ...summary('original'), reports: [] }); await fixture.componentInstance.store.loadSummary(true); fixture.detectChanges();
    expect(element.querySelector('details')).toBeNull();
  });
  it('keeps the selected intent and matching summary when returning to Descargar', async () => {
    const fixture = await renderExports(), store = fixture.componentInstance.store; store.choose({ workspaceId: workspace.id, versionId: 'original', kind: 'report' }); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const calls = api.exportSummary.mock.calls.length; fixture.destroy(); const restored = await renderExports();
    expect(restored.componentInstance.store.intent()?.versionId).toBe('original'); expect(restored.nativeElement.textContent).toContain('Demostración de texto y fechas'); expect(api.exportSummary).toHaveBeenCalledTimes(calls);
  });
});

describe('read-only version export summary request', () => {
  it('uses the exact historical version and authentication without mutation headers', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }); const api = TestBed.inject(ApiClient), http = TestBed.inject(HttpTestingController); api.setSessionToken('memory-only');
    const loading = api.exportSummary('workspace', 'original'), request = http.expectOne('/api/v1/workspaces/workspace/versions/original/export-summary?kind=report');
    expect(request.request.method).toBe('GET'); expect(request.request.headers.get('X-CE-Session')).toBe('memory-only'); expect(request.request.headers.has('If-Match')).toBe(false); expect(request.request.headers.has('Idempotency-Key')).toBe(false);
    request.flush(summary('original')); expect((await loading).versionId).toBe('original'); http.verify(); TestBed.resetTestingModule();
  });
});
