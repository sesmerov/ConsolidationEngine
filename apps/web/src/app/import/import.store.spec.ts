import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
import { ImportStore } from './import.store';
const workspaceId = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2', version = 'bfda41bd-2a55-4a80-9f22-2fc1aa89894c';
const page = { items: [], total: 3, nextCursor: null, versionId: version, sources: [], coverage: { rows: 3, variants: 3, applicableVariants: 1, supportedVariants: 3, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 }, dataSummary: { explicitNulls: 1, implicitNulls: 1, zeroValues: 1 } };
describe('ImportStore preserves the accepted version', () => {
  let http: HttpTestingController, store: ImportStore, session: SessionStore;
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), ImportStore] });
    http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('memory-only');
    session.workspace.set({ id: workspaceId, name: 'Cierre', state: 'ready', currentVersionId: version, versionIds: [version], contexts: [], counts: { snapshots: 1, facts: 5, coordinates: 6, sources: 2 }, sessionBytes: 100 });
    session.etag.set('"v-' + version + '"'); store = TestBed.inject(ImportStore);
    http.expectOne('/api/v1/capabilities').flush({ profileId: 'local', grammarVersion: '0.9', support: [], knownDifferences: [], limits: {} }); TestBed.tick(); http.expectOne(request => request.url.endsWith('/import-inspections')).flush({ active: null });
  });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  it('keeps coverage and context after a rejected multipart upload, with auth and version headers', async () => {
    http.expectOne((request) => request.url.endsWith('/rules')).flush(page); await Promise.resolve();
    const upload = store.upload(new File(['catalog'], 'catalog.xlsx'), [new File(['report'], 'report.xlsx')]);
    const request = http.expectOne((item) => item.url.endsWith('/imports'));
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
});
