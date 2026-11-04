import { DestroyRef, computed, effect, inject, Injectable, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { isTerminalJob } from '@ce/contracts';
import type { Diagnostic, Rational, RunSummaryDTO, SourceLocator, ValidationResultsPageDTO, ValidationStatus, ValidationValueDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { validationText } from '../core/exact-value';
import { CursorPage, CursorPageError } from '../core/cursor-page';
@Injectable({ providedIn: 'root' })
export class ResultsStore {
  private readonly api = inject(ApiClient); readonly session = inject(SessionStore);
  private generation = 0; private historyGeneration = 0; private observed = ''; private workspaceId: string | undefined;
  readonly pending = signal(false); readonly loading = signal(false); readonly error = signal<string | null>(null);
  readonly page = signal<ValidationResultsPageDTO | null>(null); readonly history = signal<readonly RunSummaryDTO[]>([]); readonly selectedRunId = signal<string | null>(null);
  readonly historyCursor = signal<string | null>(null); readonly historyLoading = signal(false);
  readonly status = signal(''); readonly code = signal(''); readonly table = signal('');
  readonly pagination = new CursorPage();
  readonly historical = computed(() => Boolean(this.page() && this.page()!.versionId !== this.session.versionId()));
  readonly noEvaluatedRules = computed(() => { const summary = this.page()?.run.summary; return !!summary && summary.byStatus.pass + summary.byStatus.fail === 0; });
  readonly labels: Record<ValidationStatus, string> = { pass: 'Pasa', fail: 'Falla', not_applicable: 'No aplica', not_evaluable: 'No evaluable', error: 'Error' };
  constructor() {
    effect(() => { const id = this.session.workspace()?.id; if (id !== this.workspaceId) { this.workspaceId = id; untracked(() => { this.generation++; this.historyGeneration++; this.observed = ''; this.history.set([]); this.historyCursor.set(null); this.selectedRunId.set(null); this.page.set(null); this.loading.set(false); if (id) void this.loadHistory(); }); } });
    effect(() => { const job = this.session.job(); if (job?.workspaceId === this.session.workspace()?.id && job?.kind === 'validate' && isTerminalJob(job.status) && job.resultRef?.type === 'validation') {
      const observed = job.jobId + ':' + job.status; if (observed !== this.observed) { this.observed = observed; untracked(() => { this.selectedRunId.set(job.resultRef!.id); void this.load(); }); }
    } });
    inject(DestroyRef).onDestroy(() => { this.generation++; this.historyGeneration++; });
  }
  async loadHistory(append = false): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId) return; const generation = ++this.historyGeneration, cursor = append ? this.historyCursor() : null; this.historyLoading.set(true);
    try { const history = await this.api.runs(workspaceId, cursor ?? undefined); if (generation !== this.historyGeneration || workspaceId !== this.session.workspace()?.id) return;
      const retained = this.history().find(run => run.id === this.selectedRunId());
      this.history.set(append ? [...this.history(), ...history.items.filter(row => !this.history().some(existing => existing.id === row.id))] : retained && !history.items.some(row => row.id === retained.id) ? [retained, ...history.items] : history.items); this.historyCursor.set(history.nextCursor);
      if (!this.selectedRunId() && history.items[0]) this.selectRun(history.items[0].id);
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
    const request = this.pagination.begin(JSON.stringify([workspaceId, runId, this.status(), this.code(), this.table()]), typeof append === 'number' ? append : append ? this.pagination.index() + 1 : 0);
    const generation = ++this.generation, cursor = request.cursor; this.loading.set(true); this.error.set(null);
    try { const page = await this.api.results(workspaceId, runId, { ...(this.status() ? { status: this.status() } : {}), ...(this.code() ? { code: this.code() } : {}), ...(this.table() ? { table: this.table() } : {}), ...(cursor ? { cursor } : {}) });
      if (generation !== this.generation || this.session.workspace()?.id !== workspaceId) return;
      this.pagination.accept(request.index, page.total, page.nextCursor, page.items.length); this.page.set(page);
      this.history.update((runs) => [...runs.filter((run) => run.id !== page.run.id), page.run].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    } catch (error) { if (generation === this.generation) this.report(error); } finally { if (generation === this.generation) this.loading.set(false); }
  }
  fraction(value: Rational): string { return value.denominator === '1' ? value.numerator : value.numerator + '/' + value.denominator; }
  value(value: ValidationValueDTO | undefined): string {
    return validationText(value);
  }
  source(locator: SourceLocator): string {
    const file = this.page()?.sourceFiles?.find((file) => file.id === locator.fileId)?.displayName;
    return [file, locator.sheet, locator.column ? locator.column + (locator.row ?? '') : locator.row ? 'fila ' + locator.row : undefined].filter(Boolean).join(' · ');
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
