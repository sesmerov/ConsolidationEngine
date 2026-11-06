import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplyComponent } from './apply.component';
import { ComparisonComponent } from './comparison.component';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
const workspaceId = '00000000-0000-4000-8000-000000000061', versionId = '00000000-0000-4000-8000-000000000062', previewId = '00000000-0000-4000-8000-000000000063';
const nextVersion = '00000000-0000-4000-8000-000000000064', aId = '00000000-0000-4000-8000-000000000065', dId = '00000000-0000-4000-8000-000000000066';
const workspace = { id: workspaceId, name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: versionId, versionIds: [versionId], contexts: [], counts: { snapshots: 1, coordinates: 4, facts: 4, sources: 2 }, sessionBytes: 100 };
const coordinate = { factKey: 'A', contextId: 'demo', tableCode: 'T', rowCode: '0010', columnCode: '0010', sheetCode: '', dataType: 'number', decimals: '2', unit: 'EUR', sourceLocator: {} };
const a = { id: aId, previewId, directionId: 'a'.repeat(64), instanceId: 'a'.repeat(64), variantIds: [], binding: {}, code: 'SYNTHETIC_A', targetKey: 'A', state: 'available',
  before: { factKey: 'A', coordinate, presence: 'value', normalizedValue: { numerator: '11', denominator: '1' }, originalText: '11', sourceLocator: {} },
  after: { normalizedValue: { numerator: '12', denominator: '1' }, originalText: '12.00', unit: 'EUR', decimals: '2' }, readKeys: [], predecessorIds: [], metadataReads: [], sources: [], diagnostics: [] };
