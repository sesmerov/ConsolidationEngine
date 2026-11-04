import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isCivilDateV2 } from '@ce/contracts';
import type { Coordinate, ImportContextDeclaration, ImportContextFormDTO, ReportedFact, SourceFile, SourceLocator } from '@ce/contracts';
import { ApiError } from '../../errors.js';
import { canonicalHash, canonicalStringify, immutable } from '../../session/canonical-state.js';
import { excelDate } from '../excel-dates.js';
import type { PreflightWorkbook, RawCell, RawSheet } from '../xlsx-preflight.js';
import type { NormalizedCorepReport } from './corep-ca1.js';

export const DEMO_TYPES_PROFILE_ID = 'ce-demo-types-1' as const;
export const DEMO_TYPES_LANGUAGE_PROFILE_ID = 'ce-dpmxl-0.9-closed-v2' as const;
interface TypedMapping { readonly profileId: string; readonly languageProfileId: string; readonly framework: string; readonly moduleVersion: string; readonly tableCode: string; readonly columnCode: string; readonly sheet: string; readonly instructionsTitle: string; readonly headers: readonly string[];
  readonly fields: readonly { readonly rowCode: string; readonly label: string; readonly labelCell: string; readonly valueCell: string; readonly stateCell: string; readonly type: 'text' | 'date' }[]; readonly contextFields: readonly string[] }
