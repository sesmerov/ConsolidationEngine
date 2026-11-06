import { TestBed } from '@angular/core/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonHarness } from '@angular/material/button/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportPageComponent } from './import-page.component';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';

const workspace = { id: 'workspace', name: 'Demostración', state: 'ready' as const, currentVersionId: 'v1', versionIds: ['v1'], contexts: [], counts: { snapshots: 1, coordinates: 6, facts: 6, sources: 2 }, sessionBytes: 1 };
describe('separate guided visual demonstrations', () => {
  const api = { capabilities: vi.fn(), activeImportInspection: vi.fn(), rules: vi.fn(), visualDemo: vi.fn(), inspectImport: vi.fn(), importFiles: vi.fn(), replaceDirections: vi.fn() };
  beforeEach(() => {
    vi.clearAllMocks(); api.capabilities.mockResolvedValue({ knownDifferences: [] }); api.activeImportInspection.mockResolvedValue({ active: null });
    api.rules.mockResolvedValue({ items: [], total: 0, nextCursor: null, versionId: 'v1', sources: [], coverage: {}, dataSummary: {} }); api.visualDemo.mockResolvedValue(new Blob(['demo']));
    TestBed.configureTestingModule({ imports: [ImportPageComponent], providers: [{ provide: ApiClient, useValue: api }] }); const session = TestBed.inject(SessionStore); session.workspace.set(workspace); session.etag.set('"v-v1"');
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.restoreAllMocks(); });
  async function render() { const fixture = TestBed.createComponent(ImportPageComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges(); return fixture; }
  it('offers separate COREP and text/date guides without changing uploaded data or configuring targets', async () => {
    const fixture = await render(), element = fixture.nativeElement as HTMLElement, selector = element.querySelector<HTMLSelectElement>('#demo-selector');
    expect(selector).not.toBeNull(); expect([...selector!.options].map(option => option.value)).toEqual(['corep', 'types']);
    const store = fixture.componentInstance.store, catalog = new File(['catalog'], 'kept.xlsx'), report = new File(['report'], 'kept-report.xlsx');
    store.catalog.set(catalog); store.reports.set([report]); store.setContextSource('form'); store.updateContext('entityId', 'Conservar'); fixture.detectChanges(); await fixture.whenStable();
    selector!.value = 'types'; selector!.dispatchEvent(new Event('change')); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(store.catalog()).toBe(catalog); expect(store.reports()).toEqual([report]); expect(store.contextSource()).toBe('form'); expect(store.contextForm().entityId).toBe('Conservar');
    expect(element.querySelector('[aria-label="Demostraciones guiadas"]')?.textContent).toContain('8 reglas sintéticas');
    expect(api.inspectImport).not.toHaveBeenCalled(); expect(api.importFiles).not.toHaveBeenCalled(); expect(api.replaceDirections).not.toHaveBeenCalled();
  });
  it('exposes both visual demos without offering the previous workbook downloads or eight-step guide', async () => {
    const fixture = await render(), loader = TestbedHarnessEnvironment.loader(fixture);
    expect(await loader.hasHarness(MatButtonHarness.with({ text: 'Descargar catálogo COREP' }))).toBe(true);
    expect(await loader.hasHarness(MatButtonHarness.with({ text: 'Descargar informe COREP' }))).toBe(true);
    for (const demo of ['corep', 'types']) {
      fixture.componentInstance.store.selectDemo(demo); fixture.detectChanges();
      expect((fixture.nativeElement as HTMLElement).textContent).not.toMatch(/Descargar (plantilla Excel anterior|catálogo del ejemplo|informe del ejemplo)|Empezar con el ejemplo guiado/);
    }
    expect(await loader.hasHarness(MatButtonHarness.with({ text: 'Descargar informe de texto y fechas' }))).toBe(true);
  });
  it('distinguishes the published version coverage from a candidate under review', async () => {
    const fixture = await render(); expect((fixture.nativeElement as HTMLElement).querySelector('#coverage-title')?.textContent).toContain('Datos cargados · Versión 1');
  });
  it('shows the typed workbook actual filing indicator instead of an unrelated COREP table', async () => {
    api.activeImportInspection.mockResolvedValue({ active: { id: 'inspection', workspaceId: workspace.id, baseVersionId: 'v1', state: 'ready', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), inspectionHash: 'a'.repeat(64), profiles: [], reports: [], diagnostics: [], requiresPartialCoverageAcceptance: false,
      context: [{ sourceFileId: 'typed', origin: 'workbook', declaration: { contextId: 'demo_types', entityId: 'SYNTHETIC', referenceDate: '2025-12-31', framework: 'DEMO', moduleVersion: 'DEMO_TYPES_1', filingIndicators: { DEMO_TYPES: true } } }] } });
    const fixture = await render(), review = (fixture.nativeElement as HTMLElement).querySelector('[aria-label="Revisión de la carga"]')!;
    expect(review.textContent).toContain('DEMO_TYPES'); expect(review.textContent).not.toContain('Tabla C_01.00'); expect(review.textContent).toContain('Presentada');
    const store = fixture.componentInstance.store, candidate = store.inspection(); expect(store.canCommit()).toBe(true);
    store.selectDemo('types'); fixture.detectChanges(); await fixture.whenStable();
    expect(store.inspection()).toBe(candidate); expect(store.reviewDirty()).toBe(false); expect(store.canCommit()).toBe(true);
  });
  it('downloads each explicitly selected artifact with its own filename and retains the guide across stage remounts', async () => {
    const fixture = await render(), store = fixture.componentInstance.store, loader = TestbedHarnessEnvironment.loader(fixture), names: string[] = [];
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:synthetic'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { names.push(this.download); });
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Descargar catálogo COREP' }))).click();
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Descargar informe COREP' }))).click();
    store.selectDemo('types'); fixture.detectChanges();
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Descargar catálogo de texto y fechas' }))).click();
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Descargar informe de texto y fechas' }))).click();
    expect(api.visualDemo.mock.calls).toEqual([['corep', 'catalog'], ['corep', 'report'], ['types', 'catalog'], ['types', 'report']]);
    expect(names).toEqual(['demo-corep-catalog.xlsx', 'demo-corep-report.xlsx', 'demo-types-catalog.xlsx', 'demo-types-report.xlsx']); expect(create).toHaveBeenCalledTimes(4);
    TestBed.inject(SessionStore).workspace.set({ ...workspace, name: 'Mismo conjunto actualizado' }); fixture.detectChanges(); await fixture.whenStable(); expect(store.selectedDemo()).toBe('types');
    fixture.destroy(); const restored = await render(); expect(restored.componentInstance.store.selectedDemo()).toBe('types');
    expect(api.inspectImport).not.toHaveBeenCalled(); expect(api.replaceDirections).not.toHaveBeenCalled();
  });
  it('offers a retry after download failure without losing files or changing the catalog', async () => {
    const fixture = await render(), store = fixture.componentInstance.store, catalog = new File(['catalog'], 'kept.xlsx'); store.catalog.set(catalog); api.visualDemo.mockRejectedValueOnce(new Error('Offline'));
    await store.downloadVisualDemo('catalog'); fixture.detectChanges(); expect(store.demoDownloading()).toBe(false); expect(store.catalog()).toBe(catalog);
    expect((fixture.nativeElement as HTMLElement).querySelector('[aria-label="Demostraciones guiadas"] [role="alert"]')?.textContent).toContain('volver a intentarlo');
  });
  it('suppresses duplicate pending downloads and late completion after closing the workspace', async () => {
    const fixture = await render(), store = fixture.componentInstance.store; let resolve!: (value: Blob) => void;
    api.visualDemo.mockImplementationOnce(() => new Promise<Blob>(done => { resolve = done; })); const create = vi.spyOn(URL, 'createObjectURL');
    const downloading = store.downloadVisualDemo('catalog'); await store.downloadVisualDemo('report'); expect(api.visualDemo).toHaveBeenCalledTimes(1); expect(store.demoDownloading()).toBe(true);
    TestBed.inject(SessionStore).workspace.set(null); fixture.detectChanges(); await fixture.whenStable(); resolve(new Blob(['late'])); await downloading;
    expect(create).not.toHaveBeenCalled(); expect(store.demoDownloading()).toBe(false); expect(store.selectedDemo()).toBe('corep');
  });
  it('explains the two numerical dependency branches and distinguishes conditional validation from the five explicit directions', async () => {
    const fixture = await render(), guide = (fixture.nativeElement as HTMLElement).querySelector('[aria-label="Demostraciones guiadas"]')!;
    expect(guide.textContent).toContain('5 procedentes de la EBA y 11 sintéticas'); expect(guide.textContent).toContain('Todos sus datos son sintéticos');
    expect(guide.textContent).toContain('v0174_m → v0173_m → v0172_m'); expect(guide.textContent).toContain('v0176_m → v0175_m → v0172_m');
    expect(guide.textContent).toContain('DEMO_IF_THEN y DEMO_IF_ELSE'); expect(guide.textContent).toContain('DEMO_LT_FAIL seguirá fallando');
    expect(guide.querySelectorAll('table[aria-label="Cambios esperados COREP"] tr').length).toBe(6);
    expect(api.replaceDirections).not.toHaveBeenCalled();
  });
});

describe('authenticated visual demonstration download routes', () => {
  let http: HttpTestingController, api: ApiClient;
  beforeEach(() => { TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); api = TestBed.inject(ApiClient); api.setSessionToken('memory-only'); });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  it.each([['corep', 'catalog'], ['corep', 'report'], ['types', 'catalog'], ['types', 'report']] as const)('GETs %s/%s without mutation headers', async (kind, artifact) => {
    const downloading = api.visualDemo(kind, artifact), request = http.expectOne(`/api/v1/templates/demos/${kind}/${artifact}`), blob = new Blob(['workbook']);
    expect(request.request.method).toBe('GET'); expect(request.request.responseType).toBe('blob'); expect(request.request.headers.get('X-CE-Session')).toBe('memory-only');
    expect(request.request.headers.has('If-Match')).toBe(false); expect(request.request.headers.has('Idempotency-Key')).toBe(false); request.flush(blob); expect(await downloading).toBe(blob);
  });
});
