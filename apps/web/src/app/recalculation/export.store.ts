import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { downloadIntentKey, isTerminalJob, sameDownloadIntent } from '@ce/contracts';
import type { DownloadIntent, DownloadUiState, ExportArtifactSummaryDTO, JobDTO, RunSummaryDTO, VersionExportSummaryDTO } from '@ce/contracts';
import { versionLabel } from '../core/display';
import { ApiClient } from '../core/api-client';
import { OperationAttemptStore } from '../core/operation-attempt.store';
import type { ExportOperationAttempt } from '../core/operation-attempt.store';
import { SessionStore } from '../core/session.store';
import { ArtifactExpiredError } from '../core/verified-transfer';

@Injectable({ providedIn: 'root' })
export class ExportStore {
  readonly versionLabel = versionLabel;
  readonly session = inject(SessionStore);
  private readonly api = inject(ApiClient);
  private readonly attempts = inject(OperationAttemptStore);
  readonly kind = signal<'report' | 'results'>('report'); readonly selectedRunId = signal('');
  readonly history = signal<readonly RunSummaryDTO[]>([]); readonly cursor = signal<string | null>(null); readonly historyLoading = signal(false);
  readonly state = signal<DownloadUiState>('idle'); readonly error = signal<string | null>(null);
  readonly summary = signal<VersionExportSummaryDTO | null>(null); readonly summaryLoading = signal(false); readonly summaryError = signal<string | null>(null);
  readonly runs = computed(() => this.history().filter(run => run.versionId === this.session.exportVersionId() && run.status !== 'running'));
  readonly intent = computed<DownloadIntent | null>(() => {
    const workspaceId = this.session.workspace()?.id, versionId = this.session.exportVersionId(); if (!workspaceId || !versionId) return null;
    return this.kind() === 'report' ? { workspaceId, versionId, kind: 'report' } : this.selectedRunId() ? { workspaceId, versionId, kind: 'results', runId: this.selectedRunId() } : null;
  });
  private readonly artifacts = signal<ReadonlyMap<string, ExportArtifactSummaryDTO>>(new Map());
  readonly ready = computed(() => { const intent = this.intent(); return intent ? this.artifacts().get(downloadIntentKey(intent)) ?? null : null; });
  readonly choiceLocked = computed(() => this.state() === 'accepting' || this.state() === 'uncertain');
  readonly uncertain = computed(() => this.state() === 'uncertain'); readonly pending = computed(() => ['accepting', 'transferring'].includes(this.state()));
  readonly invalidReason = computed(() => !this.session.exportVersionId() ? 'Carga un informe para descargarlo.' : this.kind() === 'results' && !this.runs().some(run => run.id === this.selectedRunId()) ? 'Esta versión no tiene una ejecución disponible. Elige una versión con resultados o valida esta versión.' : null);
  readonly canStart = computed(() => !this.invalidReason() && !this.session.pending() && !this.session.jobActive() && !this.pending() && !this.uncertain() && !!this.session.etag());
  readonly actionDisabled = computed(() => this.pending() || this.state() === 'preparing' || this.session.pending() || (!this.uncertain() && (!!this.invalidReason() || (!this.ready() && this.session.jobActive()))));
  readonly actionLabel = computed(() => this.state() === 'accepting' || this.state() === 'preparing' ? 'Preparando…' : this.state() === 'transferring' ? 'Descargando…' : this.state() === 'uncertain' || this.state() === 'failed' ? 'Reintentar descarga' : 'Descargar');
  readonly resultPresentation = computed(() => {
    const job = this.session.job(), artifact = this.ready();
    return job?.kind === 'export' && job.status === 'succeeded' && job.resultRef?.id === artifact?.id && artifact?.jobId === job.jobId && artifact.intent.workspaceId === job.workspaceId
      ? { jobId: job.jobId, workspaceId: job.workspaceId, versionId: job.baseVersionId ?? null } : null;
  });
  private attempt: ExportOperationAttempt | null = null; private workspaceId: string | undefined; private alive = true;
  private generation = 0; private summaryGeneration = 0; private summaryKey = ''; private handledJob = ''; private autoTransfer = false;
  private transfer: AbortController | null = null; private lastIntent = ''; private desiredRunId = ''; private completedJob: JobDTO | null = null;
  constructor() {
    effect(() => { const id = this.session.workspace()?.id; if (id === this.workspaceId) return;
      untracked(() => { const previous = this.workspaceId; this.workspaceId = id; this.reset(); if (previous) this.attempts.clear('export', previous);
        if (id) { void this.loadHistory(); const saved = this.attempts.get('export', id); if (saved) { this.attempt = saved; this.setIntent(saved.intent); this.state.set('uncertain'); void this.recover(); } }
      });
    });
    effect(() => { const version = this.session.exportVersionId(), runs = this.runs(); untracked(() => {
      if (!this.choiceLocked() && !this.desiredRunId && !runs.some(run => run.id === this.selectedRunId())) this.selectedRunId.set(runs[0]?.id ?? '');
    }); void version; });
    effect(() => { const intent = this.intent(), key = intent ? downloadIntentKey(intent) : ''; if (key === this.lastIntent) return;
      this.lastIntent = key; untracked(() => { this.transfer?.abort(); this.transfer = null; this.error.set(null);
        if (!this.choiceLocked()) this.state.set(this.session.jobActive() && this.attempt?.jobId === this.session.job()?.jobId ? 'preparing' : this.ready() ? 'ready' : 'idle');
        void this.loadSummary();
      });
    });
    effect(() => { const job = this.session.job(); if (!this.choiceLocked() && job && job.jobId === this.attempt?.jobId && isTerminalJob(job.status) && job.jobId !== this.handledJob) {
      this.handledJob = job.jobId; untracked(() => { void this.finish(job); });
    } });
    inject(DestroyRef).onDestroy(() => { this.alive = false; this.generation++; this.summaryGeneration++; this.transfer?.abort(); });
  }
  selectVersion(versionId: string): void { if (!this.choiceLocked()) { this.desiredRunId = ''; this.transfer?.abort(); this.session.selectExportVersion(versionId); } }
  selectKind(kind: string): void { if (!this.choiceLocked() && (kind === 'report' || kind === 'results')) { this.transfer?.abort(); this.kind.set(kind); } }
  selectRun(runId: string): void { if (!this.choiceLocked() && this.runs().some(run => run.id === runId)) { this.transfer?.abort(); this.selectedRunId.set(runId); } }
  choose(intent: DownloadIntent): boolean {
    if (this.choiceLocked() || intent.workspaceId !== this.session.workspace()?.id || !this.session.workspace()?.versionIds.includes(intent.versionId)) return false;
    this.transfer?.abort(); this.setIntent(intent); return true;
  }
  private setIntent(intent: DownloadIntent): void { this.desiredRunId = intent.kind === 'results' ? intent.runId : ''; this.session.selectExportVersion(intent.versionId); this.kind.set(intent.kind); this.selectedRunId.set(this.desiredRunId); if (this.desiredRunId && !this.historyLoading() && !this.history().some(run => run.id === this.desiredRunId)) void this.loadHistory(); }
  async loadHistory(append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId) return; const generation = ++this.generation; this.historyLoading.set(true);
    const requestedCursor = append ? this.cursor() ?? undefined : undefined;
    try { const page = await this.api.runs(workspaceId, requestedCursor); if (!this.current(workspaceId) || generation !== this.generation) return;
      this.history.set(append ? [...this.history(), ...page.items.filter(run => !this.history().some(previous => previous.id === run.id))] : page.items); this.cursor.set(page.nextCursor);
      if (this.desiredRunId && !this.history().some(run => run.id === this.desiredRunId) && page.nextCursor && page.nextCursor !== requestedCursor) await this.loadHistory(true);
    } catch (error) { if (generation === this.generation) this.report(error); } finally { if (generation === this.generation) this.historyLoading.set(false); }
  }
  async loadSummary(force = false): Promise<void> {
    const intent = this.intent(); if (!intent) { this.summaryGeneration++; this.summaryKey = ''; this.summary.set(null); this.summaryLoading.set(false); return; }
    const key = downloadIntentKey(intent); if (!force && key === this.summaryKey && (this.summaryLoading() || this.summary())) return;
    this.summaryKey = key; const generation = ++this.summaryGeneration; this.summary.set(null); this.summaryLoading.set(true); this.summaryError.set(null);
    try { const summary = await this.api.exportSummary(intent.workspaceId, intent.versionId, intent.kind, intent.kind === 'results' ? intent.runId : undefined);
      if (!this.current(intent.workspaceId) || generation !== this.summaryGeneration || !sameDownloadIntent(intent, this.intent())) return;
      if (!sameDownloadIntent(summary.intent, intent) || !summary.intentFingerprint || summary.versionId !== intent.versionId || summary.reports.length > 20) throw new Error('Invalid download summary'); this.summary.set(summary);
    } catch { if (this.current(intent.workspaceId) && generation === this.summaryGeneration) this.summaryError.set('No se pudo consultar el contenido de esta versión. Puedes volver a intentarlo.'); }
    finally { if (this.alive && generation === this.summaryGeneration) this.summaryLoading.set(false); }
  }
  async activate(): Promise<void> {
    if (this.pending() || this.state() === 'preparing' || this.session.pending()) return;
    if (this.uncertain()) { await this.recover(); return; } if (this.ready()) { await this.download(); return; }
    if (this.completedJob && sameDownloadIntent(this.attempt?.intent, this.intent())) { this.state.set('preparing'); await this.finish(this.completedJob); return; } await this.start();
  }
  async start(): Promise<void> {
    const intent = this.intent(), etag = this.session.etag(); if (!intent || !etag || !this.canStart()) return;
    const attempt: ExportOperationAttempt = { operation: 'export', intent, etag, key: crypto.randomUUID() };
    try { this.attempts.save(attempt); } catch (error) { this.report(error); this.state.set('failed'); return; }
    this.attempt = attempt; this.autoTransfer = true; this.handledJob = ''; this.completedJob = null; await this.send();
  }
  async retry(): Promise<void> { await this.activate(); }
  private async send(): Promise<void> {
    const attempt = this.attempt; if (!attempt || !this.current(attempt.intent.workspaceId)) return; this.state.set('accepting'); this.error.set(null);
    try { const intent = attempt.intent, job = await (intent.kind === 'report' ? this.api.exportReport(intent.workspaceId, intent.versionId, attempt.etag, attempt.key) : this.api.exportResults(intent.workspaceId, intent.versionId, intent.runId, attempt.etag, attempt.key));
      if (this.attempt !== attempt || !this.current(intent.workspaceId)) return; this.accept(job, { ...attempt, operationId: job.jobId, jobId: job.jobId });
    } catch (error) { if (this.attempt !== attempt || !this.current(attempt.intent.workspaceId)) return;
      this.state.set(error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500) ? 'uncertain' : error instanceof HttpErrorResponse && [401, 403, 410].includes(error.status) ? 'expired' : 'failed');
      if (!this.uncertain()) this.attempts.clear('export', attempt.intent.workspaceId); this.report(error);
    }
  }
  private accept(job: JobDTO, attempt: ExportOperationAttempt): void {
    if (job.workspaceId !== attempt.intent.workspaceId || job.kind !== 'export') throw new Error('Invalid export acceptance');
    // The pre-send record still recovers by key if updating known IDs fails.
    this.attempt = attempt; try { this.attempts.save(attempt); } catch { /* Already durably saved before sending. */ }
    this.state.set('preparing'); this.session.trackJob(job);
  }
  private async recover(): Promise<void> {
    const attempt = this.attempt; if (!attempt || !this.current(attempt.intent.workspaceId)) return; this.state.set('accepting'); this.error.set(null);
    try { const receipt = attempt.operationId ? await this.api.operation(attempt.operationId) : await this.api.operationReceipt(attempt.key);
      if (this.attempt !== attempt || !this.current(attempt.intent.workspaceId)) return;
      if (receipt.workspaceId !== attempt.intent.workspaceId || receipt.reservation?.kind !== 'export' || !sameDownloadIntent(receipt.reservation.intent, attempt.intent)) throw new Error('Invalid export receipt');
      const job = await this.api.job(receipt.workspaceId, receipt.jobId); if (this.attempt !== attempt || !this.current(attempt.intent.workspaceId)) return;
      this.accept(job, { ...attempt, operationId: receipt.operationId, jobId: receipt.jobId });
    } catch (error) { if (this.attempt !== attempt || !this.current(attempt.intent.workspaceId)) return;
      if (error instanceof HttpErrorResponse && error.status === 404 && !attempt.operationId) { await this.send(); return; }
      this.state.set(error instanceof HttpErrorResponse && [401, 403, 410].includes(error.status) ? 'expired' : 'uncertain'); this.report(error);
    }
  }
  private async finish(job: JobDTO): Promise<void> {
    const attempt = this.attempt; if (!attempt || job.jobId !== attempt.jobId || !this.current(attempt.intent.workspaceId)) return;
    if (job.status !== 'succeeded' || job.resultRef?.type !== 'export') {
      this.attempts.clear('export', attempt.intent.workspaceId);
      if (sameDownloadIntent(this.intent(), attempt.intent)) { this.state.set(job.status === 'cancelled' ? 'cancelled' : 'failed'); this.error.set(job.diagnostics[0]?.message ?? 'La preparación no se completó. Puedes volver a intentarlo.'); }
      else this.state.set(this.ready() ? 'ready' : 'idle'); return;
    }
    this.completedJob = job;
    try {
      const artifact = await this.api.exportArtifactSummary(job.workspaceId, job.resultRef.id);
      const matchingSummary = sameDownloadIntent(this.summary()?.intent, attempt.intent) ? this.summary()! : await this.api.exportSummary(attempt.intent.workspaceId, attempt.intent.versionId, attempt.intent.kind, attempt.intent.kind === 'results' ? attempt.intent.runId : undefined);
      if (!this.current(attempt.intent.workspaceId) || this.attempt !== attempt) return;
      if (!sameDownloadIntent(artifact.intent, attempt.intent) || !sameDownloadIntent(matchingSummary.intent, attempt.intent) || artifact.id !== job.resultRef.id || artifact.jobId !== job.jobId || !artifact.intentFingerprint || artifact.intentFingerprint !== matchingSummary.intentFingerprint) throw new Error('La identidad del archivo no coincide con la descarga solicitada.');
      this.artifacts.update(items => new Map([...items, [downloadIntentKey(attempt.intent), artifact]]));
      this.state.set(this.ready() ? 'ready' : 'idle');
      if (this.autoTransfer && sameDownloadIntent(this.intent(), attempt.intent)) { this.autoTransfer = false; await this.download(artifact); }
    } catch (error) { if (this.current(attempt.intent.workspaceId)) { if (sameDownloadIntent(attempt.intent, this.intent())) { if(this.artifactExpired(error))this.forgetArtifact(attempt.intent);else this.state.set('failed'); this.report(error); } else this.state.set(this.ready() ? 'ready' : 'idle'); } }
  }
  async download(artifact = this.ready()): Promise<void> {
    if (!artifact || !this.current(artifact.intent.workspaceId) || !sameDownloadIntent(artifact.intent, this.intent())) return;
    this.transfer?.abort(); const controller = new AbortController(); this.transfer = controller; this.state.set('transferring'); this.error.set(null);
    try { const blob = await this.api.downloadExport(artifact.intent.workspaceId, artifact.id, controller.signal,artifact);
      if (controller.signal.aborted || !this.current(artifact.intent.workspaceId) || !sameDownloadIntent(artifact.intent, this.intent())) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = artifact.filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); this.state.set('ready');
    } catch (error) { if (!controller.signal.aborted && this.current(artifact.intent.workspaceId) && sameDownloadIntent(artifact.intent, this.intent())) { if(this.artifactExpired(error))this.forgetArtifact(artifact.intent);else this.state.set('failed');this.report(error); } }
    finally { if (this.transfer === controller) { this.transfer = null; if (controller.signal.aborted && this.state() === 'transferring') this.state.set(this.ready() ? 'ready' : 'idle'); } }
  }
  async cancel(): Promise<void> {
    if (this.transfer) { this.transfer.abort(); this.transfer = null; this.state.set(this.ready() ? 'ready' : 'cancelled'); return; }
    if (this.attempt?.jobId === this.session.job()?.jobId && this.session.jobActive()) await this.session.cancelJob();
  }
  private current(workspaceId: string): boolean { return this.alive && workspaceId === this.session.workspace()?.id; }
  private artifactExpired(error:unknown):boolean{return error instanceof ArtifactExpiredError||error instanceof HttpErrorResponse&&error.status===410&&error.error?.error?.code==='ARTIFACT_EXPIRED';}
  private forgetArtifact(intent:DownloadIntent):void{this.artifacts.update(items=>{const next=new Map(items);next.delete(downloadIntentKey(intent));return next;});this.completedJob=null;this.attempt=null;this.autoTransfer=false;this.attempts.clear('export',intent.workspaceId);this.state.set('expired');}
  private reset(): void {
    this.generation++; this.summaryGeneration++; this.summaryKey = ''; this.lastIntent = ''; this.desiredRunId = ''; this.transfer?.abort(); this.transfer = null;
    this.summary.set(null); this.summaryLoading.set(false); this.summaryError.set(null); this.attempt = null; this.handledJob = ''; this.autoTransfer = false; this.completedJob = null;
    this.artifacts.set(new Map()); this.history.set([]); this.cursor.set(null); this.selectedRunId.set(''); this.kind.set('report'); this.error.set(null); this.state.set('idle');
  }
  private report(error: unknown): void { this.error.set(error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : error instanceof Error && !(error instanceof HttpErrorResponse) ? error.message : 'No se pudo confirmar la exportación o descargar el archivo.'); }
}
