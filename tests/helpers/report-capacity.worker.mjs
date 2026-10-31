// Synthetic capacity probe: generates business DTOs in a real 256 MiB worker, never a regulatory benchmark.
import { parentPort, workerData } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { importWorkspace } from '../../apps/api/dist/import/import-workspace.js';
import { canonicalStringify } from '../../apps/api/dist/session/canonical-state.js';
import { prepareReportExportData, writeReportExport, REPORT_EXPORT_LIMITS } from '../../apps/api/dist/export/recalculated-report.js';
const started = performance.now();
const files = await Promise.all([['eba-subset.xlsx', 'catalog'], ['report-42.xlsx', 'report']].map(async ([name, kind]) => {
  const location = path.resolve('tests/fixtures/generated', name), bytes = await readFile(location);
  return { id: randomUUID(), path: location, kind, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), displayName: name, importedAt: '2026-10-31T00:00:00.000Z' };
}));
const content = await importWorkspace(files, { cancelled: () => false, progress: () => {} });
const context = content.contexts[0], source = content.sources.find(source => source.kind === 'report'), coordinates = [], facts = [];
for (let index = 0; index < 100_000; index++) {
  const rowCode = String(index).padStart(6, '0'), factKey = canonicalStringify([context.canonicalContextKey, 'C_01.00', '', rowCode, '0010']);
  const identity = { factKey, contextId: context.contextId, tableCode: 'C_01.00', sheetCode: '', rowCode, columnCode: '0010' };
  coordinates.push({ ...identity, dataType: 'number', unit: 'EUR', decimals: '2', axes: {}, sourceLocator: { fileId: source.id, sheet: 'Coordinates', row: index + 2, column: 'A' } });
  facts.push({ ...identity, presence: 'value', originalText: '1.00', normalizedValue: { numerator: '1', denominator: '1' }, sourceLocator: { fileId: source.id, sheet: 'Facts', row: index + 2, column: 'G' } });
}
const snapshot = { versionId: randomUUID(), contentHash: 'c'.repeat(64), createdAt: '2026-10-31T00:00:00.000Z', content: { ...content, coordinates, facts } };
const data = prepareReportExportData(snapshot, { snapshot: () => { throw new Error('No ancestors'); }, applications: [] });
const outputs = { reports: [path.join(workerData.directory, 'capacity.xlsx')], json: path.join(workerData.directory, 'changes.json'), xlsx: path.join(workerData.directory, 'changes.xlsx'), zip: path.join(workerData.directory, 'report.zip') };
for (const location of [...outputs.reports, outputs.json, outputs.xlsx, outputs.zip]) await writeFile(location, '', { flag: 'wx' });
let peakHeap = process.memoryUsage().heapUsed;
const artifact = await writeReportExport(data, outputs, REPORT_EXPORT_LIMITS, () => { peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed); }, () => {});
const log = JSON.parse(await readFile(outputs.json, 'utf8'));
parentPort.postMessage({ artifact, reports: log.reports, catalog: content.sources.find(source => source.kind === 'catalog'), elapsedMs: Math.round(performance.now() - started), peakHeap, heapLimitMb: 256, directory: workerData.directory });
