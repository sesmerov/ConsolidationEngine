import { ChangeDetectionStrategy, Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { Diagnostic, ResultExplanationItemDTO, ResultOriginDTO, ValidationValueDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { isLargeValue } from '../core/public-value';
import { coordinateText, decimalText, factText, sourceText, validationText } from '../core/exact-value';

/** A large value is read only after an explicit action; its transfer verifies all part and whole hashes. */
@Component({ selector: 'ce-result-value', standalone: true, imports: [MatButtonModule], changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [':host{display:block;white-space:pre-wrap;overflow-wrap:anywhere}.value{margin:0}.interval{margin:8px 0}'],
  template: `@if (pendingValue()) { <button mat-button type="button" [disabled]="loading()" (click)="load()">Ver contenido completo de {{ label() }}</button> }
    @if (loading()) { <span role="status">Consultando contenido…</span> }
    @if (error()) { <p class="error" role="alert">{{error()}}</p> }
    @if (!pendingValue()) { <p class="value">{{display()}}</p> }
    @if (interval(); as value) { <details class="interval"><summary>Intervalo del valor</summary><p class="exact-value">{{value}}</p></details> }` })
export class ResultValueComponent {
  readonly value = input<unknown>(); readonly mode = input<'text'|'validation'|'evidence'|'diagnostic'>('text'); readonly label = input('este valor');
  private readonly api = inject(ApiClient); private readonly session = inject(SessionStore); private generation = 0; private controller?: AbortController;
  readonly resolved = signal<unknown>(undefined); readonly loading = signal(false); readonly error = signal<string|null>(null);
  private readonly current = computed(() => this.resolved() ?? this.value());
  readonly pendingValue = computed(() => { const value = this.current(); return isLargeValue(value) || this.mode() === 'evidence' && !!value && typeof value === 'object' && 'value' in value && isLargeValue(value.value); });
  readonly display = computed(() => { const value = this.current(); if (this.pendingValue() || value === undefined) return '';
    return this.mode() === 'validation' ? validationText(value as ValidationValueDTO) : this.mode() === 'evidence' ? evidenceText(value as ResultExplanationItemDTO) : this.mode() === 'diagnostic' ? (value as Diagnostic).message : typeof value === 'string' ? value : ''; });
  readonly interval = computed(() => { const value = this.current(); return this.mode() === 'validation' && !!value && typeof value === 'object' && 'kind' in value && value.kind === 'number'
    ? `[${decimalText((value as Extract<ValidationValueDTO,{kind:'number'}>).interval.lo)} → ${decimalText((value as Extract<ValidationValueDTO,{kind:'number'}>).interval.hi)}]` : undefined; });
  constructor() {
    effect(() => { this.value(); this.mode(); this.session.workspace()?.id; this.generation++; this.controller?.abort(); this.resolved.set(undefined); this.loading.set(false); this.error.set(null); });
    inject(DestroyRef).onDestroy(() => { this.generation++; this.controller?.abort(); });
  }
  async load(): Promise<void> {
    const workspaceId = this.session.workspace()?.id; if (!workspaceId || this.loading()) return;
    const generation = ++this.generation; this.controller?.abort(); const controller = this.controller = new AbortController(); this.loading.set(true); this.error.set(null);
    const current = () => generation === this.generation && workspaceId === this.session.workspace()?.id && !controller.signal.aborted;
    try {
      let value = this.value(); if (isLargeValue(value)) value = await this.api.largeValue<unknown>(workspaceId, value, controller.signal);
      if (!current()) return;
      if (this.mode() === 'evidence' && !!value && typeof value === 'object' && 'value' in value && isLargeValue(value.value)) value = { ...value, value: await this.api.largeValue<unknown>(workspaceId, value.value, controller.signal) };
      if (current()) this.resolved.set(value);
    } catch { if (current()) this.error.set('No se pudo verificar el contenido completo. Vuelve a intentarlo.'); }
    finally { if (current()) this.loading.set(false); }
  }
}
function originText(origin: ResultOriginDTO): string { return [origin.fileName, sourceText(origin.locator)].filter(Boolean).join(' · '); }
function evidenceText(item: ResultExplanationItemDTO): string {
  if (isLargeValue(item.value)) return '';
  switch (item.section) {
    case 'operands': return `${item.label}: ${validationText(item.value)}`;
    case 'reads': return `${coordinateText(item.value.coordinate)}\nValor leído: ${factText(item.value)} ${item.value.coordinate.unit}\n${item.value.derivation ? 'Recalculado en una aplicación anterior. Este valor recalculado no estaba escrito en el informe original.' : 'Valor del informe'} · ${sourceText(item.value.sourceLocator)}`;
    case 'metadata': return `${item.value.code} · ${item.value.presence === 'missing' ? 'No declarado' : item.value.value ? 'Presentada' : 'No presentada'}`;
    case 'origins': return originText(item.value);
    case 'diagnostics': return item.value.message;
    case 'descriptions': return [item.value.description,item.value.expression,item.value.precondition?`Precondición: ${item.value.precondition}`:undefined,originText(item.value.source)].filter(value=>value!==undefined).join('\n');
  }
}
