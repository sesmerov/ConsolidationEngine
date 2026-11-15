import { UUID_PATTERN } from '@ce/contracts';
import type { ApplicationBundle, ApplyChangeDTO, ApplyReceiptDTO, ExportUnavailableReason, JsonValue, ReportSourceBinding, Snapshot, SourceFile } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalStringify } from '../session/canonical-state.js';
import { jsonBytes } from './bounded-json.js';
import { writeIncrementalWorkbook, type WrittenFile } from './bounded-files.js';
import { validXmlText } from '../import/ooxml-text.js';
import { bindingRows } from './binding-rows.js';

export interface ReportManifestEntry { readonly entryName: string; readonly sourceFileId: string; readonly contextIds: readonly string[]; readonly size: number; readonly sha256: string; readonly expandedBytes: number }
export interface ChangeLogData {
  readonly reportSourceBindings?: readonly ReportSourceBinding[];
  readonly versionId: string; readonly contentHash: string; readonly profileId: string; readonly policyId: string; readonly synthetic: boolean;
  readonly sources: readonly SourceFile[]; readonly reports: readonly ReportManifestEntry[]; readonly receipts: readonly ApplyReceiptDTO[]; readonly changes: readonly ApplyChangeDTO[];
}
/** Lineage verification needs source identities, never ancestor catalogs, coordinates or facts. */
export interface ReportHistoryVersion {
  readonly versionId: string; readonly parentVersionId?: string;
  readonly content: { readonly sources: readonly Pick<SourceFile, 'id' | 'kind'>[] };
}
export interface ReportExportHistory { readonly snapshot: (versionId: string) => ReportHistoryVersion; readonly applications: readonly ApplicationBundle[] }
export const unavailable = (reason: ExportUnavailableReason): never => { throw new ApiError('EXPORT_NOT_AVAILABLE', { reason }); };
/** Imports allocate new source IDs; configuration and application retain them unchanged. */
export function sourceSignature(sources: readonly Pick<SourceFile, 'id' | 'kind'>[]): string {
  if (!sources.length || sources.filter(source => source.kind === 'catalog').length !== 1 || sources.filter(source => source.kind === 'report').length < 1
    || sources.filter(source => source.kind === 'report').length > 20 || new Set(sources.map(source => source.id)).size !== sources.length
    || sources.some(source => !UUID_PATTERN.test(source.id) || source.kind !== 'catalog' && source.kind !== 'report')) return unavailable('INVALID_REPORT_SOURCE');
  return canonicalStringify(sources.map(source => [source.kind, source.id]).sort((a, b) => a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : a[1]! < b[1]! ? -1 : a[1]! > b[1]! ? 1 : 0));
}
export function collectApplicationHistory(target: Snapshot, history: ReportExportHistory, check: () => void): Pick<ChangeLogData, 'receipts' | 'changes'> {
  const signature = sourceSignature(target.content.sources), chain: ReportHistoryVersion[] = [], visited = new Set<string>(); let current: ReportHistoryVersion | undefined = target;
  while (current) {
    check(); if (visited.has(current.versionId) || visited.size >= 20) return unavailable('INCOMPLETE_VERSION_HISTORY'); visited.add(current.versionId);
    if (sourceSignature(current.content.sources) !== signature) break;
    chain.push(current); const parent: string | undefined = current.parentVersionId;
    if (!parent) break;
    try { current = history.snapshot(parent); } catch (error) { if (error instanceof ApiError && error.code === 'RESOURCE_NOT_FOUND') return unavailable('INCOMPLETE_VERSION_HISTORY'); throw error; }
    if (!current || current.versionId !== parent) return unavailable('INCOMPLETE_VERSION_HISTORY');
  }
  const versions = new Set(chain.map(snapshot => snapshot.versionId)), byVersion = new Map<string, ApplicationBundle>(), receipts: ApplyReceiptDTO[] = [], changes: ApplyChangeDTO[] = [];
  for (const bundle of history.applications) {
    check(); if (!versions.has(bundle.receipt.newVersionId)) continue;
    if (byVersion.has(bundle.receipt.newVersionId)) return unavailable('INCOMPLETE_VERSION_HISTORY'); byVersion.set(bundle.receipt.newVersionId, bundle);
  }
  for (const snapshot of chain.reverse()) {
    check(); const bundle = byVersion.get(snapshot.versionId); if (!bundle) continue;
    if (bundle.receipt.baseVersionId !== snapshot.parentVersionId || !bundle.receipt.acceptedIds.length || new Set(bundle.receipt.acceptedIds).size !== bundle.receipt.acceptedIds.length
      || bundle.changes.length !== bundle.receipt.acceptedIds.length || new Set(bundle.changes.map(change => change.proposalId)).size !== bundle.changes.length
      || bundle.changes.some(change => change.receiptId !== bundle.receipt.id || !bundle.receipt.acceptedIds.includes(change.proposalId) || typeof change.changed !== 'boolean')) return unavailable('INCOMPLETE_VERSION_HISTORY');
    receipts.push(bundle.receipt); changes.push(...bundle.changes);
  }
  const byReceipt = new Map(receipts.map(receipt => [receipt.id, receipt]));
  if (byReceipt.size !== receipts.length) return unavailable('INCOMPLETE_VERSION_HISTORY');
  const byChange = new Map(changes.map(change => [JSON.stringify([change.receiptId, change.proposalId]), change]));
  for (const fact of target.content.facts) if (fact.derivation) {
    check(); const derivation = fact.derivation, receipt = byReceipt.get(derivation.receiptId), change = byChange.get(JSON.stringify([derivation.receiptId, derivation.proposalId]));
    if (!receipt || !change || !change.changed || receipt.previewId !== derivation.previewId || receipt.baseVersionId !== derivation.baseVersionId || change.targetKey !== fact.factKey
      || fact.presence !== 'value' || fact.originalText !== change.after.originalText || canonicalStringify(fact.normalizedValue) !== canonicalStringify(change.after.normalizedValue)) return unavailable('INCOMPLETE_VERSION_HISTORY');
  }
  return { receipts, changes };
}