const d = { ...a, id: dId, directionId: 'd'.repeat(64), instanceId: 'd'.repeat(64), code: 'SYNTHETIC_D', targetKey: 'D', before: { ...a.before, factKey: 'D', coordinate: { ...coordinate, factKey: 'D', rowCode: '0040' }, originalText: '22', normalizedValue: { numerator: '22', denominator: '1' } }, after: { ...a.after, originalText: '24.00', normalizedValue: { numerator: '24', denominator: '1' } }, predecessorIds: [aId] };
const preview = { id: previewId, baseVersionId: versionId, profileId: 'profile', policyId: 'half-even-v1', createdAt: '2026-10-31T00:00:00.000Z', state: 'ready', proposalIds: [aId, dId], graphSummary: { nodes: 2, edges: 1, order: [], cycles: [], conflicts: [], blocked: 0 }, diagnostics: [] };
const selection = { selectedIds: [aId, dId], requiredIds: [], closureHash: 'a'.repeat(64), complete: true, state: 'ready' };
describe('explicit application acceptance and recovery', () => {
  let http: HttpTestingController, session: SessionStore;
  beforeEach(() => { TestBed.configureTestingModule({ imports: [ApplyComponent, ComparisonComponent], providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('memory-only'); session.workspace.set(workspace); session.etag.set('"v-' + versionId + '"'); });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  function render(options: { preview?: object; selection?: { selectedIds: readonly string[] }; proposals?: readonly object[] } = {}) {
    const fixture = TestBed.createComponent(ApplyComponent);
    const closure = options.selection ?? selection;
    fixture.componentRef.setInput('preview', options.preview ?? preview);
    fixture.componentRef.setInput('selectedIds', closure.selectedIds);
    fixture.componentRef.setInput('selection', closure);
    fixture.componentRef.setInput('proposals', options.proposals ?? [a, d]);
    fixture.detectChanges(); TestBed.tick(); fixture.detectChanges(); return fixture;
  }
  function button(fixture: ReturnType<typeof render>, text: string) { return Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button')).find(button => button.textContent?.includes(text))!; }
  function acknowledge(fixture: ReturnType<typeof render>) { const checkbox = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type="checkbox"]')!; checkbox.click(); fixture.detectChanges(); }
  it('shows every selected change and ancestor, requiring express acceptance before posting the exact set', async () => {
    const fixture = render(), element = fixture.nativeElement as HTMLElement;
    const review = element.querySelector<HTMLDetailsElement>('details.selection-review')!; expect(review.open).toBe(false); review.querySelector('summary')!.click(); fixture.detectChanges(); expect(review.open).toBe(true);
    for (const text of ['SYNTHETIC_A', 'SYNTHETIC_D', '11,00', '12,00', '22,00', '24,00']) expect(review.textContent).toContain(text);
    expect(review.querySelectorAll('.selected-changes > li')).toHaveLength(2);
    expect(button(fixture, 'Aplicar cambios seleccionados').disabled).toBe(true); http.expectNone(request => request.method === 'POST');
    acknowledge(fixture); button(fixture, 'Aplicar cambios seleccionados').click(); fixture.detectChanges();
    const request = http.expectOne(request => request.url.endsWith('/applications')); expect(request.request.method).toBe('POST');
    expect(request.request.headers.get('If-Match')).toBe('"v-' + versionId + '"'); expect(request.request.headers.get('X-CE-Session')).toBe('memory-only'); expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    expect(request.request.body).toEqual({ baseVersionId: versionId, previewId, selectedIds: [aId, dId], closureHash: selection.closureHash });
    request.flush({ jobId: 'accepted', workspaceId, kind: 'apply', status: 'queued', progress: { completed: 0, total: 2, complete: false }, diagnostics: [], pollAfterMs: 60000 }); await Promise.resolve();
    expect(session.job()?.jobId).toBe('accepted'); expect(session.versionId()).toBe(versionId);
  });
  it.each([
    { selection: { ...selection, selectedIds: [dId], requiredIds: [aId], complete: false }, proposals: [d] },
    { selection: { ...selection, selectedIds: [], complete: true }, proposals: [] },
    { selection, proposals: [d] }, // Details for A are absent; an opaque ID is not enough to confirm it.
    { preview: { ...preview, state: 'obsolete' }, selection: { ...selection, state: 'obsolete' } },
    { preview: { ...preview, state: 'discarded' } },
  ])('never confirms incomplete, empty, missing-detail or unavailable selections (%#)', (options) => {
    const fixture = render(options);
    const action = button(fixture, 'Aplicar cambios seleccionados');
    if (options.preview || options.selection.selectedIds.length === 0) expect(action).toBeUndefined();
    else expect(action.disabled).toBe(true);
    http.expectNone(request => request.method === 'POST');
  });
  it('resets express acknowledgement when the selected set changes', () => {
    const fixture = render(); acknowledge(fixture); expect(button(fixture, 'Aplicar cambios seleccionados').disabled).toBe(false);
    fixture.componentRef.setInput('selectedIds', [aId]); fixture.componentRef.setInput('selection', { ...selection, selectedIds: [aId], closureHash: 'b'.repeat(64) }); fixture.componentRef.setInput('proposals', [a]); fixture.detectChanges(); TestBed.tick(); fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked).toBe(false); expect(button(fixture, 'Aplicar cambios seleccionados').disabled).toBe(true);
  });
  it('explains a no-op and preserves the existing calculated provenance in the confirmation', () => {
    const fixture = render({ selection: { ...selection, selectedIds: [aId] }, proposals: [{ ...a, before: { ...a.before, originalText: '12', normalizedValue: { numerator: '12', denominator: '1' }, derivation: { receiptId: 'previous-receipt', previewId, proposalId: aId, baseVersionId: versionId } } }] });
    const element = fixture.nativeElement as HTMLElement, review = element.querySelector<HTMLDetailsElement>('details.selection-review')!; review.querySelector('summary')!.click(); fixture.detectChanges();
    expect(review.textContent).toContain('Sin cambio de valor'); expect(review.textContent).toContain('Recalculado'); expect(review.textContent).toContain('12,00');
    const provenance = Array.from(review.querySelectorAll<HTMLDetailsElement>('details')).find(detail => detail.textContent?.includes('previous-receipt'))!;
    expect(provenance).toBeDefined(); provenance.querySelector('summary')!.click(); expect(provenance.open).toBe(true); expect(provenance.textContent).toContain('previous-receipt');
  });
  it('does not register an acceptance that arrives after the workspace closes', async () => {
    const fixture = render(); acknowledge(fixture); button(fixture, 'Aplicar cambios seleccionados').click(); const request = http.expectOne(request => request.url.endsWith('/applications'));
    session.workspace.set(null); TestBed.tick(); request.flush({ jobId: 'old', workspaceId, kind: 'apply', status: 'queued', progress: { completed: 0, total: 2, complete: false }, diagnostics: [] }); await Promise.resolve();
    expect(session.job()).toBeNull();
  });
  it('reports stale rejection without pretending changes were applied', async () => {
    const fixture = render(); acknowledge(fixture); button(fixture, 'Aplicar cambios seleccionados').click();
    http.expectOne(request => request.url.endsWith('/applications')).flush({ error: { code: 'STALE_VERSION', message: 'La versión ha cambiado.' } }, { status: 412, statusText: 'Precondition Failed' }); await Promise.resolve(); fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('La versión ha cambiado.'); expect(session.versionId()).toBe(versionId); expect(button(fixture, 'Aplicar cambios seleccionados').disabled).toBe(true);
  });
  it('retries an uncertain network response with the same key, body and original CAS even after a newer version is observed', async () => {
    const fixture = render(); acknowledge(fixture); button(fixture, 'Aplicar cambios seleccionados').click();
    const first = http.expectOne(request => request.url.endsWith('/applications')), body = first.request.body, key = first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error')); await Promise.resolve(); fixture.detectChanges();
    session.workspace.set({ ...workspace, currentVersionId: nextVersion, versionIds: [versionId, nextVersion] }); session.etag.set('"v-' + nextVersion + '"'); TestBed.tick(); fixture.detectChanges();
    fixture.componentRef.setInput('selection', null);
    fixture.componentRef.setInput('selectedIds', []);
    fixture.componentRef.setInput('proposals', []);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('#apply-title')).toBeNull();
    button(fixture, 'Reintentar misma aplicación').click(); const retry = http.expectOne(request => request.url.endsWith('/applications'));
    expect(retry.request.body).toEqual(body); expect(retry.request.headers.get('Idempotency-Key')).toBe(key); expect(retry.request.headers.get('If-Match')).toBe('"v-' + versionId + '"');
    retry.flush({ jobId: 'same-job', workspaceId, kind: 'apply', status: 'queued', progress: { completed: 0, total: 2, complete: false }, diagnostics: [], pollAfterMs: 60000 }); await Promise.resolve(); expect(session.job()?.jobId).toBe('same-job');
  });
  it('distinguishes remaining failures and arithmetic errors from the fact that an application completed', () => {
    const fixture = TestBed.createComponent(ComparisonComponent);
    const summary = { complete: true, rows: 3, variants: 3, applicableVariants: 3, duplicateRows: 0, instances: 3, byStatus: { pass: 1, fail: 1, error: 1, not_applicable: 0, not_evaluable: 0 } };
    const result = { id: 'result', runId: 'before', versionId, code: 'SYNTHETIC_WARNING', severity: 'warning', status: 'fail', values: {}, factReads: [], metadataReads: [], sources: [], diagnostics: [], variantIds: [], sourceRecordIds: [], tables: [], coverageOnly: false, expression: '1=1' };
    fixture.componentRef.setInput('page', { items: [{ key: 'warning', before: result, after: { ...result, runId: 'after', versionId: nextVersion, status: 'pass', factReads: [{ ...a.before, originalText: '12.00', derivation: { receiptId: 'calculated-receipt', previewId, proposalId: aId, baseVersionId: versionId } }] } },
      { key: 'fail', before: { ...result, code: 'SYNTHETIC_STILL_FAIL' }, after: { ...result, code: 'SYNTHETIC_STILL_FAIL', versionId: nextVersion } },
      { key: 'error', before: { ...result, code: 'SYNTHETIC_ARITHMETIC', status: 'error' }, after: { ...result, code: 'SYNTHETIC_ARITHMETIC', status: 'error', versionId: nextVersion, diagnostics: [{ code: 'DIVISION_BY_ZERO', message: 'División por cero.' }] } }],
      total: 3, nextCursor: null, receipt: { baseVersionId: versionId, newVersionId: nextVersion, acceptedIds: [aId, dId] }, beforeSummary: summary, afterSummary: summary });
    fixture.detectChanges(); for (const request of http.match(request => request.url.endsWith('/runs'))) request.flush({ items: [], total: 0, nextCursor: null, revision: 'rev' });
    const element = fixture.nativeElement as HTMLElement, text = element.textContent!;
    for (const value of ['SYNTHETIC_WARNING', 'Advertencia', 'SYNTHETIC_STILL_FAIL', 'Falla', 'SYNTHETIC_ARITHMETIC', 'Error', versionId, nextVersion]) expect(text).toContain(value);
    expect(text.toLowerCase()).not.toMatch(/todo correcto|todas las reglas pasan|validación aprobada/);
    element.querySelector<HTMLButtonElement>('button[aria-label="Ver cálculo y origen de SYNTHETIC_WARNING"]')!.click(); fixture.detectChanges();
    const details = element.querySelectorAll('ce-calculation-detail'), after = details[1]!;
    expect(after.textContent).toContain('Recalculado en una aplicación anterior'); expect(after.textContent).toContain('no estaba escrito en el informe original');
    const technical = after.querySelector<HTMLDetailsElement>('details[data-technical]')!; technical.open = true; technical.dispatchEvent(new Event('toggle')); fixture.detectChanges(); expect(technical.textContent).toContain('calculated-receipt');
    element.querySelector<HTMLButtonElement>('button[aria-label="Ver cálculo y origen de SYNTHETIC_ARITHMETIC"]')!.click(); fixture.detectChanges(); expect(element.textContent).toContain('División por cero.');
  });
});
