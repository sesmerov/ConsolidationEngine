import { CONTEXT_HEADERS, COORDINATE_HEADERS, FACT_HEADERS, REPORT_SHEETS, REPORT_TEMPLATE_VERSION, isCivilDate } from '@ce/contracts';
import type { Coordinate, FactIdentity, ImportedReport, ReportContext, ReportedFact, SourceFile, SourceLocator } from '@ce/contracts';
import { DecimalInputError, parseDecimal, rationalToDTO } from '@ce/engine';
import { ApiError } from '../errors.js';
import { canonicalHash, canonicalStringify } from '../session/canonical-state.js';
import type { RawCell } from './xlsx-preflight.js';
import type { RawWorkbook, WorkbookSheet } from './xlsx-reader.js';

const TABLE_CODE = /^[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/;
const CELL_CODE = /^[A-Za-z0-9]+$/;
const TEXT_TYPES = new Set(['s', 'inlineStr', 'str']);
function locator(source: SourceFile, sheet: WorkbookSheet, row: number, column: number): SourceLocator {
  let letters = ''; let index = column;
  while (index > 0) { index--; letters = String.fromCharCode(65 + index % 26) + letters; index = Math.floor(index / 26); }
  return { fileId: source.id, sheet: sheet.name, row, column: letters };
}
function invalid(reason: string, location: SourceLocator): never {
  throw new ApiError('INVALID_WORKBOOK', { reason }, location);
}
function cell(sheet: WorkbookSheet, row: number, column: number): RawCell | undefined {
  let letters = ''; let index = column;
  while (index > 0) { index--; letters = String.fromCharCode(65 + index % 26) + letters; index = Math.floor(index / 26); }
  return sheet.cells[letters + row];
}
function text(source: SourceFile, sheet: WorkbookSheet, row: number, column: number, allowEmpty = false): string {
  const raw = cell(sheet, row, column); const location = locator(source, sheet, row, column);
  if (!raw) { if (allowEmpty) return ''; return invalid('MISSING_VALUE', location); }
  // Blank styled cells carry no value. They may represent an optional empty field, not zero/null.
  if (allowEmpty && raw.text === '' && raw.lexeme === '') return '';
  if (!TEXT_TYPES.has(raw.xmlType)) return invalid('TEXT_CELL_REQUIRED', location);
  if (!allowEmpty && raw.text === '') return invalid('MISSING_VALUE', location);
  return raw.text;
}
function table(source: SourceFile, workbook: RawWorkbook, name: string, headers: readonly string[]): WorkbookSheet {
  const sheet = workbook.sheets.find((item) => item.name === name);
  if (!sheet) throw new ApiError('INVALID_WORKBOOK', { reason: 'MISSING_SHEET', sheet: name });
  if (sheet.merged) return invalid('MERGED_DATA_CELLS', { fileId: source.id, sheet: name });
  for (let column = 1; column <= headers.length; column++) {
    if (text(source, sheet, 1, column) !== headers[column - 1]) return invalid('INVALID_HEADER', locator(source, sheet, 1, column));
  }
  for (const raw of Object.values(sheet.cells)) {
    if (raw.column > headers.length && (raw.text !== '' || raw.lexeme !== '')) return invalid('UNEXPECTED_COLUMN', locator(source, sheet, raw.row, raw.column));
  }
  return sheet;
}
function rows(sheet: WorkbookSheet): number[] {
  const present = new Set<number>();
  for (const raw of Object.values(sheet.cells)) if (raw.row > 1 && (raw.text !== '' || raw.lexeme !== '')) present.add(raw.row);
  return [...present].sort((a, b) => a - b);
}
/** A flat JSON decoder retains duplicate keys, including escaped equivalents, until they are checked. */
function flatObject(text: string, kind: 'boolean', location: SourceLocator): Readonly<Record<string, boolean>>;
function flatObject(text: string, kind: 'string', location: SourceLocator): Readonly<Record<string, string>>;
function flatObject(input: string, kind: 'string' | 'boolean', location: SourceLocator): Readonly<Record<string, string | boolean>> {
  const value = input === '' ? '{}' : input; let offset = 0;
  const output: Record<string, string | boolean> = Object.create(null) as Record<string, string | boolean>;
  const space = () => { while (/[\t\n\r ]/.test(value[offset] ?? '') && offset < value.length) offset++; };
  const string = (): string => {
    const match = /^"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(value.slice(offset));
    if (!match) return invalid('INVALID_METADATA_JSON', location);
    offset += match[0].length; return JSON.parse(match[0]) as string;
  };
  space(); if (value[offset++] !== '{') return invalid('INVALID_METADATA_JSON', location); space();
  if (value[offset] !== '}') {
    while (true) {
      const key = string(); if (!key || Object.hasOwn(output, key)) return invalid('DUPLICATE_OR_EMPTY_METADATA_KEY', location);
      space(); if (value[offset++] !== ':') return invalid('INVALID_METADATA_JSON', location); space();
      let entry: string | boolean;
      if (kind === 'string') { entry = string(); if (entry === '') return invalid('EMPTY_AXIS_MEMBER', location); }
      else if (value.startsWith('true', offset)) { entry = true; offset += 4; }
      else if (value.startsWith('false', offset)) { entry = false; offset += 5; }
      else return invalid('INVALID_FILING_INDICATOR', location);
      output[key] = entry; space();
      if (value[offset] === '}') break;
      if (value[offset++] !== ',') return invalid('INVALID_METADATA_JSON', location); space();
    }
  }
  offset++; space(); if (offset !== value.length) return invalid('INVALID_METADATA_JSON', location);
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
function validUnit(unit: string): boolean {
  if (unit === 'pure') return true;
  let previous = '';
  for (const factor of unit.split('*')) {
    const match = /^([A-Z][A-Z0-9_]{0,15})(?:\^(-?[1-8]))?$/.exec(factor);
    if (!match || match[1]! <= previous || match[2] === '1') return false;
    previous = match[1]!;
  }
  return true;
}
export function importReport(workbook: RawWorkbook, source: SourceFile): ImportedReport {
  if (workbook.sheets.length !== REPORT_SHEETS.length || new Set(workbook.sheets.map((sheet) => sheet.name)).size !== REPORT_SHEETS.length
      || workbook.sheets.some((sheet) => !(REPORT_SHEETS as readonly string[]).includes(sheet.name))) {
    throw new ApiError('INVALID_WORKBOOK', { reason: 'INVALID_REPORT_SHEETS' });
  }
  const contextSheet = table(source, workbook, 'Contexts', CONTEXT_HEADERS);
  const coordinateSheet = table(source, workbook, 'Coordinates', COORDINATE_HEADERS);
  const factSheet = table(source, workbook, 'Facts', FACT_HEADERS);
  const contexts: ReportContext[] = []; const contextMap = new Map<string, ReportContext>();
  const contextDefinitions = new Map<string, string>();
  for (const row of rows(contextSheet)) {
    const get = (column: number, empty = false) => text(source, contextSheet, row, column, empty);
    if (get(1) !== REPORT_TEMPLATE_VERSION) return invalid('INVALID_TEMPLATE_VERSION', locator(source, contextSheet, row, 1));
    const contextId = get(2), entityId = get(3), referenceDate = get(4), submissionDate = get(5, true), framework = get(6), moduleVersion = get(7);
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(contextId) || contextMap.has(contextId)) return invalid('INVALID_OR_DUPLICATE_CONTEXT_ID', locator(source, contextSheet, row, 2));
    if (!isCivilDate(referenceDate)) return invalid('INVALID_REFERENCE_DATE', locator(source, contextSheet, row, 4));
    if (submissionDate && !isCivilDate(submissionDate)) return invalid('INVALID_SUBMISSION_DATE', locator(source, contextSheet, row, 5));
    if ([entityId, framework, moduleVersion].some((item) => !item.trim() || item.trim() !== item)) return invalid('INVALID_CONTEXT_ATTRIBUTE', locator(source, contextSheet, row, 3));
    if (contexts.some((item) => item.entityId !== entityId || item.referenceDate !== referenceDate)) return invalid('INCOMPATIBLE_ENTITY_OR_DATE', locator(source, contextSheet, row, 3));
    const filingIndicatorsLocator = locator(source, contextSheet, row, 8);
    const filingIndicators = flatObject(get(8, true), 'boolean', filingIndicatorsLocator);
    if (Object.keys(filingIndicators).some((key) => !TABLE_CODE.test(key) || key.startsWith('v_'))) return invalid('INVALID_FILING_INDICATOR_CODE', filingIndicatorsLocator);
    const canonicalContextKey = canonicalHash({ entityId, referenceDate, framework, moduleVersion });
    const definition = canonicalStringify({ filingIndicators, submissionDate });
    const prior = contextDefinitions.get(canonicalContextKey);
    if (prior !== undefined && prior !== definition) return invalid('CONFLICTING_CONTEXT_ATTRIBUTES', filingIndicatorsLocator);
    contextDefinitions.set(canonicalContextKey, definition);
    const context: ReportContext = { canonicalContextKey, contextId, entityId, referenceDate, ...(submissionDate ? { submissionDate } : {}), framework, moduleVersion, filingIndicators, filingIndicatorsLocator };
    contexts.push(context); contextMap.set(contextId, context);
  }
  if (!contexts.length) return invalid('MISSING_CONTEXT', { fileId: source.id, sheet: 'Contexts' });
  const identity = (sheet: WorkbookSheet, row: number): FactIdentity => {
    const contextId = text(source, sheet, row, 1), tableCode = text(source, sheet, row, 2), sheetCode = text(source, sheet, row, 3, true);
    const rowCode = text(source, sheet, row, 4), columnCode = text(source, sheet, row, 5); const context = contextMap.get(contextId);
    if (!context) return invalid('UNKNOWN_CONTEXT', locator(source, sheet, row, 1));
    if (!TABLE_CODE.test(tableCode)) return invalid('INVALID_TABLE_CODE', locator(source, sheet, row, 2));
    if (sheetCode && !CELL_CODE.test(sheetCode)) return invalid('INVALID_SHEET_CODE', locator(source, sheet, row, 3));
    if (!CELL_CODE.test(rowCode) || !CELL_CODE.test(columnCode)) return invalid('INVALID_COORDINATE_CODE', locator(source, sheet, row, 4));
    return { factKey: canonicalStringify([context.canonicalContextKey, tableCode, sheetCode, rowCode, columnCode]), contextId, tableCode, sheetCode, rowCode, columnCode };
  };
  const coordinates: Coordinate[] = []; const coordinateMap = new Map<string, Coordinate>();
  const axesBySheet = new Map<string, string>(); const tableModes = new Map<string, boolean>();
  const coordinateRows = rows(coordinateSheet); const factRows = rows(factSheet);
  if (coordinateRows.length > 100_000 || factRows.length > 100_000) throw new ApiError('EXPANSION_LIMIT');
  for (const row of coordinateRows) {
    const key = identity(coordinateSheet, row); const get = (column: number, empty = false) => text(source, coordinateSheet, row, column, empty);
    if (coordinateMap.has(key.factKey)) return invalid('DUPLICATE_COORDINATE', locator(source, coordinateSheet, row, 1));
    const dataType = get(6), unit = get(7, true), decimals = get(8, true);
    if (dataType !== 'number' && dataType !== 'boolean') return invalid('UNSUPPORTED_DATA_TYPE', locator(source, coordinateSheet, row, 6));
    if (dataType === 'number' && !validUnit(unit)) return invalid('INVALID_UNIT', locator(source, coordinateSheet, row, 7));
    if (dataType === 'number' && decimals !== 'INF' && !/^(?:0|-[1-9]|[1-9]|-1[0-8]|1[0-8])$/.test(decimals)) return invalid('INVALID_PRECISION', locator(source, coordinateSheet, row, 8));
    if (dataType === 'boolean' && (unit !== '' || decimals !== '')) return invalid('BOOLEAN_NUMERIC_METADATA', locator(source, coordinateSheet, row, 7));
    const axes = flatObject(get(9), 'string', locator(source, coordinateSheet, row, 9));
    const context = contextMap.get(key.contextId)!;
    const tableKey = canonicalStringify([context.canonicalContextKey, key.tableCode]); const sheetKey = canonicalStringify([tableKey, key.sheetCode]);
    const mode = key.sheetCode !== ''; const existingMode = tableModes.get(tableKey);
    if (existingMode !== undefined && existingMode !== mode) return invalid('MIXED_SHEET_AXIS', locator(source, coordinateSheet, row, 3));
    tableModes.set(tableKey, mode);
    const canonicalAxes = canonicalStringify(axes); const priorAxes = axesBySheet.get(sheetKey);
    if (priorAxes !== undefined && priorAxes !== canonicalAxes) return invalid('INCONSISTENT_SHEET_AXES', locator(source, coordinateSheet, row, 9));
    axesBySheet.set(sheetKey, canonicalAxes);
    const coordinate: Coordinate = { ...key, dataType, unit, decimals, axes, sourceLocator: locator(source, coordinateSheet, row, 1) };
    coordinates.push(coordinate); coordinateMap.set(key.factKey, coordinate);
  }
  const facts: ReportedFact[] = []; const factKeys = new Set<string>();
  for (const row of factRows) {
    const key = identity(factSheet, row); const coordinate = coordinateMap.get(key.factKey);
    if (!coordinate) return invalid('UNKNOWN_COORDINATE', locator(source, factSheet, row, 1));
    if (factKeys.has(key.factKey)) return invalid('DUPLICATE_FACT', locator(source, factSheet, row, 1));
    factKeys.add(key.factKey);
    const presence = text(source, factSheet, row, 6); const originalText = text(source, factSheet, row, 7, presence === 'null');
    const sourceLocator = locator(source, factSheet, row, 7);
    if (presence === 'null') {
      if (originalText !== '') return invalid('NULL_HAS_VALUE', sourceLocator);
      facts.push({ ...key, presence, sourceLocator }); continue;
    }
    if (presence !== 'value') return invalid('INVALID_PRESENCE', locator(source, factSheet, row, 6));
    if (coordinate.dataType === 'boolean') {
      if (originalText !== 'true' && originalText !== 'false') return invalid('INVALID_BOOLEAN', sourceLocator);
      facts.push({ ...key, presence, originalText, normalizedValue: originalText === 'true', sourceLocator });
    } else {
      try { facts.push({ ...key, presence, originalText, normalizedValue: rationalToDTO(parseDecimal(originalText)), sourceLocator }); }
      catch (error) { if (error instanceof DecimalInputError) return invalid(error.code, sourceLocator); throw error; }
    }
  }
  return { contexts, coordinates, facts, diagnostics: [] };
}
