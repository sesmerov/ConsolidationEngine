import { CONTEXT_HEADERS, COORDINATE_HEADERS, FACT_HEADERS, LANGUAGE_PROFILE_V1, LANGUAGE_PROFILE_V2, RECALCULATION_POLICY_ID, REPORT_TEMPLATE_VERSION } from '@ce/contracts';
import type { Coordinate, JsonValue, ReportContext, ReportedFact, ReportSourceBinding, Snapshot, SourceFile } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalStringify } from '../session/canonical-state.js';
import { jsonBuffers, writeChunks, writeIncrementalWorkbook, writeStoredZip, type StoredZipEntry } from './bounded-files.js';
import { checkChangeLog, collectApplicationHistory, sourceSignature, unavailable, writeChangeLogXlsx } from './change-log.js';
import type { ChangeLogData, ReportExportHistory, ReportManifestEntry } from './change-log.js';
import { reportOwnership } from './report-ownership.js';
import { writeCorepReport } from './corep-report.js';
import { writeTypedReport } from './typed-report.js';
import { writeFinrepReport } from './finrep-report.js';
import type { RetainedReportSource } from './finrep-report.js';

export const REPORT_EXPORT_LIMITS = Object.freeze({ maxContentBytes: 64 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024,
  maxXmlWorkloadBytes: 64 * 1024 * 1024, maxReportBytes: 10 * 1024 * 1024, maxImportBatchBytes: 50 * 1024 * 1024, maxExpandedBytes: 100 * 1024 * 1024 });
