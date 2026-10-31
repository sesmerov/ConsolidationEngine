import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import type { Coordinate, DirectionChoiceDTO, RuleResultDTO, TargetSide, ValidationResultsPageDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
type ChoiceInfo = { readonly code: string; readonly left?: Coordinate; readonly right?: Coordinate };
const ordered = (choices: Readonly<Record<string, TargetSide>>): DirectionChoiceDTO[] => Object.entries(choices).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([instanceId, targetSide]) => ({ instanceId, targetSide }));
@Component({ selector: 'ce-directions', standalone: true, templateUrl: './directions.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class DirectionsComponent {
  readonly page = input.required<ValidationResultsPageDTO>(); readonly session = inject(SessionStore); private readonly api = inject(ApiClient);
  private key = ''; private alive = true; private initializedConfiguration = false;
  readonly draft = signal<Readonly<Record<string, TargetSide>>>({}); private readonly baseline = signal<readonly DirectionChoiceDTO[]>([]);
  readonly known = signal<Readonly<Record<string, ChoiceInfo>>>({}); readonly pending = signal(false); readonly error = signal<string | null>(null); readonly message = signal<string | null>(null);
  private readonly committedVersion = signal<string | null>(null);
  private readonly stale = signal(false);
  readonly historical = computed(() => this.page().versionId !== this.session.versionId() || this.committedVersion() !== null || this.stale());
  readonly knownConfiguration = computed(() => this.page().configuredDirections !== undefined);
  readonly completeRun = computed(() => this.page().run.status === 'completed' && this.page().run.summary.complete);
  readonly editable = computed(() => !this.historical() && this.knownConfiguration() && this.completeRun() && !this.pending() && !this.session.pending() && !this.session.jobActive());
  readonly choices = computed(() => ordered(this.draft()));
  readonly dirty = computed(() => JSON.stringify(this.choices()) !== JSON.stringify(this.baseline()));
  readonly hiddenCount = computed(() => { const visible = new Set(this.page().items.flatMap(row => row.instanceId ? [row.instanceId] : [])); return this.choices().filter(choice => !visible.has(choice.instanceId)).length; });
  readonly canSave = computed(() => this.editable() && this.dirty());
  constructor() {
    effect(() => {
      const page = this.page(), key = (this.session.workspace()?.id ?? '') + ':' + page.versionId;
      untracked(() => {
        if (key !== this.key || !this.initializedConfiguration && page.configuredDirections !== undefined) {
          this.key = key; const initial = Object.fromEntries((page.configuredDirections ?? []).map(choice => [choice.instanceId, choice.targetSide]));
          this.initializedConfiguration = page.configuredDirections !== undefined;
          this.draft.set(initial); this.baseline.set(ordered(initial)); this.known.set({}); this.error.set(null); this.message.set(null); this.committedVersion.set(null); this.stale.set(false);
        }
        const known = { ...this.known() };
        for (const row of page.items) if (row.instanceId) known[row.instanceId] = { code: row.code,
          ...(row.recalculation?.left.target ? { left: row.recalculation.left.target } : {}), ...(row.recalculation?.right.target ? { right: row.recalculation.right.target } : {}) };
        this.known.set(known);
      });
    });
    inject(DestroyRef).onDestroy(() => { this.alive = false; });
  }
  choose(result: RuleResultDTO, side: string): void {
    if (!this.editable() || !result.instanceId || side !== '' && side !== 'left' && side !== 'right') return;
    if (side && !result.recalculation?.[side].eligible) return;
    const next = { ...this.draft() }; if (side) next[result.instanceId] = side; else delete next[result.instanceId]; this.draft.set(next); this.error.set(null);
  }
  clear(): void { if (this.editable()) { this.draft.set({}); this.error.set(null); } }
  target(cell: Coordinate | undefined): string { return cell ? `${cell.tableCode} · r${cell.rowCode} · c${cell.columnCode}${cell.sheetCode ? ' · s' + cell.sheetCode : ''}` : ''; }
  reason(row: RuleResultDTO, side: TargetSide): string {
    const eligibility = row.recalculation?.[side]; if (!eligibility) return 'No se recibió la comprobación de este lado.';
    const messages: Readonly<Record<string, string>> = { UNKNOWN_COORDINATE: 'La referencia no pertenece al catálogo de coordenadas.', AMBIGUOUS_REFERENCE: 'La referencia corresponde a más de una celda o contexto.',
      EMPTY_SELECTION: 'El ámbito no contiene una celda de destino.', SYNTAX_ERROR: 'La expresión contiene un error de sintaxis.', UNSUPPORTED_CONSTRUCT: 'La expresión queda fuera del perfil admitido.',
      RESOURCE_LIMIT: 'No se completó la comprobación dentro de la cuota de la consulta.', DEADLINE_EXCEEDED: 'No se completó la comprobación dentro del plazo de la consulta.' };
    return eligibility.diagnostics.map(diagnostic => messages[diagnostic.code] ?? diagnostic.message).join(' ') || 'Este lado no es un destino disponible.';
  }
  async save(): Promise<void> {
    const workspace = this.session.workspace(), etag = this.session.etag(); if (!workspace || !etag || !this.canSave()) return;
    const key = this.key, choices = this.choices(); this.pending.set(true); this.session.pending.set(true); this.error.set(null);
    let committed = false;
    try {
      const response = await this.api.replaceDirections(workspace.id, choices, etag);
      if (!response.body?.versionId || !response.headers.get('ETag')) throw new Error('Invalid configuration response'); committed = true;
      if (!this.alive || this.session.workspace()?.id !== workspace.id) return;
      if (this.key === key) { this.baseline.set(choices); this.committedVersion.set(response.body.versionId); this.message.set('Configuración guardada. No se han cambiado valores. Valida la versión vigente si quieres editar sus destinos.'); }
      await this.session.refreshWorkspace(workspace.id);
    } catch (error) {
      if (!this.alive || this.session.workspace()?.id !== workspace.id) return;
      this.error.set(committed ? 'La configuración se guardó, pero no se pudo actualizar el conjunto visible. Recarga la sesión antes de continuar.'
        : error instanceof HttpErrorResponse && typeof error.error?.error?.message === 'string' ? error.error.error.message as string : 'No se pudo guardar la configuración de destinos.');
      if (error instanceof HttpErrorResponse && error.status === 412) {
        this.stale.set(true);
        try { await this.session.refreshWorkspace(workspace.id); } catch { this.error.set('La versión ha cambiado. Recarga la sesión antes de elegir destinos.'); }
      }
    } finally { this.pending.set(false); this.session.pending.set(false); }
  }
}
