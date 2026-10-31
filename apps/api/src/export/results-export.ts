import type { CatalogData, JsonValue, ReportContext, SourceFile, ValidationBundle, ValidationValueDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { jsonBytes } from './bounded-json.js';
import { jsonBuffers, writeChunks, writeStoredZip, writeIncrementalWorkbook } from './bounded-files.js';
import { validXmlText } from '../import/ooxml-text.js';
export const EXPORT_LIMITS = { maxContentBytes: 64 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024 } as const;
export interface ExportLimits { readonly maxContentBytes: number; readonly maxTotalBytes: number }
export interface ResultsExportData extends ValidationBundle { readonly profileId: string; readonly versionId: string; readonly contentHash: string; readonly contexts: readonly ReportContext[];
  readonly sources: readonly SourceFile[]; readonly catalog: Pick<CatalogData, 'records' | 'variants' | 'coverage'>; readonly synthetic: boolean }
export interface ExportPaths { readonly json: string; readonly xlsx: string; readonly zip: string }
export function exportLimits(overrides: Partial<ExportLimits> = {}): ExportLimits {
  const limits = { ...EXPORT_LIMITS, ...overrides }; for (const key of Object.keys(limits) as (keyof ExportLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > EXPORT_LIMITS[key]) throw new ApiError('INTERNAL_ERROR'); return limits;
}
type SheetRow = { sheet: string; values: readonly string[] };
function numberText(value: ValidationValueDTO | undefined): string {
  if (!value) return ''; if (value.kind === 'number') return value.nominal.numerator + '/' + value.nominal.denominator + ' [' + value.interval.lo.numerator + '/' + value.interval.lo.denominator + ', ' + value.interval.hi.numerator + '/' + value.interval.hi.denominator + '] ' + value.unit;
  return value.kind === 'boolean' ? String(value.value) : value.presence;
}
function* spreadsheetRows(data: ResultsExportData): Generator<SheetRow> {
  const row = (sheet: string, ...values: string[]): SheetRow => ({ sheet, values });
  yield row('Summary', 'Concepto', 'Valor');
  for (const [key, value] of Object.entries({ profile: data.profileId, version: data.versionId, contentHash: data.contentHash, run: data.run.id, status: data.run.status, synthetic: String(data.synthetic), complete: String(data.run.summary.complete),
    rows: String(data.run.summary.rows), variants: String(data.run.summary.variants), instances: String(data.run.summary.instances), duplicateRows: String(data.run.summary.duplicateRows),
    ...Object.fromEntries(Object.entries(data.run.summary.byStatus).map(([key, value]) => [key, String(value)])),
    policy: 'Racionales exactos; intervalos cerrados conservadores. Vista literal adicional a results.json; no es un fichero oficial de remisión.' })) yield row('Summary', key, value);
  yield row('Results', 'resultId', 'code', 'status', 'severity', 'coverageOnly', 'instanceId', 'expression', 'precondition', 'left', 'right', 'result');
  yield row('Facts', 'resultId', 'contextId', 'table', 'sheet', 'row', 'column', 'presence', 'originalText', 'numerator', 'denominator', 'boolean', 'unit', 'decimals', 'fileId', 'sourceSheet', 'sourceRow', 'sourceColumn');
  yield row('Metadata', 'resultId', 'contextId', 'code', 'presence', 'value', 'fileId', 'sheet', 'row', 'column');
  yield row('Diagnostics', 'resultId', 'code', 'message', 'fileId', 'sheet', 'row', 'column');
  yield row('Sources', 'fileId', 'displayName', 'sha256', 'kind', 'bytes');
  yield row('Provenance', 'resultId', 'kind', 'id');
  for (const source of data.sources) yield row('Sources', source.id, source.displayName, source.sha256, source.kind, String(source.size));
  for (const result of data.results) {
    yield row('Results', result.id, result.code, result.status, result.severity, String(result.coverageOnly), result.instanceId ?? '', result.expression, result.precondition ?? '', numberText(result.values.left), numberText(result.values.right), numberText(result.values.result));
    for (const id of result.variantIds) yield row('Provenance', result.id, 'variant', id); for (const id of result.sourceRecordIds) yield row('Provenance', result.id, 'sourceRecord', id);
    for (const read of result.factReads) { const value = read.normalizedValue, coordinate = read.coordinate, source = read.sourceLocator;
      yield row('Facts', result.id, coordinate.contextId, coordinate.tableCode, coordinate.sheetCode, coordinate.rowCode, coordinate.columnCode, read.presence, read.originalText ?? '',
        typeof value === 'object' ? value.numerator : '', typeof value === 'object' ? value.denominator : '', typeof value === 'boolean' ? String(value) : '', coordinate.unit, coordinate.decimals,
        source.fileId ?? '', source.sheet ?? '', String(source.row ?? ''), source.column ?? ''); }
    for (const read of result.metadataReads) yield row('Metadata', result.id, read.contextId, read.code, read.presence, read.value === undefined ? '' : String(read.value), read.sourceLocator?.fileId ?? '', read.sourceLocator?.sheet ?? '', String(read.sourceLocator?.row ?? ''), read.sourceLocator?.column ?? '');
    for (const diagnostic of result.diagnostics) yield row('Diagnostics', result.id, diagnostic.code, diagnostic.message, diagnostic.locator?.fileId ?? '', diagnostic.locator?.sheet ?? '', String(diagnostic.locator?.row ?? ''), diagnostic.locator?.column ?? '');
  }
  for (const diagnostic of data.run.diagnostics) yield row('Diagnostics', '', diagnostic.code, diagnostic.message, diagnostic.locator?.fileId ?? '', diagnostic.locator?.sheet ?? '', String(diagnostic.locator?.row ?? ''), diagnostic.locator?.column ?? '');
}
export function checkExportData(data: ResultsExportData, limits: ExportLimits, check: () => void = () => {}): number {
  const size = jsonBytes(data as unknown as JsonValue, Math.min(limits.maxContentBytes, limits.maxTotalBytes), check);
  // Preserve the existing conservative XML-work guard even with the incremental writer.
  let xmlBudget = 64 * 1024; const rows = new Map<string, number>();
  for (const row of spreadsheetRows(data)) { check(); const count = (rows.get(row.sheet) ?? 0) + 1; rows.set(row.sheet, count); if (count > 1_048_576) throw new ApiError('EXPORT_LIMIT');
    xmlBudget += 128; for (const value of row.values) { if (value.length > 32_767) throw new ApiError('EXPORT_LIMIT'); if (!validXmlText(value)) throw new ApiError('EXPORT_NOT_AVAILABLE', { reason: 'INVALID_REPORT_SOURCE' }); xmlBudget += 128 + Buffer.byteLength(value, 'utf8') * 6; }
    if (xmlBudget > limits.maxContentBytes) throw new ApiError('EXPORT_LIMIT', { reason: 'XML_WORKLOAD_LIMIT' }); }
  return size;
}
export async function writeResultsExport(data: ResultsExportData, paths: ExportPaths, limits: ExportLimits, check: () => void, progress: (completed: number, total: number) => void): Promise<{ size: number; sha256: string }> {
  checkExportData(data, limits, check);
  const json = await writeChunks(paths.json, jsonBuffers(data as unknown as JsonValue), limits.maxContentBytes, check); progress(1, 3);
  const names = new Set<string>(); for (const row of spreadsheetRows(data)) { check(); names.add(row.sheet); }
  function* rows(name: string): Generator<readonly string[]> { for (const row of spreadsheetRows(data)) { check(); if (row.sheet === name) yield row.values; } }
  const xlsx = await writeIncrementalWorkbook(paths.xlsx, [...names].map(name => ({ name, rows: rows(name) })), Math.min(limits.maxContentBytes, limits.maxTotalBytes - json.size), { expandedBytes: 0 }, limits.maxContentBytes, check);
  progress(2, 3); if (json.size + xlsx.size > limits.maxTotalBytes) throw new ApiError('EXPORT_LIMIT');
  const zip = await writeStoredZip(paths.zip, [{ name: 'results.json', path: paths.json, ...json }, { name: 'results.xlsx', path: paths.xlsx, ...xlsx }], limits.maxTotalBytes, check); progress(3, 3);
  return { size: zip.size, sha256: zip.sha256 };
}
