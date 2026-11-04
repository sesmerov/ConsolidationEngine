import { StageTitleDirective } from '../core/stage-title.directive';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatTableModule } from '@angular/material/table';
import { MatPaginatorModule } from '@angular/material/paginator';
import type { RuleResultDTO } from '@ce/contracts';
import { versionLabel } from '../core/display';
import { policyLabel, resultLocation } from '../core/exact-value';
import { ResultsStore } from './results.store';
import { ResultsExportComponent } from './results-export.component';
import { DirectionsComponent } from '../recalculation/directions.component';
import { CalculationDetailComponent } from '../shared/calculation-detail.component';
@Component({ selector: 'ce-validation-page', standalone: true, imports: [StageTitleDirective, FormsModule, DatePipe, MatButtonModule, MatFormFieldModule, MatInputModule, MatTableModule, MatPaginatorModule, ResultsExportComponent, DirectionsComponent, CalculationDetailComponent], templateUrl: './validation-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class ValidationPageComponent {
readonly store = inject(ResultsStore); readonly session = this.store.session; readonly versionLabel = versionLabel; readonly policyLabel = policyLabel; readonly resultLocation = resultLocation;
readonly detail = signal<RuleResultDTO | undefined>(undefined); private detailTrigger?: HTMLElement;
statusLabel(row: RuleResultDTO): string { return this.store.labels[row.status]; }
openDetail(row: RuleResultDTO, event: Event): void { this.detailTrigger = event.currentTarget as HTMLElement; this.detail.set(row); }
closeDetail(): void { this.detail.set(undefined); this.detailTrigger?.focus(); }
}