const mappingBytes = readFileSync(new URL('./demo-types-mapping.json', import.meta.url));
export const DEMO_TYPES_MAPPING = immutable(JSON.parse(mappingBytes.toString('utf8')) as TypedMapping);
export const DEMO_TYPES_MAPPING_SHA256 = createHash('sha256').update(mappingBytes).digest('hex');
const textTypes = ['s', 'str', 'inlineStr'];
const nonempty = (cell: RawCell) => cell.text !== '' || cell.lexeme !== '';
const locator = (sheet: string, address: string, source?: SourceFile): SourceLocator => ({ ...(source ? { fileId: source.id } : {}), sheet, row: Number(address.replace(/^[A-Z]+/, '')), column: address.replace(/[0-9]+$/, '') });
function invalid(reason: string, sheet: string, address: string, source?: SourceFile): never { throw new ApiError('INVALID_WORKBOOK', { reason }, locator(sheet, address, source)); }
function text(sheet: RawSheet, address: string, source?: SourceFile): string {
  const cell = sheet.cells[address]; if (!cell || !nonempty(cell)) return '';
  if (!textTypes.includes(cell.xmlType)) invalid('TEXT_CELL_REQUIRED', sheet.name, address, source); return cell.text;
}
/** Exact server layout. Values never select types, coordinates or the profile. */
export function recognizeDemoTypesStructure(workbook: PreflightWorkbook, source?: SourceFile): void {
  if (workbook.profile || workbook.sheets.length !== 3 || !['Instrucciones', 'Datos', 'Contexto'].every(name => workbook.sheets.some(sheet => sheet.name === name))) throw new ApiError('INVALID_WORKBOOK', { reason: 'UNKNOWN_REPORT_PROFILE' });
  const instructions = workbook.sheets.find(sheet => sheet.name === 'Instrucciones')!, data = workbook.sheets.find(sheet => sheet.name === 'Datos')!, context = workbook.sheets.find(sheet => sheet.name === 'Contexto')!;
  for (const sheet of workbook.sheets) if (sheet.merged || Object.keys(sheet.fragmentedRows ?? {}).length) invalid('INVALID_TYPED_LAYOUT', sheet.name, 'A1', source);
  if (text(instructions, 'A1', source) !== DEMO_TYPES_MAPPING.instructionsTitle) invalid('INVALID_TYPED_LAYOUT', instructions.name, 'A1', source);
  if (text(instructions, 'A2', source) !== DEMO_TYPES_PROFILE_ID) invalid('INVALID_TYPED_LAYOUT', instructions.name, 'A2', source);
  for (const cell of Object.values(instructions.cells)) if (nonempty(cell) && (cell.column !== 1 || !textTypes.includes(cell.xmlType))) invalid('UNEXPECTED_TYPED_CONTENT', instructions.name, cell.address, source);
  for (const [index, header] of DEMO_TYPES_MAPPING.headers.entries()) if (text(data, String.fromCharCode(65 + index) + '3', source) !== header) invalid('INVALID_TYPED_LAYOUT', data.name, String.fromCharCode(65 + index) + '3', source);
  for (const field of DEMO_TYPES_MAPPING.fields) if (text(data, field.labelCell, source) !== field.label) invalid('INVALID_TYPED_LAYOUT', data.name, field.labelCell, source);
  for (const cell of Object.values(data.cells)) if (nonempty(cell) && (cell.row < 3 || cell.row > 9 || cell.column > 3)) invalid('UNEXPECTED_TYPED_CONTENT', data.name, cell.address, source);
  for (const [index, header] of ['Campo', 'Valor'].entries()) if (text(context, String.fromCharCode(65 + index) + '3', source) !== header) invalid('INVALID_CONTEXT_LAYOUT', context.name, String.fromCharCode(65 + index) + '3', source);
  for (const [index, field] of DEMO_TYPES_MAPPING.contextFields.entries()) if (text(context, 'A' + (index + 4), source) !== field) invalid('INVALID_CONTEXT_LAYOUT', context.name, 'A' + (index + 4), source);
  for (const cell of Object.values(context.cells)) if (nonempty(cell) && (cell.row < 3 || cell.row > 10 || cell.column > 2)) invalid('UNEXPECTED_CONTEXT_CONTENT', context.name, cell.address, source);
}
function declaration(form: ImportContextFormDTO): ImportContextDeclaration {
  if (form.currency !== undefined || form.scaleExponent !== undefined || form.displayDecimals !== undefined) throw new ApiError('CONTEXT_MISMATCH');
  if (typeof form.entityId !== 'string' || !form.entityId || form.entityId.length > 200 || form.entityId.trim() !== form.entityId || !isCivilDateV2(form.referenceDate)
    || form.submissionDate !== undefined && !isCivilDateV2(form.submissionDate) || !form.filingIndicators || Object.keys(form.filingIndicators).length !== 1 || typeof form.filingIndicators.DEMO_TYPES !== 'boolean') throw new ApiError('MISSING_CONTEXT');
  return { contextId: 'demo_types', framework: 'DEMO', moduleVersion: 'DEMO_TYPES_1', entityId: form.entityId, referenceDate: form.referenceDate,
    ...(form.submissionDate ? { submissionDate: form.submissionDate } : {}), filingIndicators: { DEMO_TYPES: form.filingIndicators.DEMO_TYPES } };
}
export function readDemoTypesWorkbookContext(workbook: PreflightWorkbook, source?: SourceFile): { declaration: ImportContextDeclaration; locators: Readonly<Record<string, SourceLocator>> } | undefined {
  recognizeDemoTypesStructure(workbook, source); const sheet = workbook.sheets.find(item => item.name === 'Contexto')!;
  for (const [address, expected] of [['B7', 'DEMO'], ['B8', 'DEMO_TYPES_1'], ['B9', DEMO_TYPES_PROFILE_ID]]) if (text(sheet, address!, source) !== expected) throw new ApiError('CONTEXT_MISMATCH', {}, locator('Contexto', address!, source));
  const entityId = text(sheet, 'B4', source), referenceDate = text(sheet, 'B5', source), submissionDate = text(sheet, 'B6', source), filing = text(sheet, 'B10', source);
  if ([entityId, referenceDate, submissionDate, filing].every(value => value === '')) return undefined;
  if (!['Sí', 'No'].includes(filing)) throw new ApiError('MISSING_CONTEXT', {}, locator('Contexto', 'B10', source));
  let value: ImportContextDeclaration;
  try { value = declaration({ entityId, referenceDate, ...(submissionDate ? { submissionDate } : {}), filingIndicators: { DEMO_TYPES: filing === 'Sí' } }); }
  catch (error) { if (error instanceof ApiError) throw new ApiError(error.code, error.details, locator('Contexto', !entityId ? 'B4' : !isCivilDateV2(referenceDate) ? 'B5' : 'B6', source)); throw error; }
  const fields = { entityId: 'B4', referenceDate: 'B5', ...(submissionDate ? { submissionDate: 'B6' } : {}), framework: 'B7', moduleVersion: 'B8', filingIndicators: 'B10' };
  return { declaration: value, locators: Object.fromEntries(Object.entries(fields).map(([key, address]) => [key, locator('Contexto', address, source)])) };
}
function ambiguousDateFormat(format: string | undefined): boolean {
  if (!format) return false;
  if (format.startsWith('builtin:')) return [9, 10, 18, 19, 20, 21, 22, 45, 46, 47].includes(Number(format.slice(8)));
  return /[%hs]/i.test(format.replace(/"(?:[^"]|"")*"|\\.|_.|\*./g, '').replace(/\[(?![hms]+\])[^\]]*\]/gi, ''));
}
export function normalizeDemoTypes(workbook: PreflightWorkbook, source: SourceFile, form?: ImportContextFormDTO, options: { check?: () => void } = {}): NormalizedCorepReport {
  options.check?.(); const fromWorkbook = readDemoTypesWorkbookContext(workbook, source), fromForm = form ? declaration(form) : undefined;
  if (fromWorkbook && fromForm && canonicalStringify(fromWorkbook.declaration) !== canonicalStringify(fromForm)) throw new ApiError('CONTEXT_MISMATCH', {}, locator('Contexto', 'B4', source));
  const resolved = fromForm ?? fromWorkbook?.declaration; if (!resolved) throw new ApiError('MISSING_CONTEXT', {}, { fileId: source.id });
  const { contextId, entityId, referenceDate, submissionDate, framework, moduleVersion, filingIndicators } = resolved, canonicalContextKey = canonicalHash({ entityId, referenceDate, framework, moduleVersion });
  const contextLocators = !fromForm ? fromWorkbook?.locators : undefined;
  const context = { contextId, entityId, referenceDate, ...(submissionDate ? { submissionDate } : {}), framework, moduleVersion, filingIndicators, canonicalContextKey, ...(contextLocators?.filingIndicators ? { filingIndicatorsLocator: contextLocators.filingIndicators } : {}) };
  const sheet = workbook.sheets.find(item => item.name === 'Datos')!, coordinates: Coordinate[] = [], facts: ReportedFact[] = [];
  for (const field of DEMO_TYPES_MAPPING.fields) {
    options.check?.(); const identity = { contextId, tableCode: 'DEMO_TYPES', sheetCode: '', rowCode: field.rowCode, columnCode: '0010', factKey: canonicalStringify([canonicalContextKey, 'DEMO_TYPES', '', field.rowCode, '0010']) };
    coordinates.push({ ...identity, dataType: field.type, unit: '', decimals: '', axes: {}, sourceLocator: locator('Datos', field.labelCell, source) });
    const state = text(sheet, field.stateCell, source), raw = sheet.cells[field.valueCell];
    if (!['Informado', 'Sin dato'].includes(state)) invalid('INVALID_TYPED_STATE', 'Datos', field.stateCell, source);
    if (raw && !nonempty(raw) && !textTypes.includes(raw.xmlType) && raw.xmlType !== 'n') invalid('INCOMPATIBLE_CELL_TYPE', 'Datos', field.valueCell, source);
    if (state === 'Sin dato') {
      if (raw && nonempty(raw)) invalid('NULL_WITH_VALUE', 'Datos', field.stateCell, source);
      facts.push({ ...identity, presence: 'null', sourceLocator: locator('Datos', field.stateCell, source) }); continue;
    }
    let value: string;
    if (field.type === 'text') {
      if (raw && nonempty(raw) && !textTypes.includes(raw.xmlType)) invalid('TEXT_CELL_REQUIRED', 'Datos', field.valueCell, source);
      value = raw?.text ?? '';
    } else {
      try { if (ambiguousDateFormat(workbook.numberFormats?.[Number(raw?.style ?? 0)])) throw new ApiError('INVALID_WORKBOOK'); const date = excelDate(raw, workbook.date1904); if (!date || !isCivilDateV2(date)) throw new ApiError('INVALID_WORKBOOK'); value = date; }
      catch { invalid('INVALID_CIVIL_DATE', 'Datos', field.valueCell, source); }
    }
    facts.push({ ...identity, presence: 'value', originalText: raw?.xmlType === 'n' ? raw.lexeme : raw?.text ?? '', normalizedValue: { kind: field.type, value }, sourceLocator: locator('Datos', field.valueCell, source) });
  }
  return { report: { contexts: [context], coordinates, facts, diagnostics: [] }, declaration: resolved,
    binding: { sourceFileId: source.id, contextIds: [contextId], profileId: DEMO_TYPES_PROFILE_ID, mappingSha256: DEMO_TYPES_MAPPING_SHA256, selectedSheets: ['Datos'], excludedSheets: [], contextOrigin: fromForm ? 'form' : 'workbook' },
    ...(contextLocators ? { contextLocators } : {}) };
}
