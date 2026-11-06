import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './session.store';
import type { ReportContext } from '@ce/contracts';
const workspaceId = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2';
const workspace = { id: workspaceId, name: 'Cierre', state: 'empty', versionIds: [], contexts: [], counts: { snapshots: 0, coordinates: 0, facts: 0, sources: 0 }, sessionBytes: 0 };
describe('SessionStore HTTP lifecycle', () => {
  let http: HttpTestingController;
  let store: SessionStore;
  beforeEach(() => { TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); store = TestBed.inject(SessionStore); });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
  it('preserves the active context by ID on refresh and falls back to the first remaining context or none', async () => {
    const firstContext: ReportContext = { contextId: 'primero', canonicalContextKey: 'scope-a', entityId: 'Entidad', referenceDate: '2025-12-31', framework: 'COREP', moduleVersion: 'COREP_OF_4.0', filingIndicators: {} };
    const secondContext = { ...firstContext, contextId: 'segundo', canonicalContextKey: 'scope-b' };
    async function refresh(contexts: readonly ReportContext[]): Promise<void> {
      const pending = store.refreshWorkspace(workspaceId);
      http.expectOne('/api/v1/workspaces/' + workspaceId).flush({ ...workspace, contexts }, { headers: { ETag: '"refreshed"' } });
      await pending;
    }

    await refresh([firstContext, secondContext]);
    expect(store.selectedContextId()).toBe(firstContext.contextId);
    store.selectContext(secondContext.contextId);
    await refresh([secondContext, firstContext]);
    expect(store.selectedContextId()).toBe(secondContext.contextId);
    await refresh([firstContext]);
    expect(store.selectedContext()).toEqual(firstContext);
    await refresh([]);
    expect(store.selectedContextId()).toBeNull();
    expect(store.selectedContext()).toBeNull();
  });
  it('restores the active workspace after bootstrap using only the token in memory', async () => {
    const connect = store.connect();
    const bootstrap = http.expectOne('/api/v1/bootstrap'); expect(bootstrap.request.headers.has('X-CE-Session')).toBe(false);
    bootstrap.flush({ sessionToken: 'ephemeral-token', apiVersion: 'v1', sessionPersistence: 'ephemeral', activeWorkspaceId: workspaceId });
    await Promise.resolve();
    const restore = http.expectOne('/api/v1/workspaces/' + workspaceId);
    expect(restore.request.headers.get('X-CE-Session')).toBe('ephemeral-token');
    restore.flush(workspace, { headers: { ETag: '"empty"' } }); await connect;
    expect(store.workspace()?.id).toBe(workspaceId); expect(store.etag()).toBe('"empty"'); expect(store.connected()).toBe(true);
  });
  it('sends If-Match when closing and clears the visible workspace only after success', async () => {
    const connect = store.connect(); http.expectOne('/api/v1/bootstrap').flush({ sessionToken: 'token', apiVersion: 'v1', sessionPersistence: 'ephemeral' }); await connect;
    const create = store.create('Cierre'); http.expectOne('/api/v1/workspaces').flush(workspace, { headers: { ETag: '"empty"' } }); await create;
    const close = store.close(); const request = http.expectOne('/api/v1/workspaces/' + workspaceId);
    expect(request.request.method).toBe('DELETE'); expect(request.request.headers.get('If-Match')).toBe('"empty"');
    expect(store.workspace()?.id).toBe(workspaceId); request.flush(null, { status: 204, statusText: 'No Content' }); await close;
    expect(store.workspace()).toBeNull(); expect(store.etag()).toBeNull();
  });
  it('forgets a previous process workspace when a new bootstrap has no active workspace', async () => {
    const first = store.connect(); http.expectOne('/api/v1/bootstrap').flush({ sessionToken: 'old-token', apiVersion: 'v1', sessionPersistence: 'ephemeral' }); await first;
    const create = store.create('Cierre'); http.expectOne('/api/v1/workspaces').flush(workspace, { headers: { ETag: '"empty"' } }); await create;
    const reconnect = store.connect(); http.expectOne('/api/v1/bootstrap').flush({ sessionToken: 'new-token', apiVersion: 'v1', sessionPersistence: 'ephemeral' }); await reconnect;
    expect(store.workspace()).toBeNull(); expect(store.job()).toBeNull(); expect(store.etag()).toBeNull();
  });
  it('preserves a completed application when cancellation arrives after publication', async () => {
    store.trackJob({ jobId: 'apply-job', workspaceId, kind: 'apply', status: 'running', progress: { completed: 1, total: 2, complete: false }, diagnostics: [], pollAfterMs: 60000 });
    const cancel = store.cancelJob(); http.expectOne('/api/v1/workspaces/' + workspaceId + '/jobs/apply-job').flush({ jobId: 'apply-job', workspaceId, kind: 'apply', status: 'succeeded', newVersionId: 'published', resultRef: { type: 'application', id: 'receipt' }, progress: { completed: 2, total: 2, complete: true }, diagnostics: [] });
    await Promise.resolve();
    http.expectOne('/api/v1/workspaces/' + workspaceId).flush({ ...workspace, state: 'ready', currentVersionId: 'published', versionIds: ['base', 'published'] }, { headers: { ETag: '"v-published"' } }); await cancel;
    expect(store.job()?.status).toBe('succeeded'); expect(store.job()?.resultRef?.id).toBe('receipt'); expect(store.versionId()).toBe('published'); expect(store.jobActive()).toBe(false);
  });
});
