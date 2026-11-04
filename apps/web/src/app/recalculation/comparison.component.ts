import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatTableModule } from '@angular/material/table';
import { MatPaginatorModule } from '@angular/material/paginator';
import { SessionStore } from '../core/session.store';
import { calculationHeadingId, StageFocus } from '../core/stage-title.directive';
import { versionLabel } from '../core/display';
import { coordinateText, factText, statusLabels, validationText } from '../core/exact-value';
import { CalculationDetailComponent } from '../shared/calculation-detail.component';
import { ExportStore } from './export.store';
import type { ApplicationDetailDTO, ComparisonPageDTO, ComparisonRowDTO, RuleResultDTO, ValidationStatus } from '@ce/contracts';
@Component({ selector: 'ce-comparison', standalone: true, imports: [MatButtonModule, MatTableModule, MatPaginatorModule, CalculationDetailComponent], changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './comparison.component.html' })
export class ComparisonComponent {
readonly session = inject(SessionStore); readonly exports = inject(ExportStore); readonly versionLabel = versionLabel;
readonly page = input.required<ComparisonPageDTO>(); readonly detail = input<ApplicationDetailDTO | null>(null); readonly loading = input(false); readonly pageIndex = input(0); readonly changedOnly = input(true); readonly pageChange = output<number>(); readonly toggleAll = output<void>(); readonly more = output<void>();
readonly labels = statusLabels; readonly value = validationText; readonly opened = signal<ComparisonRowDTO | null>(null); private trigger?: HTMLElement;
private readonly focus = inject(StageFocus, { optional: true });
readonly statuses: readonly ValidationStatus[] = ['pass','fail','not_applicable','not_evaluable','error'];
sides(row: ComparisonRowDTO) { return [{ label: 'Antes', result: row.before }, { label: 'Después', result: row.after }]; }
code(row: ComparisonRowDTO): string { return row.after?.code || row.before?.code || 'Sin código'; }
state(result: RuleResultDTO | undefined): string { return result ? this.labels[result.status] : 'Sin registro'; }
changes(row: ComparisonRowDTO): readonly { location: string; before: string; after: string; unit: string }[] {
const before = new Map(row.before?.factReads.map(read => [read.factKey, read]) ?? []), after = new Map(row.after?.factReads.map(read => [read.factKey, read]) ?? []);
return [...new Set([...before.keys(), ...after.keys()])].flatMap(key => { const a = before.get(key), b = after.get(key); if (a?.presence === b?.presence && JSON.stringify(a?.normalizedValue) === JSON.stringify(b?.normalizedValue)) return [];
return [{ location: coordinateText((b ?? a)?.coordinate), before: a ? factText(a) : 'Sin dato', after: b ? factText(b) : 'Sin dato', unit: (b ?? a)?.coordinate.unit ?? '' }]; });
}
open(row: ComparisonRowDTO, event: Event): void { this.trigger = event.currentTarget as HTMLElement; const first = row.before ?? row.after; if (first) this.focus?.request(calculationHeadingId(first.id)); this.opened.set(row); }
close(): void { this.opened.set(null); this.trigger?.focus(); }
}
