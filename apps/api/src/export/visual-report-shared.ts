import { isCivilDateV2, isRationalValue } from '@ce/contracts';
import type { Coordinate, Rational, ReportContext, ReportedFact, ReportSourceBinding } from '@ce/contracts';
import { divide, parseDecimal, rational } from '@ce/engine';
import { ApiError } from '../errors.js';
import { canonicalHash, canonicalStringify } from '../session/canonical-state.js';
import { encodeSpreadsheetText, validXmlText } from '../import/ooxml-text.js';
import type { ReportPartition } from './recalculated-report.js';

export type VisualReportPartition = ReportPartition & { readonly binding: ReportSourceBinding };
export const invalidVisualReport = (): never => { throw new ApiError('EXPORT_NOT_AVAILABLE', { reason: 'INVALID_REPORT_SOURCE' }); };
const absolute = (value: bigint) => value < 0n ? -value : value;
/** Exact decimal reconstruction, independent of display precision. No quantization or Number conversion. */
export function decimalForWorkbook(value: Rational, scale: 0 | 3 | 6, check: () => void = () => {}): string {
  check();
  if (!isRationalValue(value) || ![0, 3, 6].includes(scale) || value.numerator.length > 1235 || value.denominator.length > 1234
    || !/^-?(?:0|[1-9][0-9]*)$/.test(value.numerator) || !/^[1-9][0-9]*$/.test(value.denominator)) return invalidVisualReport();
  let number;
  try { number = divide(rational(BigInt(value.numerator), BigInt(value.denominator)), rational(10n ** BigInt(scale))); }
  catch { return invalidVisualReport(); }
  if (number.n === 0n) return '0';
  let denominator = number.d, twos = 0, fives = 0;
  while (denominator % 2n === 0n) { check(); denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { check(); denominator /= 5n; fives++; }
  if (denominator !== 1n) return invalidVisualReport();
  const places = Math.max(twos, fives); check();
  const integer = absolute(number.n) * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives), digits = integer.toString().padStart(places + 1, '0');
  const text = (number.n < 0n ? '-' : '') + (places ? digits.slice(0, -places) + '.' + digits.slice(-places) : digits);
  if (text.length > 32_767) return invalidVisualReport(); check(); return text;
}
/** Storage policy only: its upper endpoint need not be importable as a complete report. */
export function isSafeXmlNumber(text: string): boolean {
  if (!/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(text)) return false;
  const [integer, fraction = ''] = text.replace(/^-/, '').split('.'), all = integer! + fraction;
  const significant = all.replace(/^0+/, '').replace(/0+$/, ''); if (!significant) return true;
  if (significant.length > 15) return false;
  const exponent = integer !== '0' ? integer!.length - 1 : -(fraction.search(/[1-9]/) + 1);
  return exponent >= -128 && (exponent < 128 || exponent === 128 && significant === '1');
}
export function serializeWorkbookAmount(value: Rational, scale: 0 | 3 | 6, check: () => void = () => {}): { text: string; type: 'number' | 'text' } {
  const text = decimalForWorkbook(value, scale, check);
  try { parseDecimal(text); } catch { return invalidVisualReport(); }
  return { text, type: isSafeXmlNumber(text) ? 'number' : 'text' };
}
export function xmlEscape(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function literalCell(address: string, value: string, style?: string): string {
  if (value.length > 32_767 || !validXmlText(value)) return invalidVisualReport();
  return `<c r="${address}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(encodeSpreadsheetText(value))}</t></is></c>`;
}
export function replaceVisualCell(xml: string, address: string, replacement: string): string {
  const pattern = new RegExp('<c\\b(?=[^>]*\\br="' + address + '")(?:[^>]*\\/>|[^>]*>[\\s\\S]*?</c>)');
  const matches = xml.match(new RegExp(pattern.source, 'g')); if (matches && matches.length !== 1) throw new ApiError('INTERNAL_ERROR');
  if (matches) return xml.replace(pattern, replacement);
  const row = new RegExp('(<row\\b[^>]*\\br="' + address.replace(/^[A-Z]+/, '') + '"[^>]*>[\\s\\S]*?)(</row>)');
  if (!row.test(xml)) throw new ApiError('INTERNAL_ERROR'); return xml.replace(row, (_match, start: string, end: string) => start + replacement + end);
}
export function visualCellStyle(xml: string, address: string): string | undefined {
  const cell = new RegExp('<c\\b(?=[^>]*\\br="' + address + '")[^>]*>').exec(xml)?.[0]; return /\bs="([0-9]+)"/.exec(cell ?? '')?.[1];
}
export function instructionsSheet(rows: readonly string[]): Buffer {
  return Buffer.from('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols><col min="1" max="1" width="115" customWidth="1"/></cols><sheetData>' + rows.map((value, index) => `<row r="${index + 1}">${literalCell('A' + (index + 1), value)}</row>`).join('') + '</sheetData></worksheet>');
}
/** Re-check worker input against the trusted profile, including business identity and source ownership. */
export function visualPartitionContext(partition: VisualReportPartition, expected: { profileId: string; mappingSha256: string; contextId: string; framework: string; moduleVersion: string; tableCode: string; selectedSheet: string }, check: () => void): ReportContext {
  check(); const binding = partition.binding, context = partition.contexts[0];
  if (!binding || binding.profileId !== expected.profileId || binding.mappingSha256 !== expected.mappingSha256 || binding.sourceFileId !== partition.sourceFileId
    || partition.contexts.length !== 1 || !context || context.contextId !== expected.contextId || canonicalStringify(partition.contextIds) !== canonicalStringify([context.contextId])
    || canonicalStringify(binding.contextIds) !== canonicalStringify([context.contextId]) || canonicalStringify(binding.selectedSheets) !== canonicalStringify([expected.selectedSheet])
    || !['workbook', 'form'].includes(binding.contextOrigin) || context.framework !== expected.framework || context.moduleVersion !== expected.moduleVersion
    || !context.entityId || context.entityId.length > 200 || context.entityId.trim() !== context.entityId || !isCivilDateV2(context.referenceDate)
    || context.submissionDate !== undefined && !isCivilDateV2(context.submissionDate) || Object.keys(context.filingIndicators).length !== 1 || typeof context.filingIndicators[expected.tableCode] !== 'boolean'
    || context.canonicalContextKey !== canonicalHash({ entityId: context.entityId, referenceDate: context.referenceDate, framework: context.framework, moduleVersion: context.moduleVersion })) return invalidVisualReport();
  return context;
}
export function assertVisualCoordinate(coordinate: Coordinate, context: ReportContext, sourceFileId: string, expected: { tableCode: string; rowCode: string; columnCode: string; dataType: string; unit: string; decimals: string }): void {
  if (coordinate.contextId !== context.contextId || coordinate.tableCode !== expected.tableCode || coordinate.rowCode !== expected.rowCode || coordinate.columnCode !== expected.columnCode || coordinate.sheetCode !== ''
    || coordinate.dataType !== expected.dataType || coordinate.unit !== expected.unit || coordinate.decimals !== expected.decimals || Object.keys(coordinate.axes).length
    || coordinate.sourceLocator.fileId !== sourceFileId || coordinate.factKey !== canonicalStringify([context.canonicalContextKey, expected.tableCode, '', expected.rowCode, expected.columnCode])) invalidVisualReport();
}
export function visualFacts(partition: VisualReportPartition, coordinates: ReadonlyMap<string, Coordinate>, check: () => void): ReadonlyMap<string, ReportedFact> {
  const facts = new Map<string, ReportedFact>();
  for (const fact of partition.facts) {
    check(); const coordinate = coordinates.get(fact.factKey);
    if (!coordinate || facts.has(fact.factKey) || fact.contextId !== coordinate.contextId || fact.tableCode !== coordinate.tableCode || fact.sheetCode !== coordinate.sheetCode
      || fact.rowCode !== coordinate.rowCode || fact.columnCode !== coordinate.columnCode || fact.sourceLocator.fileId !== partition.sourceFileId
      || fact.presence !== 'value' && fact.presence !== 'null' || fact.presence === 'value' && (typeof fact.originalText !== 'string' || fact.normalizedValue === undefined)
      || fact.presence === 'null' && (fact.normalizedValue !== undefined || fact.originalText !== undefined)) return invalidVisualReport();
    facts.set(fact.factKey, fact);
  }
  return facts;
}
