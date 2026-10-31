import { DestroyRef, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { CapabilitiesDTO, RulesPageDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
@Injectable()
export class ImportStore {
  private readonly api = inject(ApiClient); private readonly session = inject(SessionStore);
  private controller: AbortController | undefined; private pageGeneration = 0;
  readonly uploading = signal(false); readonly loading = signal(false); readonly error = signal<string | null>(null);
  readonly page = signal<RulesPageDTO | null>(null); readonly capabilities = signal<CapabilitiesDTO | null>(null);
  readonly code = signal(''); readonly status = signal('');
  constructor() {
    effect(() => { const version = this.session.versionId(); if (version) untracked(() => { void this.load(version); }); else { this.pageGeneration++; this.page.set(null); } });
    inject(DestroyRef).onDestroy(() => { this.controller?.abort(); this.pageGeneration++; });
    void this.api.capabilities().then((value) => this.capabilities.set(value)).catch((error: unknown) => this.report(error));
  }
  async upload(catalog: File, reports: readonly File[]): Promise<void> {
    const workspace = this.session.workspace(), etag = this.session.etag(); if (!workspace || !etag || this.uploading() || this.session.jobActive()) return;
    const controller = new AbortController(); this.controller = controller; this.uploading.set(true); this.error.set(null);
    try {
      const job = await this.api.importFiles(workspace.id, etag, catalog, reports, crypto.randomUUID(), controller.signal);
      if (this.session.workspace()?.id !== workspace.id) return;
      this.session.trackJob(job); if (job.status === 'succeeded') await this.session.refreshWorkspace(workspace.id);
    } catch (error) { if (controller.signal.aborted) this.error.set('Carga cancelada. Se conserva la versión anterior.'); else this.report(error); }
    finally { if (this.controller === controller) this.controller = undefined; this.uploading.set(false); }
  }
  cancelUpload(): void { this.controller?.abort(); }
  async downloadTemplate(): Promise<void> {
    try { const blob = await this.api.reportTemplate(); const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'ce-report-1.xlsx'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
    catch (error) { this.report(error); }
  }
  async downloadExample(kind: 'catalog' | 'report'): Promise<void> {
    try { const blob = await this.api.guidedExample(kind); const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = kind === 'catalog' ? 'ejemplo-catalogo.xlsx' : 'ejemplo-informe.xlsx'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
    catch (error) { this.report(error); }
  }
  async load(version = this.session.versionId(), append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!version || !workspaceId) return;
    const generation = ++this.pageGeneration; this.loading.set(true);
    const cursor = append ? this.page()?.nextCursor : null;
    try {
      const page = await this.api.rules(workspaceId, version, { ...(this.code() ? { code: this.code() } : {}), ...(this.status() ? { status: this.status() } : {}), ...(cursor ? { cursor } : {}) });
      if (generation !== this.pageGeneration || this.session.versionId() !== version) return;
      this.page.set(append ? { ...page, items: [...(this.page()?.items ?? []), ...page.items] } : page);
    } catch (error) { if (generation === this.pageGeneration) this.report(error); }
    finally { if (generation === this.pageGeneration) this.loading.set(false); }
  }
  fileName(id: string | undefined): string { return this.page()?.sources.find((source) => source.id === id)?.displayName ?? 'Archivo de origen'; }
  private report(error: unknown): void {
    this.error.set(error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo completar la petición. Se conserva la versión cargada.');
  }
}
