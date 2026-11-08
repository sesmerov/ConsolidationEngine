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
import { MatCheckboxModule } from '@angular/material/checkbox';
import { versionLabel } from '../core/display';
import { ExactValueComponent } from '../core/exact-value.component';
import { ProposalExplanationComponent } from './proposal-explanation.component';
import { PreviewStore } from './preview.store';
import { DirectionsComponent } from './directions.component';
import { ApplyComponent } from './apply.component';
import { ComparisonComponent } from './comparison.component';
import type { ProposalSelectionRowDTO } from '@ce/contracts';
@Component({ selector: 'ce-preview-page', standalone: true, imports: [DirectionsComponent, StageTitleDirective, FormsModule, DatePipe, MatButtonModule, MatFormFieldModule, MatInputModule, MatTableModule, MatPaginatorModule, MatCheckboxModule, ExactValueComponent, ProposalExplanationComponent, ApplyComponent, ComparisonComponent], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './preview-page.component.html' })
export class PreviewPageComponent implements DoCheck {
readonly store = inject(PreviewStore); readonly session = this.store.session; readonly versionLabel = versionLabel;
readonly showApplied = signal(false); readonly invert = (value: boolean) => !value;
readonly proposalColumns = ['select','rule','target','change','dependencies','detail'];
columns(): string[] { return this.store.preview()?.state !== 'ready' || this.store.historical() ? this.proposalColumns.slice(1) : this.proposalColumns; }
private detailTrigger?: HTMLElement;
private dependenciesTrigger: HTMLElement | undefined;
private readonly focus = inject(StageFocus, { optional: true });
private readonly historySelector = viewChild('historySelector', {read: ElementRef<HTMLSelectElement>});
private readonly historyHeading = viewChild<ElementRef<HTMLElement>>('historyHeading');
ngDoCheck(): void { const select=this.historySelector()?.nativeElement; if(this.store.history().length<=1 && select && select.ownerDocument.activeElement===select) this.historyHeading()?.nativeElement.focus(); }
statusLabel(row: ProposalSelectionRowDTO): string { return this.store.labels[row.state]; }
openDetail(id: string, event: Event): void { this.detailTrigger = event.currentTarget as HTMLElement; this.focus?.request(calculationHeadingId(id)); void this.store.openDetail(id); }
closeDetail(): void { this.store.closeDetail(); this.detailTrigger?.focus(); }
openDependencies(id: string, event: Event): void { this.dependenciesTrigger = event.currentTarget as HTMLElement; this.focus?.request('dependencies-title'); void this.store.openDependencies(id); }
closeDependencies(): void { this.store.closeDependencies(); if (this.dependenciesTrigger?.isConnected) this.dependenciesTrigger.focus(); this.dependenciesTrigger = undefined; }
}
