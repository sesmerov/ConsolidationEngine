import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type {
  DirectionReviewCommitDTO, DirectionReviewDecision, DirectionReviewOperationDTO, DirectionReviewPageDTO,
  DirectionReviewPatchDTO, DirectionReviewPrepareDTO, DirectionReviewReceiptDTO, DirectionReviewRowDTO,
  DirectionReviewSummaryDTO, JobDTO, TargetSide, ValidationRunDTO,
  DirectionConflictGroupDTO, DirectionConflictGroupsPageDTO, DirectionConflictCandidatesPageDTO, DirectionConflictCandidateDetailDTO,
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
interface GroupEditor { group: DirectionConflictGroupDTO; revision: number; value: string | null | undefined; original: string | null | undefined; code?: string }
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
  private groupsGeneration = 0; private candidatesGeneration = 0; private detailGeneration = 0;
  private confirmingGroupId: string | null = null;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private attempt: Attempt | null = null;
  private observedJob: { jobId: string; reviewId?: string } | null = null;
  private commitOrigin: string | null = null;
  private readonly synchronized = signal(false);

  readonly run = signal<ValidationRunDTO | null>(null);
  readonly review = signal<DirectionReviewSummaryDTO | null>(null);
  readonly otherReview = signal<DirectionReviewSummaryDTO | null>(null);
  readonly rows = signal<DirectionReviewPageDTO | null>(null);
  readonly groups = signal<DirectionConflictGroupsPageDTO | null>(null);
  readonly groupsPagination = new CursorPage(); readonly candidatesPagination = new CursorPage();
  readonly groupsLoading = signal(false); readonly candidatesLoading = signal(false);
  readonly editor = signal<GroupEditor | null>(null);
  readonly candidates = signal<DirectionConflictCandidatesPageDTO | null>(null);
  readonly candidateDetail = signal<DirectionConflictCandidateDetailDTO | null>(null);
  readonly candidateDetailLoading = signal(false);
  readonly anchoredGroup = signal<DirectionConflictGroupDTO | null>(null);
  readonly displayGroups = computed(() => {
    const items = this.groups()?.items ?? [], anchor = this.anchoredGroup();
    return anchor && !items.some(group => group.groupId === anchor.groupId) ? [...items, anchor] : items;
  });
  readonly hasUnsavedChoice = computed(() => !!this.editor() && this.editor()!.value !== this.editor()!.original);
  readonly selectedOutsidePage = computed(() => !!this.editor()?.value && !this.candidates()?.items.some(row => row.instanceId === this.editor()?.value));
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
  readonly busy = computed(() => this.pending() || this.looking() || this.loading() || this.groupsLoading() || this.candidatesLoading() || this.session.pending() || this.session.jobActive());
  readonly needsPartial = computed(() => {
    const counts = this.review()?.counts;
    return !!counts && counts.pending + counts.undetermined > 0;
  });
  readonly canPrepare = computed(() => this.synchronized() && !!this.run() && this.complete() && !this.historical() && !this.busy() && !this.uncertain()
    && !this.otherReview() && (!this.review() || this.expired() || ['expired','obsolete','discarded','failed'].includes(this.review()!.state)));
  readonly editable = computed(() => this.synchronized() && this.complete() && !this.historical() && !this.expired() && !this.uncertain() && !this.busy()
    && !this.otherReview() && this.review()?.state === 'ready' && !!this.review()?.counts && this.rows()?.revision === this.review()?.revision);
  readonly canSave = computed(() => this.editable() && !this.hasUnsavedChoice() && this.groups()?.revision === this.review()?.revision
    && this.review()?.conflictGroupCount === 0 && (!this.needsPartial() || this.partialAccepted()));
  readonly configurable = computed(() => (this.rows()?.items ?? []).filter(row => ['included','pending','omitted'].includes(row.state)));
  readonly unavailable = computed(() => (this.rows()?.items ?? []).filter(row => row.state === 'excluded' || row.state === 'undetermined'));
  readonly resultPresentation = computed(() => {
    const job = this.session.job(), review = this.review(), receipt = this.receipt();
    if (!job || job.status !== 'succeeded' || job.workspaceId !== this.session.workspace()?.id || job.resultRef?.type !== 'direction-review') return null;
    const prepared = job.kind === 'prepare-directions' && review?.id === job.resultRef.id && review.state === 'ready'
      && !this.expired() && !this.historical() && !!review.counts && this.rows()?.reviewId === review.id && this.rows()?.revision === review.revision
      && this.groups()?.reviewId === review.id && this.groups()?.revision === review.revision;
    const committed = job.kind === 'commit-directions' && receipt?.reviewId === job.resultRef.id
      && receipt.baseVersionId === job.baseVersionId && receipt.newVersionId === job.newVersionId;
    return prepared || committed ? { jobId: job.jobId, workspaceId: job.workspaceId, versionId: job.newVersionId ?? job.baseVersionId ?? null } : null;
  });

  constructor() {
    effect(() => {
      const version = this.session.versionId(), editor = this.editor(), review = this.review();
      if (editor && review && version !== review.baseVersionId) untracked(() => this.invalidateEditor('La versión cambió. La elección pendiente se ha cancelado; actualiza la revisión.'));
    });
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
      this.lookupGeneration++; this.rowGeneration++; this.groupsGeneration++; this.candidatesGeneration++; this.detailGeneration++;
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
    this.resetGroups();
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
      this.groupsPagination.reset(); this.candidatesPagination.reset();
      if (this.editor() && this.editor()!.revision !== summary.revision) {
        if (this.confirmingGroupId === this.editor()!.group.groupId) { this.editor.set(null); this.candidates.set(null); }
        else this.invalidateEditor('La revisión cambió. Comprueba la elección publicada antes de continuar.');
      }
    }
    clearTimeout(this.expiryTimer);
    this.expired.set(summary.state === 'expired');
    if (summary.state === 'ready') {
      const remaining = Date.parse(summary.expiresAt ?? '') - Date.now();
      if (!(remaining > 0)) { this.expired.set(true); this.rows.set(null); this.invalidateEditor('La revisión ha caducado. Prepara una nueva para continuar.'); return; }
      this.expiryTimer = setTimeout(() => { this.expired.set(true); this.partialAccepted.set(false); this.invalidateEditor('La revisión ha caducado. Prepara una nueva para continuar.'); }, Math.min(remaining,2_147_483_647));
      await Promise.all([this.loadRows(0), this.loadGroups(0, previous?.id !== summary.id)]);
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
      if (generation !== this.rowGeneration || !this.matches(review) || this.review()?.id !== review.id || this.review()?.revision !== review.revision) return;
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
    if (!this.allowLeaveEditor()) return;
    this.stateFilter.set(state); this.groupFilter.set(groupId); this.rows.set(null);
    await this.loadRows();
  }

  allowLeaveEditor(): boolean {
    if (!this.hasUnsavedChoice()) return true;
    this.error.set('Confirma o cancela la elección pendiente antes de continuar.'); return false;
  }
  private invalidateEditor(message: string): void {
    if (this.hasUnsavedChoice()) this.error.set(message);
    this.editor.set(null); this.candidates.set(null); this.candidateDetail.set(null);
    this.candidatesGeneration++; this.detailGeneration++;
    this.candidatesLoading.set(false); this.candidateDetailLoading.set(false);
  }
  private resetGroups(): void {
    this.groupsGeneration++; this.candidatesGeneration++; this.detailGeneration++;
    this.groups.set(null); this.editor.set(null); this.candidates.set(null); this.candidateDetail.set(null); this.anchoredGroup.set(null);
    this.groupsPagination.reset(); this.candidatesPagination.reset(); this.groupsLoading.set(false); this.candidatesLoading.set(false);
  }
  async loadGroups(index = 0, openFirst = false): Promise<void> {
    const review = this.review();
    if (!review || review.state !== 'ready' || this.expired() || !this.matches(review)) return;
    if (index !== this.groupsPagination.index() && !this.allowLeaveEditor()) return;
    const generation = ++this.groupsGeneration; this.groupsLoading.set(true);
    try {
      const request = this.groupsPagination.begin(JSON.stringify([review.id, review.revision]), index);
      const page = await this.api.directionConflictGroups(review.workspaceId, review.id, request.cursor ? { cursor: request.cursor } : {});
      if (generation !== this.groupsGeneration || !this.matches(review) || this.review()?.revision !== review.revision) return;
      if (page.reviewId !== review.id || page.revision !== review.revision) throw new Error('La revisión cambió. Actualiza los destinos antes de continuar.');
      this.groupsPagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.groups.set(page);
      if (openFirst && !this.editor()) { const group = page.items.find(item => item.state === 'conflicted' || item.state === 'pending'); if (group) await this.openGroup(group, true); }
    } catch (error) { if (generation === this.groupsGeneration && this.matches(review)) this.error.set(errorMessage(error)); }
    finally { if (generation === this.groupsGeneration) this.groupsLoading.set(false); }
  }
  async openGroup(group: DirectionConflictGroupDTO, initial = false): Promise<void> {
    const review = this.review();
    if (!review || !this.allowLeaveEditor() || (!initial && !this.editable())) return;
    const original = group.state === 'omitted' ? null : group.selectedCandidate?.instanceId;
    this.editor.set({ group, revision: review.revision, value: original, original, ...(group.selectedCandidate ? { code: group.selectedCandidate.code } : {}) });
    this.candidates.set(null); this.candidateDetail.set(null); this.candidatesPagination.reset(); this.error.set('');
    await this.loadCandidates();
  }
  async loadCandidates(index = 0): Promise<void> {
    const editor = this.editor(), review = this.review();
    if (!editor || !review || editor.revision !== review.revision || !this.matches(review)) return;
    const generation = ++this.candidatesGeneration; this.candidatesLoading.set(true);
    try {
      const request = this.candidatesPagination.begin(JSON.stringify([review.id, review.revision, editor.group.groupId]), index);
      const page = await this.api.directionConflictCandidates(review.workspaceId, review.id, editor.group.groupId, request.cursor ? { cursor: request.cursor } : {});
      if (generation !== this.candidatesGeneration || this.editor()?.group.groupId !== editor.group.groupId || this.review()?.revision !== review.revision || !this.matches(review)) return;
      if (page.reviewId !== review.id || page.revision !== review.revision || page.group.groupId !== editor.group.groupId) throw new Error('La revisión cambió. Actualiza los destinos antes de continuar.');
      this.candidatesPagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.candidates.set(page);
    } catch (error) { if (generation === this.candidatesGeneration) this.error.set(errorMessage(error)); }
    finally { if (generation === this.candidatesGeneration) this.candidatesLoading.set(false); }
  }
  selectCandidate(value: string | null): void {
    const editor = this.editor(); if (!editor || !this.editable()) return;
    const candidate = value === null ? undefined : this.candidates()?.items.find(row => row.instanceId === value);
    if (value !== null && (!candidate || candidate.availability !== 'selectable')) return;
    this.editor.set({ ...editor, value, code: candidate?.code ?? '' });
    this.error.set('');
  }
  cancelChoice(): void {
    if (this.pending() || this.uncertain()) return;
    this.editor.set(null); this.candidates.set(null); this.candidateDetail.set(null); this.candidatesGeneration++; this.detailGeneration++; this.error.set('');
  }
  async confirmChoice(): Promise<boolean> {
    const editor = this.editor(), review = this.review();
    if (!editor || !review || editor.value === undefined || !this.hasUnsavedChoice() || !this.editable() || editor.revision !== review.revision) return false;
    this.confirmingGroupId = editor.group.groupId; this.anchoredGroup.set(editor.group);
    await this.resolveGroup(editor.group.groupId, editor.value);
    this.confirmingGroupId = null;
    if (this.uncertain() || this.review()?.revision === review.revision) return false;
    const latest = this.displayGroups().find(group => group.groupId === editor.group.groupId);
    if (latest && this.groups()?.items.includes(latest)) this.anchoredGroup.set(latest);
    else if (this.review()?.state === 'ready') {
      const fresh = this.review()!;
      try { const page = await this.api.directionConflictCandidates(fresh.workspaceId, fresh.id, editor.group.groupId);
        if (this.review()?.revision === page.revision && this.matches(fresh)) this.anchoredGroup.set(page.group);
      } catch (error) { this.error.set(errorMessage(error)); }
    }
    return true;
  }
  async showCandidate(instanceId: string): Promise<void> {
    const review = this.review(), editor = this.editor(); if (!review || !editor) return;
    const generation = ++this.detailGeneration; this.candidateDetailLoading.set(true); this.candidateDetail.set(null);
    try { const detail = await this.api.directionConflictCandidate(review.workspaceId, review.id, editor.group.groupId, instanceId);
      if (generation === this.detailGeneration && this.matches(review) && this.review()?.revision === detail.revision && this.editor()?.group.groupId === editor.group.groupId) this.candidateDetail.set(detail);
    } catch (error) { if (generation === this.detailGeneration) this.error.set(errorMessage(error)); }
    finally { if (generation === this.detailGeneration) this.candidateDetailLoading.set(false); }
  }

  async prepare(): Promise<void> {
    const run = this.run(), workspaceId = this.session.workspace()?.id, etag = this.session.etag();
    if (!run || !workspaceId || !etag || !this.canPrepare()) return;
    await this.send({kind:'prepare',workspaceId,etag,key:crypto.randomUUID(),body:{baseVersionId:run.versionId,runId:run.id}});
  }
  async choose(row: DirectionReviewRowDTO, choice: TargetSide | 'omit' | 'suggest'): Promise<void> {
    if (!this.allowLeaveEditor()) return;
    if (!row.instanceId || row.state === 'excluded' || row.state === 'undetermined' || row.state === 'conflicted') return;
    if ((choice === 'left' || choice === 'right') && !row.options.some(option => option.side === choice)) return;
    await this.edit({op:'set',instanceId:row.instanceId,choice});
  }
  async resolveGroup(groupId: string, winnerInstanceId: string | null): Promise<void> {
    if (!this.displayGroups().some(group => group.groupId === groupId)) return;
    await this.edit({op:'resolveGroup',groupId,winnerInstanceId});
  }
  async omitAll(): Promise<void> { if (this.allowLeaveEditor()) await this.edit({op:'omitAll'}); }
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
    if (!this.allowLeaveEditor()) return;
    const review = this.otherReview() ?? this.review(), etag = this.session.etag();
    if (!review || review.state !== 'ready' || !etag || this.busy() || this.uncertain()) return;
    this.pending.set(true);
    try {
      await this.api.discardDirectionReview(review.workspaceId,review.id,etag);
      if (this.owns(review.workspaceId)) { this.resetGroups(); this.review.set(null); this.rows.set(null); this.otherReview.set(null); await this.recover(); }
    } catch(error) { if (this.owns(review.workspaceId)) this.error.set(errorMessage(error)); }
    finally { if (this.owns(review.workspaceId)) this.pending.set(false); }
  }
}
