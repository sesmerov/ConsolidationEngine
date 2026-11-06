import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type {
  DirectionReviewCommitDTO, DirectionReviewDecision, DirectionReviewOperationDTO, DirectionReviewPageDTO,
  DirectionReviewPatchDTO, DirectionReviewPrepareDTO, DirectionReviewReceiptDTO, DirectionReviewRowDTO,
  DirectionReviewSummaryDTO, JobDTO, TargetSide, ValidationRunDTO,
} from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { CursorPage, CursorPageError } from '../core/cursor-page';
import { SessionStore } from '../core/session.store';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';

type Attempt = { workspaceId: string; etag: string } & (
  | { kind: 'prepare'; body: DirectionReviewPrepareDTO; key: string }
  | { kind: 'edit'; id: string; body: DirectionReviewPatchDTO }
  | { kind: 'commit'; id: string; body: DirectionReviewCommitDTO; key: string }
);
const errorMessage = (error: unknown) => error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string'
  ? error.error.error.message as string : error instanceof CursorPageError ? error.message : 'No se pudo completar la revisión de destinos.';

@Injectable({ providedIn: 'root' })
export class DirectionsStore {
  readonly session = inject(SessionStore);
  private readonly api = inject(ApiClient);
  private readonly view = inject(WorkspaceViewStore);
  private scope = '';
  private boundWorkspaceId = '';
  private requiresWorkspaceRefresh = false;
  private alive = true;
  private lookupGeneration = 0;
  private rowGeneration = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private attempt: Attempt | null = null;
  private observedJob: { jobId: string; reviewId?: string } | null = null;
  private commitOrigin: string | null = null;
  private readonly synchronized = signal(false);

  readonly run = signal<ValidationRunDTO | null>(null);
  readonly review = signal<DirectionReviewSummaryDTO | null>(null);
  readonly otherReview = signal<DirectionReviewSummaryDTO | null>(null);
  readonly rows = signal<DirectionReviewPageDTO | null>(null);
  readonly receipt = signal<DirectionReviewReceiptDTO | null>(null);
  readonly stateFilter = signal<DirectionReviewDecision | ''>('');
  readonly groupFilter = signal('');
  readonly pagination = new CursorPage();
  readonly partialAccepted = signal(false);
  readonly uncertain = signal(false);
  readonly pending = signal(false);
  readonly looking = signal(false);
  readonly loading = signal(false);
  readonly expired = signal(false);
  readonly error = signal('');
  readonly historical = computed(() => this.run()?.versionId !== this.session.versionId());
  readonly complete = computed(() => this.run()?.status === 'completed' && this.run()?.summary.complete === true);
  readonly busy = computed(() => this.pending() || this.looking() || this.loading() || this.session.pending() || this.session.jobActive());
  readonly needsPartial = computed(() => {
    const counts = this.review()?.counts;
    return !!counts && counts.pending + counts.undetermined > 0;
  });
  readonly canPrepare = computed(() => this.synchronized() && !!this.run() && this.complete() && !this.historical() && !this.busy() && !this.uncertain()
    && !this.otherReview() && (!this.review() || this.expired() || ['expired','obsolete','discarded','failed'].includes(this.review()!.state)));
  readonly editable = computed(() => this.synchronized() && this.complete() && !this.historical() && !this.expired() && !this.uncertain() && !this.busy()
    && !this.otherReview() && this.review()?.state === 'ready' && !!this.review()?.counts && this.rows()?.revision === this.review()?.revision);
  readonly canSave = computed(() => this.editable() && this.review()?.conflictGroupCount === 0 && (!this.needsPartial() || this.partialAccepted()));
  readonly conflicts = computed(() => {
    const groups = new Map<string, DirectionReviewRowDTO[]>();
    for (const row of this.rows()?.items ?? []) {
      if (row.state !== 'conflicted' || !row.groupId) continue;
      const members = groups.get(row.groupId) ?? [];
      members.push(row); groups.set(row.groupId, members);
    }
    return [...groups.entries()].map(([id, members]) => {
      const first = members[0]!;
      const targetLabel = first.options.find(option => option.side === first.selectedSide)?.label ?? first.location;
      return { id, members, targetLabel, contextLabel:first.contextLabel, total:first.producerCount ?? members.length };
    });
  });
  readonly configurable = computed(() => (this.rows()?.items ?? []).filter(row => ['included','pending','omitted'].includes(row.state)));
  readonly unavailable = computed(() => (this.rows()?.items ?? []).filter(row => row.state === 'excluded' || row.state === 'undetermined'));

