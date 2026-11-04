import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuleResultDTO, ValidationResultsPageDTO } from '@ce/contracts';
import { DirectionsComponent } from './directions.component';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';

const workspaceId = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2', versionId = 'bfda41bd-2a55-4a80-9f22-2fc1aa89894c', nextVersion = '027345c5-36db-4bb2-bcee-0f55b13165ad', runId = '5976e981-9b8d-4e80-af2a-b1ffeced4b55';
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
const workspace = { id: workspaceId, name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: versionId, versionIds: [versionId], contexts: [], counts: { snapshots: 1, coordinates: 6, facts: 5, sources: 2 }, sessionBytes: 100 };
const target = { factKey: 'target', contextId: 'demo', tableCode: 'C_01.00', sheetCode: '', rowCode: '0230', columnCode: '0010', dataType: 'number' as const, unit: 'EUR', decimals: '2', axes: {}, sourceLocator: {} };
const result: RuleResultDTO = { id: 'result', runId, versionId, profileId: 'ce-dpmxl-0.9-closed-v1', instanceId: a, binding: { contextId: 'demo' }, coverageOnly: false,
  code: 'SYNTHETIC_A', variantIds: [a], sourceRecordIds: [], tables: ['C_01.00'], status: 'not_applicable', severity: 'error', severityOriginal: 'Error',
  expression: '{tC_01.00,r0230,c0010}=1', precondition: 'false', values: {}, readKeys: [], factReads: [], metadataReads: [], sources: [], diagnostics: [],
  recalculation: { policy: { mode: 'standard', profileId: 'ce-dpmxl-0.9-closed-v1', reasons: [] }, left: { eligible: true, target, diagnostics: [] }, right: { eligible: false, diagnostics: [{ code: 'INVALID_DIRECTION', message: 'El lado elegido debe ser una única celda declarada.' }] } } };
const page = { items: [result], total: 1, nextCursor: null, versionId, configuredDirections: [], run: { id: runId, versionId, profileId: result.profileId, status: 'completed' as const, startedAt: '2026-10-31T00:00:00.000Z', diagnostics: [], resultIds: [result.id],
  summary: { complete: true, rows: 1, variants: 1, applicableVariants: 1, instances: 1, duplicateRows: 0, byStatus: { pass: 0, fail: 0, not_applicable: 1, not_evaluable: 0, error: 0 } } } } as ValidationResultsPageDTO;
