import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import type { ValidationRunDTO } from '@ce/contracts';
import { ExportStore } from '../recalculation/export.store';
import { versionLabel } from '../core/display';
@Component({ selector: 'ce-results-export', standalone: true, imports: [MatButtonModule, DatePipe], changeDetection: ChangeDetectionStrategy.OnPush,
template: `<section class="export-actions" aria-label="Descarga de resultados"><h3>Guardar esta validación</h3>
<p class="muted">{{ versionLabel(session.workspace(), run().versionId) }} · Ejecución del {{ run().startedAt | date:'dd/MM/yyyy HH:mm:ss' }}. Incluye el resultado de cada regla, sus lecturas y diagnósticos.</p>
@if (run().status === 'incomplete' || !run().summary.complete) { <p class="notice">Ejecución incompleta: el paquete conserva ese estado. No constituye una validación completa.</p> }
<button mat-button (click)="start()" [disabled]="store.pending() || store.uncertain() || session.pending() || session.jobActive() || run().status === 'running'">Descargar resultados de esta ejecución</button>
@if (store.error(); as message) { <p class="error" role="alert">{{ message }}</p> } @if (store.uncertain()) { <button mat-button (click)="store.retry()" [disabled]="store.pending() || session.pending() || session.jobActive()">Reintentar misma exportación</button> }
@if (repeatable()) { <button mat-button (click)="downloadAgain()" [disabled]="store.pending()">Descargar resultados de nuevo</button> }
<details class="trace-details"><summary>Formato de los resultados</summary><p>Paquete ZIP con results.xlsx para lectura y results.json con valores exactos. Los textos y fechas se conservan como datos literales.</p></details></section>` })
export class ResultsExportComponent {
  readonly run = input.required<ValidationRunDTO>(); readonly store = inject(ExportStore); readonly session = this.store.session; readonly versionLabel = versionLabel;
  readonly repeatable = computed(() => { const artifact = this.store.ready(), run = this.run(); return artifact?.workspaceId === this.session.workspace()?.id && artifact?.kind === 'results' && artifact.versionId === run.versionId && artifact.runId === run.id ? artifact : null; });
  async start(): Promise<void> { await this.store.startForRun(this.run().versionId, this.run().id); }
  async downloadAgain(): Promise<void> { const artifact = this.repeatable(); if (artifact) await this.store.download(artifact); }
}
