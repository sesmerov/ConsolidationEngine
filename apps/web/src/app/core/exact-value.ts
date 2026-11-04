import type { Coordinate, FactReadDTO, NormalizedValue, ProposalDTO, Rational, RuleResultDTO, SourceFile, SourceLocator, ValidationValueDTO } from '@ce/contracts';
import { civilDate } from './display';

/** Formats exact rationals using integer arithmetic only; never rounds for presentation. */
export function decimalText(value: Rational, decimals = ''): string {
  let numerator = BigInt(value.numerator), denominator = BigInt(value.denominator);
  if (denominator <= 0n) return 'Valor no disponible';
  const sign = numerator < 0n ? '−' : ''; if (numerator < 0n) numerator = -numerator;
  let rest = denominator, twos = 0, fives = 0;
  while (rest % 2n === 0n) { rest /= 2n; twos++; }
  while (rest % 5n === 0n) { rest /= 5n; fives++; }
  if (rest !== 1n) return `${sign}${numerator}/${denominator}`;
  const places = Math.max(twos, fives);
  const scaled = numerator * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives);
  const raw = scaled.toString().padStart(places + 1, '0');
  const integer = places ? raw.slice(0, -places) : raw;
  let fraction = places ? raw.slice(-places).replace(/0+$/, '') : '';
  // Only the small declared precision is converted, never an amount.
  const minimum = /^(?:[0-9]|1[0-8])$/.test(decimals) ? parseInt(decimals, 10) : 0;
  fraction = fraction.padEnd(minimum, '0');
  const grouped = BigInt(integer).toLocaleString('es-ES');
  return sign + grouped + (fraction ? ',' + fraction : '');
}
export function normalizedText(value: NormalizedValue | undefined, decimals = ''): string {
  if (value === undefined) return 'Sin dato';
  if (typeof value === 'boolean') return value ? 'Verdadero' : 'Falso';
  if ('kind' in value) return value.kind === 'date' ? civilDate(value.value) : value.value === '' ? 'Texto vacío' : `“${value.value}”`;
  return decimalText(value, decimals);
}
export function validationText(value: ValidationValueDTO | undefined): string {
  if (!value) return 'Sin valor calculado';
  switch (value.kind) {
    case 'number': return [decimalText(value.nominal), value.unit].filter(Boolean).join(' ');
    case 'text': case 'date': return normalizedText(value);
    case 'boolean': return normalizedText(value.value);
    case 'null': return 'Sin dato';
    case 'unknown': return 'Valor desconocido';
  }
}
export function factText(read: FactReadDTO): string { return read.presence === 'value' ? normalizedText(read.normalizedValue, read.coordinate.decimals) : 'Sin dato'; }
export function coordinateText(cell: Coordinate | undefined): string {
  return cell ? [cell.tableCode, cell.sheetCode ? `s${cell.sheetCode}` : '', `r${cell.rowCode}`, `c${cell.columnCode}`].filter(Boolean).join(' · ') : 'Destino no disponible';
}
export function resultLocation(row: RuleResultDTO): string {
  const binding = row.binding;
  if (binding?.rowCode || binding?.columnCode) return [binding.tableCode, binding.sheetCode ? `s${binding.sheetCode}` : '', binding.rowCode ? `r${binding.rowCode}` : '', binding.columnCode ? `c${binding.columnCode}` : ''].filter(Boolean).join(' · ');
  return row.tables?.join(' · ') || coordinateText(row.factReads?.[0]?.coordinate);
}
export function sourceText(locator: SourceLocator, files: readonly SourceFile[] = []): string {
  return [files.find(file => file.id === locator.fileId)?.displayName, locator.sheet,
    locator.column ? locator.column + (locator.row ?? '') : locator.row ? 'fila ' + locator.row : ''].filter(Boolean).join(' · ') || 'Contexto declarado';
}
export function roundedProposal(row: ProposalDTO): boolean {
  const after = row.after?.normalizedValue;
  return !!row.exactNominal && !!after && typeof after !== 'boolean' && BigInt(row.exactNominal.numerator) * BigInt(after.denominator) !== BigInt(after.numerator) * BigInt(row.exactNominal.denominator);
}
export function hasInterval(row: ProposalDTO): boolean { return !!row.derivedInterval && (row.derivedInterval.lo.numerator !== row.derivedInterval.hi.numerator || row.derivedInterval.lo.denominator !== row.derivedInterval.hi.denominator); }
export const statusLabels = { pass: 'Pasa', fail: 'Falla', not_applicable: 'No aplica', not_evaluable: 'No evaluable', error: 'Error' } as const;
export function policyLabel(row: RuleResultDTO): string {
  const policy = row.recalculation?.policy;
  return policy?.mode === 'validation_only' ? 'Solo validación' : policy?.mode !== 'standard' ? 'Capacidad no disponible'
    : row.recalculation?.left.eligible || row.recalculation?.right.eligible ? 'Destino configurable' : 'Sin recálculo';
}
