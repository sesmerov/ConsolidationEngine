import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { PreviewDTO, PreviewSelectionDTO, PreviewSummaryDTO, ProposalDTO, ProposalsPageDTO, Rational, SourceLocator } from '@ce/contracts';
import type { ApplicationDetailDTO, ComparisonPageDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
@Injectable()
export class PreviewStore {
  private readonly api = inject(ApiClient); readonly session = inject(SessionStore);
  private generation = 0; private historyGeneration = 0; private selectionGeneration = 0; private observed = ''; private workspaceId: string | undefined; private version: string | null | undefined;
  private applicationGeneration = 0; private observedApplication = ''; private readonly selectedDetails = signal<ReadonlyMap<string, ProposalDTO>>(new Map());
  readonly history = signal<readonly PreviewSummaryDTO[]>([]); readonly historyCursor = signal<string | null>(null); readonly historyLoading = signal(false);
  readonly selectedPreviewId = signal<string | null>(null); readonly preview = signal<PreviewDTO | null>(null); readonly page = signal<ProposalsPageDTO | null>(null);
  readonly selected = signal<readonly string[]>([]); readonly selection = signal<PreviewSelectionDTO | null>(null); readonly selecting = signal(false);
  readonly selectedProposals = computed(() => [...this.selectedDetails().values()].filter(row => this.selected().includes(row.id)));
  readonly application = signal<ApplicationDetailDTO | null>(null); readonly comparison = signal<ComparisonPageDTO | null>(null); readonly applicationLoading = signal(false);
  readonly loading = signal(false); readonly pending = signal(false); readonly error = signal<string | null>(null); readonly confirmDiscard = signal(false);
  readonly status = signal(''); readonly code = signal(''); readonly table = signal('');
  readonly historical = computed(() => !!this.preview() && (this.preview()!.baseVersionId !== this.session.versionId() || this.preview()!.state === 'obsolete'));
  readonly canDiscard = computed(() => this.preview()?.state === 'ready' && !this.historical() && !this.pending() && !this.session.pending() && !this.session.jobActive());
  readonly labels = { ready: 'Preparada', applied: 'Aplicada', discarded: 'Descartada', obsolete: 'Obsoleta', available: 'Disponible', blocked: 'Bloqueada', accepted: 'Aceptada' };
  constructor() {
    effect(() => { const id = this.session.workspace()?.id, version = this.session.versionId(); untracked(() => {
      if (id !== this.workspaceId) { this.workspaceId = id; this.version = version; this.reset(); if (id) void this.loadHistory(); }
      else if (version !== this.version) { this.version = version; this.selected.set([]); this.selectedDetails.set(new Map()); this.selection.set(null); this.selectionGeneration++; if (id) { void this.loadHistory(); if (this.selectedPreviewId()) void this.load(); } }
    }); });
    effect(() => { const job = this.session.job(); if (job?.workspaceId === this.session.workspace()?.id && job?.kind === 'preview' && isTerminalJob(job.status) && job.resultRef?.type === 'preview' && job.jobId !== this.observed) {
      this.observed = job.jobId; untracked(() => { this.choose(job.resultRef!.id); void this.loadHistory(); });
    } });
    effect(() => { const job = this.session.job(); if (job && job.workspaceId === this.session.workspace()?.id && job.kind === 'apply' && job.status === 'succeeded' && job.resultRef?.type === 'application' && job.jobId !== this.observedApplication) {
      this.observedApplication = job.jobId; untracked(() => { void this.loadHistory(); if (this.selectedPreviewId()) void this.load(); });
    } });
    inject(DestroyRef).onDestroy(() => this.reset());
  }
  private reset(): void { this.generation++; this.historyGeneration++; this.selectionGeneration++; this.applicationGeneration++; this.observed = ''; this.observedApplication = ''; this.history.set([]); this.historyCursor.set(null); this.selectedPreviewId.set(null); this.preview.set(null); this.page.set(null); this.selected.set([]); this.selectedDetails.set(new Map()); this.selection.set(null); this.application.set(null); this.comparison.set(null); this.applicationLoading.set(false); this.confirmDiscard.set(false); this.loading.set(false); this.historyLoading.set(false); this.selecting.set(false); this.pending.set(false); this.error.set(null); }
  async loadHistory(append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId) return; const generation = ++this.historyGeneration, cursor = append ? this.historyCursor() : null; this.historyLoading.set(true);
    try { const history = await this.api.previews(workspaceId, cursor ?? undefined); if (generation !== this.historyGeneration || workspaceId !== this.session.workspace()?.id) return;
      const retained = this.history().find(row => row.id === this.selectedPreviewId());
      this.history.set(append ? [...this.history(), ...history.items.filter(row => !this.history().some(existing => existing.id === row.id))] : retained && !history.items.some(row => row.id === retained.id) ? [retained, ...history.items] : history.items); this.historyCursor.set(history.nextCursor);
      if (!this.selectedPreviewId() && history.items[0]) this.choose(history.items[0].id);
    } catch (error) { if (generation === this.historyGeneration) this.report(error); } finally { if (generation === this.historyGeneration) this.historyLoading.set(false); }
  }
  choose(id: string): void { this.selectedPreviewId.set(id); this.status.set(''); this.code.set(''); this.table.set(''); this.selected.set([]); this.selectedDetails.set(new Map()); this.selection.set(null); this.selectionGeneration++; this.applicationGeneration++; this.application.set(null); this.comparison.set(null); this.applicationLoading.set(false); this.confirmDiscard.set(false); this.preview.set(null); this.page.set(null); void this.load(); }
  async load(append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id, id = this.selectedPreviewId(); if (!workspaceId || !id) return;
    const generation = ++this.generation, cursor = append ? this.page()?.nextCursor : undefined; this.loading.set(true); this.error.set(null);
    try { const [preview, page] = await Promise.all([this.api.preview(workspaceId, id), this.api.proposals(workspaceId, id, { ...(this.status() ? { status: this.status() } : {}), ...(this.code() ? { code: this.code() } : {}), ...(this.table() ? { table: this.table() } : {}), ...(cursor ? { cursor } : {}) })]);
      if (generation !== this.generation || workspaceId !== this.session.workspace()?.id) return; this.preview.set(preview); this.page.set(append ? { ...page, items: [...(this.page()?.items ?? []), ...page.items] } : page);
      this.selectedDetails.update(rows => { const next = new Map(rows); for (const row of page.items) if (next.has(row.id)) next.set(row.id, row); return next; });
      this.history.update(rows => rows.some(row => row.id === id) ? rows.map(row => row.id === id ? preview : row) : [preview, ...rows]);
      if (preview.appliedReceiptId && this.application()?.receipt.id !== preview.appliedReceiptId) void this.loadApplication();
    } catch (error) { if (generation === this.generation) this.report(error); } finally { if (generation === this.generation) this.loading.set(false); }
  }
  async execute(): Promise<void> {
    const workspaceId = this.session.workspace()?.id, version = this.session.versionId(), etag = this.session.etag(); if (!workspaceId || !version || !etag || this.pending() || this.session.pending() || this.session.jobActive()) return;
    this.pending.set(true); this.error.set(null);
    try { const job = await this.api.createPreview(workspaceId, version, etag, crypto.randomUUID()); if (workspaceId === this.session.workspace()?.id) this.session.trackJob(job); }
    catch (error) { if (workspaceId === this.session.workspace()?.id) this.report(error); } finally { if (workspaceId === this.session.workspace()?.id) this.pending.set(false); }
  }
  selectable(proposal: ProposalDTO): boolean { return !this.pending() && ((this.preview()?.state === 'ready' && proposal.state === 'available') || (this.preview()?.state === 'obsolete' && proposal.state === 'obsolete')); }
  async toggle(id: string, checked: boolean): Promise<void> {
    const workspaceId = this.session.workspace()?.id, preview = this.preview(), proposal = this.page()?.items.find(row => row.id === id); if (!workspaceId || !preview || !proposal || !this.selectable(proposal)) return;
    const selected = new Set(this.selected()); if (checked) selected.add(id); else selected.delete(id); const selectedIds = [...selected].sort(); this.selected.set(selectedIds); this.selection.set(null); this.selecting.set(true);
    this.selectedDetails.update(rows => { const next = new Map(rows); if (checked) next.set(id, proposal); else next.delete(id); return next; });
    const generation = ++this.selectionGeneration;
    try { const selection = await this.api.previewSelection(workspaceId, preview.id, selectedIds); if (generation === this.selectionGeneration && workspaceId === this.session.workspace()?.id && preview.id === this.preview()?.id) this.selection.set(selection); }
    catch (error) { if (generation === this.selectionGeneration) this.report(error); } finally { if (generation === this.selectionGeneration) this.selecting.set(false); }
  }
  async discard(): Promise<void> {
    const workspaceId = this.session.workspace()?.id, preview = this.preview(), etag = this.session.etag(); if (!workspaceId || !preview || !etag || !this.canDiscard()) return;
    this.pending.set(true); this.error.set(null);
    try { const discarded = await this.api.discardPreview(workspaceId, preview.id, etag); if (workspaceId !== this.session.workspace()?.id || preview.id !== this.preview()?.id) return;
      this.preview.set(discarded); this.selected.set([]); this.selectedDetails.set(new Map()); this.selection.set(null); this.selectionGeneration++; this.confirmDiscard.set(false); await this.load(); await this.loadHistory();
    } catch (error) { if (workspaceId === this.session.workspace()?.id) this.report(error); } finally { if (workspaceId === this.session.workspace()?.id) this.pending.set(false); }
  }
  async loadApplication(append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id, receiptId = this.preview()?.appliedReceiptId; if (!workspaceId || !receiptId) return;
    const generation = ++this.applicationGeneration, cursor = append ? this.comparison()?.nextCursor : undefined; this.applicationLoading.set(true);
    try { const [application, page] = await Promise.all([this.api.application(workspaceId, receiptId), this.api.comparison(workspaceId, receiptId, cursor ?? undefined)]);
      if (generation !== this.applicationGeneration || workspaceId !== this.session.workspace()?.id || receiptId !== this.preview()?.appliedReceiptId) return;
      this.application.set(application); this.comparison.set(append ? { ...page, items: [...(this.comparison()?.items ?? []), ...page.items] } : page);
    } catch (error) { if (generation === this.applicationGeneration) this.report(error); } finally { if (generation === this.applicationGeneration) this.applicationLoading.set(false); }
  }
  proposalName(id: string): string { const row = this.page()?.items.find(row => row.id === id) ?? this.selectedDetails().get(id); return row ? row.code + ' · ' + this.target(row) : 'Propuesta ' + id + ' (fuera de esta página)'; }
  directionName(id: string): string { const row = this.page()?.items.find(row => row.directionId === id); return row ? row.code + ' · ' + this.target(row) : id; }
  target(proposal: ProposalDTO): string { const coordinate = proposal.before?.coordinate; return coordinate ? [coordinate.contextId, coordinate.tableCode, coordinate.sheetCode ? 's' + coordinate.sheetCode : '', 'r' + coordinate.rowCode, 'c' + coordinate.columnCode].filter(Boolean).join(' · ') : proposal.targetKey; }
  fraction(value: Rational): string { return value.denominator === '1' ? value.numerator : value.numerator + '/' + value.denominator; }
  source(locator: SourceLocator): string { return [this.page()?.sourceFiles?.find(file => file.id === locator.fileId)?.displayName, locator.sheet, locator.column ? locator.column + (locator.row ?? '') : locator.row ? 'fila ' + locator.row : ''].filter(Boolean).join(' · '); }
  private report(error: unknown): void { this.error.set(error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo obtener la previsualización.'); }
}
