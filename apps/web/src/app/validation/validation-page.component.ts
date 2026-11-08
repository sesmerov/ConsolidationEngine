import { calculationHeadingId, StageFocus, StageTitleDirective } from '../core/stage-title.directive';
import { ChangeDetectionStrategy, Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import type { DoCheck } from '@angular/core';
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
import { CalculationDetailComponent } from '../shared/calculation-detail.component';
@Component({ selector: 'ce-validation-page', standalone: true, imports: [StageTitleDirective, FormsModule, DatePipe, MatButtonModule, MatFormFieldModule, MatInputModule, MatTableModule, MatPaginatorModule, ResultsExportComponent, CalculationDetailComponent], templateUrl: './validation-page.component.html', changeDetection: ChangeDetectionStrategy.OnPush })
export class ValidationPageComponent implements DoCheck {
readonly store = inject(ResultsStore); readonly session = this.store.session; readonly versionLabel = versionLabel; readonly policyLabel = policyLabel; readonly resultLocation = resultLocation;
readonly detail = signal<RuleResultDTO | undefined>(undefined); private detailTrigger?: HTMLElement;
private readonly focus = inject(StageFocus, { optional: true });
private readonly historySelector = viewChild('historySelector', {read: ElementRef<HTMLSelectElement>});
private readonly historyHeading = viewChild<ElementRef<HTMLElement>>('historyHeading');
ngDoCheck(): void { const select=this.historySelector()?.nativeElement; if(this.store.history().length<=1 && select && select.ownerDocument.activeElement===select) this.historyHeading()?.nativeElement.focus(); }
selectRun(id: string): void { this.closeDetail(); this.store.selectRun(id); }
statusLabel(row: RuleResultDTO): string { return this.store.labels[row.status]; }
openDetail(row: RuleResultDTO, event: Event): void { this.detailTrigger = event.currentTarget as HTMLElement; this.focus?.request(calculationHeadingId(row.id)); this.detail.set(row); }
closeDetail(): void { this.detail.set(undefined); this.detailTrigger?.focus(); }
}
