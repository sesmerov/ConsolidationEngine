import { computed, Injectable, signal } from '@angular/core';
import type { DownloadIntent, JobDTO, ValidationRunDTO } from '@ce/contracts';
export interface ResultPresentation { jobId: string; workspaceId: string; versionId: string | null }
export type WorkspaceStage = 'import' | 'validation' | 'preview' | 'exports';
type NextStage = Exclude<WorkspaceStage, 'import'>;
interface Publication {
  kind: 'publication'; workspaceId: string; baseVersionId: string | null; newVersionId: string;
  operationId: string; target: Exclude<NextStage, 'preview'>; receiptId?: string;
}
interface ValidationCompletion {
  kind: 'validation'; workspaceId: string; versionId: string; validationBasisId?: string; operationId: string; target: 'preview';
}
type Milestone = Publication | ValidationCompletion;
type CompletedRun = Pick<ValidationRunDTO, 'id' | 'versionId' | 'validationBasisId' | 'status' | 'summary'>;

@Injectable({ providedIn: 'root' })
export class WorkspaceViewStore {
  readonly downloadIntentEntry = signal<{ id: number; intent: DownloadIntent } | null>(null);
  private downloadSequence = 0;
  requestDownload(intent: DownloadIntent): void {
    if (intent.workspaceId !== this.workspaceId) return;
    this.downloadIntentEntry.set({ id: ++this.downloadSequence, intent }); this.stage.set('exports');
  }
  consumeDownloadIntent(id: number): void { if (this.downloadIntentEntry()?.id === id) this.downloadIntentEntry.set(null); }
  readonly stage = signal<WorkspaceStage>('import');
  private readonly hint = signal<Milestone | null>(null);
  readonly recommended = computed(() => this.hint()?.target ?? null);
  readonly downloadEntry = signal<Publication | null>(null);
  readonly highlight = signal<{ id: string; startedAt: number; endsAt: number } | null>(null);
  private readonly announced = new Set<string>();
  private readonly presented = signal<ReadonlySet<string>>(new Set());
  private pending: Publication | null = null;
  private workspaceId: string | null = null;
  private versionId: string | null = null;
  private validationBasisId: string | null = null;
  private readonly consumed = new Set<string>();

  reconcile(workspaceId: string | null, versionId: string | null, validationBasisId: string | null = null): void {
    if (this.workspaceId !== workspaceId) {
      this.workspaceId = workspaceId; this.downloadIntentEntry.set(null);
      this.consumed.clear(); this.announced.clear(); this.presented.set(new Set()); this.pending = null; this.hint.set(null); this.highlight.set(null); this.downloadEntry.set(null);
    }
    this.versionId = versionId; this.validationBasisId = validationBasisId;
    const hint = this.hint();
    if (hint && !this.matchesCurrent(hint)) { this.hint.set(null); this.highlight.set(null); }
    if (this.downloadEntry()?.newVersionId !== versionId) this.downloadEntry.set(null);
    const pending = this.pending;
    if (!pending) return;
    if (pending.newVersionId === versionId) { this.pending = null; this.present(pending); }
    else if (pending.baseVersionId !== versionId) this.pending = null;
  }

  /** Import/application publish a version; a configuration save is not a workflow milestone. */
  published(workspaceId: string, baseVersionId: string | null, newVersionId: string, operationId: string, target: NextStage, receiptId?: string): void {
    if (target === 'preview' || workspaceId !== this.workspaceId || this.consumed.has('publication:' + operationId)) return;
    if (this.versionId !== baseVersionId && this.versionId !== newVersionId) return;
    if (target === 'exports' && !receiptId) return;
    this.pending = { kind: 'publication', workspaceId, baseVersionId, newVersionId, operationId, target, ...(receiptId ? { receiptId } : {}) };
    this.reconcile(workspaceId, this.versionId, this.validationBasisId);
  }

  /** A confirmed complete run can advance without inventing a newly published version. */
  validated(workspaceId: string, run: CompletedRun): void {
    if (workspaceId !== this.workspaceId || run.status !== 'completed' || !run.summary.complete) return;
    const milestone: ValidationCompletion = { kind: 'validation', workspaceId, versionId: run.versionId,
      ...(run.validationBasisId ? { validationBasisId: run.validationBasisId } : {}), operationId: run.id, target: 'preview' };
    if (this.matchesCurrent(milestone)) this.present(milestone);
  }

  private matchesCurrent(milestone: Milestone): boolean {
    if (milestone.workspaceId !== this.workspaceId || !this.versionId) return false;
    if (milestone.kind === 'publication') return milestone.newVersionId === this.versionId;
    return milestone.validationBasisId && this.validationBasisId
      ? milestone.validationBasisId === this.validationBasisId
      : milestone.versionId === this.versionId;
  }
  private present(milestone: Milestone): void {
    const key = milestone.kind + ':' + milestone.operationId;
    if (this.consumed.has(key)) return;
    this.consumed.add(key);
    if (milestone.target === this.stage()) {
      if (milestone.kind === 'publication' && milestone.target === 'exports') this.downloadEntry.set(milestone);
      return;
    }
    this.hint.set(milestone);
    const startedAt = Date.now();
    this.highlight.set({ id: JSON.stringify([milestone.workspaceId, key]), startedAt, endsAt: startedAt + 4_500 });
  }
  visit(stage: WorkspaceStage): void {
    const hint = this.hint();
    if (hint?.target === stage) {
      if (hint.kind === 'publication' && stage === 'exports') this.downloadEntry.set(hint);
      this.hint.set(null); this.highlight.set(null);
    }
    this.stage.set(stage);
  }
  claimAnnouncement(): string | null {
    const highlight = this.highlight(), target = this.recommended();
    if (!highlight || !target || this.announced.has(highlight.id)) return null;
    this.announced.add(highlight.id);
    return { validation: 'Validar', preview: 'Recalcular', exports: 'Descargar' }[target];
  }
  resultPresented(result: ResultPresentation): void {
    if (result.workspaceId !== this.workspaceId || result.versionId !== this.versionId) return;
    const key = JSON.stringify([result.workspaceId, result.jobId, result.versionId]);
    if (!this.presented().has(key)) this.presented.update(old => new Set([...old, key]));
  }
  resultWasPresented(job: JobDTO): boolean {
    return job.status === 'succeeded' && job.progress.complete && this.presented().has(JSON.stringify([job.workspaceId, job.jobId, job.newVersionId ?? job.baseVersionId ?? null]));
  }
}
