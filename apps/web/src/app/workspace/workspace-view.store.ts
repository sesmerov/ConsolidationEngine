import { computed, Injectable, signal } from '@angular/core';
import type { JobDTO } from '@ce/contracts';
export interface ResultPresentation { jobId: string; workspaceId: string; versionId: string | null }
export type WorkspaceStage = 'import' | 'validation' | 'preview' | 'exports';
type NextStage = Exclude<WorkspaceStage, 'import'>;
interface Publication {
  workspaceId: string; baseVersionId: string | null; newVersionId: string; operationId: string; target: NextStage; receiptId?: string;
}
@Injectable({ providedIn: 'root' })
export class WorkspaceViewStore {
  readonly stage = signal<WorkspaceStage>('import');
  private readonly hint = signal<Publication | null>(null);
  readonly recommended = computed(() => this.hint()?.target ?? null);
  readonly downloadEntry = signal<Publication | null>(null);
  readonly highlight = signal<{ id: string; startedAt: number; endsAt: number } | null>(null);
  private readonly announced = new Set<string>();
  private readonly presented = signal<ReadonlySet<string>>(new Set());
  private pending: Publication | null = null;
  private workspaceId: string | null = null;
  private versionId: string | null = null;
  private readonly consumed = new Set<string>();

  reconcile(workspaceId: string | null, versionId: string | null): void {
    if (this.workspaceId !== workspaceId) {
      this.workspaceId = workspaceId;
      this.consumed.clear(); this.announced.clear(); this.presented.set(new Set()); this.pending = null; this.hint.set(null); this.highlight.set(null); this.downloadEntry.set(null);
    }
    this.versionId = versionId;
    if (this.hint()?.newVersionId !== versionId) { this.hint.set(null); this.highlight.set(null); }
    if (this.downloadEntry()?.newVersionId !== versionId) this.downloadEntry.set(null);
    const pending = this.pending;
    if (!pending) return;
    if (pending.newVersionId === versionId) {
      this.pending = null; this.consumed.add(pending.operationId);
      if (pending.target === this.stage()) {
        if (pending.target === 'exports') this.downloadEntry.set(pending);
      } else {
        this.hint.set(pending);
        const startedAt = Date.now();
        this.highlight.set({ id: JSON.stringify([pending.workspaceId, pending.operationId, pending.baseVersionId, pending.newVersionId]), startedAt, endsAt: startedAt + 4_500 });
      }
    } else if (pending.baseVersionId !== versionId) this.pending = null;
  }

  published(workspaceId: string, baseVersionId: string | null, newVersionId: string, operationId: string, target: NextStage, receiptId?: string): void {
    if (workspaceId !== this.workspaceId || this.consumed.has(operationId)) return;
    if (this.versionId !== baseVersionId && this.versionId !== newVersionId) return;
    if (target === 'exports' && !receiptId) return;
    this.pending = { workspaceId, baseVersionId, newVersionId, operationId, target, ...(receiptId ? { receiptId } : {}) };
    this.reconcile(workspaceId, this.versionId);
  }

  visit(stage: WorkspaceStage): void {
    const hint = this.hint();
    if (hint?.target === stage) {
      if (stage === 'exports') this.downloadEntry.set(hint);
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