export type ReportExportLimits = { readonly [K in keyof typeof REPORT_EXPORT_LIMITS]: number };
export function reportExportLimits(overrides: Partial<ReportExportLimits> = {}): ReportExportLimits {
  const limits = { ...REPORT_EXPORT_LIMITS, ...overrides };
  for (const key of Object.keys(limits) as (keyof ReportExportLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > REPORT_EXPORT_LIMITS[key]) throw new ApiError('INTERNAL_ERROR');
  return limits;
}
export interface ReportPartition {
  readonly binding?: ReportSourceBinding;
  readonly entryName: string; readonly sourceFileId: string; readonly contextIds: readonly string[];
  readonly contexts: readonly ReportContext[]; readonly coordinates: readonly Coordinate[]; readonly facts: readonly ReportedFact[];
}
export interface ReportExportData extends Omit<ChangeLogData, 'reports'> { readonly partitions: readonly ReportPartition[] }
export interface ReportExportPaths { readonly reports: readonly string[]; readonly json: string; readonly xlsx: string; readonly zip: string }
const ordinal = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function catalogSource(sources: readonly SourceFile[]): SourceFile & { readonly expandedBytes: number } {
  sourceSignature(sources);
  if (sources.some(source => !Number.isSafeInteger(source.expandedBytes) || source.expandedBytes! <= 0 || source.expandedBytes! > REPORT_EXPORT_LIMITS.maxExpandedBytes)) return unavailable('MISSING_IMPORT_STATS');
  if (sources.some(source => !Number.isSafeInteger(source.size) || source.size <= 0 || source.size > REPORT_EXPORT_LIMITS.maxReportBytes)) return unavailable('INVALID_REPORT_SOURCE');
  return sources.find(source => source.kind === 'catalog')! as SourceFile & { readonly expandedBytes: number };
}
/** Projects the requested version and its lineage before Worker structuredClone; contains no AST/catalog. */
export function prepareReportExportData(target: Snapshot, history: ReportExportHistory, limits: ReportExportLimits = REPORT_EXPORT_LIMITS, check: () => void = () => {}): ReportExportData {
  check(); const catalog = catalogSource(target.content.sources);
  const ownership = reportOwnership(target, check);
  if (catalog.size >= limits.maxImportBatchBytes || catalog.expandedBytes >= limits.maxExpandedBytes) throw new ApiError('EXPORT_LIMIT');
  const contexts = new Map<string, string>(), partitions = new Map<string, { contexts: ReportContext[]; coordinates: Coordinate[]; facts: ReportedFact[] }>();
  for (const source of target.content.sources) if (source.kind === 'report') partitions.set(source.id, { contexts: [], coordinates: [], facts: [] });
  for (const context of target.content.contexts) {
    check(); const fileId = ownership.owners.get(context.contextId);
    if (!fileId || !partitions.has(fileId) || contexts.has(context.contextId)) return unavailable('INVALID_REPORT_SOURCE');
    contexts.set(context.contextId, fileId); partitions.get(fileId)!.contexts.push(context);
  }
  const coordinates = new Map<string, { coordinate: Coordinate; fileId: string }>();
  for (const coordinate of target.content.coordinates) {
    check(); const fileId = contexts.get(coordinate.contextId);
    if (!fileId || coordinate.sourceLocator.fileId !== fileId || coordinates.has(coordinate.factKey)) return unavailable('INVALID_REPORT_SOURCE');
    coordinates.set(coordinate.factKey, { coordinate, fileId }); partitions.get(fileId)!.coordinates.push(coordinate);
  }
  const factKeys = new Set<string>();
  for (const fact of target.content.facts) {
    check(); const fileId = contexts.get(fact.contextId), coordinate = coordinates.get(fact.factKey);
    if (!fileId || !coordinate || coordinate.fileId !== fileId || fact.sourceLocator.fileId !== fileId || factKeys.has(fact.factKey)
      || fact.presence !== 'null' && (fact.presence !== 'value' || fact.originalText === undefined || fact.normalizedValue === undefined)) return unavailable('INVALID_REPORT_SOURCE');
    factKeys.add(fact.factKey); partitions.get(fileId)!.facts.push(fact);
  }
  if (coordinates.size > 100_000 || factKeys.size > 100_000) throw new ApiError('EXPORT_LIMIT');
  const reports: ReportPartition[] = [...partitions].sort(([a], [b]) => ordinal(a, b)).map(([sourceFileId, partition], index) => {
    if (!partition.contexts.length) return unavailable('INVALID_REPORT_SOURCE'); if (partition.contexts.length > 200_000) throw new ApiError('EXPORT_LIMIT');
    partition.contexts.sort((a, b) => ordinal(a.contextId, b.contextId)); partition.coordinates.sort((a, b) => ordinal(a.factKey, b.factKey)); partition.facts.sort((a, b) => ordinal(a.factKey, b.factKey));
    const binding = ownership.bindings.get(sourceFileId);
    return { entryName: `reports/report-${String(index + 1).padStart(3, '0')}.xlsx`, sourceFileId, contextIds: partition.contexts.map(context => context.contextId), ...partition, ...(binding ? { binding } : {}) };
  });
  const application = collectApplicationHistory(target, history, check);
  const data: ReportExportData = { versionId: target.versionId, contentHash: target.contentHash, profileId: target.content.profileId, policyId: RECALCULATION_POLICY_ID,
    synthetic: target.content.contexts.some(context => context.entityId === 'SYNTHETIC'), sources: target.content.sources, partitions: reports,
    ...(target.content.reportSourceBindings ? { reportSourceBindings: target.content.reportSourceBindings } : {}), ...application };
  // Upper-bound only the tiny measured manifest fields; the final log is checked again after writing reports.
  const manifest = reports.map(report => ({ entryName: report.entryName, sourceFileId: report.sourceFileId, contextIds: report.contextIds,
    size: limits.maxReportBytes, sha256: '0'.repeat(64), expandedBytes: limits.maxExpandedBytes }));
  const { partitions: _partitions, ...base } = data; checkChangeLog({ ...base, reports: manifest }, limits, check);
  return data;
}
function reportSheets(partition: ReportPartition, data: ReportExportData) {
  function* contexts(): Generator<readonly string[]> {
    yield CONTEXT_HEADERS;
    for (const context of partition.contexts) yield [REPORT_TEMPLATE_VERSION, context.contextId, context.entityId, context.referenceDate, context.submissionDate ?? '', context.framework, context.moduleVersion, canonicalStringify(context.filingIndicators)];
  }
  function* coordinates(): Generator<readonly string[]> {
    yield COORDINATE_HEADERS;
    for (const coordinate of partition.coordinates) yield [coordinate.contextId, coordinate.tableCode, coordinate.sheetCode, coordinate.rowCode, coordinate.columnCode, coordinate.dataType, coordinate.unit, coordinate.decimals, canonicalStringify(coordinate.axes)];
  }
  function* facts(): Generator<readonly string[]> {
    yield FACT_HEADERS;
    for (const fact of partition.facts) yield [fact.contextId, fact.tableCode, fact.sheetCode, fact.rowCode, fact.columnCode, fact.presence, fact.presence === 'value' ? fact.originalText! : ''];
  }
  return [{ name: 'Instructions', rows: [
    ['Plantilla', REPORT_TEMPLATE_VERSION], ['Perfil', data.profileId], ['Versión', data.versionId], ['Datos sintéticos', String(data.synthetic)],
    ['Aviso', 'Informe literal para reimportación en ConsolidationEngine; no es un fichero oficial de remisión.'],
  ] }, { name: 'Contexts', rows: contexts() }, { name: 'Coordinates', rows: coordinates() }, { name: 'Facts', rows: facts() }];
}
/** The worker writes the reports first so changes.json describes measured, final XLSX artifacts. */
export async function writeReportExport(data: ReportExportData, paths: ReportExportPaths, limits: ReportExportLimits, check: () => void, progress: (completed: number, total: number) => void,originalReports:readonly RetainedReportSource[]=[]): Promise<{ size: number; sha256: string }> {
  const catalog = catalogSource(data.sources); check();
  if (paths.reports.length !== data.partitions.length || !paths.reports.length || new Set([...paths.reports, paths.json, paths.xlsx, paths.zip]).size !== paths.reports.length + 3) throw new ApiError('INTERNAL_ERROR');
  const expansion = { expandedBytes: catalog.expandedBytes }, manifest: ReportManifestEntry[] = [], entries: StoredZipEntry[] = [];
  let compressedBatch = catalog.size, contentBytes = 0, completed = 0; const total = data.partitions.length + 3;
  for (const [index, report] of data.partitions.entries()) {
    check(); const maximum = Math.min(limits.maxReportBytes, limits.maxImportBatchBytes - compressedBatch, limits.maxTotalBytes - contentBytes);
    if (maximum <= 0) throw new ApiError('EXPORT_LIMIT');
    const output = data.profileId === LANGUAGE_PROFILE_V1 && !report.binding
      ? await writeIncrementalWorkbook(paths.reports[index]!, reportSheets(report, data), maximum, expansion, limits.maxExpandedBytes, check)
      : data.profileId === LANGUAGE_PROFILE_V2 && report.binding?.profileId === 'eba-corep-of-4.0-ca1-v1'
        ? await writeCorepReport(paths.reports[index]!, { ...report, binding: report.binding }, data, maximum, expansion, limits.maxExpandedBytes, check)
        : data.profileId === LANGUAGE_PROFILE_V2 && report.binding?.profileId === 'ce-demo-types-1'
          ? await writeTypedReport(paths.reports[index]!, { ...report, binding: report.binding }, data, maximum, expansion, limits.maxExpandedBytes, check)
          : data.profileId===LANGUAGE_PROFILE_V2 && report.binding?.profileId==='eba-finrep-4.0-f0101-v1'
            ? await writeFinrepReport(paths.reports[index]!,{...report,binding:report.binding},data,originalReports.find(source=>source.id===report.sourceFileId)!,maximum,expansion,limits.maxExpandedBytes,check)
          : unavailable('INVALID_REPORT_SOURCE');
    compressedBatch += output.size; contentBytes += output.size;
    manifest.push({ entryName: report.entryName, sourceFileId: report.sourceFileId, contextIds: report.contextIds, size: output.size, sha256: output.sha256, expandedBytes: output.expandedBytes });
    entries.push({ name: report.entryName, path: paths.reports[index]!, ...output }); progress(++completed, total);
  }
  const { partitions: _partitions, ...base } = data, log: ChangeLogData = { ...base, reports: manifest };
  checkChangeLog(log, limits, check);
  const json = await writeChunks(paths.json, jsonBuffers(log as unknown as JsonValue), Math.min(limits.maxContentBytes, limits.maxTotalBytes - contentBytes), check);
  contentBytes += json.size; entries.push({ name: 'changes.json', path: paths.json, ...json }); progress(++completed, total);
  const xlsx = await writeChangeLogXlsx(log, paths.xlsx, Math.min(limits.maxContentBytes, limits.maxTotalBytes - contentBytes), check);
  contentBytes += xlsx.size; entries.push({ name: 'changes.xlsx', path: paths.xlsx, ...xlsx }); progress(++completed, total);
  if (contentBytes > limits.maxTotalBytes) throw new ApiError('EXPORT_LIMIT');
  const zip = await writeStoredZip(paths.zip, entries, limits.maxTotalBytes, check); progress(++completed, total);
  return { size: zip.size, sha256: zip.sha256 };
}
