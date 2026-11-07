import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { ImportPageComponent } from './import-page.component';
import type { JobDTO } from '@ce/contracts';

const workspace = { id: 'workspace', name: 'FINREP prueba', state: 'empty' as const, versionIds: [], contexts: [], counts: { snapshots: 0, coordinates: 0, facts: 0, sources: 0 }, sessionBytes: 0 };
const job = (jobId: string): JobDTO => ({ jobId, workspaceId: workspace.id, kind: 'inspect-import', status: 'queued', progress: { completed: 0, total: 1, complete: false }, diagnostics: [], pollAfterMs: 60000 });
const choice = { reportIndex: 0, sha256: 'a'.repeat(64), candidates: [
  { profileId: 'eba-corep-of-4.0-ca1-v1' as const, label: 'COREP · C 01.00 · plantilla 4.0', tableCode: 'C_01.00' },
  { profileId: 'eba-finrep-4.0-f0101-v1' as const, label: 'FINREP · F 01.01 · plantilla 4.0', tableCode: 'F_01.01' },
] };
describe('FINREP form, verified profile choices and demonstration', () => {
  const api = { capabilities: vi.fn().mockResolvedValue({}), activeImportInspection: vi.fn().mockResolvedValue({ active: null }), inspectImport: vi.fn(), rules: vi.fn(), visualDemo: vi.fn().mockResolvedValue(new Blob(['demo'])) };
  beforeEach(() => { vi.clearAllMocks(); api.inspectImport.mockResolvedValue(job('first')); TestBed.configureTestingModule({ imports: [ImportPageComponent], providers: [{ provide: ApiClient, useValue: api }] }); const session = TestBed.inject(SessionStore); session.workspace.set(workspace); session.etag.set('"empty"'); });
  afterEach(() => { vi.restoreAllMocks(); TestBed.resetTestingModule(); });
  async function render() { const f = TestBed.createComponent(ImportPageComponent); f.detectChanges(); await f.whenStable(); return f; }
  it('declares FINREP filing in the form and labels the supported table', async () => {
    const f = await render(), store = f.componentInstance.store; store.contextSource.set('form'); f.detectChanges(); await f.whenStable();
    const select = (f.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('#context-framework'); expect(select).not.toBeNull();
    select!.value = 'finrep'; select!.dispatchEvent(new Event('change')); f.detectChanges(); await f.whenStable(); f.detectChanges();
    store.contextForm.set({ entityId: 'SYNTHETIC', referenceDate: '2025-12-31', submissionDate: '', currency: 'EUR', scaleExponent: '0', displayDecimals: '2', presented: 'true' });
    expect(store.contextInput()).toMatchObject({ source: 'form', declaration: { filingIndicators: { 'F_01.01': true } } });
    expect((f.nativeElement as HTMLElement).textContent).toContain('¿Se presenta la tabla F_01.01?');
  });
  it('offers only server-recognized candidates and retries retained files with a new request key', async () => {
    const f = await render(), store = f.componentInstance.store, session = TestBed.inject(SessionStore);
    const report = new File(['original'], 'full.xlsx'); store.catalog.set(new File(['catalog'], 'rules.xlsx')); store.reports.set([report]); f.detectChanges(); await f.whenStable(); await store.inspect();
    const key = api.inspectImport.mock.calls[0]![5]; session.trackJob({ ...job('first'), status: 'failed', diagnostics: [{ code: 'REPORT_PROFILE_REQUIRED', message: 'Elige la tabla del libro.', fileName: report.name, profileChoice: choice }] });
    f.detectChanges(); await f.whenStable(); f.detectChanges();
    const select = (f.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('[data-profile-choice]'); expect(select).not.toBeNull();
    expect([...select!.options].map(o => o.textContent)).toEqual(['Elige una plantilla', choice.candidates[0]!.label, choice.candidates[1]!.label]);
    select!.value = 'eba-finrep-4.0-f0101-v1'; select!.dispatchEvent(new Event('change')); f.detectChanges(); await f.whenStable();
    api.inspectImport.mockResolvedValue(job('second')); await store.inspect();
    expect(api.inspectImport.mock.calls[1]![3]).toEqual([report]);
    expect(api.inspectImport.mock.calls[1]![4]).toEqual({ source: 'workbook', reportProfiles: [{ reportIndex: 0, sha256: choice.sha256, profileId: 'eba-finrep-4.0-f0101-v1' }] });
    expect(api.inspectImport.mock.calls[1]![5]).not.toBe(key);
  });
  it('forgets profile choices when report bytes change and rejects late diagnostics from the prior job', async () => {
    const f = await render(), store = f.componentInstance.store, session = TestBed.inject(SessionStore); store.catalog.set(new File(['catalog'], 'rules.xlsx')); store.reports.set([new File(['one'], 'same.xlsx')]); f.detectChanges(); await f.whenStable(); await store.inspect();
    store.reports.set([new File(['two'], 'same.xlsx')]); f.detectChanges(); await f.whenStable();
    session.trackJob({ ...job('first'), status: 'failed', diagnostics: [{ code: 'REPORT_PROFILE_REQUIRED', message: 'Elige', profileChoice: choice }] }); f.detectChanges(); await f.whenStable();
    expect((f.nativeElement as HTMLElement).querySelector('[data-profile-choice]')).toBeNull(); expect(store.contextInput()).toEqual({ source: 'workbook' });
  });
  it('offers FINREP synthetic demo with two known changes and independent download filenames', async () => {
    const f = await render(), store = f.componentInstance.store; store.selectDemo('finrep'); f.detectChanges();
    expect(store.selectedDemo()).toBe('finrep'); const text = (f.nativeElement as HTMLElement).textContent!;
    expect(text).toContain('90,00 → 100,00'); expect(text).toContain('105,00 → 120,00');
    const names: string[] = []; vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:demo'); vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function(this: HTMLAnchorElement) { names.push(this.download); });
    await store.downloadVisualDemo('catalog'); await store.downloadVisualDemo('report'); expect(names).toEqual(['demo-finrep-catalog.xlsx', 'demo-finrep-report.xlsx']);
  });
});
