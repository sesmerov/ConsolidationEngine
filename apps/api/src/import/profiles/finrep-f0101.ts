import type { Coordinate, ImportedReport, ImportContextDeclaration, ImportContextFormDTO, ReportContext, ReportedFact, ReportSourceBinding, SourceFile, SourceLocator } from '@ce/contracts';
import { DecimalInputError, NumericError, multiply, parseDecimal, rational, rationalToDTO } from '@ce/engine';
import { ApiError } from '../../errors.js';
import { canonicalHash, canonicalStringify } from '../../session/canonical-state.js';
import type { PreflightWorkbook, RawCell } from '../xlsx-preflight.js';
import { FINREP_MAPPING, FINREP_MAPPING_SHA256, FINREP_PROFILE_ID, FINREP_MODULE, recognizeFinrepStructure } from './finrep-f0101-structure.js';
import { ambiguousFormat, decimalLexeme } from './corep-ca1.js';
import { resolveMonetaryContext, readMonetaryWorkbookContext } from './context.js';
export { FINREP_MAPPING, FINREP_MAPPING_SHA256, FINREP_PROFILE_ID } from './finrep-f0101-structure.js';
const profile=(source?:SourceFile)=>({profileId:FINREP_PROFILE_ID,framework:'FINREP',moduleVersion:FINREP_MODULE,tableCode:'F_01.01',contextId:'finrep_'+(source?.id.replaceAll('-','')??'inspection')});
export const readFinrepWorkbookContext=(workbook:PreflightWorkbook,source?:SourceFile)=>readMonetaryWorkbookContext(workbook,source,profile(source));

export interface NormalizedFinrepReport { readonly report: ImportedReport; readonly binding: ReportSourceBinding; readonly declaration: ImportContextDeclaration; readonly contextLocators?: Readonly<Record<string, SourceLocator>> }
export function normalizeFinrepF0101(workbook: PreflightWorkbook, source: SourceFile, formDeclaration?: ImportContextFormDTO, options: { check?: () => void } = {}): NormalizedFinrepReport {
  options.check?.(); recognizeFinrepStructure(workbook);
  const resolved = resolveMonetaryContext(workbook, source, formDeclaration, profile(source)), declaration = resolved.declaration;
  const { contextId, entityId, referenceDate, submissionDate, framework, moduleVersion, filingIndicators } = declaration;
  const canonicalContextKey = canonicalHash({ entityId, referenceDate, framework, moduleVersion });
  const context: ReportContext = { contextId, entityId, referenceDate, ...(submissionDate ? { submissionDate } : {}), framework, moduleVersion, filingIndicators, canonicalContextKey,
    ...(resolved.locators?.filingIndicators ? { filingIndicatorsLocator: resolved.locators.filingIndicators } : {}) };
  const scale = declaration.scaleExponent!, decimals = declaration.displayDecimals === 'INF' ? 'INF' : String(declaration.displayDecimals! - scale);
  const sheet = workbook.sheets.find(item => item.name === '1.1')!, coordinates: Coordinate[] = [], facts: ReportedFact[] = [];
  const locator = (address: string): SourceLocator => ({ fileId: source.id, sheet: '1.1', row: Number(address.replace(/^[A-Z]+/, '')), column: address.replace(/[0-9]+$/, '') });
  for (const mapping of FINREP_MAPPING.mapping) {
    options.check?.(); const { tableCode, sheetCode, rowCode, columnCode } = mapping;
    const factKey = canonicalStringify([canonicalContextKey, tableCode, sheetCode, rowCode, columnCode]);
    const identity = { factKey, contextId, tableCode, sheetCode, rowCode, columnCode };
    coordinates.push({ ...identity, dataType: 'number', unit: declaration.currency!, decimals, axes: {}, sourceLocator: locator(mapping.codeCell) });
    const raw = sheet.cells[mapping.amountCell]; if (!raw || raw.text === '' && raw.lexeme === '') continue;
    const sourceLocator = locator(mapping.amountCell);
    if (!['n', 's', 'str', 'inlineStr'].includes(raw.xmlType) || ambiguousFormat(workbook.numberFormats?.[Number(raw.style ?? 0)])) throw new ApiError('INVALID_WORKBOOK', { reason: 'AMBIGUOUS_FINREP_AMOUNT' }, sourceLocator);
    try {
      const normalizedValue = rationalToDTO(multiply(parseDecimal(decimalLexeme(raw)), rational(10n ** BigInt(scale))));
      facts.push({ ...identity, presence: 'value', originalText: raw.xmlType === 'n' ? raw.lexeme : raw.text, normalizedValue, sourceLocator });
    } catch (error) {
      if (error instanceof DecimalInputError || error instanceof NumericError) throw new ApiError('INVALID_WORKBOOK', { reason: error.code }, sourceLocator);
      throw error;
    }
  }
  return { report: { contexts: [context], coordinates, facts, diagnostics: [] }, declaration,
    binding: { sourceFileId: source.id, contextIds: [contextId], profileId: FINREP_PROFILE_ID, mappingSha256: FINREP_MAPPING_SHA256, selectedSheets: ['1.1'],
      excludedSheets: workbook.sheets.map(item => item.name).filter(name => !['1.1', 'Contexto', 'Instrucciones'].includes(name)), scaleExponent: scale, displayDecimals: declaration.displayDecimals!, contextOrigin: resolved.origin },
    ...(resolved.locators ? { contextLocators: resolved.locators } : {}) };
}