  constructor() {
    effect(() => {
      const job = this.session.job();
      if (!job || job.workspaceId !== this.session.workspace()?.id || !isTerminalJob(job.status) || job.jobId !== this.observedJob?.jobId) return;
      const tracked = this.observedJob;
      this.observedJob = null;
      untracked(() => { void this.finishJob(job, tracked.reviewId ?? job.resultRef?.id); });
    });
    inject(DestroyRef).onDestroy(() => {
      this.alive = false;
      clearTimeout(this.expiryTimer);
      this.lookupGeneration++; this.rowGeneration++;
    });
  }

  bind(run: ValidationRunDTO): void {
    const workspaceId = this.session.workspace()?.id;
    if (!workspaceId) return;
    const key = workspaceId + ':' + run.id + ':' + run.versionId;
    this.run.set(run);
    if (key === this.scope) return;
    if (workspaceId !== this.boundWorkspaceId) {
      this.boundWorkspaceId = workspaceId;
      this.requiresWorkspaceRefresh = false;
      this.attempt = null; this.commitOrigin = null; this.observedJob = null;
      this.uncertain.set(false); this.pending.set(false);
    }
    this.scope = key;
    this.lookupGeneration++; this.rowGeneration++;
    this.review.set(null); this.rows.set(null); this.otherReview.set(null); this.receipt.set(null);
    this.stateFilter.set(''); this.groupFilter.set(''); this.partialAccepted.set(false);
    this.expired.set(false); this.loading.set(false); this.error.set(''); clearTimeout(this.expiryTimer);
    void this.recover();
  }
  private owns(workspaceId: string): boolean { return this.alive && this.session.workspace()?.id === workspaceId; }
  private matches(summary: DirectionReviewSummaryDTO): boolean {
    return this.owns(summary.workspaceId) && this.run()?.id === summary.runId && this.run()?.versionId === summary.baseVersionId;
  }

  async recover(): Promise<void> {
    const workspaceId = this.session.workspace()?.id;
    if (!workspaceId || !this.run()) return;
    const generation = ++this.lookupGeneration;
    this.looking.set(true);
    this.synchronized.set(false);
    try {
      if (this.requiresWorkspaceRefresh) {
        await this.session.refreshWorkspace(workspaceId);
        if (!this.owns(workspaceId) || generation !== this.lookupGeneration) return;
        this.requiresWorkspaceRefresh = false;
      }
      const {active, latestCommit} = await this.api.activeDirectionReviews(workspaceId);
      if (!this.owns(workspaceId) || generation !== this.lookupGeneration) return;
      this.synchronized.set(true);
      if (latestCommit && this.commitOrigin === latestCommit.reviewId) {
        await this.acceptReceipt(workspaceId, latestCommit);
        if (!this.owns(workspaceId) || generation !== this.lookupGeneration) return;
      }
      this.otherReview.set(active && !this.matches(active) ? active : null);
      if (active && this.matches(active)) {
        await this.acceptSummary(active);
        if (['preparing','committing'].includes(active.state) && active.jobId && generation === this.lookupGeneration) {
          const job = await this.api.job(workspaceId,active.jobId);
          if (this.owns(workspaceId) && generation === this.lookupGeneration) this.track(job,active.id);
        }
      } else if (this.review()?.state === 'ready' || this.review()?.state === 'committing') {
        const existing = this.review()!;
        const summary = await this.api.directionReview(workspaceId, existing.id);
        if (!this.owns(workspaceId) || generation !== this.lookupGeneration) return;
        await this.acceptSummary(summary);
      }
      if (latestCommit && this.owns(workspaceId) && generation === this.lookupGeneration) await this.acceptReceipt(workspaceId, latestCommit);
    } catch (error) {
      if (generation === this.lookupGeneration && this.owns(workspaceId)) {
        this.synchronized.set(false); this.error.set(errorMessage(error));
      }
    } finally {
      if (generation === this.lookupGeneration) this.looking.set(false);
    }
  }
  private async acceptSummary(summary: DirectionReviewSummaryDTO): Promise<void> {
    if (!this.matches(summary)) return;
    const previous = this.review();
    if (previous?.id === summary.id && previous.revision > summary.revision) return;
    if (previous?.id === summary.id && previous.state === 'committed' && summary.state !== 'committed') return;
    this.review.set(summary);
    this.otherReview.set(null);
    if (previous?.id !== summary.id || previous.revision !== summary.revision) {
      this.partialAccepted.set(false); this.pagination.reset();
    }
    clearTimeout(this.expiryTimer);
    this.expired.set(summary.state === 'expired');
    if (summary.state === 'ready') {
      const remaining = Date.parse(summary.expiresAt ?? '') - Date.now();
      if (!(remaining > 0)) { this.expired.set(true); this.rows.set(null); return; }
      this.expiryTimer = setTimeout(() => { this.expired.set(true); this.partialAccepted.set(false); }, Math.min(remaining,2_147_483_647));
      await this.loadRows(0);
    } else {
      this.rowGeneration++; this.loading.set(false); this.rows.set(null);
      if (summary.receipt) await this.acceptReceipt(summary.workspaceId,summary.receipt);
    }
  }
  private async acceptReceipt(workspaceId: string, receipt: DirectionReviewReceiptDTO): Promise<void> {
    const related = this.commitOrigin === receipt.reviewId;
    if (receipt.runId !== this.run()?.id && !related) return;
    this.receipt.set(receipt);
    const review = this.review();
    if (review?.id === receipt.reviewId) {
      clearTimeout(this.expiryTimer);
      this.review.set({ ...review, state:'committed', receipt });
      this.rowGeneration++; this.rows.set(null); this.loading.set(false); this.partialAccepted.set(false);
    }
    if (related) {
      this.commitOrigin = null;
      if (this.attempt?.kind === 'commit' && this.attempt.id === receipt.reviewId) {
        this.attempt = null; this.uncertain.set(false);
      }
      this.error.set('');
      if (receipt.included > 0) this.view.published(workspaceId,receipt.baseVersionId,receipt.newVersionId,receipt.reviewId,'preview');
    }
    if (this.session.versionId() === receipt.baseVersionId) await this.session.refreshWorkspace(workspaceId);
  }

