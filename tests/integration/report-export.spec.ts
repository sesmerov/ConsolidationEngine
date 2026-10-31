import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import readXlsxFile from 'read-excel-file/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotContent } from '@ce/contracts';
import { ApiError } from '../../apps/api/src/errors.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { StagedFile } from '../../apps/api/src/import/multipart-staging.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import { canonicalHash, canonicalStringify } from '../../apps/api/src/session/canonical-state.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { writeIncrementalWorkbook } from '../../apps/api/src/export/bounded-files.js';
import { prepareReportExportData, reportExportLimits, writeReportExport, type ReportExportPaths } from '../../apps/api/src/export/recalculated-report.js';

const directories: string[] = [], date = '2026-10-31T00:00:00.000Z', mib = 1024 * 1024;
const operation = { cancelled: () => false, progress: () => {} } as unknown as OperationContext;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve('.cache'), directory);
    if (!relative.startsWith('report-export-') || relative.includes(path.sep)) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
async function directory() { await mkdir('.cache', { recursive: true }); const value = await mkdtemp(path.resolve('.cache/report-export-')); directories.push(value); return value; }
async function output(count = 1): Promise<ReportExportPaths> {
  const root = await directory(), paths = { reports: Array.from({ length: count }, (_, index) => path.join(root, `report-${index}.xlsx`)), json: path.join(root, 'changes.json'), xlsx: path.join(root, 'changes.xlsx'), zip: path.join(root, 'report.zip') };
  await Promise.all([...paths.reports, paths.json, paths.xlsx, paths.zip].map(location => writeFile(location, '', { flag: 'wx' }))); return paths;
}
async function staged(location: string, kind: 'catalog' | 'report'): Promise<StagedFile> {
  const bytes = await readFile(location); return { id: randomUUID(), path: location, kind, sha256: hash(bytes), size: bytes.length, displayName: path.basename(location), importedAt: date };
}
async function fixture() {
  const files = await Promise.all([staged(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), 'catalog'), staged(path.resolve('tests/fixtures/generated/report-42.xlsx'), 'report')]);
  const content = await importWorkspace(files.map(file => ({ ...file, expandedBytes: 1 })), operation);
  const snapshot: Snapshot = { versionId: randomUUID(), contentHash: canonicalHash(content), content, createdAt: date };
  const history = { snapshot: () => { throw new ApiError('RESOURCE_NOT_FOUND'); }, applications: [] };
  return { files, snapshot, history, data: prepareReportExportData(snapshot, history) };
}
function business(content: Pick<SnapshotContent, 'contexts' | 'coordinates' | 'facts'>) {
  return { contexts: content.contexts.map(({ filingIndicatorsLocator: _source, ...item }) => item).sort((a, b) => a.contextId.localeCompare(b.contextId)),
    coordinates: content.coordinates.map(({ sourceLocator: _source, ...item }) => item).sort((a, b) => a.factKey.localeCompare(b.factKey)),
    facts: content.facts.map(({ sourceLocator: _source, derivation: _session, ...item }) => item).sort((a, b) => a.factKey.localeCompare(b.factKey)) };
}
/** Independent ZIP reader verifies central metadata and CRC against decompressed bytes. */
async function entries(location: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(location, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => error ? reject(error) : resolve(zip)));
  const parts = new Map<string, { bytes: Buffer; expanded: number; method: number }>();
  await new Promise<void>((resolve, reject) => {
    zip.on('end', resolve); zip.on('error', reject);
    zip.on('entry', (entry: yauzl.Entry) => zip.openReadStream(entry, (error, stream) => {
      if (error) return reject(error); const chunks: Buffer[] = [];
      stream!.on('error', reject); stream!.on('data', (chunk: Buffer) => chunks.push(chunk)); stream!.on('end', () => {
        try { const bytes = Buffer.concat(chunks); expect(bytes.length).toBe(entry.uncompressedSize); expect(crc32(bytes)).toBe(entry.crc32); expect(parts.has(entry.fileName)).toBe(false);
          parts.set(entry.fileName, { bytes, expanded: entry.uncompressedSize, method: entry.compressionMethod }); zip.readEntry(); } catch (failure) { reject(failure); }
      });
    })); zip.readEntry();
  }).finally(() => zip.close()); return parts;
}

