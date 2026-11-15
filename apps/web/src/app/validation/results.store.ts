import { DestroyRef, computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { CompactPageDTO, CompactResultsPageDTO, CompactRuleResultDTO, Diagnostic, PublicValue, Rational, RunSummaryDTO, SourceLocator, ValidationStatus, ValidationValueDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { validationText } from '../core/exact-value';
import { CursorPage, CursorPageError } from '../core/cursor-page';
import { isLargeValue } from '../core/public-value';
@Injectable({ providedIn: 'root' })
export class ResultsStore {
  private readonly api = inject(ApiClient); readonly session = inject(SessionStore);
  private generation = 0; private historyGeneration = 0; private observed = ''; private workspaceId: string | undefined;
  readonly pending = signal(false); readonly loading = signal(false); readonly error = signal<string | null>(null);
  readonly page = signal<CompactResultsPageDTO | null>(null); readonly history = signal<readonly RunSummaryDTO[]>([]); readonly selectedRunId = signal<string | null>(null);
  readonly completedValidation = computed(() => {
    const job = this.session.job(), page = this.page();
    return job?.status === 'succeeded' && job.progress.complete && job.kind === 'validate' && job.workspaceId === this.session.workspace()?.id
      && page?.run.status === 'completed' && page.run.summary.complete && page.run.id === job.resultRef?.id
      && page.versionId === page.run.versionId && page.versionId === job.baseVersionId ? page.run : null;
  });
  readonly resultPresentation = computed(() => {
    const job = this.session.job(), run = this.completedValidation();
    return job && run ? { jobId: job.jobId, workspaceId: job.workspaceId, versionId: run.versionId } : null;
  });
  readonly historyCursor = signal<string | null>(null); readonly historyLoading = signal(false);
  readonly status = signal(''); readonly code = signal(''); readonly table = signal('');
  readonly pagination = new CursorPage();
  readonly diagnosticPage=signal<CompactPageDTO<PublicValue<Diagnostic>>|null>(null);readonly diagnosticsLoading=signal(false);readonly diagnosticsError=signal<string|null>(null);readonly diagnosticsPagination=new CursorPage();private diagnosticGeneration=0;
  readonly historical = computed(() => Boolean(this.page() && this.page()!.versionId !== this.session.versionId()));
  readonly noEvaluatedRules = computed(() => { const summary = this.page()?.run.summary; return !!summary && summary.byStatus.pass + summary.byStatus.fail === 0; });
  readonly labels: Record<ValidationStatus, string> = { pass: 'Pasa', fail: 'Falla', not_applicable: 'No aplica', not_evaluable: 'No evaluable', error: 'Error' };
  constructor() {
    effect(() => { const id = this.session.workspace()?.id; if (id !== this.workspaceId) { this.workspaceId = id; untracked(() => { this.generation++; this.historyGeneration++; this.observed = ''; this.history.set([]); this.historyCursor.set(null); this.selectedRunId.set(null); this.page.set(null); this.loading.set(false); if (id) void this.loadHistory(); }); } });
    effect(() => { const job = this.session.job(); if (job?.workspaceId === this.session.workspace()?.id && job?.kind === 'validate' && isTerminalJob(job.status) && job.resultRef?.type === 'validation') {
      const observed = job.jobId + ':' + job.status; if (observed !== this.observed) { this.observed = observed; untracked(() => { this.selectedRunId.set(job.resultRef!.id); void this.load(); }); }
    } });
    effect(()=>{this.selectedRunId();this.session.workspace()?.id;this.diagnosticGeneration++;this.diagnosticPage.set(null);this.diagnosticsLoading.set(false);this.diagnosticsError.set(null);this.diagnosticsPagination.reset();});
    inject(DestroyRef).onDestroy(() => { this.generation++; this.historyGeneration++;this.diagnosticGeneration++; });
  }
  async loadHistory(append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId) return; const generation = ++this.historyGeneration, cursor = append ? this.historyCursor() : null; this.historyLoading.set(true);
    try { const history = await this.api.runs(workspaceId, cursor ?? undefined); if (generation !== this.historyGeneration || workspaceId !== this.session.workspace()?.id) return;
      const retained = this.history().find(run => run.id === this.selectedRunId());
      this.history.set(append ? [...this.history(), ...history.items.filter(row => !this.history().some(existing => existing.id === row.id))] : retained && !history.items.some(row => row.id === retained.id) ? [retained, ...history.items] : history.items); this.historyCursor.set(history.nextCursor);
      if (!this.selectedRunId()) { const restored=this.session.recoveryView()?.runId; if(restored) this.selectRun(restored); else if(history.items[0]) this.selectRun(history.items[0].id); }
    } catch (error) { if (generation === this.historyGeneration) this.report(error); } finally { if (generation === this.historyGeneration) this.historyLoading.set(false); }
  }
  async execute(): Promise<void> {
    const workspace = this.session.workspace(), version = this.session.versionId(), etag = this.session.etag(); if (!workspace || !version || !etag || this.pending() || this.session.jobActive()) return;
    this.pending.set(true); this.error.set(null);
    try { const job = await this.api.validate(workspace.id, version, etag, crypto.randomUUID()); if (this.session.workspace()?.id === workspace.id) this.session.trackJob(job); }
    catch (error) { this.report(error); } finally { this.pending.set(false); }
  }
  selectRun(id: string): void { this.selectedRunId.set(id); this.status.set(''); this.code.set(''); this.table.set(''); void this.load(); }
  async load(append: boolean | number = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id, runId = this.selectedRunId(); if (!workspaceId || !runId) return;
    const generation = ++this.generation; this.loading.set(true); this.error.set(null);
    try { const request = this.pagination.begin(JSON.stringify([workspaceId, runId, this.status(), this.code(), this.table()]), typeof append === 'number' ? append : append ? this.pagination.index() + 1 : 0), cursor=request.cursor;
      const page = await this.api.compactResults(workspaceId, runId, { ...(this.status() ? { status: this.status() } : {}), ...(this.code() ? { code: this.code() } : {}), ...(this.table() ? { table: this.table() } : {}), ...(cursor ? { cursor } : {}) });
      if (generation !== this.generation || this.session.workspace()?.id !== workspaceId) return;
      if (page.workspaceId !== workspaceId || page.run.workspaceId !== workspaceId || page.run.id !== runId || page.versionId !== page.run.versionId) throw new CursorPageError('Los resultados recibidos no corresponden a esta ejecución.');
      this.pagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.page.set(page);
      this.session.rememberView({runId:page.run.id});
      this.history.update((runs) => [...runs.filter((run) => run.id !== page.run.id), page.run].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    } catch (error) { if (generation === this.generation) this.report(error); } finally { if (generation === this.generation) this.loading.set(false); }
  }
  async resolveResult(value: PublicValue<CompactRuleResultDTO>, signal: AbortSignal): Promise<CompactRuleResultDTO> {
    const page = this.page(), workspaceId = this.session.workspace()?.id;
    if (!page || !workspaceId) throw new CursorPageError('La ejecución ya no está disponible.');
    const row = isLargeValue(value) ? await this.api.largeValue<CompactRuleResultDTO>(workspaceId, value, signal) : value;
    if (signal.aborted || this.page() !== page || this.session.workspace()?.id !== workspaceId || row.runId !== page.run.id || row.versionId !== page.versionId) throw new CursorPageError('El resultado ha cambiado. Vuelve a abrir el detalle.');
    return row;
  }
  async loadDiagnostics(index=0):Promise<void>{
    const workspaceId=this.session.workspace()?.id,run=this.page()?.run;if(!workspaceId||!run)return;const generation=++this.diagnosticGeneration;this.diagnosticsLoading.set(true);this.diagnosticsError.set(null);
    try{const request=this.diagnosticsPagination.begin(JSON.stringify([workspaceId,run.id]),index),page=await this.api.runDiagnostics(workspaceId,run.id,request.cursor);
      if(generation!==this.diagnosticGeneration||workspaceId!==this.session.workspace()?.id||run.id!==this.page()?.run.id)return;
      if(page.workspaceId!==workspaceId||page.versionId!==run.versionId)throw new CursorPageError('Los avisos no corresponden a esta ejecución.');
      this.diagnosticsPagination.accept(request.index,page.total,page.nextCursor,page.items.length);this.diagnosticPage.set(page);
    }catch(error){if(generation===this.diagnosticGeneration)this.diagnosticsError.set(error instanceof CursorPageError?error.message:'No se pudieron consultar los avisos. Vuelve a intentarlo.');}
    finally{if(generation===this.diagnosticGeneration)this.diagnosticsLoading.set(false);}
  }
  fraction(value: Rational): string { return value.denominator === '1' ? value.numerator : value.numerator + '/' + value.denominator; }
  value(value: ValidationValueDTO | undefined): string {
    return validationText(value);
  }
  source(locator: SourceLocator): string {
    return [locator.sheet, locator.column ? locator.column + (locator.row ?? '') : locator.row ? 'fila ' + locator.row : undefined].filter(Boolean).join(' · ');
  }
  diagnostic(diagnostic: Diagnostic): string {
    const messages: Readonly<Record<string, string>> = { SYNTAX_ERROR: 'La expresión contiene un error de sintaxis.', UNSUPPORTED_CONSTRUCT: 'Esta construcción queda fuera del perfil admitido.', DIVISION_BY_ZERO: 'El divisor es cero o su intervalo contiene cero.',
      MISSING_FILING_INDICATOR: 'Falta un indicador de presentación necesario para decidir.', UNKNOWN_COORDINATE: 'La celda no pertenece al catálogo de coordenadas.', AMBIGUOUS_REFERENCE: 'La referencia corresponde a más de un contexto o celda.',
      TYPE_MISMATCH: 'Los tipos de los operandos no son compatibles.', UNIT_MISMATCH: 'Las unidades de los operandos no son compatibles.', EMPTY_AGGREGATION: 'La suma no contiene valores; su resultado es nulo.',
      RULE_NOT_APPLICABLE: 'La regla está inactiva o fuera de su vigencia/contexto.', CONTEXT_NOT_APPLICABLE: 'No hay un contexto declarado para el módulo y framework de la regla.',
      MISSING_SUBMISSION_DATE: 'La vigencia requiere una fecha de envío que no se ha declarado.', CONFLICTING_VARIANTS: 'Hay variantes incompatibles aplicables al mismo contexto.', RESOURCE_LIMIT: 'La ejecución superó una cuota y quedó incompleta.',
      CANCELLED: 'La ejecución fue cancelada.', DEADLINE_EXCEEDED: 'La ejecución superó el plazo.', EMPTY_SELECTION: 'El ámbito no contiene coordenadas para crear instancias.' };
    return messages[diagnostic.code] ?? diagnostic.message;
  }
  private report(error: unknown): void { this.error.set(error instanceof CursorPageError ? error.message : error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudieron obtener los resultados de esta ejecución.'); }
}