  async loadRows(index = 0): Promise<void> {
    const review = this.review();
    if (!review || review.state !== 'ready' || this.expired() || !this.matches(review)) return;
    const generation = ++this.rowGeneration;
    const state = this.stateFilter(), groupId = this.groupFilter();
    this.loading.set(true);
    try {
      const request = this.pagination.begin(JSON.stringify([review.id,review.revision,state,groupId]),index);
      const page = await this.api.directionReviewRows(review.workspaceId,review.id,{
        ...(state ? {state} : {}), ...(groupId ? {groupId} : {}), ...(request.cursor ? {cursor:request.cursor} : {}),
      });
      if (generation !== this.rowGeneration || !this.matches(review) || this.review()?.id !== review.id) return;
      if (page.reviewId !== review.id || page.revision !== review.revision) {
        this.rows.set(null); this.error.set('La revisión cambió. Actualiza los destinos antes de continuar.'); return;
      }
      this.pagination.accept(request.index,page.total,page.nextCursor,page.items.length);
      this.rows.set(page);
    } catch (error) {
      if (generation === this.rowGeneration && this.matches(review)) { this.rows.set(null); this.error.set(errorMessage(error)); }
    } finally { if (generation === this.rowGeneration) this.loading.set(false); }
  }
  async filter(state: DirectionReviewDecision | '', groupId = ''): Promise<void> {
    this.stateFilter.set(state); this.groupFilter.set(groupId); this.rows.set(null);
    await this.loadRows();
  }

