import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from './session.store';
const workspaceId = 'a4a99ec0-bb65-41f5-90d1-b857f4ebefb2';
const workspace = { id: workspaceId, name: 'Cierre', state: 'empty', versionIds: [], contexts: [], counts: { snapshots: 0, coordinates: 0, facts: 0, sources: 0 }, sessionBytes: 0 };
describe('SessionStore HTTP lifecycle', () => {
  let http: HttpTestingController;
  let store: SessionStore;
  beforeEach(() => { TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); store = TestBed.inject(SessionStore); });
  afterEach(() => { http.verify(); TestBed.resetTestingModule(); });
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
});