describe('explicit direction configuration', () => {
  let http: HttpTestingController, session: SessionStore;
  beforeEach(() => { TestBed.configureTestingModule({ imports: [DirectionsComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('memory-only'); session.workspace.set(workspace); session.etag.set('"v-' + versionId + '"'); });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  function render(data: ValidationResultsPageDTO = page) { const fixture = TestBed.createComponent(DirectionsComponent); fixture.componentRef.setInput('page', data); fixture.detectChanges(); TestBed.tick(); fixture.detectChanges(); return fixture; }
  function choose(fixture: ReturnType<typeof render>, value: string) { const select = (fixture.nativeElement as HTMLElement).querySelector('select')!; select.value = value; select.dispatchEvent(new Event('change')); fixture.detectChanges(); }
  it.each(['absent', 'undetermined', 'validation_only'] as const)('does not authorize a destination under %s policy, even if its structural side is eligible', async (mode) => {
    const { policy: _policy, ...sides } = result.recalculation!;
    const fixture = render({ ...page, items: [{ ...result, recalculation: mode === 'absent' ? sides : { ...sides, policy: { mode, profileId: result.profileId, reasons: mode === 'validation_only' ? ['TEXT'] : [] } } }] });
    expect((fixture.nativeElement as HTMLElement).querySelector('select')!.disabled).toBe(true);
    fixture.componentInstance.choose(fixture.componentInstance.page().items[0]!, 'left'); await fixture.componentInstance.save(); expect(fixture.componentInstance.draft()).toEqual({}); http.expectNone(request => request.method === 'PUT');
  });
  it('starts with no inferred target, allows a structurally eligible false-precondition side and explains the rejected side', () => {
    const fixture = render(), element = fixture.nativeElement as HTMLElement, select = element.querySelector('select')!;
    expect(select.value).toBe(''); expect(select.querySelector<HTMLOptionElement>('option[value="left"]')!.disabled).toBe(false); expect(select.querySelector<HTMLOptionElement>('option[value="right"]')!.disabled).toBe(true);
    expect(element.textContent).toContain('una única celda declarada'); expect(element.textContent).toContain('no modifica los valores');
    const save = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.includes('Guardar configuración'))!; expect(save.disabled).toBe(true);
    choose(fixture, 'left'); expect(save.disabled).toBe(false); http.expectNone(request => request.method !== 'GET');
  });
  it('sends the complete explicit selection including configured directions outside the page, then retains the old run as historical', async () => {
    const fixture = render({ ...page, configuredDirections: [{ instanceId: b, targetSide: 'right' }] } as ValidationResultsPageDTO);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('direcciones fuera de esta página'); choose(fixture, 'left');
    const saving = fixture.componentInstance.save(); const request = http.expectOne('/api/v1/workspaces/' + workspaceId + '/directions');
    expect(request.request.method).toBe('PUT'); expect(request.request.headers.get('If-Match')).toBe('"v-' + versionId + '"'); expect(request.request.headers.get('X-CE-Session')).toBe('memory-only');
    expect(request.request.body).toEqual({ directions: [{ instanceId: a, targetSide: 'left' }, { instanceId: b, targetSide: 'right' }] }); expect(request.request.body).not.toHaveProperty('expression');
    request.flush({ versionId: nextVersion, configVersion: 'changed', directions: [] }, { headers: { ETag: '"v-' + nextVersion + '"' } }); await Promise.resolve();
    http.expectOne('/api/v1/workspaces/' + workspaceId).flush({ ...workspace, currentVersionId: nextVersion, versionIds: [versionId, nextVersion] }, { headers: { ETag: '"v-' + nextVersion + '"' } }); await saving; fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(session.versionId()).toBe(nextVersion); expect(fixture.componentInstance.page().versionId).toBe(versionId); expect((fixture.nativeElement as HTMLElement).textContent).toContain('Configuración guardada');
    expect((fixture.nativeElement as HTMLElement).querySelector('select')!.disabled).toBe(true); http.expectNone(request => request.url.endsWith('/applications') || request.url.endsWith('/previews'));
  });
  it('preserves a draft across filters/pages and restores the full configuration after recreating the component', async () => {
    const configuredDirections = [{ instanceId: b, targetSide: 'right' as const }]; const fixture = render({ ...page, configuredDirections } as ValidationResultsPageDTO); choose(fixture, 'left');
    fixture.componentRef.setInput('page', { ...page, items: [{ ...result, id: 'other', instanceId: c, code: 'SYNTHETIC_C' }], configuredDirections }); fixture.detectChanges(); TestBed.tick(); choose(fixture, 'left');
    const saving = fixture.componentInstance.save(); const request = http.expectOne(request => request.url.endsWith('/directions'));
    expect(request.request.body.directions).toEqual([{ instanceId: a, targetSide: 'left' }, { instanceId: b, targetSide: 'right' }, { instanceId: c, targetSide: 'left' }]);
    request.flush({ error: { message: 'Rechazo de prueba' } }, { status: 422, statusText: 'Unprocessable Entity' }); await saving;
    fixture.destroy(); const restored = render({ ...page, configuredDirections } as ValidationResultsPageDTO); expect((restored.nativeElement as HTMLElement).textContent).toContain('direcciones fuera de esta página');
    choose(restored, 'left'); const retry = restored.componentInstance.save(); const restoredRequest = http.expectOne(request => request.url.endsWith('/directions')); expect(restoredRequest.request.body.directions).toHaveLength(3);
    restoredRequest.flush({ error: { message: 'Rechazo de prueba' } }, { status: 422, statusText: 'Unprocessable Entity' }); await retry;
  });
  it('never saves a historical or incomplete run or a page without a complete configuration list', async () => {
    const fixture = render(); choose(fixture, 'left'); session.workspace.set({ ...workspace, currentVersionId: nextVersion }); fixture.detectChanges(); await fixture.componentInstance.save();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('histórica'); http.expectNone(request => request.method === 'PUT');
    session.workspace.set(workspace); fixture.componentRef.setInput('page', { ...page, run: { ...page.run, status: 'incomplete' } }); fixture.detectChanges(); await fixture.componentInstance.save(); http.expectNone(request => request.method === 'PUT');
    fixture.destroy(); const { configuredDirections: _configured, ...missing } = page; const unavailable = render(missing); expect((unavailable.nativeElement as HTMLElement).textContent).toContain('configuración completa'); await unavailable.componentInstance.save(); http.expectNone(request => request.method === 'PUT');
  });
  it('can explicitly clear every configured direction, including hidden choices', async () => {
    const fixture = render({ ...page, configuredDirections: [{ instanceId: b, targetSide: 'right' }] } as ValidationResultsPageDTO);
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(button => button.textContent?.includes('Quitar todas'))!.click(); fixture.detectChanges();
    const saving = fixture.componentInstance.save(); const request = http.expectOne(request => request.url.endsWith('/directions')); expect(request.request.body).toEqual({ directions: [] });
    request.flush({ error: { message: 'Rechazo de prueba' } }, { status: 422, statusText: 'Unprocessable Entity' }); await saving;
  });
  it('refreshes after a stale-version rejection, keeps the draft visible and requires a current validation before retry', async () => {
    const fixture = render(); choose(fixture, 'left'); const saving = fixture.componentInstance.save();
    http.expectOne(request => request.url.endsWith('/directions')).flush({ error: { code: 'STALE_VERSION', message: 'La versión ha cambiado.' } }, { status: 412, statusText: 'Precondition Failed' }); await Promise.resolve();
    http.expectOne('/api/v1/workspaces/' + workspaceId).flush({ ...workspace, currentVersionId: nextVersion }, { headers: { ETag: '"v-' + nextVersion + '"' } }); await saving; fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.componentInstance.draft()[a]).toBe('left'); expect((fixture.nativeElement as HTMLElement).textContent).toContain('La versión ha cambiado'); expect((fixture.nativeElement as HTMLElement).querySelector('select')!.value).toBe('left'); expect((fixture.nativeElement as HTMLElement).querySelector('select')!.disabled).toBe(true);
    await fixture.componentInstance.save(); http.expectNone(request => request.method === 'PUT');
  });
  it('keeps saving blocked after a stale rejection even when the workspace refresh fails', async () => {
    const fixture = render(); choose(fixture, 'left'); const saving = fixture.componentInstance.save();
    http.expectOne(request => request.url.endsWith('/directions')).flush({ error: { code: 'STALE_VERSION', message: 'La versión ha cambiado.' } }, { status: 412, statusText: 'Precondition Failed' }); await Promise.resolve();
    http.expectOne('/api/v1/workspaces/' + workspaceId).flush({ error: { message: 'No disponible' } }, { status: 503, statusText: 'Service Unavailable' }); await saving; fixture.detectChanges();
    expect(fixture.componentInstance.draft()[a]).toBe('left'); expect(fixture.componentInstance.canSave()).toBe(false); expect((fixture.nativeElement as HTMLElement).textContent).toContain('Recarga la sesión');
    await fixture.componentInstance.save(); http.expectNone(request => request.method === 'PUT');
  });
});
