import type { Coordinate, ImportedReport, ImportContextDeclaration, ImportContextFormDTO, ReportContext, ReportedFact, ReportSourceBinding, SourceFile, SourceLocator } from '@ce/contracts';
import { DecimalInputError, NumericError, multiply, parseDecimal, rational, rationalToDTO } from '@ce/engine';
import { ApiError } from '../../errors.js';
import { canonicalHash, canonicalStringify } from '../../session/canonical-state.js';
import type { PreflightWorkbook, RawCell } from '../xlsx-preflight.js';
import { COREP_MAPPING, COREP_MAPPING_SHA256, COREP_PROFILE_ID, recognizeCorepStructure } from './corep-structure.js';
import { resolveCorepContext } from './context.js';
export { COREP_MAPPING, COREP_MAPPING_SHA256, COREP_PROFILE_ID, COREP_LANGUAGE_PROFILE_ID } from './corep-structure.js';

function ambiguousFormat(format: string | undefined): boolean {
  if (!format) return false;
  if (format.startsWith('builtin:')) { const id = Number(format.slice(8)); return [9, 10, 45, 46, 47].includes(id) || id >= 14 && id <= 22 || id >= 27 && id <= 36 || id >= 50 && id <= 58; }
  const tokens = format.replace(/"(?:[^"]|"")*"|\\.|_.|\*./g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, '');
  return /[%ymdhs]/i.test(tokens);
}
function decimalLexeme(cell: RawCell): string {
  if (cell.xmlType !== 'n') return cell.text;
  const match = /^([+-]?)([0-9]+)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/.exec(cell.lexeme);
  if (!match || (match[4]?.replace(/^[+-]/, '').length ?? 0) > 3) throw new DecimalInputError('INVALID_DECIMAL');
  const fraction = match[3] ?? '', exponent = Number(match[4] ?? 0);
  if (Math.abs(exponent) > 128 || fraction.length > 128) throw new DecimalInputError('INPUT_VALUE_LIMIT');
  const digits = match[2]! + fraction, point = match[2]!.length + exponent;
  const magnitude = point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
  return (match[1] === '-' ? '-' : '') + magnitude;
}
export interface NormalizedCorepReport { readonly report: ImportedReport; readonly binding: ReportSourceBinding; readonly declaration: ImportContextDeclaration; readonly contextLocators?: Readonly<Record<string, SourceLocator>> }
export function normalizeCorepCa1(workbook: PreflightWorkbook, source: SourceFile, formDeclaration?: ImportContextFormDTO, options: { check?: () => void } = {}): NormalizedCorepReport {
  options.check?.(); recognizeCorepStructure(workbook);
  const resolved = resolveCorepContext(workbook, source, formDeclaration), declaration = resolved.declaration;
  const { contextId, entityId, referenceDate, submissionDate, framework, moduleVersion, filingIndicators } = declaration;
  const canonicalContextKey = canonicalHash({ entityId, referenceDate, framework, moduleVersion });
  const context: ReportContext = { contextId, entityId, referenceDate, ...(submissionDate ? { submissionDate } : {}), framework, moduleVersion, filingIndicators, canonicalContextKey,
    ...(resolved.locators?.filingIndicators ? { filingIndicatorsLocator: resolved.locators.filingIndicators } : {}) };
  const scale = declaration.scaleExponent!, decimals = declaration.displayDecimals === 'INF' ? 'INF' : String(declaration.displayDecimals! - scale);
  const sheet = workbook.sheets.find(item => item.name === 'CA1')!, coordinates: Coordinate[] = [], facts: ReportedFact[] = [];
  const locator = (address: string): SourceLocator => ({ fileId: source.id, sheet: 'CA1', row: Number(address.replace(/^[A-Z]+/, '')), column: address.replace(/[0-9]+$/, '') });
  for (const mapping of COREP_MAPPING.mapping) {
    options.check?.(); const { tableCode, sheetCode, rowCode, columnCode } = mapping;
    const factKey = canonicalStringify([canonicalContextKey, tableCode, sheetCode, rowCode, columnCode]);
    const identity = { factKey, contextId, tableCode, sheetCode, rowCode, columnCode };
    coordinates.push({ ...identity, dataType: 'number', unit: declaration.currency!, decimals, axes: {}, sourceLocator: locator(mapping.codeCell) });
    const raw = sheet.cells[mapping.amountCell]; if (!raw || raw.text === '' && raw.lexeme === '') continue;
    const sourceLocator = locator(mapping.amountCell);
    if (!['n', 's', 'str', 'inlineStr'].includes(raw.xmlType) || ambiguousFormat(workbook.numberFormats?.[Number(raw.style ?? 0)])) throw new ApiError('INVALID_WORKBOOK', { reason: 'AMBIGUOUS_COREP_AMOUNT' }, sourceLocator);
    try {
      const normalizedValue = rationalToDTO(multiply(parseDecimal(decimalLexeme(raw)), rational(10n ** BigInt(scale))));
      facts.push({ ...identity, presence: 'value', originalText: raw.xmlType === 'n' ? raw.lexeme : raw.text, normalizedValue, sourceLocator });
    } catch (error) {
      if (error instanceof DecimalInputError || error instanceof NumericError) throw new ApiError('INVALID_WORKBOOK', { reason: error.code }, sourceLocator);
      throw error;
    }
  }
  return { report: { contexts: [context], coordinates, facts, diagnostics: [] }, declaration,
    binding: { sourceFileId: source.id, contextIds: [contextId], profileId: COREP_PROFILE_ID, mappingSha256: COREP_MAPPING_SHA256, selectedSheets: ['CA1'],
      excludedSheets: workbook.sheets.map(item => item.name).filter(name => !['CA1', 'Contexto', 'Instrucciones'].includes(name)), scaleExponent: scale, displayDecimals: declaration.displayDecimals!, contextOrigin: resolved.origin },
    ...(resolved.locators ? { contextLocators: resolved.locators } : {}) };
}
