import { isCivilDateV2 } from '@ce/contracts';
import type { ImportContextDeclaration, ImportContextFormDTO, SourceFile, SourceLocator } from '@ce/contracts';
import { ApiError } from '../../errors.js';
import { canonicalStringify } from '../../session/canonical-state.js';
import type { PreflightWorkbook, RawSheet } from '../xlsx-preflight.js';
import { COREP_PROFILE_ID } from './corep-structure.js';

export const COREP_CONTEXT_FIELDS = ['Perfil', 'Framework', 'Módulo', 'Entidad', 'Fecha de referencia', 'Fecha de envío', 'Divisa', 'Escala', 'Decimales del importe', 'Tabla presentada'] as const;
const location = (source: SourceFile | undefined, row: number): SourceLocator => ({ ...(source ? { fileId: source.id } : {}), sheet: 'Contexto', row, column: 'B' });
function text(sheet: RawSheet, address: string): string {
  const cell = sheet.cells[address]; if (!cell || cell.text === '' && cell.lexeme === '') return '';
  if (!['s', 'inlineStr', 'str'].includes(cell.xmlType)) throw new ApiError('INVALID_WORKBOOK', { reason: 'TEXT_CELL_REQUIRED' }, { sheet: 'Contexto', column: address[0]!, row: Number(address.slice(1)) });
  return cell.text;
}
export function corepContextDeclaration(form: ImportContextFormDTO): ImportContextDeclaration {
  const missing = (): never => { throw new ApiError('MISSING_CONTEXT'); };
  if (typeof form.entityId !== 'string' || !form.entityId || form.entityId.length > 200 || form.entityId.trim() !== form.entityId
    || typeof form.referenceDate !== 'string' || !isCivilDateV2(form.referenceDate)
    || form.submissionDate !== undefined && !isCivilDateV2(form.submissionDate)
    || typeof form.currency !== 'string' || !/^[A-Z]{3}$/.test(form.currency)
    || ![0, 3, 6].includes(form.scaleExponent as number)
    || form.displayDecimals !== 'INF' && (!Number.isInteger(form.displayDecimals) || form.displayDecimals! < -18 || form.displayDecimals! > 18)
    || !form.filingIndicators || Object.keys(form.filingIndicators).length !== 1 || typeof form.filingIndicators['C_01.00'] !== 'boolean') missing();
  if (form.displayDecimals !== 'INF' && (form.displayDecimals! - form.scaleExponent! < -18 || form.displayDecimals! - form.scaleExponent! > 18)) throw new ApiError('INVALID_WORKBOOK', { reason: 'INVALID_PRECISION' });
  return { contextId: 'corep', framework: 'COREP', moduleVersion: 'COREP_OF_4.0', entityId: form.entityId, referenceDate: form.referenceDate,
    ...(form.submissionDate ? { submissionDate: form.submissionDate } : {}), currency: form.currency!, scaleExponent: form.scaleExponent!, displayDecimals: form.displayDecimals!, filingIndicators: { 'C_01.00': form.filingIndicators['C_01.00']! } };
}
export function readCorepWorkbookContext(workbook: PreflightWorkbook, source?: SourceFile): { declaration: ImportContextDeclaration; locators: Readonly<Record<string, SourceLocator>> } | undefined {
  const sheet = workbook.sheets.find(item => item.name === 'Contexto'); if (!sheet) return undefined;
  if (sheet.merged || text(sheet, 'A1') !== 'Campo' || text(sheet, 'B1') !== 'Valor') throw new ApiError('INVALID_WORKBOOK', { reason: 'INVALID_CONTEXT_LAYOUT' }, location(source, 1));
  for (const [index, key] of COREP_CONTEXT_FIELDS.entries()) if (text(sheet, 'A' + (index + 2)) !== key) throw new ApiError('INVALID_WORKBOOK', { reason: 'INVALID_CONTEXT_LAYOUT' }, location(source, index + 2));
  for (const cell of Object.values(sheet.cells)) if ((cell.row > 11 || cell.column > 2) && (cell.text !== '' || cell.lexeme !== '')) throw new ApiError('INVALID_WORKBOOK', { reason: 'UNEXPECTED_CONTEXT_CONTENT' }, location(source, cell.row));
  const values = COREP_CONTEXT_FIELDS.map((_key, index) => text(sheet, 'B' + (index + 2)));
  if (values[0] !== COREP_PROFILE_ID || values[1] !== 'COREP' || values[2] !== 'COREP_OF_4.0') throw new ApiError('CONTEXT_MISMATCH', {}, location(source, 2));
  // A blank product template contains labels and profile metadata but no business declaration.
  if (values.slice(3).every(value => value === '')) return undefined;
  const [entityId, referenceDate, submissionDate, currency, scale, decimals, filing] = values.slice(3) as [string, string, string, string, string, string, string];
  if (!/^(?:0|3|6)$/.test(scale) || !/^(?:INF|0|-?[1-9]|-?1[0-8])$/.test(decimals) || !['true', 'false'].includes(filing)) throw new ApiError('MISSING_CONTEXT', {}, location(source, 9));
  const declaration = corepContextDeclaration({ entityId, referenceDate, ...(submissionDate ? { submissionDate } : {}), currency,
    scaleExponent: Number(scale) as 0 | 3 | 6, displayDecimals: decimals === 'INF' ? 'INF' : Number(decimals), filingIndicators: { 'C_01.00': filing === 'true' } });
  const keys = ['framework', 'moduleVersion', 'entityId', 'referenceDate', 'submissionDate', 'currency', 'scaleExponent', 'displayDecimals', 'filingIndicators'];
  const locators = Object.fromEntries(keys.filter(key => key !== 'submissionDate' || submissionDate).map(key => [key, location(source, keys.indexOf(key) + 3)]));
  return { declaration, locators };
}
export function resolveCorepContext(workbook: PreflightWorkbook, source: SourceFile, form?: ImportContextFormDTO): { declaration: ImportContextDeclaration; origin: 'form' | 'workbook'; locators?: Readonly<Record<string, SourceLocator>> } {
  const fromWorkbook = readCorepWorkbookContext(workbook, source), fromForm = form ? corepContextDeclaration(form) : undefined;
  if (fromWorkbook && fromForm && canonicalStringify(fromWorkbook.declaration) !== canonicalStringify(fromForm)) throw new ApiError('CONTEXT_MISMATCH', {}, location(source, 5));
  if (fromForm) return { declaration: fromForm, origin: 'form' };
  if (!fromWorkbook) throw new ApiError('MISSING_CONTEXT', {}, { fileId: source.id });
  return { declaration: fromWorkbook.declaration, origin: 'workbook', locators: fromWorkbook.locators };
}
