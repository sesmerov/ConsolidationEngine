import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
import { ImportStore } from './import.store';
import { ImportPageComponent } from './import-page.component';
const workspaceId = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2', version = 'bfda41bd-2a55-4a80-9f22-2fc1aa89894c';
const page = { items: [], total: 3, nextCursor: null, versionId: version, sources: [], coverage: { rows: 3, variants: 3, applicableVariants: 1, supportedVariants: 3, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 }, dataSummary: { explicitNulls: 1, implicitNulls: 1, zeroValues: 1 } };
describe('ImportStore preserves the accepted version', () => {
  let http: HttpTestingController, store: ImportStore, session: SessionStore;
  beforeEach(() => {
    TestBed.configureTestingModule({ imports: [ImportPageComponent], providers: [provideHttpClient(), provideHttpClientTesting(), ImportStore] });
    http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('memory-only');
    session.workspace.set({ id: workspaceId, name: 'Cierre', state: 'ready', currentVersionId: version, versionIds: [version], contexts: [], counts: { snapshots: 1, facts: 5, coordinates: 6, sources: 2 }, sessionBytes: 100 });
    session.etag.set('"v-' + version + '"'); store = TestBed.inject(ImportStore);
    http.expectOne('/api/v1/capabilities').flush({ profileId: 'local', grammarVersion: '0.9', support: [], knownDifferences: [], limits: {} }); TestBed.tick(); http.expectOne(request => request.url.endsWith('/import-inspections')).flush({ active: null });
  });
  afterEach(() => { vi.useRealTimers(); http.verify(); TestBed.resetTestingModule(); });
  it('keeps coverage and context after a rejected multipart upload, with auth and version headers', async () => {
    http.expectOne((request) => request.url.endsWith('/rules')).flush(page); await Promise.resolve();
    store.catalog.set(new File(['catalog'], 'catalog.xlsx'));
    store.reports.set([new File(['report'], 'report.xlsx')]);
    const upload = store.inspect();
    const request = http.expectOne((item) => item.method === 'POST' && item.url.endsWith('/import-inspections'));
    expect(request.request.body).toBeInstanceOf(FormData); expect(request.request.headers.get('X-CE-Session')).toBe('memory-only');
    expect(request.request.headers.get('If-Match')).toBe('"v-' + version + '"'); expect(request.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    request.flush({ error: { message: 'La carga supera los límites admitidos.' } }, { status: 413, statusText: 'Too Large' }); await upload;
    expect(store.page()?.coverage.rows).toBe(3); expect(session.versionId()).toBe(version); expect(store.error()).toContain('límites'); expect(store.uploading()).toBe(false);
  });
  it('does not restore rows from a late response after the workspace is closed', async () => {
    const request = http.expectOne((item) => item.url.endsWith('/rules'));
    session.workspace.set(null); TestBed.tick(); request.flush(page); await Promise.resolve();
    expect(store.page()).toBeNull();
  });
  async function renderFilters() {
    const fixture = TestBed.createComponent(ImportPageComponent);
    fixture.detectChanges();
    http.expectOne(request => request.url.endsWith('/rules')).flush({ ...page, nextCursor: 'old-cursor' });
    await fixture.whenStable();
    fixture.detectChanges();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const element = fixture.nativeElement as HTMLElement;
    const code = element.querySelector<HTMLInputElement>('input[name=code]')!;
    function setValue(field: HTMLInputElement | HTMLSelectElement, value: string) {
      field.value = value;
      field.dispatchEvent(new Event(field instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
      fixture.detectChanges();
    }
    return { fixture, element, code, setValue };
  }
  it('waits 250ms after the latest edit and rejects an old append error during the new pause while keeping focus and coverage', async () => {
    const { fixture, element, code, setValue } = await renderFilters();
    const append = Array.from(element.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Cargar más registros')!;
    append.click();
    const old = http.expectOne(request => request.params.get('cursor') === 'old-cursor');
    code.focus();
    setValue(code, 'A');
    await vi.advanceTimersByTimeAsync(180);
    setValue(code, 'AB');
    old.flush({ error: { message: 'error de búsqueda anterior' } }, { status: 500, statusText: 'Error' });
    await Promise.resolve(); fixture.detectChanges();
    expect(document.activeElement).toBe(code);
    expect(element.textContent).not.toContain('error de búsqueda anterior');
    expect(element.textContent).toContain('Filas del catálogo');
    await vi.advanceTimersByTimeAsync(249);
    http.expectNone(request => request.url.endsWith('/rules'));
    await vi.advanceTimersByTimeAsync(1);
    const current = http.expectOne(request => request.params.get('code') === 'AB');
    expect(current.request.params.has('cursor')).toBe(false);
    current.flush({ ...page, total: 0 }); await Promise.resolve(); fixture.detectChanges();
    expect(element.textContent).toContain('Sin coincidencias');
    expect(element.textContent).not.toContain('Filtrar reglas');
    expect(document.activeElement).toBe(code);
  });
  it('combines immediate status and table with the current text, drops late rows and resets the page on clear and version change', async () => {
    const { fixture, element, code, setValue } = await renderFilters();
    setValue(code, 'custom');
    setValue(element.querySelector<HTMLSelectElement>('select[name=status]')!, 'applicable');
    const old = http.expectOne(request => request.params.get('status') === 'applicable' && request.params.get('code') === 'custom');
    const table = element.querySelector<HTMLInputElement>('input[name=table]')!;
    setValue(table, 'C_01.00');
    const current = http.expectOne(request => request.params.get('table') === 'C_01.00' && request.params.get('code') === 'custom');
    current.flush({ ...page, total: 2 }); await Promise.resolve();
    old.flush({ ...page, total: 400 }); await Promise.resolve(); fixture.detectChanges();
    expect(element.textContent).toContain('0 de 2 registros');
    expect(element.textContent).not.toContain('400 registros');
    setValue(code, '');
    await vi.advanceTimersByTimeAsync(250);
    const clearing = http.expectOne(request => request.params.get('table') === 'C_01.00' && !request.params.has('code'));
    expect(clearing.request.params.get('status')).toBe('applicable');
    expect(clearing.request.params.has('cursor')).toBe(false);
    session.workspace.update(workspace => ({ ...workspace!, currentVersionId: 'v2' }));
    TestBed.tick();
    const replaced = http.expectOne(request => request.params.get('versionId') === 'v2');
    expect(replaced.request.params.get('table')).toBe('C_01.00');
    replaced.flush({ ...page, versionId: 'v2', total: 1 });
    clearing.flush({ ...page, total: 300 }); await Promise.resolve(); fixture.detectChanges();
    expect(element.textContent).toContain('0 de 1 registros');
  });
});
