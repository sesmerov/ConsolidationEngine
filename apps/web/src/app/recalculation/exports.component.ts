import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { RunSummaryDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
interface ExportAttempt { workspaceId: string; versionId: string; kind: 'report' | 'results'; runId?: string; etag: string; key: string }
interface Download { workspaceId: string; versionId: string; id: string; filename: 'report.zip' | 'results.zip' }
@Component({ selector: 'ce-exports', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './exports.component.html' })
export class ExportsComponent {
  readonly session = inject(SessionStore); private readonly api = inject(ApiClient);
  readonly kind = signal<'report' | 'results'>('report'); readonly selectedRunId = signal(''); readonly history = signal<readonly RunSummaryDTO[]>([]); readonly cursor = signal<string | null>(null);
  readonly historyLoading = signal(false); readonly pending = signal(false); readonly error = signal<string | null>(null); readonly uncertain = signal(false); readonly ready = signal<Download | null>(null);
  readonly runs = computed(() => this.history().filter(run => run.versionId === this.session.exportVersionId()));
  readonly canStart = computed(() => !!this.session.exportVersionId() && !!this.session.etag() && !this.session.jobActive() && !this.session.pending() && !this.pending() && !this.uncertain()
    && (this.kind() === 'report' || this.runs().some(run => run.id === this.selectedRunId() && run.status !== 'running')));
  private generation = 0; private workspaceId: string | undefined; private attempt: ExportAttempt | undefined; private requested: (ExportAttempt & { jobId: string }) | undefined; private handledJob = ''; private alive = true;
  constructor() {
    effect(() => { const id = this.session.workspace()?.id; if (id !== this.workspaceId) { this.workspaceId = id; untracked(() => { this.generation++; this.attempt = undefined; this.requested = undefined; this.handledJob = ''; this.ready.set(null); this.history.set([]); this.cursor.set(null); this.selectedRunId.set(''); this.error.set(null); this.uncertain.set(false); this.pending.set(false); if (id) void this.loadHistory(); }); } });
    effect(() => { const version = this.session.exportVersionId(), runs = this.runs(); untracked(() => { if (!runs.some(run => run.id === this.selectedRunId())) this.selectedRunId.set(runs.find(run => run.status !== 'running')?.id ?? ''); }); void version; });
    effect(() => { const job = this.session.job(), requested = this.requested; if (!job || !requested || job.jobId !== requested.jobId || requested.workspaceId !== this.session.workspace()?.id || !isTerminalJob(job.status) || this.handledJob === job.jobId) return;
      this.handledJob = job.jobId; untracked(() => { if (job.status === 'succeeded' && job.resultRef?.type === 'export') { const download: Download = { workspaceId: requested.workspaceId, versionId: requested.versionId, id: job.resultRef.id, filename: requested.kind === 'report' ? 'report.zip' : 'results.zip' }; this.ready.set(download); void this.download(download); }
        else this.error.set(job.diagnostics[0]?.message ?? 'La exportación quedó incompleta. No hay un paquete publicado.'); }); });
    inject(DestroyRef).onDestroy(() => { this.alive = false; this.generation++; });
  }
  async loadHistory(append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId) return; const generation = ++this.generation; this.historyLoading.set(true);
    try { const page = await this.api.runs(workspaceId, append ? this.cursor() ?? undefined : undefined); if (!this.alive || generation !== this.generation || workspaceId !== this.session.workspace()?.id) return;
      this.history.set(append ? [...this.history(), ...page.items.filter(run => !this.history().some(previous => previous.id === run.id))] : page.items); this.cursor.set(page.nextCursor);
    } catch (error) { if (generation === this.generation) this.report(error); } finally { if (generation === this.generation) this.historyLoading.set(false); }
  }
  async start(): Promise<void> {
    const workspaceId = this.session.workspace()?.id, versionId = this.session.exportVersionId(), etag = this.session.etag(); if (!workspaceId || !versionId || !etag || !this.canStart()) return;
    this.attempt = { workspaceId, versionId, etag, kind: this.kind(), key: crypto.randomUUID(), ...(this.kind() === 'results' ? { runId: this.selectedRunId() } : {}) }; await this.send();
  }
  async retry(): Promise<void> { if (this.uncertain() && !this.pending() && !this.session.pending() && !this.session.jobActive()) await this.send(); }
  private async send(): Promise<void> {
    const attempt = this.attempt; if (!attempt || attempt.workspaceId !== this.session.workspace()?.id) return; this.pending.set(true); this.error.set(null);
    try { const job = await (attempt.kind === 'report' ? this.api.exportReport(attempt.workspaceId, attempt.versionId, attempt.etag, attempt.key) : this.api.exportResults(attempt.workspaceId, attempt.versionId, attempt.runId!, attempt.etag, attempt.key));
      if (!this.alive || this.attempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return; this.requested = { ...attempt, jobId: job.jobId }; this.attempt = undefined; this.uncertain.set(false); this.session.trackJob(job);
    } catch (error) { if (this.alive && this.attempt === attempt && attempt.workspaceId === this.session.workspace()?.id) { this.uncertain.set(error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500)); this.report(error); } }
    finally { if (this.alive && attempt.workspaceId === this.session.workspace()?.id) this.pending.set(false); }
  }
  async download(download = this.ready()): Promise<void> {
    if (!download || download.workspaceId !== this.session.workspace()?.id) return; this.pending.set(true);
    try { const blob = await this.api.downloadExport(download.workspaceId, download.id); if (!this.alive || download.workspaceId !== this.session.workspace()?.id) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = download.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (error) { if (this.alive && download.workspaceId === this.session.workspace()?.id) this.report(error); } finally { if (this.alive && download.workspaceId === this.session.workspace()?.id) this.pending.set(false); }
  }
  private report(error: unknown): void { this.error.set(error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo confirmar la exportación o descargar el archivo.'); }
}