describe('reimportable report package and bounded incremental OOXML', () => {
  it('records measured expanded bytes instead of trusting the staged metadata', async () => {
    const f = await fixture();
    for (const file of f.files) expect(f.snapshot.content.sources.find(source => source.id === file.id)!.expandedBytes).toBe((await preflightXlsx(file.path)).expandedBytes);
  });
  it('preserves real imported values, missing facts, explicit null, zero, boolean and an empty source partition', async () => {
    const f = await fixture(), original = f.snapshot.content, ctx = original.contexts[0]!, report = original.sources.find(source => source.kind === 'report')!;
    const identity = { factKey: canonicalStringify([ctx.canonicalContextKey, 'C_01.00', '', '0900', '0010']), contextId: ctx.contextId, tableCode: 'C_01.00', sheetCode: '', rowCode: '0900', columnCode: '0010' };
    // Controlled addition exercises the serializer's boolean branch; it does not claim a regulatory application occurred.
    const emptySource = { ...report, id: randomUUID(), displayName: 'empty-context.xlsx' };
    const content = { ...original, sources: [...original.sources, emptySource], contexts: [...original.contexts, { ...ctx, contextId: 'empty_alias', filingIndicatorsLocator: { ...ctx.filingIndicatorsLocator!, fileId: emptySource.id } }],
      coordinates: [...original.coordinates, { ...identity, dataType: 'boolean' as const, unit: '', decimals: '', axes: {}, sourceLocator: { fileId: report.id, sheet: 'Coordinates', row: 99, column: 'A' } }],
      facts: [...original.facts, { ...identity, presence: 'value' as const, originalText: 'true', normalizedValue: true, sourceLocator: { fileId: report.id, sheet: 'Facts', row: 99, column: 'G' } }] };
    const target = { ...f.snapshot, content, contentHash: canonicalHash(content) }, before = canonicalStringify(target), data = prepareReportExportData(target, f.history), paths = await output(2), progress: number[] = [];
    expect(JSON.stringify(data)).not.toMatch(/"(?:ast|analyses|catalog)":/);
    const artifact = await writeReportExport(data, paths, reportExportLimits(), () => {}, completed => progress.push(completed)), zip = await entries(paths.zip);
    expect([...zip.keys()]).toEqual(['reports/report-001.xlsx', 'reports/report-002.xlsx', 'changes.json', 'changes.xlsx']);
    expect(artifact).toEqual({ size: (await stat(paths.zip)).size, sha256: hash(await readFile(paths.zip)) }); expect(progress).toEqual([1, 2, 3, 4, 5]);
    const log = JSON.parse(zip.get('changes.json')!.bytes.toString('utf8')); expect(log.receipts).toEqual([]); expect(log.changes).toEqual([]);
    const reimport = [f.files[0]!];
    for (const [index, report] of log.reports.entries()) {
      const bytes = zip.get(report.entryName)!.bytes, preflight = await preflightXlsx(paths.reports[index]!);
      expect(report).toMatchObject({ size: bytes.length, sha256: hash(bytes), expandedBytes: preflight.expandedBytes });
      const parts = await entries(paths.reports[index]!); expect([...parts.values()].every(part => part.method === 8)).toBe(true);
      expect([...parts.values()].reduce((sum, part) => sum + part.expanded, 0)).toBe(report.expandedBytes);
      for (const part of parts.values()) expect(part.bytes.toString('utf8')).not.toMatch(/<(?:\w+:)?f\b|<hyperlink\b|TargetMode="External"/);
      const independent = await readXlsxFile(paths.reports[index]!, { trim: false, parseNumber: text => text });
      expect(independent.flatMap(sheet => sheet.data.flat()).every(value => value === null || typeof value === 'string')).toBe(true);
      reimport.push(await staged(paths.reports[index]!, 'report'));
    }
    const restored = await importWorkspace(reimport, operation); expect(business(restored)).toEqual(business(content));
    expect(restored.facts.some(fact => fact.originalText === '123456789012345678901234567890.123456789')).toBe(true);
    expect(restored.facts.some(fact => fact.presence === 'null')).toBe(true); expect(restored.facts.some(fact => fact.originalText === '0')).toBe(true);
    expect(restored.coordinates.length).toBeGreaterThan(restored.facts.length); expect(restored.facts.some(fact => fact.normalizedValue === true)).toBe(true);
    expect(canonicalStringify(target)).toBe(before); for (const file of f.files) expect(hash(await readFile(file.path))).toBe(file.sha256);
  });
  it('keeps Unicode, XML characters, edge spaces, CR/LF and literal escape patterns through the real reader', async () => {
    const paths = await output(), values = ['  á😀 &<>  ', 'a\r\nb\nc\td', '_x0041_', '_x005F_x0041_', '_x000D_', '=SUM(1,2)', '�'];
    await writeIncrementalWorkbook(paths.reports[0]!, [{ name: 'Text', rows: [values] }], 10 * mib, { expandedBytes: 0 }, 100 * mib, () => {});
    const preflight = await preflightXlsx(paths.reports[0]!), workbook = await readWorkbook(paths.reports[0]!, preflight);
    expect(Object.values(workbook.sheets[0]!.cells).map(cell => cell.text)).toEqual(values);
    const parts = await entries(paths.reports[0]!), xml = parts.get('xl/worksheets/sheet1.xml')!.bytes.toString('utf8');
    expect(xml).toContain('xml:space="preserve"'); expect(xml).toContain('a_x000D_\nb\nc\td'); expect(xml).toContain('_x005F_x0041_'); expect(xml).toContain('&amp;&lt;&gt;');
    expect(xml).not.toMatch(/<f\b/);
    // This independent library exposes ST_Xstring transport escapes, so compare that representation explicitly.
    const rows = await readXlsxFile(paths.reports[0]!, { trim: false }); expect(rows[0]!.data[0]![2]).toBe('_x005F_x0041_');
  });
  it.each(['\u0000', '\u0001', '\ud800', '\uffff'])('rejects nonrepresentable text %j without publishing an artifact', async value => {
    const paths = await output(); await expect(writeIncrementalWorkbook(paths.reports[0]!, [{ name: 'Text', rows: [[value]] }], 10 * mib, { expandedBytes: 0 }, 100 * mib, () => {})).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE', details: { reason: 'INVALID_REPORT_SOURCE' } });
    expect((await stat(paths.zip)).size).toBe(0);
  });
  it.each([{ maxContentBytes: 10 }, { maxXmlWorkloadBytes: 100 }])('precounts logs before files for %j', async limits => {
    const f = await fixture(), paths = await output(); expect(() => prepareReportExportData(f.snapshot, f.history, reportExportLimits(limits))).toThrowError(expect.objectContaining({ code: 'EXPORT_LIMIT' }));
    for (const location of [...paths.reports, paths.json, paths.xlsx, paths.zip]) expect((await stat(location)).size).toBe(0);
  });
  it.each(['expanded', 'compressed', 'batch', 'package'] as const)('enforces the real %s byte budget and leaves final ZIP unpublished', async kind => {
    const f = await fixture(), paths = await output(), catalog = f.data.sources.find(source => source.kind === 'catalog')!;
    const limits = reportExportLimits(kind === 'expanded' ? { maxExpandedBytes: catalog.expandedBytes! + 100 } : kind === 'compressed' ? { maxReportBytes: 100 } : kind === 'batch' ? { maxImportBatchBytes: catalog.size + 100 } : { maxTotalBytes: 100 });
    await expect(writeReportExport(f.data, paths, limits, () => {}, () => {})).rejects.toMatchObject({ code: 'EXPORT_LIMIT' }); expect((await stat(paths.zip)).size).toBe(0);
    if (kind === 'compressed') expect((await stat(paths.reports[0]!)).size).toBeLessThanOrEqual(100);
  });
  it('observes cancellation after a report and does not finish a package', async () => {
    const f = await fixture(), paths = await output(); let cancelled = false; const marker = new Error('controlled cancellation');
    await expect(writeReportExport(f.data, paths, reportExportLimits(), () => { if (cancelled) throw marker; }, () => { cancelled = true; })).rejects.toBe(marker); expect((await stat(paths.zip)).size).toBe(0);
  });
  it.each(['missing-stats', 'duplicate-source', 'broken-history'] as const)('rejects %s before generating files', async kind => {
    const f = await fixture(); const target = kind === 'broken-history' ? { ...f.snapshot, parentVersionId: randomUUID() } : { ...f.snapshot, content: { ...f.snapshot.content,
      sources: kind === 'duplicate-source' ? [...f.snapshot.content.sources, f.snapshot.content.sources[1]!] : f.snapshot.content.sources.map(({ expandedBytes: _stat, ...source }) => source) } };
    expect(() => prepareReportExportData(target, f.history)).toThrowError(expect.objectContaining({ code: 'EXPORT_NOT_AVAILABLE', statusCode: 409, details: { reason: kind === 'broken-history' ? 'INCOMPLETE_VERSION_HISTORY' : kind === 'missing-stats' ? 'MISSING_IMPORT_STATS' : 'INVALID_REPORT_SOURCE' } }));
  });
  it('writes 100000 coordinates and facts inside an actual worker with a 256 MiB heap limit', async () => {
    const root = await directory();
    const result = await new Promise<{ reports: { size: number; expandedBytes: number }[]; catalog: { size: number; expandedBytes: number }; artifact: { size: number }; heapLimitMb: number; peakHeap: number }>((resolve, reject) => {
      const worker = new Worker(new URL('../helpers/report-capacity.worker.mjs', import.meta.url), { workerData: { directory: root }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
      worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error('Capacity worker exited ' + code)); });
    });
    expect(result.heapLimitMb).toBe(256); expect(result.peakHeap).toBeLessThan(256 * mib); expect(result.reports).toHaveLength(1);
    expect(result.reports[0]!.size).toBeLessThan(10 * mib); expect(result.reports[0]!.size + result.catalog.size).toBeLessThan(50 * mib);
    expect(result.reports[0]!.expandedBytes + result.catalog.expandedBytes).toBeLessThan(100 * mib); expect(result.artifact.size).toBeLessThan(100 * mib);
    const parts = await entries(path.join(root, 'capacity.xlsx'));
    expect([...parts.values()].reduce((sum, part) => sum + part.expanded, 0)).toBe(result.reports[0]!.expandedBytes);
    expect(Math.max(...[...parts.values()].map(part => part.expanded))).toBeLessThan(64 * mib);
    for (const index of [3, 4]) { const xml = parts.get(`xl/worksheets/sheet${index}.xml`)!.bytes.toString('utf8'); expect((xml.match(/<row\b/g) ?? []).length).toBe(100_001); }
  }, 60_000);
});
