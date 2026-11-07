import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { CompactPreviewDTO, CompactApplicationDetailDTO, CompactComparisonPageDTO, PreviewSummaryDTO,
  ProposalSelectionSummaryDTO, ProposalSelectionPageDTO, ProposalSelectionRowDTO, ProposalSelectionFilterDTO,
  ProposalSelectionEditDTO, ProposalSelectionOperationDTO, ProposalDependencyPageDTO, ProposalExplanationDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { CursorPage, CursorPageError } from '../core/cursor-page';
import { ApplyStore } from './apply.store';
interface SelectionAttempt { workspaceId: string; previewId: string; baseVersionId: string; etag: string; key: string; body: ProposalSelectionEditDTO | null }
@Injectable({ providedIn: 'root' })
export class PreviewStore {
  private readonly api = inject(ApiClient); readonly session = inject(SessionStore); private readonly applying = inject(ApplyStore);
  private generation = 0; private historyGeneration = 0; private detailGeneration = 0; private dependencyGeneration = 0; private applicationGeneration = 0;
  private workspaceId: string | undefined; private version: string | null | undefined; private context: string | null | undefined;
  private ownPreviewJob = ''; private observedPreviewJob = ''; private observedSelectionJob = ''; private observedApplication = '';
  private selectionAttempt: SelectionAttempt | undefined; private selectionJobId: string | undefined; private recoveringJob = '';
  readonly history = signal<readonly PreviewSummaryDTO[]>([]); readonly historyCursor = signal<string | null>(null); readonly historyLoading = signal(false);
  readonly selectedPreviewId = signal<string | null>(null); readonly preview = signal<CompactPreviewDTO | null>(null);
  readonly page = signal<ProposalSelectionPageDTO | null>(null); readonly selection = signal<ProposalSelectionSummaryDTO | null>(null);
  readonly selecting = signal(false); readonly selectionUncertain = signal(false); readonly selectionMissing = signal(false);
  readonly application = signal<CompactApplicationDetailDTO | null>(null); readonly comparison = signal<CompactComparisonPageDTO | null>(null); readonly applicationLoading = signal(false);
  readonly loading = signal(false); readonly pending = signal(false); readonly error = signal<string | null>(null); readonly confirmDiscard = signal(false);
  readonly status = signal(''); readonly code = signal(''); readonly table = signal(''); readonly scope = signal<'all' | 'missing'>('all');
  readonly pagination = new CursorPage(); readonly comparisonPagination = new CursorPage(); readonly changedOnly = signal(true);
  readonly detail = signal<ProposalExplanationDTO | null>(null); readonly detailLoading = signal(false);
  readonly dependencies = signal<ProposalDependencyPageDTO | null>(null); readonly dependenciesLoading = signal(false);
  readonly dependencyProposalId = signal<string | null>(null); readonly dependencyPagination = new CursorPage();
  readonly hiddenSelectedCount = computed(() => this.page()?.filterCounts.selectedOutsidePage ?? 0);
  readonly selectedOutsideFilter = computed(() => this.page()?.filterCounts.selectedOutsideFilter ?? 0);
  readonly historical = computed(() => !!this.preview() && (this.preview()!.baseVersionId !== this.session.versionId() || this.preview()!.state === 'obsolete'));
  readonly editable = computed(() => this.preview()?.state === 'ready' && !this.historical() && this.selection()?.state === 'ready'
    && !this.loading() && !this.selecting() && !this.selectionUncertain() && !this.pending() && !this.applying.pending() && !this.applying.uncertain() && !this.session.pending() && !this.session.jobActive());
  readonly allMatchingSelected = computed(() => !!this.page()?.filterCounts.available && this.page()!.filterCounts.selected === this.page()!.filterCounts.available);
  readonly partiallySelected = computed(() => !!this.page()?.filterCounts.selected && !this.allMatchingSelected());
  readonly canSimulate = computed(() => !!this.session.workspace()?.id && !!this.session.versionId() && !!this.session.etag()
    && !this.pending() && !this.selectionUncertain() && !this.selecting() && !this.applying.pending() && !this.applying.uncertain() && !this.session.pending() && !this.session.jobActive());
  readonly canDiscard = computed(() => this.preview()?.state === 'ready' && !this.historical() && !this.pending() && !this.selecting()
    && !this.selectionUncertain() && !this.applying.pending() && !this.applying.uncertain() && !this.session.pending() && !this.session.jobActive());
  readonly labels = { ready: 'Preparada', applied: 'Aplicada', discarded: 'Descartada', obsolete: 'Obsoleta', available: 'Disponible', blocked: 'Bloqueada', accepted: 'Aceptada' };
  readonly resultPresentation = computed(() => {
    const job = this.session.job(), preview = this.preview(); if (!job || job.status !== 'succeeded' || job.workspaceId !== this.session.workspace()?.id) return null;
    const visible = job.kind === 'preview' ? job.resultRef?.id === preview?.id && this.page()?.previewId === preview?.id
      : job.kind === 'apply' && this.comparison()?.receipt.id === job.resultRef?.id && this.comparison()?.receipt.newVersionId === job.newVersionId;
    return visible ? { jobId: job.jobId, workspaceId: job.workspaceId, versionId: job.newVersionId ?? job.baseVersionId ?? null } : null;
  });
  constructor() {
    effect(() => { const id = this.session.workspace()?.id, version = this.session.versionId(), context = this.session.selectedContextId(); untracked(() => {
      if (id !== this.workspaceId) { this.workspaceId = id; this.version = version; this.context = context; this.reset(); if (id) void this.loadHistory(); }
      else if (version !== this.version) { this.version = version; this.applying.invalidateSelection(); this.closeDetail(); this.closeDependencies(); this.pagination.reset(); if (id) { void this.loadHistory(); if (this.selectedPreviewId()) void this.load(); } }
      else if (context !== this.context) { this.context = context; this.pagination.reset(); if (this.selectedPreviewId()) void this.load(); }
    }); });
    effect(() => { const job = this.session.job(); if (!job || job.workspaceId !== this.session.workspace()?.id) return; untracked(() => {
      if (job.kind === 'preview' && job.status === 'succeeded' && job.resultRef?.type === 'preview' && job.baseVersionId === this.session.versionId() && job.jobId === this.ownPreviewJob && job.jobId !== this.observedPreviewJob) {
        this.observedPreviewJob = job.jobId; this.choose(job.resultRef.id); void this.loadHistory();
      }
      if (job.kind === 'select-proposals' && isTerminalJob(job.status) && job.jobId === this.selectionJobId && job.jobId !== this.observedSelectionJob) {
        this.observedSelectionJob = job.jobId; this.selecting.set(false); void this.load().then(() => { if (job.status !== 'succeeded') this.error.set(job.diagnostics[0]?.message ?? 'La selección no se modificó. Vuelve a intentarlo.'); });
      }
      if (job.kind === 'apply' && job.status === 'succeeded' && job.resultRef?.type === 'application' && job.jobId !== this.observedApplication) { this.observedApplication = job.jobId; void this.loadHistory(); if (this.selectedPreviewId()) void this.load(); }
    }); });
    effect(() => { this.applying.preview.set(this.preview()); this.applying.selection.set(this.selection()); this.applying.selectionBusy.set(this.selecting() || this.selectionUncertain()); });
    inject(DestroyRef).onDestroy(() => this.reset());
  }
  private reset(): void {
    this.generation++; this.historyGeneration++; this.applicationGeneration++; this.closeDetail(); this.closeDependencies(); this.pagination.reset(); this.comparisonPagination.reset(); this.changedOnly.set(true);
    this.ownPreviewJob = ''; this.observedPreviewJob = ''; this.observedSelectionJob = ''; this.observedApplication = ''; this.selectionJobId = undefined; this.selectionAttempt = undefined; this.recoveringJob = '';
    this.history.set([]); this.historyCursor.set(null); this.selectedPreviewId.set(null); this.preview.set(null); this.page.set(null); this.selection.set(null); this.applying.invalidateSelection();
    this.selectionMissing.set(false); this.selectionUncertain.set(false); this.selecting.set(false); this.application.set(null); this.comparison.set(null); this.applicationLoading.set(false);
    this.confirmDiscard.set(false); this.loading.set(false); this.historyLoading.set(false); this.pending.set(false); this.error.set(null); this.scope.set('all');
  }
  async loadHistory(append = false): Promise<void> {
    const w = this.session.workspace()?.id; if (!w) return; const generation = ++this.historyGeneration, cursor = append ? this.historyCursor() : null; this.historyLoading.set(true);
    try { const history = await this.api.previews(w, cursor ?? undefined); if (generation !== this.historyGeneration || w !== this.session.workspace()?.id) return;
      const retained = this.history().find(row => row.id === this.selectedPreviewId());
      this.history.set(append ? [...this.history(), ...history.items.filter(row => !this.history().some(existing => existing.id === row.id))] : retained && !history.items.some(row => row.id === retained.id) ? [retained, ...history.items] : history.items);
      this.historyCursor.set(history.nextCursor); if (!this.selectedPreviewId() && history.items[0]) this.choose(history.items[0].id);
    } catch (error) { if (generation === this.historyGeneration) this.report(error); } finally { if (generation === this.historyGeneration) this.historyLoading.set(false); }
  }
  choose(id: string): void {
    if (this.selectionUncertain() || this.selecting() || this.applying.uncertain()) return;
    this.closeDetail(); this.closeDependencies(); this.pagination.reset(); this.comparisonPagination.reset(); this.changedOnly.set(true); this.selectedPreviewId.set(id);
    this.status.set(''); this.code.set(''); this.table.set(''); this.scope.set('all'); this.applying.invalidateSelection(); this.selection.set(null); this.selectionMissing.set(false); this.applicationGeneration++;
    this.application.set(null); this.comparison.set(null); this.applicationLoading.set(false); this.confirmDiscard.set(false); this.preview.set(null); this.page.set(null); void this.load();
  }
  private filters(): ProposalSelectionFilterDTO { const contextId = this.session.selectedContextId(); return {
    ...(this.status() ? { status: this.status() as NonNullable<ProposalSelectionFilterDTO['status']> } : {}), ...(this.code() ? { code: this.code() } : {}),
    ...(this.table() ? { table: this.table() } : {}), ...(contextId ? { contextId } : {}) }; }
  async load(append: boolean | number = false): Promise<void> {
    const w = this.session.workspace()?.id, id = this.selectedPreviewId(); if (!w || !id) return;
    const scope = this.scope(), filter = scope === 'missing' ? {} : this.filters(); const request = this.pagination.begin(JSON.stringify([w, id, filter, scope, this.session.versionId()]), typeof append === 'number' ? append : append ? this.pagination.index() + 1 : 0);
    const generation = ++this.generation; this.loading.set(true); if (!this.selectionUncertain()) this.error.set(null);
    try {
      const [preview, summaryResult, pageResult] = await Promise.all([this.api.previewCompact(w, id),
        this.api.proposalSelectionState(w, id).then(value => ({ value }), error => ({ error })),
        this.api.selectionRows(w, id, { ...filter, scope, ...(request.cursor ? { cursor: request.cursor } : {}) }).then(value => ({ value }), error => ({ error }))]);
      if (generation !== this.generation || w !== this.session.workspace()?.id || id !== this.selectedPreviewId()) return;
      this.preview.set(preview); this.history.update(rows => rows.some(row => row.id === id) ? rows.map(row => row.id === id ? preview : row) : [preview, ...rows]);
      if ('error' in summaryResult) {
        if (summaryResult.error instanceof HttpErrorResponse && summaryResult.error.status === 404) { this.selectionMissing.set(true); this.selection.set(null); this.page.set(null); this.selecting.set(false); } else throw summaryResult.error;
      } else {
        const summary = summaryResult.value;
        if (summary.previewId !== id || summary.workspaceId !== w || summary.baseVersionId !== preview.baseVersionId) throw new CursorPageError('La selección recibida no pertenece a esta simulación.');
        this.selectionMissing.set(false);
        if ('value' in pageResult && summary.revision > 0) {
          const page = pageResult.value;
          if (page.previewId !== id || page.selectionId !== summary.id || page.revision < summary.revision || page.revision < (this.selection()?.revision ?? 0)) throw new CursorPageError('La selección ha cambiado. Actualiza las propuestas.');
          if (this.selection()?.revision !== page.revision && request.index > 0) { this.pagination.reset(); throw new CursorPageError('La selección ha cambiado. Vuelve a la primera página.'); }
          this.pagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.page.set(page); this.selection.set(page.summary);
        } else { this.selection.set(summary); this.page.set(null); if (summary.revision > 0 && 'error' in pageResult) throw pageResult.error; }
        const current = this.selection()!; this.selecting.set(current.state === 'preparing' || current.state === 'updating');
        if (current.pendingJobId) void this.recoverJob(w, id, current.pendingJobId);
      }
      if (preview.appliedReceiptId && this.application()?.receipt.id !== preview.appliedReceiptId) void this.loadApplication();
    } catch (error) { if (generation === this.generation) { this.applying.invalidateSelection(); this.report(error); } } finally { if (generation === this.generation) this.loading.set(false); }
  }
  private async recoverJob(w: string, previewId: string, jobId: string): Promise<void> {
    this.selectionJobId = jobId; if (this.session.job()?.jobId === jobId || this.recoveringJob === jobId || this.session.jobActive()) return; this.recoveringJob = jobId;
    try { const job = await this.api.job(w, jobId); if (w === this.session.workspace()?.id && previewId === this.preview()?.id && this.selection()?.pendingJobId === jobId) this.session.trackJob(job); }
    catch (error) { if (w === this.session.workspace()?.id && previewId === this.preview()?.id) this.report(error); } finally { if (this.recoveringJob === jobId) this.recoveringJob = ''; }
  }
  async execute(): Promise<void> {
    const w = this.session.workspace()?.id, version = this.session.versionId(), etag = this.session.etag(); if (!w || !version || !etag || !this.canSimulate()) return;
    this.pending.set(true); this.error.set(null); try { const job = await this.api.createPreview(w, version, etag, crypto.randomUUID()); if (w === this.session.workspace()?.id) { this.ownPreviewJob = job.jobId; this.session.trackJob(job); } }
    catch (error) { if (w === this.session.workspace()?.id) this.report(error); } finally { if (w === this.session.workspace()?.id) this.pending.set(false); }
  }
  selectable(row: ProposalSelectionRowDTO): boolean { return this.editable() && row.state === 'available'; }
  async toggle(id: string, checked: boolean): Promise<void> { this.applying.invalidateSelection(); const row = this.page()?.items.find(row => row.id === id) ?? this.dependencies()?.items.find(row => row.id === id);
    if (!row || !this.selectable(row) || row.selected === checked) return; await this.editSelection([{ op: 'set', proposalId: id, selected: checked }]); }
  async selectMatching(): Promise<void> { this.applying.invalidateSelection(); if (this.editable() && this.page()?.filterCounts.available) await this.editSelection([{ op: 'selectMatching', filter: this.filters() }]); }
  async clearAll(): Promise<void> { this.applying.invalidateSelection(); if (this.editable() && this.selection()?.selectedCount) await this.editSelection([{ op: 'clear' }]); }
  private async editSelection(operations: readonly ProposalSelectionOperationDTO[]): Promise<void> {
    const w = this.session.workspace()?.id, preview = this.preview(), selection = this.selection(), etag = this.session.etag(); if (!w || !preview || !selection || !etag || !this.editable()) return;
    this.selectionAttempt = { workspaceId: w, previewId: preview.id, baseVersionId: preview.baseVersionId, etag, key: crypto.randomUUID(), body: { selectionId: selection.id, expectedRevision: selection.revision, operations } }; await this.sendSelection();
  }
  async prepareEmptySelection(): Promise<void> {
    const w = this.session.workspace()?.id, preview = this.preview(), etag = this.session.etag(); if (!w || !preview || !etag || !this.selectionMissing() || preview.state !== 'ready' || this.historical() || !this.canSimulate()) return;
    this.applying.invalidateSelection(); this.selectionAttempt = { workspaceId: w, previewId: preview.id, baseVersionId: preview.baseVersionId, etag, key: crypto.randomUUID(), body: null }; await this.sendSelection();
  }
  async retrySelection(): Promise<void> { if (this.selectionUncertain() && !this.selecting() && !this.session.pending() && !this.session.jobActive()) await this.sendSelection(); }
  private async sendSelection(): Promise<void> {
    const attempt = this.selectionAttempt; if (!attempt || attempt.workspaceId !== this.session.workspace()?.id) return; this.applying.invalidateSelection(); this.selecting.set(true); this.error.set(null);
    try {
      const job = attempt.body ? await this.api.editProposalSelection(attempt.workspaceId, attempt.previewId, attempt.body, attempt.etag, attempt.key) : await this.api.prepareProposalSelection(attempt.workspaceId, attempt.previewId, attempt.baseVersionId, attempt.etag, attempt.key);
      if (this.selectionAttempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return;
      this.selectionUncertain.set(false); this.selectionAttempt = undefined; this.selectionJobId = job.jobId; this.closeDetail(); this.closeDependencies(); this.pagination.reset();
      const selection = this.selection(); if (selection) this.selection.set({ ...selection, state: 'updating', pendingJobId: job.jobId });
      if (isTerminalJob(job.status)) this.observedSelectionJob = job.jobId;
      this.session.trackJob(job);
      if (isTerminalJob(job.status)) { this.selecting.set(false); await this.load(); }
    } catch (error) {
      if (this.selectionAttempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return;
      const uncertain = error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500); this.selectionUncertain.set(uncertain); this.selecting.set(false);
      if (uncertain) this.error.set('No se ha podido confirmar la selección. Reintenta la misma operación antes de tomar otra decisión.');
      else { this.selectionAttempt = undefined; this.report(error); const message = this.error(); await this.load(); this.error.set(message); }
    }
  }
  showMissing(): void { this.scope.set(this.scope() === 'missing' ? 'all' : 'missing'); this.pagination.reset(); void this.load(); }
  async openDependencies(proposalId: string, index = 0): Promise<void> {
    const w = this.session.workspace()?.id, preview = this.preview(), selection = this.selection(); if (!w || !preview || !selection?.revision) return;
    const request = this.dependencyPagination.begin(JSON.stringify([w, preview.id, selection.revision, proposalId]), index), generation = ++this.dependencyGeneration; this.dependencyProposalId.set(proposalId); this.dependenciesLoading.set(true);
    try { const page = await this.api.selectionDependencies(w, preview.id, proposalId, { ...(request.cursor ? { cursor: request.cursor } : {}) });
      if (generation !== this.dependencyGeneration || w !== this.session.workspace()?.id || preview.id !== this.preview()?.id) return;
      if (page.selectionId !== selection.id || page.revision !== this.selection()?.revision) throw new CursorPageError('La selección ha cambiado. Vuelve a consultar los antecedentes.');
      this.dependencyPagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.dependencies.set(page);
    } catch (error) { if (generation === this.dependencyGeneration) this.report(error); } finally { if (generation === this.dependencyGeneration) this.dependenciesLoading.set(false); }
  }
  closeDependencies(): void { this.dependencyGeneration++; this.dependencies.set(null); this.dependencyProposalId.set(null); this.dependenciesLoading.set(false); this.dependencyPagination.reset(); }
  async openDetail(id: string): Promise<void> {
    const w = this.session.workspace()?.id, previewId = this.preview()?.id; if (!w || !previewId) return; const generation = ++this.detailGeneration; this.detailLoading.set(true); this.detail.set(null);
    try { const detail = await this.api.proposalExplanation(w, previewId, id); if (generation !== this.detailGeneration || w !== this.session.workspace()?.id || previewId !== this.preview()?.id) return;
      if (detail.revision !== this.selection()?.revision) throw new CursorPageError('La selección ha cambiado. Vuelve a abrir el detalle.'); this.detail.set(detail);
    } catch (error) { if (generation === this.detailGeneration) this.report(error); } finally { if (generation === this.detailGeneration) this.detailLoading.set(false); }
  }
  closeDetail(): void { this.detailGeneration++; this.detail.set(null); this.detailLoading.set(false); }
  async discard(): Promise<void> {
    const w = this.session.workspace()?.id, preview = this.preview(), etag = this.session.etag(); if (!w || !preview || !etag || !this.canDiscard()) return; this.pending.set(true); this.error.set(null);
    try { const discarded = await this.api.discardPreviewCompact(w, preview.id, etag); if (w !== this.session.workspace()?.id || preview.id !== this.preview()?.id) return;
      this.preview.set(discarded); this.applying.invalidateSelection(); this.confirmDiscard.set(false); await this.load(); await this.loadHistory();
    } catch (error) { if (w === this.session.workspace()?.id) this.report(error); } finally { if (w === this.session.workspace()?.id) this.pending.set(false); }
  }
  async loadApplication(append: boolean | number = false): Promise<void> {
    const w = this.session.workspace()?.id, receiptId = this.preview()?.appliedReceiptId; if (!w || !receiptId) return;
    const request = this.comparisonPagination.begin(JSON.stringify([w, receiptId, this.changedOnly()]), typeof append === 'number' ? append : append ? this.comparisonPagination.index() + 1 : 0), generation = ++this.applicationGeneration; this.applicationLoading.set(true);
    try { const [application, page] = await Promise.all([this.api.applicationCompact(w, receiptId), this.api.comparisonCompact(w, receiptId, { ...(request.cursor ? { cursor: request.cursor } : {}), changedOnly: this.changedOnly() })]);
      if (generation !== this.applicationGeneration || w !== this.session.workspace()?.id || receiptId !== this.preview()?.appliedReceiptId) return;
      this.application.set(application); this.applying.confirmReceipt(application.receipt); this.comparisonPagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.comparison.set(page);
    } catch (error) { if (generation === this.applicationGeneration) this.report(error); } finally { if (generation === this.applicationGeneration) this.applicationLoading.set(false); }
  }
  showAllComparisons(): void { this.changedOnly.update(value => !value); void this.loadApplication(); }
  target(row: ProposalSelectionRowDTO): string { const c = row.target; return [c.tableCode, c.sheetCode ? 's' + c.sheetCode : '', 'r' + c.rowCode, 'c' + c.columnCode].filter(Boolean).join(' · '); }
  private report(error: unknown): void { this.error.set(error instanceof CursorPageError ? error.message : error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo obtener la previsualización.'); }
}
