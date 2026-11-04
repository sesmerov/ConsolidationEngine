import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { ValidationRunDTO } from '@ce/contracts';
import { ExportStore } from '../recalculation/export.store';
@Component({ selector: 'ce-results-export', standalone: true, imports: [MatButtonModule], changeDetection: ChangeDetectionStrategy.OnPush,
template: `<div class="export-actions"><button mat-button (click)="start()" [disabled]="store.pending() || store.uncertain() || session.pending() || session.jobActive() || run().status === 'running'">Exportar resultados (ZIP)</button>@if (store.error(); as message) { <p class="error" role="alert">{{ message }}</p> }@if (store.uncertain()) { <button mat-button (click)="store.retry()" [disabled]="store.pending()">Reintentar misma exportación</button> }@if (store.ready()) { <button mat-button (click)="store.download()" [disabled]="store.pending()">Descargar ZIP de nuevo</button> }</div>` })
export class ResultsExportComponent { readonly run = input.required<ValidationRunDTO>(); readonly store = inject(ExportStore); readonly session = this.store.session; async start(): Promise<void> { await this.store.startForRun(this.run().versionId, this.run().id); } }
