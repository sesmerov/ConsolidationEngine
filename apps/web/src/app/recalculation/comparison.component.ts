import { ChangeDetectionStrategy, Component, inject, input, output } from '@angular/core';
import { SessionStore } from '../core/session.store';
import { civilDate, versionLabel } from '../core/display';
import type { ApplicationDetailDTO, ComparisonPageDTO, ComparisonRowDTO, Rational, SourceLocator, ValidationStatus, ValidationValueDTO } from '@ce/contracts';
@Component({ selector: 'ce-comparison', standalone: true, changeDetection: ChangeDetectionStrategy.OnPush, templateUrl: './comparison.component.html' })
export class ComparisonComponent {
  readonly session = inject(SessionStore); readonly versionLabel = versionLabel;
  readonly page = input.required<ComparisonPageDTO>(); readonly detail = input<ApplicationDetailDTO | null>(null); readonly loading = input(false); readonly more = output<void>();
  readonly labels: Record<ValidationStatus, string> = { pass: 'Pasa', fail: 'Falla', not_applicable: 'No aplica', not_evaluable: 'No evaluable', error: 'Error' };
  readonly statuses: readonly ValidationStatus[] = ['pass', 'fail', 'not_applicable', 'not_evaluable', 'error'];
  sides(row: ComparisonRowDTO) { return [{ label: 'Antes', result: row.before }, { label: 'Después', result: row.after }]; }
  fraction(value: Rational): string { return value.denominator === '1' ? value.numerator : value.numerator + '/' + value.denominator; }
  value(value: ValidationValueDTO | undefined): string {
    if (!value) return 'Sin valor calculado'; if (value.kind === 'boolean') return value.value ? 'true' : 'false'; if (value.kind === 'unknown') return 'Metadato desconocido';
    if (value.kind === 'text') return value.value === '' ? 'Texto vacío' : value.value;
    if (value.kind === 'date') return civilDate(value.value);
    if (value.kind === 'null') return value.presence === 'explicit_null' ? 'Nulo explícito' : value.presence === 'implicit_null' ? 'Nulo implícito' : 'Nulo derivado';
    return this.fraction(value.nominal) + ' ' + value.unit + ' · intervalo [' + this.fraction(value.interval.lo) + ', ' + this.fraction(value.interval.hi) + ']';
  }
  source(locator: SourceLocator): string { return [this.page().sourceFiles?.find(file => file.id === locator.fileId)?.displayName, locator.sheet, locator.column ? locator.column + (locator.row ?? '') : locator.row ? 'fila ' + locator.row : ''].filter(Boolean).join(' · '); }
}