interface SheetRow { readonly sheet: string; readonly values: readonly string[] }
function* spreadsheetRows(data: ChangeLogData): Generator<SheetRow> {
  const row = (sheet: string, ...values: string[]): SheetRow => ({ sheet, values });
  yield row('Summary', 'Concepto', 'Valor');
  for (const [key, value] of Object.entries({ versionId: data.versionId, contentHash: data.contentHash, profileId: data.profileId, policyId: data.policyId, synthetic: String(data.synthetic),
    applications: String(data.receipts.length), accepted: String(data.changes.length), changed: String(data.changes.filter(change => change.changed).length),
    notice: 'Vista literal del registro de cambios; no es un fichero oficial de remisión.' })) yield row('Summary', key, value);
  yield row('Reports', 'entryName', 'sourceFileId', 'size', 'sha256', 'expandedBytes');
  yield* bindingRows(data.reportSourceBindings);
  yield row('ReportContexts', 'sourceFileId', 'contextId');
  for (const report of data.reports) { yield row('Reports', report.entryName, report.sourceFileId, String(report.size), report.sha256, String(report.expandedBytes)); for (const contextId of report.contextIds) yield row('ReportContexts', report.sourceFileId, contextId); }
  yield row('OriginalSources', 'fileId', 'displayName', 'kind', 'size', 'expandedBytes', 'sha256');
  for (const source of data.sources) yield row('OriginalSources', source.id, source.displayName, source.kind, String(source.size), String(source.expandedBytes ?? ''), source.sha256);
  yield row('Receipts', 'id', 'previewId', 'baseVersionId', 'newVersionId', 'beforeValidationRunId', 'validationRunId', 'closureHash', 'appliedAt');
  yield row('Accepted', 'receiptId', 'proposalId');
  for (const receipt of data.receipts) { yield row('Receipts', receipt.id, receipt.previewId, receipt.baseVersionId, receipt.newVersionId, receipt.beforeValidationRunId, receipt.validationRunId, receipt.closureHash, receipt.appliedAt); for (const id of receipt.acceptedIds) yield row('Accepted', receipt.id, id); }
  yield row('Changes', 'receiptId', 'proposalId', 'changed', 'code', 'directionId', 'instanceId', 'targetKey', 'contextId', 'table', 'sheet', 'row', 'column', 'beforePresence', 'beforeText', 'afterText', 'afterNumerator', 'afterDenominator', 'afterBoolean', 'unit', 'decimals', 'exactNumerator', 'exactDenominator', 'loNumerator', 'loDenominator', 'hiNumerator', 'hiDenominator', 'policyId');
  yield row('Dependencies', 'proposalId', 'kind', 'id'); yield row('Sources', 'proposalId', 'fileId', 'sheet', 'row', 'column');
  yield row('Metadata', 'proposalId', 'contextId', 'code', 'presence', 'value', 'fileId', 'sheet', 'row', 'column');
  for (const change of data.changes) {
    const coordinate = change.before.coordinate, after = change.after, value = after.normalizedValue;
    yield row('Changes', change.receiptId, change.proposalId, String(change.changed), change.code, change.directionId, change.instanceId, change.targetKey, coordinate.contextId, coordinate.tableCode, coordinate.sheetCode, coordinate.rowCode, coordinate.columnCode,
      change.before.presence, change.before.originalText ?? '', after.originalText, typeof value === 'object' ? value.numerator : '', typeof value === 'object' ? value.denominator : '', typeof value === 'boolean' ? String(value) : '',
      'unit' in after ? after.unit : '', 'decimals' in after ? after.decimals : '', change.exactNominal?.numerator ?? '', change.exactNominal?.denominator ?? '', change.derivedInterval?.lo.numerator ?? '', change.derivedInterval?.lo.denominator ?? '', change.derivedInterval?.hi.numerator ?? '', change.derivedInterval?.hi.denominator ?? '', change.policyId ?? '');
    for (const id of change.variantIds) yield row('Dependencies', change.proposalId, 'variant', id);
    for (const id of change.readKeys) yield row('Dependencies', change.proposalId, 'read', id);
    for (const id of change.predecessorIds) yield row('Dependencies', change.proposalId, 'predecessor', id);
    for (const source of change.sources) yield row('Sources', change.proposalId, source.fileId ?? '', source.sheet ?? '', String(source.row ?? ''), source.column ?? '');
    for (const read of change.metadataReads) yield row('Metadata', change.proposalId, read.contextId, read.code, read.presence, read.value === undefined ? '' : String(read.value), read.sourceLocator?.fileId ?? '', read.sourceLocator?.sheet ?? '', String(read.sourceLocator?.row ?? ''), read.sourceLocator?.column ?? '');
  }
}
export function checkChangeLog(data: ChangeLogData, limits: { maxContentBytes: number; maxTotalBytes: number; maxXmlWorkloadBytes: number }, check: () => void): number {
  const size = jsonBytes(data as unknown as JsonValue, Math.min(limits.maxContentBytes, limits.maxTotalBytes), check), rows = new Map<string, number>(); let workload = 64 * 1024;
  for (const row of spreadsheetRows(data)) {
    check(); const count = (rows.get(row.sheet) ?? 0) + 1; rows.set(row.sheet, count); if (count > 1_048_576) throw new ApiError('EXPORT_LIMIT'); workload += 128;
    for (const value of row.values) { if (value.length > 32_767) throw new ApiError('EXPORT_LIMIT'); if (!validXmlText(value)) unavailable('INVALID_REPORT_SOURCE'); workload += 128 + 6 * Buffer.byteLength(value); }
    if (workload > limits.maxXmlWorkloadBytes) throw new ApiError('EXPORT_LIMIT', { reason: 'XML_WORKLOAD_LIMIT' });
  }
  return size;
}
export async function writeChangeLogXlsx(data: ChangeLogData, location: string, maximum: number, check: () => void): Promise<WrittenFile> {
  const names = new Set<string>(); for (const row of spreadsheetRows(data)) { check(); names.add(row.sheet); }
  function* rows(name: string): Generator<readonly string[]> { for (const row of spreadsheetRows(data)) { check(); if (row.sheet === name) yield row.values; } }
  return writeIncrementalWorkbook(location, [...names].map(name => ({ name, rows: rows(name) })), maximum, { expandedBytes: 0 }, 64 * 1024 * 1024, check);
}
