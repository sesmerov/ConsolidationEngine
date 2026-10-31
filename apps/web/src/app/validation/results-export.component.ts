import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { ValidationRunDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
@Component({ selector: 'ce-results-export', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div class="export-actions"><button class="secondary" (click)="start()" [disabled]="pending() || session.jobActive() || run().status === 'running'">Exportar resultados (ZIP)</button>
    <p class="muted">Descarga results.zip con results.json exacto y results.xlsx como vista literal. Se exporta la ejecución seleccionada, también si es histórica o incompleta.</p>
    @if (error(); as message) { <p class="error" role="alert">{{ message }}</p> }
    @if (ready()) { <button class="secondary" (click)="download(ready()!)" [disabled]="pending()">Descargar ZIP de nuevo</button> }
  </div>` })
export class ResultsExportComponent {
  readonly run = input.required<ValidationRunDTO>(); readonly session = inject(SessionStore); private readonly api = inject(ApiClient);
  readonly pending = signal(false); readonly error = signal<string | null>(null); readonly ready = signal<string | null>(null);
  private requestedJob: string | undefined; private requestedRun: string | undefined; private handledJob = ''; private alive = true;
  constructor() {
    effect(() => { const job = this.session.job(); if (!job || job.jobId !== this.requestedJob || !isTerminalJob(job.status) || this.handledJob === job.jobId) return;
      this.handledJob = job.jobId; untracked(() => { if (job.status === 'succeeded' && job.resultRef?.type === 'export') { if (this.requestedRun === this.run().id) this.ready.set(job.resultRef.id); void this.download(job.resultRef.id); }
        else this.error.set(job.diagnostics[0]?.message ?? 'La exportación quedó incompleta. Puedes volver a solicitarla.'); }); });
    effect(() => { const id = this.run().id; untracked(() => { if (this.requestedRun !== id) this.ready.set(null); }); });
    inject(DestroyRef).onDestroy(() => { this.alive = false; });
  }
  async start(): Promise<void> {
    const workspace = this.session.workspace(), etag = this.session.etag(); if (!workspace || !etag || this.session.jobActive()) return;
    this.pending.set(true); this.error.set(null); const run = this.run();
    try { const job = await this.api.exportResults(workspace.id, run.versionId, run.id, etag, crypto.randomUUID()); if (!this.alive) return; this.requestedJob = job.jobId; this.requestedRun = run.id; this.session.trackJob(job); }
    catch (error) { this.report(error); } finally { this.pending.set(false); }
  }
  async download(id: string): Promise<void> {
    const workspace = this.session.workspace(); if (!workspace) return; this.pending.set(true);
    try { const blob = await this.api.downloadExport(workspace.id, id); if (!this.alive) return; const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'results.zip'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); }
    catch (error) { this.report(error); } finally { this.pending.set(false); }
  }
  private report(error: unknown): void { this.error.set(error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo descargar la exportación.'); }
}
