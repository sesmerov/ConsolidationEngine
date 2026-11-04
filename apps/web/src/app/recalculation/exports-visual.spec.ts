import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExportsComponent } from './exports.component';
import { ResultsExportComponent } from '../validation/results-export.component';
import { ExportStore } from './export.store';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

const workspace = { id: 'workspace', name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: 'current', versionIds: ['original', 'current'], contexts: [], counts: { snapshots: 2, coordinates: 110, facts: 15, sources: 2 }, sessionBytes: 100 };
const run = { id: 'run-original', versionId: 'original', profileId: 'ce-dpmxl-0.9-typed-v2', status: 'incomplete' as const, startedAt: '2026-11-04T00:00:00.000Z', resultIds: [], diagnostics: [], summary: { complete: false, rows: 8, variants: 8, applicableVariants: 8, instances: 3, duplicateRows: 0, byStatus: { pass: 3, fail: 0, not_evaluable: 0, not_applicable: 0, error: 0 } } };
const summary = (versionId: string) => ({ versionId, profileId: 'ce-dpmxl-0.9-typed-v2', createdAt: '2026-11-04T00:00:00.000Z', reports: [{ sourceFileId: 'report', displayName: versionId === 'original' ? 'tipos.xlsx' : 'corep.xlsx', profileId: versionId === 'original' ? 'ce-demo-types-1' : 'eba-corep-of-4.0-ca1-v1', contextCount: 1, commonEntityId: 'SYNTHETIC', commonReferenceDate: '2025-12-31', contextOrigin: 'workbook', selectedSheets: versionId === 'original' ? ['Datos'] : ['CA1'], excludedSheets: versionId === 'original' ? [] : ['CA2'], ...(versionId === 'original' ? {} : { scaleExponent: 0, displayDecimals: 2 }) }] });
describe('visual export content and exact artifact identity', () => {
  const api = { runs: vi.fn(), exportSummary: vi.fn(), exportReport: vi.fn(), exportResults: vi.fn(), downloadExport: vi.fn() };
  beforeEach(() => {
    vi.resetAllMocks(); api.runs.mockResolvedValue({ items: [run], total: 1, nextCursor: null, revision: 'r' }); api.exportSummary.mockImplementation((_workspace: string, versionId: string) => Promise.resolve(summary(versionId)));
    TestBed.configureTestingModule({ imports: [ExportsComponent, ResultsExportComponent], providers: [{ provide: ApiClient, useValue: api }] }); const session = TestBed.inject(SessionStore); session.workspace.set(workspace); session.etag.set('"v-current"');
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
  async function renderExports() { const fixture = TestBed.createComponent(ExportsComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture; }
  async function renderResults() { const fixture = TestBed.createComponent(ResultsExportComponent); fixture.componentRef.setInput('run', run); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture; }
  it('describes the selected historical profile instead of the current workspace profile', async () => {
    TestBed.inject(SessionStore).selectExportVersion('original'); const fixture = await renderExports(), element = fixture.nativeElement as HTMLElement;
    const content = element.querySelector('[aria-label="Contenido de la versión elegida"]'); expect(content).not.toBeNull();
    expect(content!.textContent).toContain('Versión 1'); expect(content!.textContent).toContain('histórica'); expect(content!.textContent).toContain('Demostración de texto y fechas'); expect(content!.textContent).not.toContain('COREP de fondos propios');
    expect(api.exportSummary).toHaveBeenCalledWith('workspace', 'original'); expect(TestBed.inject(SessionStore).versionId()).toBe('current');
  });
  it.each(['report', 'other-version', 'other-run'] as const)('does not offer a repeat download for an unrelated %s artifact', async kind => {
    const fixture = await renderResults(); const artifact = { workspaceId: workspace.id, versionId: kind === 'other-version' ? 'current' : 'original', id: 'artifact', filename: kind === 'report' ? 'report.zip' as const : 'results.zip' as const, kind: kind === 'report' ? 'report' as const : 'results' as const, runId: kind === 'other-run' ? 'other-run' : run.id };
    TestBed.inject(ExportStore).ready.set(artifact); fixture.detectChanges();
    expect([...((fixture.nativeElement as HTMLElement).querySelectorAll('button'))].filter(button => button.textContent?.includes('de nuevo'))).toHaveLength(0);
  });
  it('identifies incomplete execution exports with their own version and preserves their status', async () => {
    const fixture = await renderResults(), text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('Descargar resultados de esta ejecución'); expect(text).toContain('Versión 1'); expect(text).toContain('Ejecución incompleta: el paquete conserva ese estado');
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
  it('retains a matching ready result artifact and downloads only that exact execution', async () => {
    const fixture = await renderResults(), artifact = { workspaceId: workspace.id, versionId: run.versionId, kind: 'results' as const, runId: run.id, id: 'correct-artifact', filename: 'results.zip' as const };
    const store = TestBed.inject(ExportStore), download = vi.spyOn(store, 'download').mockResolvedValue(); store.ready.set(artifact); fixture.detectChanges();
    const button = [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')].find(button => button.textContent?.includes('Descargar resultados de nuevo'))!; expect(button).toBeDefined(); button.click(); expect(download).toHaveBeenCalledWith(artifact);
    fixture.componentRef.setInput('run', { ...run, id: 'another-run' }); fixture.detectChanges(); expect((fixture.nativeElement as HTMLElement).textContent).not.toContain('Descargar resultados de nuevo');
  });
  it('keeps the latest package identity separate from a newly selected version', async () => {
    const fixture = await renderExports(); TestBed.inject(ExportStore).ready.set({ workspaceId: workspace.id, versionId: 'original', kind: 'report', id: 'old-package', filename: 'report.zip' }); fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('Informes y cambios · Versión 1'); expect(TestBed.inject(SessionStore).exportVersionId()).toBe('current');
    fixture.destroy(); const restored = await renderExports(); expect(restored.componentInstance.ready()?.versionId).toBe('original'); expect(api.exportSummary).toHaveBeenCalledTimes(1);
  });
});

describe('read-only version export summary request', () => {
  it('uses the exact historical version and authentication without mutation headers', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }); const api = TestBed.inject(ApiClient), http = TestBed.inject(HttpTestingController); api.setSessionToken('memory-only');
    const loading = api.exportSummary('workspace', 'original'), request = http.expectOne('/api/v1/workspaces/workspace/versions/original/export-summary');
    expect(request.request.method).toBe('GET'); expect(request.request.headers.get('X-CE-Session')).toBe('memory-only'); expect(request.request.headers.has('If-Match')).toBe(false); expect(request.request.headers.has('Idempotency-Key')).toBe(false);
    request.flush(summary('original')); expect((await loading).versionId).toBe('original'); http.verify(); TestBed.resetTestingModule();
  });
});
