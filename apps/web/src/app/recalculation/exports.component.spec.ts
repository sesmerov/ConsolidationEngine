import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ExportsComponent } from './exports.component';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
const workspaceId = '00000000-0000-4000-8000-000000000091', original = '00000000-0000-4000-8000-000000000092', current = '00000000-0000-4000-8000-000000000093', runId = '00000000-0000-4000-8000-000000000094';
const workspace = { id: workspaceId, name: 'SYNTHETIC', state: 'ready' as const, currentVersionId: current, versionIds: [original, current], contexts: [], counts: { snapshots: 2, coordinates: 1, facts: 1, sources: 2 }, sessionBytes: 100 };
const run = { id: runId, versionId: original, profileId: 'profile', status: 'completed' as const, startedAt: '2026-10-31T00:00:00.000Z' };
// Preserve the former binding in an isolated probe to document the delayed-option regression.
@Component({ standalone: true, template: `<select [value]="selected()">@for (id of versions(); track id) { <option [value]="id">{{ id }}</option> }</select>` })
class LegacySelectProbe { readonly selected = signal(current); readonly versions = signal<string[]>([]); }

describe('visible download intent and one primary action', () => {
  let http: HttpTestingController, session: SessionStore;
  beforeEach(() => { sessionStorage.clear(); TestBed.configureTestingModule({ imports: [ExportsComponent, LegacySelectProbe], providers: [provideHttpClient(), provideHttpClientTesting()] }); http = TestBed.inject(HttpTestingController); session = TestBed.inject(SessionStore); TestBed.inject(ApiClient).setSessionToken('ephemeral'); session.workspace.set(workspace); session.etag.set('"v-' + current + '"'); });
  function flushSummaries() { for (const request of http.match(request => request.url.endsWith('/export-summary'))) {
    const versionId = request.request.url.split('/').at(-2), kind = request.request.params.get('kind') ?? 'report', runId = request.request.params.get('runId');
    request.flush({ versionId, profileId: 'profile', createdAt: '2026-10-31T00:00:00.000Z', reports: [], intent: { workspaceId, versionId, kind, ...(runId ? { runId } : {}) }, intentFingerprint: 'a'.repeat(64) });
  } }
  afterEach(() => { try { flushSummaries(); http.verify(); } finally { TestBed.resetTestingModule(); sessionStorage.clear(); } });
  async function render(items: object[] = [run]) {
    const fixture = TestBed.createComponent(ExportsComponent); fixture.detectChanges(); http.expectOne(request => request.url.endsWith('/runs')).flush({ items, total: items.length, nextCursor: null, revision: 'r' });
    await settle(fixture); return fixture;
  }
  async function settle(fixture: { detectChanges(): void }) { for (let i = 0; i < 3; i++) { await Promise.resolve(); TestBed.tick(); flushSummaries(); fixture.detectChanges(); } }
  it('reproduces the old value binding mismatch when options arrive after the selected value', () => {
    const probe = TestBed.createComponent(LegacySelectProbe); probe.detectChanges(); probe.componentInstance.versions.set([original, current]); probe.detectChanges();
    expect(probe.componentInstance.selected()).toBe(current); expect((probe.nativeElement.querySelector('select') as HTMLSelectElement).value).toBe(original);
  });
  it('keeps DOM, state, summary and POST on the same chosen version, including late options', async () => {
    session.workspace.set({ ...workspace, versionIds: [] }); const fixture = await render(); session.workspace.set(workspace); await settle(fixture);
    const element = fixture.nativeElement as HTMLElement, select = element.querySelector('#export-version') as HTMLSelectElement;
    expect(select.value).toBe(current); expect(element.querySelector('.export-summary h3')?.textContent).toContain('Versión 2');
    select.value = original; select.dispatchEvent(new Event('change')); await settle(fixture); expect(session.exportVersionId()).toBe(original); expect(fixture.componentInstance.store.summary()?.intent?.versionId).toBe(original); expect(element.querySelector('.export-summary h3')?.textContent).toContain('Versión 1');
    const starting = fixture.componentInstance.store.activate(), request = http.expectOne(request => request.url.endsWith('/exports')); expect(request.request.body).toEqual({ versionId: original, kind: 'report' }); expect(request.request.headers.get('If-Match')).toBe('"v-' + current + '"'); request.flush({ error: { message: 'Prueba sin publicación' } }, { status: 412, statusText: 'Precondition Failed' }); await starting;
  });
  it('renders exactly one preparation/download/retry action and locks choices while acceptance is uncertain', async () => {
    const fixture = await render(), element = fixture.nativeElement as HTMLElement, store = fixture.componentInstance.store;
    expect(element.querySelectorAll('[data-download-action]')).toHaveLength(1); expect(element.textContent).not.toMatch(/Preparar descarga|paquete de nuevo|Descargar informes aplicados/);
    const starting = store.activate(); await settle(fixture); expect(element.querySelector('[data-download-action]')?.textContent).toContain('Preparando'); expect((element.querySelector('#export-version') as HTMLSelectElement).disabled).toBe(true);
    http.expectOne(request => request.url.endsWith('/exports')).error(new ProgressEvent('error')); await starting; await settle(fixture); expect(element.querySelector('[data-download-action]')?.textContent).toContain('Reintentar descarga'); expect((element.querySelector('#export-kind') as HTMLSelectElement).disabled).toBe(true);
  });
  it('shows single version/run as read-only and explains zero result options', async () => {
    session.workspace.set({ ...workspace, currentVersionId: original, versionIds: [original] }); const fixture = await render(), element = fixture.nativeElement as HTMLElement;
    fixture.componentInstance.store.selectKind('results'); await settle(fixture); expect(element.querySelector('#export-version')).toBeNull(); expect(element.querySelector('#export-run')).toBeNull(); expect(element.querySelector('[data-export-run]')?.textContent).toContain('Terminada');
    fixture.componentInstance.store.history.set([]); await settle(fixture); expect(element.textContent).toContain('Esta versión no tiene una ejecución'); expect((element.querySelector('[data-download-action]') as HTMLButtonElement).disabled).toBe(true);
  });
  it('consumes explicit navigation once, while ordinary visits preserve voluntarily chosen history', async () => {
    const fixture = await render(), view = TestBed.inject(WorkspaceViewStore); view.reconcile(workspaceId, current); view.requestDownload({ workspaceId, versionId: original, kind: 'results', runId }); await settle(fixture);
    expect(fixture.componentInstance.store.intent()).toEqual({ workspaceId, versionId: original, kind: 'results', runId }); expect(view.downloadIntentEntry()).toBeNull(); http.expectNone(request => request.method === 'POST');
    fixture.componentInstance.store.selectKind('report'); view.visit('validation'); view.visit('exports'); await settle(fixture); expect(session.exportVersionId()).toBe(original); expect(fixture.componentInstance.kind()).toBe('report');
  });
});