  async prepare(): Promise<void> {
    const run = this.run(), workspaceId = this.session.workspace()?.id, etag = this.session.etag();
    if (!run || !workspaceId || !etag || !this.canPrepare()) return;
    await this.send({kind:'prepare',workspaceId,etag,key:crypto.randomUUID(),body:{baseVersionId:run.versionId,runId:run.id}});
  }
  async choose(row: DirectionReviewRowDTO, choice: TargetSide | 'omit' | 'suggest'): Promise<void> {
    if (!row.instanceId || row.state === 'excluded' || row.state === 'undetermined' || row.state === 'conflicted') return;
    if ((choice === 'left' || choice === 'right') && !row.options.some(option => option.side === choice)) return;
    await this.edit({op:'set',instanceId:row.instanceId,choice});
  }
  async resolveGroup(groupId: string, winnerInstanceId: string | null): Promise<void> {
    if (!this.conflicts().some(group => group.id === groupId)) return;
    await this.edit({op:'resolveGroup',groupId,winnerInstanceId});
  }
  async omitAll(): Promise<void> { await this.edit({op:'omitAll'}); }
  private async edit(operation: DirectionReviewOperationDTO): Promise<void> {
    const review = this.review(), etag = this.session.etag();
    if (!review || !etag || !this.editable()) return;
    await this.send({kind:'edit',id:review.id,workspaceId:review.workspaceId,etag,
      body:{expectedRevision:review.revision,mutationId:crypto.randomUUID(),operations:[operation]}});
  }
  async save(): Promise<void> {
    const review = this.review(), etag = this.session.etag();
    if (!review || !etag || !this.canSave()) return;
    this.commitOrigin = review.id;
    await this.send({kind:'commit',id:review.id,workspaceId:review.workspaceId,etag,key:crypto.randomUUID(),
      body:{expectedRevision:review.revision,acceptPartial:this.needsPartial() && this.partialAccepted()}});
  }
  async retry(): Promise<void> {
    if (this.attempt && this.uncertain() && !this.pending()) await this.send(this.attempt);
  }
  private async send(attempt: Attempt): Promise<void> {
    if (!this.owns(attempt.workspaceId)) return;
    this.attempt = attempt; this.pending.set(true); this.error.set('');
    try {
      if (attempt.kind === 'edit') {
        const reply = await this.api.editDirectionReview(attempt.workspaceId,attempt.id,attempt.body,attempt.etag);
        if (this.attempt !== attempt || !this.owns(attempt.workspaceId)) return;
        this.attempt = null; this.uncertain.set(false);
        if (this.groupFilter()) { this.groupFilter.set(''); this.stateFilter.set(''); }
        await this.acceptSummary(reply.summary);
      } else {
        const job = attempt.kind === 'prepare'
          ? await this.api.prepareDirectionReview(attempt.workspaceId,attempt.body,attempt.etag,attempt.key)
          : await this.api.commitDirectionReview(attempt.workspaceId,attempt.id,attempt.body,attempt.etag,attempt.key);
        if (this.attempt !== attempt || !this.owns(attempt.workspaceId)) return;
        this.attempt = null; this.uncertain.set(false);
        this.track(job,attempt.kind === 'commit' ? attempt.id : job.resultRef?.id);
      }
    } catch (error) {
      if (this.attempt !== attempt || !this.owns(attempt.workspaceId)) return;
      this.error.set(errorMessage(error));
      const uncertain = error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500);
      this.uncertain.set(uncertain);
      if (!uncertain) { this.attempt = null; this.commitOrigin = null; }
      if (uncertain || error instanceof HttpErrorResponse && [409,410,412].includes(error.status)) {
        this.rows.set(null);
        if (error instanceof HttpErrorResponse && error.status === 412) this.requiresWorkspaceRefresh = true;
        await this.recover();
      }
    } finally { if (this.owns(attempt.workspaceId)) this.pending.set(false); }
  }
  private track(job: JobDTO, reviewId?: string): void {
    this.observedJob = { jobId:job.jobId,...(reviewId ? {reviewId} : {}) };
    if (job.kind === 'commit-directions' && reviewId) this.commitOrigin = reviewId;
    this.session.trackJob(job);
  }
  private async finishJob(job: JobDTO, id?: string): Promise<void> {
    const generation = this.lookupGeneration;
    this.looking.set(true);
    try {
      if (job.status !== 'succeeded') {
        this.error.set(job.diagnostics[0]?.message ?? 'La operación de destinos no se completó.');
        this.commitOrigin = null;
      }
      if (id) {
        const review = await this.api.directionReview(job.workspaceId,id);
        if (!this.owns(job.workspaceId)) return;
        if (this.matches(review)) await this.acceptSummary(review);
        else if (review.receipt) await this.acceptReceipt(job.workspaceId,review.receipt);
      } else await this.recover();
    } catch (error) { if (this.owns(job.workspaceId)) this.error.set(errorMessage(error)); }
    finally { if (generation === this.lookupGeneration) this.looking.set(false); }
  }
  async discard(): Promise<void> {
    const review = this.otherReview() ?? this.review(), etag = this.session.etag();
    if (!review || review.state !== 'ready' || !etag || this.busy() || this.uncertain()) return;
    this.pending.set(true);
    try {
      await this.api.discardDirectionReview(review.workspaceId,review.id,etag);
      if (this.owns(review.workspaceId)) { this.review.set(null); this.rows.set(null); this.otherReview.set(null); await this.recover(); }
    } catch(error) { if (this.owns(review.workspaceId)) this.error.set(errorMessage(error)); }
    finally { if (this.owns(review.workspaceId)) this.pending.set(false); }
  }
}
