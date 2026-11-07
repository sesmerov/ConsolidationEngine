import { DestroyRef, computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isCivilDate, isTerminalJob } from '@ce/contracts';
import type { CapabilitiesDTO, ImportContextInputDTO, ImportInspectionCommitDTO, ImportInspectionDTO, RulesPageDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
export interface ContextForm { entityId: string; referenceDate: string; submissionDate: string; currency: string; scaleExponent: string; displayDecimals: string; presented: string }
const emptyContext = (): ContextForm => ({ entityId: '', referenceDate: '', submissionDate: '', currency: '', scaleExponent: '', displayDecimals: '', presented: '' });
interface CommitAttempt { workspaceId: string; id: string; body: ImportInspectionCommitDTO; etag: string; key: string }
@Injectable({ providedIn: 'root' })
export class ImportStore {
  readonly catalog = signal<File | null>(null); readonly reports = signal<readonly File[]>([]);
  private readonly api = inject(ApiClient); private readonly session = inject(SessionStore);
  private readonly view = inject(WorkspaceViewStore);
  private controller: AbortController | undefined; private pageGeneration = 0;
  readonly uploading = signal(false); readonly error = signal<string | null>(null);
  readonly page = signal<RulesPageDTO | null>(null); readonly capabilities = signal<CapabilitiesDTO | null>(null);
  readonly published = signal<Pick<RulesPageDTO, 'versionId' | 'coverage' | 'dataSummary'> | null>(null);
  readonly resultPresentation = computed(() => {
    const job = this.session.job();
    if (!job || job.status !== 'succeeded' || job.workspaceId !== this.session.workspace()?.id) return null;
    const visible = job.kind === 'inspect-import' ? job.resultRef?.id === this.inspection()?.id && this.inspection()?.state === 'ready'
      : job.kind === 'import' && !!job.newVersionId && this.published()?.versionId === job.newVersionId;
    return visible ? { jobId: job.jobId, workspaceId: job.workspaceId, versionId: job.newVersionId ?? job.baseVersionId ?? null } : null;
  });
  readonly code = signal(''); readonly status = signal(''); readonly table = signal('');
  readonly queryState = signal<'idle' | 'waiting' | 'loading'>('idle');
  readonly queryError = signal<string | null>(null);
  private queryTimer?: ReturnType<typeof setTimeout>;
  private rulesWorkspaceId: string | undefined;
  private rulesVersionId: string | null = null;
  readonly selectedDemo = signal<'corep' | 'types'>('corep'); readonly demoDownloading = signal(false); readonly demoError = signal<string | null>(null);
  private downloadGeneration = 0; private demoWorkspaceId: string | undefined;
  readonly contextSource = signal<'workbook' | 'form'>('workbook'); readonly contextForm = signal<ContextForm>(emptyContext());
  readonly inspection = signal<ImportInspectionDTO | null>(null); readonly inspectionPending = signal(false); readonly acceptedExcludedSheets = signal(false);
  readonly reviewDirty = signal(false); readonly locallyExpired = signal(false); readonly uncertainCommit = signal(false);
  readonly contextError = computed(() => this.contextSource() === 'workbook' ? null : this.validateContext());
  readonly liveInspection = computed(() => this.inspection()?.state === 'ready' || this.inspection()?.state === 'committing');
  readonly staleInspection = computed(() => !!this.inspection() && this.inspection()!.baseVersionId !== (this.session.versionId() ?? undefined));
  readonly canInspect = computed(() => !!this.catalog() && this.reports().length > 0 && !this.contextError() && !this.liveInspection() && !this.uploading() && !this.inspectionPending() && !this.uncertainCommit() && !this.session.jobActive() && !this.session.pending());
  readonly canCommit = computed(() => this.inspection()?.state === 'ready' && !this.reviewDirty() && !this.locallyExpired() && !this.staleInspection() && !this.inspectionPending() && !this.uploading() && !this.session.jobActive() && !this.session.pending() && !this.uncertainCommit() && (!this.inspection()!.requiresPartialCoverageAcceptance || this.acceptedExcludedSheets()));
  private workspaceId: string | undefined; private inspectionGeneration = 0; private observedJob = ''; private alive = true; private commitAttempt: CommitAttempt | undefined;
  private commitJobId: string | undefined; private expiryTimer: ReturnType<typeof setTimeout> | undefined; private inputRevision = 0; private preparingRevision: number | undefined;
  private lastInput: { catalog: File | null; reports: readonly File[]; context: string } | undefined;
  constructor() {
    effect(() => { const id = this.session.workspace()?.id; if (id !== this.demoWorkspaceId) { this.demoWorkspaceId = id; untracked(() => { this.downloadGeneration++; this.selectedDemo.set('corep'); this.demoDownloading.set(false); this.demoError.set(null); }); } });
    effect(() => {
      const id = this.session.workspace()?.id, version = this.session.versionId();
      if (id === this.rulesWorkspaceId && version === this.rulesVersionId) return;
      untracked(() => {
        if (id !== this.rulesWorkspaceId) { this.code.set(''); this.status.set(''); this.table.set(''); }
        this.rulesWorkspaceId = id;
        this.rulesVersionId = version;
        this.published.set(null);
        this.refreshRules();
      });
    });
    effect(() => { const id = this.session.workspace()?.id; if (id !== this.workspaceId) { const previous = this.workspaceId; this.workspaceId = id; untracked(() => { this.inspectionGeneration++; this.inspection.set(null); this.acceptedExcludedSheets.set(false); this.reviewDirty.set(false); this.locallyExpired.set(false); this.commitAttempt = undefined; this.commitJobId = undefined; this.uncertainCommit.set(false); this.observedJob = ''; this.preparingRevision = undefined; if (this.expiryTimer) clearTimeout(this.expiryTimer); if (previous) { this.controller?.abort(); this.catalog.set(null); this.reports.set([]); this.contextSource.set('workbook'); this.contextForm.set(emptyContext()); this.inspectionPending.set(false); this.uploading.set(false); this.inputRevision++; this.lastInput = this.captureInput(); } if (id) void this.recoverInspection(); }); } });
    effect(() => { const input = this.captureInput(); untracked(() => { const previous = this.lastInput; this.lastInput = input; if (previous && (previous.catalog !== input.catalog || previous.reports !== input.reports || previous.context !== input.context)) { this.inputRevision++; this.acceptedExcludedSheets.set(false); if (this.liveInspection()) this.reviewDirty.set(true); } }); });
    effect(() => {
      const job = this.session.job();
      if (!job || job.workspaceId !== this.session.workspace()?.id || !isTerminalJob(job.status)) return;
      const isCommit = job.kind === 'import' && job.jobId === this.commitJobId;
      if (job.kind !== 'inspect-import' && !isCommit) return;
      const key = job.jobId + ':' + job.status;
      if (this.observedJob === key) return;
      this.observedJob = key;
      untracked(() => {
        if (isCommit && job.status === 'succeeded' && job.newVersionId) {
          this.view.published(job.workspaceId, job.baseVersionId ?? null, job.newVersionId, job.jobId, 'validation');
        }
        const inspection = this.inspection();
        if (job.kind === 'inspect-import' && job.status === 'succeeded' && job.resultRef?.type === 'import-inspection') {
          void this.loadInspection(job.resultRef.id);
        } else if (isCommit && inspection) {
          void this.loadInspection(inspection.id);
        } else if (job.status !== 'succeeded' && job.diagnostics.length === 0) {
          // The workspace focuses job diagnostics with their file and cell. Only add a fallback when none exists.
          this.error.set('La inspección no se completó. El conjunto vigente se conserva.');
        }
      });
    });
    effect(() => { const stale = this.staleInspection(); if (stale) untracked(() => this.acceptedExcludedSheets.set(false)); });
    inject(DestroyRef).onDestroy(() => { this.alive = false; this.controller?.abort(); this.pageGeneration++; this.inspectionGeneration++; if (this.expiryTimer) clearTimeout(this.expiryTimer); this.catalog.set(null); this.reports.set([]); this.contextForm.set(emptyContext()); this.inspection.set(null); this.commitAttempt = undefined; });
    void this.api.capabilities().then((value) => this.capabilities.set(value)).catch((error: unknown) => this.report(error));
    inject(DestroyRef).onDestroy(() => clearTimeout(this.queryTimer));
  }
  setContextSource(source: 'workbook' | 'form'): void { this.contextSource.set(source); }
  selectDemo(kind: string): void { if (kind === 'corep' || kind === 'types') this.selectedDemo.set(kind); }
  async downloadVisualDemo(artifact: 'catalog' | 'report'): Promise<void> {
    const workspaceId = this.session.workspace()?.id, kind = this.selectedDemo(); if (!workspaceId || this.demoDownloading()) return;
    const generation = ++this.downloadGeneration; this.demoDownloading.set(true); this.demoError.set(null);
    try {
      const blob = await this.api.visualDemo(kind, artifact); if (!this.alive || generation !== this.downloadGeneration || workspaceId !== this.session.workspace()?.id) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = `demo-${kind}-${artifact}.xlsx`;
      try { anchor.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 0); }
    } catch { if (this.alive && generation === this.downloadGeneration && workspaceId === this.session.workspace()?.id) this.demoError.set('No se pudo descargar el archivo de la demostración. Puedes volver a intentarlo.'); }
    finally { if (this.alive && generation === this.downloadGeneration) this.demoDownloading.set(false); }
  }
  updateContext(field: keyof ContextForm, value: string): void { this.contextForm.update(form => ({ ...form, [field]: value })); }
  private captureInput() { return { catalog: this.catalog(), reports: this.reports(), context: JSON.stringify([this.contextSource(), this.contextForm()]) }; }
  private validateContext(): string | null {
    const form = this.contextForm(); if (!form.entityId.trim() || form.entityId.length > 200) return 'Indica una entidad de hasta 200 caracteres.';
    if (!isCivilDate(form.referenceDate)) return 'Indica una fecha de referencia válida.'; if (form.submissionDate && !isCivilDate(form.submissionDate)) return 'Revisa la fecha de envío.';
    if (!/^[A-Z]{3}$/.test(form.currency)) return 'Indica una divisa de tres letras mayúsculas, como EUR.';
    if (!['0', '3', '6'].includes(form.scaleExponent)) return 'Elige si los importes están en unidades, miles o millones.';
    if (form.displayDecimals !== 'INF') { if (!/^-?\d{1,2}$/.test(form.displayDecimals)) return 'Indica la precisión escrita: de −18 a 18, o INF si es exacta.'; const precision = parseInt(form.displayDecimals, 10), base = precision - parseInt(form.scaleExponent, 10); if (precision < -18 || precision > 18 || base < -18 || base > 18) return 'La precisión escrita y la precisión en unidades base deben estar entre −18 y 18.'; }
    if (!['true', 'false'].includes(form.presented)) return 'Indica expresamente si se presenta la tabla C_01.00.'; return null;
  }
  contextInput(): ImportContextInputDTO {
    if (this.contextSource() === 'workbook') return { source: 'workbook' }; const form = this.contextForm();
    return { source: 'form', declaration: { entityId: form.entityId.trim(), referenceDate: form.referenceDate, ...(form.submissionDate ? { submissionDate: form.submissionDate } : {}), currency: form.currency, scaleExponent: parseInt(form.scaleExponent, 10) as 0 | 3 | 6, displayDecimals: form.displayDecimals === 'INF' ? 'INF' : parseInt(form.displayDecimals, 10), filingIndicators: { 'C_01.00': form.presented === 'true' } } };
  }
  async inspect(): Promise<void> {
    const workspace = this.session.workspace(), etag = this.session.etag(), catalog = this.catalog(); if (!workspace || !etag || !catalog || !this.canInspect()) return;
    const controller = new AbortController(); this.controller = controller; this.preparingRevision = this.inputRevision; this.uploading.set(true); this.error.set(null); this.acceptedExcludedSheets.set(false); this.reviewDirty.set(false); this.inspection.set(null); this.locallyExpired.set(false); if (this.expiryTimer) clearTimeout(this.expiryTimer);
    try { const job = await this.api.inspectImport(workspace.id, etag, catalog, this.reports(), this.contextInput(), crypto.randomUUID(), controller.signal); if (!this.alive || workspace.id !== this.session.workspace()?.id) return; this.session.trackJob(job); }
    catch (error) { if (this.alive && workspace.id === this.session.workspace()?.id) {
      if (controller.signal.aborted) this.error.set('Carga cancelada. El conjunto vigente se conserva.'); else this.report(error);
      if (error instanceof HttpErrorResponse && (error.status === 0 || error.status === 409 || error.status >= 500)) {
        await this.recoverInspection(false); if (this.alive && workspace.id === this.session.workspace()?.id && !this.inspection()) { try { await this.session.refreshWorkspace(workspace.id); } catch { this.error.set('No se pudo recuperar el estado de la inspección. Conserva los archivos y actualiza la sesión antes de repetirla.'); } }
      }
    } }
    finally { if (this.controller === controller) this.controller = undefined; if (this.alive) this.uploading.set(false); }
  }
  async recoverInspection(hydrate = true): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId) return; const generation = ++this.inspectionGeneration, revision = this.inputRevision; this.inspectionPending.set(true);
    try { const response = await this.api.activeImportInspection(workspaceId); if (!this.alive || generation !== this.inspectionGeneration || workspaceId !== this.session.workspace()?.id) return; if (response.active) { this.acceptInspection(response.active, revision, hydrate); if (!hydrate && response.active.state === 'ready') this.reviewDirty.set(true); await this.recoverCommit(response.active); } else this.inspection.set(null); }
    catch (error) { if (this.alive && generation === this.inspectionGeneration) this.report(error); } finally { if (this.alive && generation === this.inspectionGeneration) this.inspectionPending.set(false); }
  }
  async loadInspection(id = this.inspection()?.id, hydrate = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId || !id) return; const generation = ++this.inspectionGeneration, revision = this.preparingRevision ?? this.inputRevision; this.inspectionPending.set(true);
    try { const value = await this.api.importInspection(workspaceId, id); if (!this.alive || generation !== this.inspectionGeneration || workspaceId !== this.session.workspace()?.id) return; this.acceptInspection(value, revision, hydrate || this.preparingRevision !== undefined && this.inspection()?.id !== value.id); }
    catch (error) { if (this.alive && generation === this.inspectionGeneration) this.report(error); } finally { if (this.alive && generation === this.inspectionGeneration) this.inspectionPending.set(false); }
  }
  private acceptInspection(value: ImportInspectionDTO, revision: number, hydrate: boolean): void {
    const changed = this.inspection()?.id !== value.id; this.inspection.set(value); if (changed) this.acceptedExcludedSheets.set(false);
    this.reviewDirty.set(this.reviewDirty() || revision !== this.inputRevision); this.locallyExpired.set(value.state === 'ready' && Date.parse(value.expiresAt) <= Date.now());
    if (hydrate && revision === this.inputRevision && value.context[0]) { const context = value.context[0], form = context.declaration;
      this.contextSource.set(context.origin); this.contextForm.set({ entityId: form.entityId, referenceDate: form.referenceDate, submissionDate: form.submissionDate ?? '', currency: form.currency ?? '', scaleExponent: form.scaleExponent === undefined ? '' : String(form.scaleExponent), displayDecimals: form.displayDecimals === undefined ? '' : String(form.displayDecimals), presented: form.filingIndicators['C_01.00'] === undefined ? '' : String(form.filingIndicators['C_01.00']) }); this.lastInput = this.captureInput();
    }
    if (this.expiryTimer) clearTimeout(this.expiryTimer); if (value.state === 'ready' && !this.locallyExpired()) this.expiryTimer = setTimeout(() => { this.locallyExpired.set(true); this.acceptedExcludedSheets.set(false); void this.loadInspection(value.id); }, Math.max(1, Date.parse(value.expiresAt) - Date.now()));
    if (value.commitJobId) this.commitJobId = value.commitJobId;
  }
  private async recoverCommit(value: ImportInspectionDTO): Promise<void> {
    if (!value.commitJobId || value.state !== 'committing') return; const job = await this.api.job(value.workspaceId, value.commitJobId);
    if (!this.alive || value.workspaceId !== this.session.workspace()?.id || this.inspection()?.id !== value.id) return; this.session.trackJob(job); if (isTerminalJob(job.status)) await this.session.refreshWorkspace(value.workspaceId);
  }
  async commit(): Promise<void> {
    const value = this.inspection(), workspaceId = this.session.workspace()?.id, etag = this.session.etag(); if (!value || !workspaceId || !etag || !this.canCommit()) return;
    this.commitAttempt = { workspaceId, id: value.id, body: { inspectionHash: value.inspectionHash, acceptedExcludedSheets: value.requiresPartialCoverageAcceptance && this.acceptedExcludedSheets() }, etag, key: crypto.randomUUID() }; await this.sendCommit();
  }
  async retryCommit(): Promise<void> { if (this.uncertainCommit() && !this.inspectionPending() && !this.session.pending() && !this.session.jobActive()) await this.sendCommit(); }
  private async sendCommit(): Promise<void> {
    const attempt = this.commitAttempt; if (!attempt || attempt.workspaceId !== this.session.workspace()?.id) return; this.inspectionPending.set(true); this.error.set(null);
    try { const job = await this.api.commitImportInspection(attempt.workspaceId, attempt.id, attempt.body, attempt.etag, attempt.key); if (!this.alive || this.commitAttempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return;
      this.commitAttempt = undefined; this.uncertainCommit.set(false); this.commitJobId = job.jobId; if (this.expiryTimer) clearTimeout(this.expiryTimer); this.locallyExpired.set(false); this.inspection.update(value => value ? { ...value, state: 'committing', commitJobId: job.jobId } : null); this.acceptedExcludedSheets.set(false); this.session.trackJob(job); if (isTerminalJob(job.status)) await this.session.refreshWorkspace(attempt.workspaceId);
    } catch (error) { if (!this.alive || this.commitAttempt !== attempt || attempt.workspaceId !== this.session.workspace()?.id) return; this.uncertainCommit.set(error instanceof HttpErrorResponse && (error.status === 0 || error.status >= 500)); this.report(error);
      if (error instanceof HttpErrorResponse && (error.status === 410 || error.status === 412)) { this.acceptedExcludedSheets.set(false); this.inspection.update(value => value ? { ...value, state: error.status === 410 ? 'expired' : 'invalidated' } : null); if (error.status === 412) { try { await this.session.refreshWorkspace(attempt.workspaceId); } catch { this.error.set('La base cambió. Recupera el conjunto antes de repetir la inspección.'); } } }
    } finally { if (this.alive && attempt.workspaceId === this.session.workspace()?.id) this.inspectionPending.set(false); }
  }
  async discardInspection(): Promise<void> {
    const value = this.inspection(), workspaceId = this.session.workspace()?.id, etag = this.session.etag(); if (!value || !workspaceId || !etag || this.inspectionPending() || this.session.pending() || this.session.jobActive() || this.uncertainCommit()) return;
    this.inspectionPending.set(true); this.error.set(null); const generation = ++this.inspectionGeneration;
    try { const discarded = await this.api.discardImportInspection(workspaceId, value.id, etag); if (!this.alive || generation !== this.inspectionGeneration || workspaceId !== this.session.workspace()?.id) return; this.acceptInspection(discarded, this.inputRevision, false); this.reviewDirty.set(false); this.acceptedExcludedSheets.set(false); this.preparingRevision = undefined; }
    catch (error) { if (this.alive && generation === this.inspectionGeneration) this.report(error); } finally { if (this.alive && generation === this.inspectionGeneration) this.inspectionPending.set(false); }
  }
  async downloadCorepTemplate(): Promise<void> { try { const blob = await this.api.corepTemplate(); const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = 'COREP-CA1.xlsx'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0); } catch (error) { this.report(error); } }
  cancelUpload(): void { this.controller?.abort(); }
  setRuleFilter(field: 'code' | 'status' | 'table', value: string): void {
    if (this[field]() === value) return;
    this[field].set(value);
    this.refreshRules(field === 'code');
  }
  refreshRules(debounce = false): void {
    clearTimeout(this.queryTimer);
    const generation = ++this.pageGeneration;
    this.page.set(null);
    this.queryError.set(null);
    this.queryState.set('idle');
    if (!this.rulesWorkspaceId || !this.rulesVersionId) return;
    if (debounce) {
      this.queryState.set('waiting');
      this.queryTimer = setTimeout(() => void this.fetchRules(generation), 250);
    } else {
      void this.fetchRules(generation);
    }
  }
  loadMoreRules(): void {
    const previous = this.page();
    if (this.queryState() !== 'idle' || !previous?.nextCursor) return;
    void this.fetchRules(this.pageGeneration, previous);
  }
  private async fetchRules(generation: number, previous?: RulesPageDTO): Promise<void> {
    const workspaceId = this.rulesWorkspaceId, versionId = this.rulesVersionId;
    const current = () => this.alive && generation === this.pageGeneration
      && workspaceId === this.session.workspace()?.id && versionId === this.session.versionId();
    if (!workspaceId || !versionId || !current()) return;
    this.queryState.set('loading');
    this.queryError.set(null);
    try {
      const result = await this.api.rules(workspaceId, versionId, {
        ...(this.code() && { code: this.code() }),
        ...(this.status() && { status: this.status() }),
        ...(this.table() && { table: this.table() }),
        ...(previous?.nextCursor && { cursor: previous.nextCursor }),
      });
      if (!current() || result.versionId !== versionId) return;
      this.published.set({ versionId, coverage: result.coverage, dataSummary: result.dataSummary });
      this.page.set(previous ? { ...result, items: [...previous.items, ...result.items] } : result);
    } catch (error) {
      if (current()) this.queryError.set(error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string'
        ? error.error.error.message : 'No se pudo consultar el catálogo de reglas.');
    } finally {
      if (current()) this.queryState.set('idle');
    }
  }
  fileName(id: string | undefined): string { return this.page()?.sources.find((source) => source.id === id)?.displayName ?? 'Archivo de origen'; }
  private report(error: unknown): void {
    this.error.set(error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo completar la petición. Se conserva la versión cargada.');
  }
}
