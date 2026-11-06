import { computed, Injectable, signal } from '@angular/core';
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
  private pending: Publication | null = null;
  private workspaceId: string | null = null;
  private versionId: string | null = null;
  private readonly consumed = new Set<string>();

  reconcile(workspaceId: string | null, versionId: string | null): void {
    if (this.workspaceId !== workspaceId) {
      this.workspaceId = workspaceId;
      this.consumed.clear(); this.pending = null; this.hint.set(null); this.downloadEntry.set(null);
    }
    this.versionId = versionId;
    if (this.hint()?.newVersionId !== versionId) this.hint.set(null);
    if (this.downloadEntry()?.newVersionId !== versionId) this.downloadEntry.set(null);
    const pending = this.pending;
    if (!pending) return;
    if (pending.newVersionId === versionId) {
      this.pending = null; this.consumed.add(pending.operationId);
      if (pending.target === this.stage()) {
        if (pending.target === 'exports') this.downloadEntry.set(pending);
      } else this.hint.set(pending);
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
      this.hint.set(null);
    }
    this.stage.set(stage);
  }
}
