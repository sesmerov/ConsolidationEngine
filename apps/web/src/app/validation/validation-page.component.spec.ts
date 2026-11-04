import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ValidationPageComponent } from './validation-page.component';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
const workspaceId = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2', versionId = 'bfda41bd-2a55-4a80-9f22-2fc1aa89894c', runId = '5976e981-9b8d-4e80-af2a-b1ffeced4b55';
const workspace = { id: workspaceId, name: 'Cierre', state: 'ready' as const, currentVersionId: versionId, versionIds: [versionId], contexts: [], counts: { snapshots: 1, coordinates: 6, facts: 5, sources: 2 }, sessionBytes: 100 };
const summary = { complete: true, rows: 3, variants: 3, applicableVariants: 1, instances: 1, duplicateRows: 0, byStatus: { pass: 1, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 } };
const result = { id: 'result-1', runId, instanceId: 'a'.repeat(64), code: 'v0190_m', variantIds: ['b'.repeat(64)], sourceRecordIds: [], coverageOnly: false, tables: ['C_01.00'], readKeys: [], versionId, profileId: 'ce-dpmxl-0.9-closed-v1', status: 'pass', severity: 'warning', severityOriginal: 'Warning',
  expression: '1/3 = 1/3', precondition: '{v_C_01.00}', values: { left: { kind: 'number', nominal: { numerator: '1', denominator: '3' }, interval: { lo: { numerator: '1', denominator: '3' }, hi: { numerator: '1', denominator: '3' } }, unit: 'pure' } },
  recalculation: { policy: { profileId: 'ce-dpmxl-0.9-closed-v1', mode: 'standard', reasons: [] }, left: { eligible: false, diagnostics: [] }, right: { eligible: false, diagnostics: [] } },
  factReads: [], sources: [{ sheet: 'Facts', row: 2, column: 'G' }], diagnostics: [], metadataReads: [{ contextId: 'demo', code: 'C_01.00', presence: 'declared', value: true }] };
const page = { items: [result], total: 1, nextCursor: null, versionId, configuredDirections: [], run: { id: runId, versionId, profileId: 'ce-dpmxl-0.9-closed-v1', status: 'completed', startedAt: '2026-10-31T00:00:00.000Z', endedAt: '2026-10-31T00:00:01.000Z', summary, resultIds: ['result-1'], diagnostics: [] } };
const terminalJob = { jobId: '0cfafc23-142c-48f1-8cdf-c346df5ec02b', workspaceId, kind: 'validate' as const, status: 'succeeded' as const, baseVersionId: versionId, progress: { completed: 1, total: 1, complete: true }, resultRef: { type: 'validation', id: runId }, diagnostics: [], pollAfterMs: 1000 };
describe('validation page HTTP workflow', () => {
  let http: HttpTestingController, session: SessionStore;
  beforeEach(() => { TestBed.configureTestingModule({ imports: [ValidationPageComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('memory-only'); session.workspace.set(workspace); session.etag.set('"v-' + versionId + '"'); });
  function flushHistory() { for (const request of http.match(request => request.url.endsWith('/runs'))) request.flush({ items: [], total: 0, nextCursor: null, revision: 'rev' }); }
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  it('starts validation against the visible snapshot and separates pass from warning severity with exact values', async () => {
    const fixture = TestBed.createComponent(ValidationPageComponent); fixture.detectChanges(); flushHistory();
    const button = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find((element) => element.textContent?.includes('Validar informes'))!; expect(button).toBeDefined(); button.click();
    const request = http.expectOne((item) => item.url.endsWith('/validations')); expect(request.request.body).toEqual({ baseVersionId: versionId }); expect(request.request.headers.get('If-Match')).toBe('"v-' + versionId + '"'); expect(request.request.headers.get('X-CE-Session')).toBe('memory-only');
    request.flush(terminalJob); await Promise.resolve(); TestBed.tick();
    http.expectOne((item) => item.url.endsWith('/runs/' + runId + '/results')).flush(page); await Promise.resolve(); fixture.detectChanges(); flushHistory();
    const element = fixture.nativeElement as HTMLElement; expect(element.textContent).toContain('Pasa'); expect(element.textContent).toContain('Advertencia');
    expect(element.querySelector('ce-calculation-detail')).toBeNull();
    element.querySelector<HTMLButtonElement>('button[aria-label="Ver cálculo y origen de v0190_m"]')!.click(); fixture.detectChanges();
    const detail = element.querySelector('[role="region"][aria-label="Cálculo y origen de v0190_m"]')!;
    expect(detail.textContent).toContain('1/3'); expect(detail.textContent).toContain('Facts'); expect(detail.textContent).toContain('G2'); expect(detail.textContent).not.toContain('0.333333');
  });
  it('keeps the historical run visible but labels it after the current snapshot changes', async () => {
    session.job.set(terminalJob); const fixture = TestBed.createComponent(ValidationPageComponent); fixture.detectChanges(); flushHistory(); TestBed.tick();
    http.expectOne((item) => item.url.endsWith('/runs/' + runId + '/results')).flush(page); await Promise.resolve(); fixture.detectChanges(); flushHistory();
    session.workspace.set({ ...workspace, currentVersionId: '027345c5-36db-4bb2-bcee-0f55b13165ad', versionIds: [versionId, '027345c5-36db-4bb2-bcee-0f55b13165ad'] }); TestBed.tick(); fixture.detectChanges(); flushHistory();
    const text = (fixture.nativeElement as HTMLElement).textContent!; expect(text).toContain('histórico'); expect(text).toContain('v0190_m'); expect(text).toContain(versionId);
  });
  it('never presents a cancelled run as a complete approval', async () => {
    session.job.set({ ...terminalJob, status: 'cancelled', progress: { completed: 0, total: 1, complete: false } });
    const fixture = TestBed.createComponent(ValidationPageComponent); fixture.detectChanges(); flushHistory(); TestBed.tick();
    http.expectOne((item) => item.url.endsWith('/runs/' + runId + '/results')).flush({ ...page, items: [], total: 0, run: { ...page.run, status: 'incomplete', summary: { ...summary, complete: false, instances: 0, byStatus: { pass: 0, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 } }, resultIds: [] } });
    await Promise.resolve(); fixture.detectChanges(); flushHistory(); const text = (fixture.nativeElement as HTMLElement).textContent!.toLowerCase(); expect(text).toContain('incompleta'); expect(text).not.toContain('todo correcto');
  });
  it('does not equate a completed run with zero evaluated rules to approval', async () => {
    session.job.set(terminalJob); const fixture = TestBed.createComponent(ValidationPageComponent); fixture.detectChanges(); flushHistory(); TestBed.tick();
    http.expectOne((item) => item.url.endsWith('/runs/' + runId + '/results')).flush({ ...page,
      items: [{ ...result, status: 'not_applicable' }, { ...result, id: 'result-2', code: 'unsupported', status: 'not_evaluable' }], total: 2,
      run: { ...page.run, summary: { ...summary, instances: 0, byStatus: { pass: 0, fail: 0, not_applicable: 1, not_evaluable: 1, error: 0 } }, resultIds: ['result-1', 'result-2'] } });
    await Promise.resolve(); fixture.detectChanges(); flushHistory(); const text = (fixture.nativeElement as HTMLElement).textContent!.toLowerCase();
    expect(text).toContain('sin reglas evaluadas'); expect(text).not.toContain('todo correcto'); expect(text).not.toContain('validación correcta');
  });
});
