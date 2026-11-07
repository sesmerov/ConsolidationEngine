import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isRationalValue, isTerminalJob } from '@ce/contracts';
import type { ApplicationRequestDTO, CompactApplyReceiptDTO, CompactPreviewDTO, JobDTO, ProposalSelectionSummaryDTO, ProposalSelectionPageDTO, ProposalSelectionRowDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
import { CursorPage, CursorPageError } from '../core/cursor-page';
interface Attempt { workspaceId: string; etag: string; key: string; body: ApplicationRequestDTO }
@Injectable({ providedIn: 'root' })
export class ApplyStore {
  readonly preview = signal<CompactPreviewDTO | null>(null); readonly selection = signal<ProposalSelectionSummaryDTO | null>(null); readonly selectionBusy = signal(false);
  readonly session = inject(SessionStore); private readonly api = inject(ApiClient); private readonly view = inject(WorkspaceViewStore);
  private accepted: { jobId: string; previewId: string; baseVersionId: string; closureHash: string; selectionId: string; revision: number } | null = null;
  readonly acknowledged = signal(false); readonly pending = signal(false); readonly error = signal<string | null>(null); readonly uncertain = signal(false); readonly rejected = signal(false);
  readonly reviewOpen = signal(false); readonly reviewLoading = signal(false); readonly reviewPage = signal<ProposalSelectionPageDTO | null>(null); readonly reviewPagination = new CursorPage();
  private contextKey = ''; private attempt: Attempt | undefined; private workspaceId: string | undefined; private reviewGeneration = 0;
  readonly canApply = computed(() => {
    const preview = this.preview(), selection = this.selection(), workspace = this.session.workspace();
    return !!workspace && preview?.state === 'ready' && preview.baseVersionId === this.session.versionId()
      && selection?.workspaceId === workspace.id && selection.previewId === preview.id && selection.baseVersionId === preview.baseVersionId
      && selection.state === 'ready' && selection.revision > 0 && !!selection.selectedCount && selection.complete === true && selection.requiredCount === 0 && !!selection.closureHash
      && !!this.session.etag() && !this.session.pending() && !this.session.jobActive() && !this.pending() && !this.uncertain() && !this.rejected() && !this.selectionBusy()
      && (!this.reviewOpen() || !this.reviewLoading() && this.reviewPage()?.revision === selection.revision);
  });
  constructor() {
    effect(() => { const job = this.session.job(); if (job?.kind === 'apply' && job.status === 'succeeded' && job.resultRef?.type === 'application' && job.jobId === this.accepted?.jobId) untracked(() => { void this.observeReceipt(job); }); });
    effect(() => {
      const p = this.preview(), s = this.selection(), base = this.session.versionId(), workspaceId = this.session.workspace()?.id;
      const key = JSON.stringify([workspaceId, base, p?.id, p?.state, s?.id, s?.revision, s?.state, s?.closureHash]);
      untracked(() => { if (key !== this.contextKey) {
        this.contextKey = key; this.acknowledged.set(false); if (!this.uncertain()) this.rejected.set(false);
        this.reviewGeneration++; this.reviewPage.set(null); this.reviewPagination.reset(); this.reviewLoading.set(false);
        if (this.reviewOpen() && s?.state === 'ready' && s.selectedCount) void this.loadReview();
      } });
    });
    effect(() => { const id = this.session.workspace()?.id; if (id !== this.workspaceId) { this.workspaceId = id; untracked(() => {
      this.attempt = undefined; this.accepted = null; this.uncertain.set(false); this.pending.set(false); this.rejected.set(false); this.error.set(null); this.acknowledged.set(false);
      this.reviewOpen.set(false); this.reviewGeneration++; this.reviewPage.set(null); this.reviewPagination.reset(); this.reviewLoading.set(false);
    }); } });
  }
  private async observeReceipt(job: JobDTO): Promise<void> { try { this.confirmReceipt((await this.api.applicationCompact(job.workspaceId, job.resultRef!.id)).receipt); } catch { /* Comparison independently reconciles the same receipt. */ } }
  confirmReceipt(receipt: CompactApplyReceiptDTO): void {
    const accepted = this.accepted, job = this.session.job();
    if (!accepted || !job || job.jobId !== accepted.jobId || job.status !== 'succeeded' || job.resultRef?.id !== receipt.id || job.newVersionId !== receipt.newVersionId
      || job.workspaceId !== this.session.workspace()?.id || accepted.previewId !== receipt.previewId || accepted.baseVersionId !== receipt.baseVersionId
      || accepted.closureHash !== receipt.closureHash || accepted.selectionId !== receipt.selectionRef?.id || accepted.revision !== receipt.selectionRef.revision) return;
    this.view.published(job.workspaceId, receipt.baseVersionId, receipt.newVersionId, job.jobId, 'exports', receipt.id); this.accepted = null;
  }
  invalidateSelection(): void { this.acknowledged.set(false); this.selection.set(null); }
  toggleReview(open: boolean): void { this.reviewOpen.set(open); if (open && !this.reviewPage() && !this.reviewLoading()) void this.loadReview(); }
  async loadReview(index = 0): Promise<void> {
    const w = this.session.workspace()?.id, p = this.preview(), s = this.selection(); if (!w || !p || !s?.revision || !s.selectedCount) return;
    const request = this.reviewPagination.begin(JSON.stringify([w, p.id, s.id, s.revision]), index), generation = ++this.reviewGeneration;
    this.reviewLoading.set(true); this.error.set(null);
    try { const page = await this.api.selectionRows(w, p.id, { scope: 'selected', ...(request.cursor ? { cursor: request.cursor } : {}) });
      if (generation !== this.reviewGeneration || w !== this.session.workspace()?.id || p.id !== this.preview()?.id) return;
      if (page.selectionId !== s.id || page.revision !== this.selection()?.revision || page.scope !== 'selected') throw new CursorPageError('La selección ha cambiado. Revisa los cambios actuales.');
      this.reviewPagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.reviewPage.set(page);
    } catch (error) { if (generation === this.reviewGeneration) { this.acknowledged.set(false); this.error.set(error instanceof CursorPageError ? error.message : 'No se pudieron consultar los cambios seleccionados. Vuelve a intentarlo.'); } }
    finally { if (generation === this.reviewGeneration) this.reviewLoading.set(false); }
  }
  async apply(): Promise<void> {
    const workspaceId = this.session.workspace()?.id, etag = this.session.etag(), selection = this.selection(), preview = this.preview();
    if (!workspaceId || !etag || !selection?.closureHash || !preview || !this.canApply() || !this.acknowledged()) return;
    this.attempt = { workspaceId, etag, key: crypto.randomUUID(), body: { baseVersionId: preview.baseVersionId, previewId: preview.id,
      selectionRef: { id: selection.id, revision: selection.revision }, closureHash: selection.closureHash } }; await this.send();
  }
  async retry(): Promise<void> { if (!this.uncertain() || this.pending() || this.session.pending() || this.session.jobActive()) return; await this.send(); }
  private async send(): Promise<void> {
    const attempt = this.attempt; if (!attempt || attempt.workspaceId !== this.session.workspace()?.id) return; this.pending.set(true); this.error.set(null);
    try { const job = await this.api.apply(attempt.workspaceId, attempt.body, attempt.etag, attempt.key); if (this.attempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return;
      this.uncertain.set(false); this.acknowledged.set(false); this.attempt = undefined;
      const { previewId, baseVersionId, closureHash, selectionRef } = attempt.body;
      if (selectionRef) this.accepted = { jobId: job.jobId, previewId, baseVersionId, closureHash, selectionId: selectionRef.id, revision: selectionRef.revision };
      this.session.trackJob(job); if (isTerminalJob(job.status)) await this.session.refreshWorkspace(attempt.workspaceId);
    } catch (error) { if (this.attempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return;
      const uncertain = error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500); this.uncertain.set(uncertain); this.rejected.set(!uncertain);
      this.error.set(uncertain ? 'No se ha podido confirmar la respuesta. Reintenta la misma aplicación para recuperar su estado sin duplicar cambios.'
        : error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo aplicar la selección.');
    } finally { if (attempt.workspaceId === this.session.workspace()?.id) this.pending.set(false); }
  }
  target(row: ProposalSelectionRowDTO): string { const c = row.target; return [c.tableCode, c.sheetCode ? 's' + c.sheetCode : '', 'r' + c.rowCode, 'c' + c.columnCode].filter(Boolean).join(' · '); }
  noChange(row: ProposalSelectionRowDTO): boolean { if (row.before?.presence !== 'value' || !row.after) return false; const a = row.before.normalizedValue, b = row.after.normalizedValue;
    return typeof a === 'boolean' || typeof b === 'boolean' ? a === b : isRationalValue(a) && isRationalValue(b) && a.numerator === b.numerator && a.denominator === b.denominator; }
}
