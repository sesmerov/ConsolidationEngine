import { randomUUID } from 'node:crypto';
import { EBA_HEADERS } from '@ce/contracts';
import type { Diagnostic, JsonObject, JsonValue, RawRuleRecord, ReportContext, RuleVariant, Severity, SourceFile, SourceLocator } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { RawWorkbook, WorkbookSheet } from './xlsx-reader.js';
import type { RawCell } from './xlsx-preflight.js';
import { excelDate } from './excel-dates.js';
export interface ImportedCatalog { readonly records: readonly RawRuleRecord[]; readonly variants: readonly RuleVariant[] }
function columnName(value: number): string { let result = ''; while (value > 0) { value--; result = String.fromCharCode(65 + value % 26) + result; value = Math.floor(value / 26); } return result; }
const isText = (cell: RawCell | undefined) => cell !== undefined && ['s', 'inlineStr', 'str'].includes(cell.xmlType);
export function importCatalog(workbook: RawWorkbook, source: SourceFile): ImportedCatalog {
  const candidates: { sheet: WorkbookSheet; columns: Map<string, number> }[] = [];
  for (const sheet of workbook.sheets) {
    const columns = new Map<string, number>(); const duplicates = new Set<string>();
    for (const cell of Object.values(sheet.cells).filter((value) => value.row === 1)) {
      if (!isText(cell) || cell.text === '') continue;
      if (columns.has(cell.text)) duplicates.add(cell.text); columns.set(cell.text, cell.column);
    }
    if (EBA_HEADERS.every((name) => columns.has(name))) { if (duplicates.size || sheet.merged) throw new ApiError('INVALID_WORKBOOK'); candidates.push({ sheet, columns }); }
  }
  if (candidates.length !== 1) throw new ApiError('INVALID_WORKBOOK'); const { sheet, columns } = candidates[0]!;
  const records: RawRuleRecord[] = []; const variants = new Map<string, RuleVariant>();
  for (let row = 2; row <= sheet.maxRow; row++) {
    const rowCells = Array.from({ length: sheet.maxColumn }, (_, i) => sheet.cells[columnName(i + 1) + row]);
    if (!rowCells.some((cell) => cell && cell.text !== '')) continue;
    if (records.length >= 500) throw new ApiError('EXPANSION_LIMIT');
    const id = randomUUID(); const locator: SourceLocator = { fileId: source.id, sheet: sheet.name, row }; const diagnostics: Diagnostic[] = [];
    const originalFields = Object.create(null) as Record<string, JsonValue>;
    for (let column = 1; column <= sheet.maxColumn; column++) {
      const header = sheet.cells[columnName(column) + '1']?.text || 'column:' + columnName(column); const raw = sheet.cells[columnName(column) + row];
      originalFields[header] = raw ? { value: raw.text, xmlType: raw.xmlType, lexeme: raw.lexeme, column: columnName(column), ...(raw.style ? { style: raw.style } : {}) } : null;
    }
    const cell = (name: string) => sheet.cells[columnName(columns.get(name)!) + row];
    const locate = (name: string): SourceLocator => ({ ...locator, column: columnName(columns.get(name)!) });
    function text(name: string, required = true): string {
      const value = cell(name); if ((!value || value.text === '') && !required) return '';
      if (!isText(value) || (required && !value!.text.trim())) throw new ApiError('INVALID_WORKBOOK'); return value!.text;
    }
    function parsed<T>(name: string, operation: () => T): T | undefined {
      try { return operation(); } catch { diagnostics.push({ code: name.includes('Date') ? 'INVALID_RULE_DATE' : 'INVALID_RULE_METADATA', message: 'No se puede interpretar el campo ' + name + ' de esta regla.', locator: locate(name), severity: 'error' }); return undefined; }
    }
    const code = parsed('VR Code', () => text('VR Code')) ?? '';
    const framework = parsed('Framework', () => text('Framework'));
    const list = (name: string): readonly string[] => { const tokens = text(name).split(',').map((value) => value.trim()); if (tokens.some((value) => !value)) throw new ApiError('INVALID_WORKBOOK'); return [...new Set(tokens)].sort(); };
    const modules = parsed('Modules', () => list('Modules')); const tables = parsed('Tables', () => list('Tables'));
    const expression = parsed('Expression', () => text('Expression'));
    const precondition = parsed('Precondtion', () => { const value = text('Precondtion', false); return value.trim() === '' || value === 'NULL' ? undefined : value; });
    const active = parsed('IsActive', () => { const value = text('IsActive').trim().toLowerCase(); if (!['active', 'inactive'].includes(value)) throw new ApiError('INVALID_WORKBOOK'); return value === 'active'; });
    const crossModule = parsed('Cross module', () => { const value = text('Cross module').trim().toLowerCase(); if (!['yes', 'no'].includes(value)) throw new ApiError('INVALID_WORKBOOK'); return value === 'yes'; });
    const from = parsed('FromReferenceDate', () => excelDate(cell('FromReferenceDate'), workbook.date1904));
    const to = parsed('ToReferenceDate', () => excelDate(cell('ToReferenceDate'), workbook.date1904));
    const submissionFrom = parsed('FromSubmissionDate', () => excelDate(cell('FromSubmissionDate'), workbook.date1904));
    if (from && to && from > to) diagnostics.push({ code: 'INVALID_RULE_DATE', message: 'El inicio de vigencia es posterior al final.', locator: locate('FromReferenceDate'), severity: 'error' });
    const severityOriginal = cell('Severity')?.text ?? ''; const category = severityOriginal.trim().toLowerCase(); const severity: Severity = category === 'error' || category === 'warning' ? category : 'unknown';
    if (severity === 'unknown') diagnostics.push({ code: 'UNKNOWN_SEVERITY', message: 'Se conserva una severidad no reconocida.', locator: locate('Severity'), severity: 'warning' });
    let variantId: string | undefined;
    if (!diagnostics.some((item) => item.severity === 'error') && code && framework && modules && tables && expression && active !== undefined && crossModule !== undefined) {
      const semantic = { code, framework, modules, crossModule, tables, expression, ...(precondition ? { precondition } : {}), active,
        referenceWindow: { ...(from ? { from } : {}), ...(to ? { to } : {}) }, ...(submissionFrom ? { submissionFrom } : {}), severity, ...(severity === 'unknown' ? { unknownSeverity: severityOriginal } : {}) };
      variantId = canonicalHash(semantic); const existing = variants.get(variantId);
      if (existing) {
        variants.set(variantId, { ...existing, sourceRecords: [...existing.sourceRecords, id], sourceLocators: [...existing.sourceLocators, locator] });
        diagnostics.push({ code: 'DUPLICATE_RULE', message: 'Registro equivalente conservado con su procedencia; no duplica la ejecución.', locator, severity: 'info' });
      } else variants.set(variantId, { variantId, code, framework, modules, crossModule, tables, expression, ...(precondition ? { precondition } : {}), active,
        referenceWindow: semantic.referenceWindow, ...(submissionFrom ? { submissionFrom } : {}), severityOriginal, severity, sourceRecords: [id], sourceLocators: [locator] });
    }
    records.push({ id, code, sourceLocator: locator, originalFields: originalFields as JsonObject, diagnostics, ...(variantId ? { variantId } : {}) });
  }
  return { records, variants: [...variants.values()].sort((a, b) => a.code.localeCompare(b.code) || a.variantId.localeCompare(b.variantId)) };
}
export function variantApplicability(variant: RuleVariant, contexts: readonly ReportContext[]): 'applicable' | 'not_applicable' | 'not_evaluable' {
  if (!variant.active) return 'not_applicable';
  const matching = contexts.filter((context) => context.framework === variant.framework && variant.modules.includes(context.moduleVersion)
    && (!variant.referenceWindow.from || context.referenceDate >= variant.referenceWindow.from) && (!variant.referenceWindow.to || context.referenceDate <= variant.referenceWindow.to));
  if (matching.length === 0 || (variant.crossModule && variant.modules.some((module) => !matching.some((context) => context.moduleVersion === module)))) return 'not_applicable';
  if (variant.submissionFrom && matching.some((context) => !context.submissionDate)) return 'not_evaluable';
  if (variant.submissionFrom && matching.every((context) => context.submissionDate! < variant.submissionFrom!)) return 'not_applicable';
  return 'applicable';
}
export function conflictingVariants(variants: readonly RuleVariant[], contexts: readonly ReportContext[]): ReadonlySet<string> {
  const result = new Set<string>();
  const effective = (rule: RuleVariant) => canonicalHash({ expression: rule.expression, precondition: rule.precondition ?? null, tables: rule.tables, crossModule: rule.crossModule, severity: rule.severity });
  for (let i = 0; i < variants.length; i++) for (let j = i + 1; j < variants.length; j++) {
    const left = variants[i]!, right = variants[j]!;
    if (left.code !== right.code || effective(left) === effective(right) || variantApplicability(left, contexts) !== 'applicable' || variantApplicability(right, contexts) !== 'applicable') continue;
    const applies = (rule: RuleVariant, context: ReportContext) => context.framework === rule.framework && rule.modules.includes(context.moduleVersion)
      && (!rule.referenceWindow.from || context.referenceDate >= rule.referenceWindow.from) && (!rule.referenceWindow.to || context.referenceDate <= rule.referenceWindow.to)
      && (!rule.submissionFrom || (context.submissionDate !== undefined && context.submissionDate >= rule.submissionFrom));
    if (contexts.some((context) => applies(left, context) && applies(right, context))) { result.add(left.variantId); result.add(right.variantId); }
  }
  return result;
}
