import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImportContextInputDTO, Snapshot, SnapshotContent } from '@ce/contracts';
import { ApiError } from '../../apps/api/src/errors.js';
import { inspectWorkspace, importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { StagedFile } from '../../apps/api/src/import/multipart-staging.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { prepareReportExportData, reportExportLimits, writeReportExport, type ReportExportLimits, type ReportExportPaths } from '../../apps/api/src/export/recalculated-report.js';
import type { ReportExportHistory } from '../../apps/api/src/export/change-log.js';
import { zipBytes, type ZipPart } from './xlsx-fixtures.js';

const roots: string[] = [];
export const visualStartedAt = '2026-11-04T00:00:00.000Z';
export const visualOperation = { cancelled: () => false, progress: () => {} } as unknown as OperationContext;
export const visualHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export const emptyVisualHistory: ReportExportHistory = { applications: [], snapshot: () => { throw new ApiError('RESOURCE_NOT_FOUND'); } };
export async function cleanupVisualExports(): Promise<void> {
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve('.cache'), path.resolve(root));
    if (!relative.startsWith('visual-export-') || relative.includes(path.sep) || path.isAbsolute(relative)) throw new Error('Unsafe visual export cleanup');
    await rm(root, { recursive: true, force: true });
  }
}
export async function visualDirectory(): Promise<string> {
  await mkdir('.cache', { recursive: true }); const root = await mkdtemp(path.resolve('.cache/visual-export-')); roots.push(root); return root;
}
export async function visualStaged(location: string, kind: 'catalog' | 'report'): Promise<StagedFile> {
  const bytes = await readFile(location); return { id: randomUUID(), path: location, kind, sha256: visualHash(bytes), size: bytes.length, importedAt: visualStartedAt, displayName: path.basename(location) };
}
export async function visualFile(parts: readonly ZipPart[], name = 'source.xlsx'): Promise<StagedFile> {
  const location = path.join(await visualDirectory(), name); await writeFile(location, zipBytes(parts)); return visualStaged(location, 'report');
}
export function visualSnapshot(content: SnapshotContent): Snapshot { return { versionId: randomUUID(), contentHash: canonicalHash(content), createdAt: visualStartedAt, content }; }
export async function importVisual(report: StagedFile, kind: 'corep' | 'types' | 'finrep', declaration: ImportContextInputDTO = { source: 'workbook' }) {
  const catalog = await visualStaged(path.resolve(`assets/demos/demo-${kind}-catalog.xlsx`), 'catalog');
  const candidate = await inspectWorkspace([catalog, report], visualOperation, declaration);
  return { snapshot: visualSnapshot(candidate.content), files: [catalog, report], candidate };
}
export async function visualDemo(kind: 'corep' | 'types' | 'finrep') { return importVisual(await visualStaged(path.resolve(`assets/demos/demo-${kind}-report.xlsx`), 'report'), kind); }
export async function visualLegacy() {
  const files = await Promise.all([visualStaged(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), 'catalog'), visualStaged(path.resolve('tests/fixtures/generated/report-42.xlsx'), 'report')]);
  return { files, snapshot: visualSnapshot(await importWorkspace(files, visualOperation)) };
}
export async function visualOutput(count = 1): Promise<ReportExportPaths> {
  const root = await visualDirectory(), paths = { reports: Array.from({ length: count }, (_, index) => path.join(root, `report-${index}.xlsx`)), json: path.join(root, 'changes.json'), xlsx: path.join(root, 'changes.xlsx'), zip: path.join(root, 'package.zip') };
  await Promise.all([...paths.reports, paths.json, paths.xlsx, paths.zip].map(location => writeFile(location, '', { flag: 'wx' }))); return paths;
}
export async function exportVisual(snapshot: Snapshot, history = emptyVisualHistory, limits: Partial<ReportExportLimits> = {}) {
  const bounded = reportExportLimits(limits), data = prepareReportExportData(snapshot, history, bounded), paths = await visualOutput(data.partitions.length);
  const artifact = await writeReportExport(data, paths, bounded, () => {}, () => {});
  return { data, paths, artifact, log: JSON.parse(await readFile(paths.json, 'utf8')) };
}
export async function reimportVisual(catalog: StagedFile, paths: readonly string[], legacy = false): Promise<SnapshotContent> {
  const files = [await visualStaged(catalog.path, 'catalog'), ...await Promise.all(paths.map(location => visualStaged(location, 'report')))];
  return legacy ? importWorkspace(files, visualOperation) : (await inspectWorkspace(files, visualOperation, { source: 'workbook' })).content;
}
/** Export changes representation and source IDs, but never business type, presence, context or exact normalized value. */
export function visualBusiness(content: SnapshotContent) {
  return { contexts: content.contexts.map(({ filingIndicatorsLocator: _locator, ...context }) => context).sort((a, b) => a.contextId.localeCompare(b.contextId)),
    coordinates: content.coordinates.map(({ sourceLocator: _locator, ...coordinate }) => coordinate).sort((a, b) => a.factKey.localeCompare(b.factKey)),
    facts: content.facts.map(({ sourceLocator: _locator, derivation: _history, originalText, ...fact }) => ({ ...fact, ...(typeof fact.normalizedValue === 'object' && 'kind' in fact.normalizedValue && fact.normalizedValue.kind === 'text' ? { originalText } : {}) })).sort((a, b) => a.factKey.localeCompare(b.factKey)) };
}
