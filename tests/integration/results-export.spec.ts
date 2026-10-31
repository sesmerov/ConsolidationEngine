import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import sax from 'sax';
import readXlsxFile from 'read-excel-file/node';
import { afterEach, describe, expect, it } from 'vitest';
import type { Coordinate, JsonValue, RuleResultDTO } from '@ce/contracts';
import { jsonBytes, jsonChunks } from '../../apps/api/src/export/bounded-json.js';
import { checkExportData, exportLimits, writeResultsExport } from '../../apps/api/src/export/results-export.js';
import type { ExportPaths, ResultsExportData } from '../../apps/api/src/export/results-export.js';

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve('.cache'), path.resolve(directory));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('results-export-')) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
async function paths(): Promise<ExportPaths> {
  await mkdir(path.resolve('.cache'), { recursive: true });
  const directory = await mkdtemp(path.resolve('.cache/results-export-')); directories.push(directory);
  const result = { json: path.join(directory, randomUUID()), xlsx: path.join(directory, randomUUID()), zip: path.join(directory, randomUUID()) };
  await Promise.all(Object.values(result).map((location) => writeFile(location, Buffer.alloc(0), { flag: 'wx' }))); return result;
}
async function unzip(bytes: Buffer): Promise<Map<string, Buffer>> {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file)));
  const entries = new Map<string, Buffer>();
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => zip.openReadStream(entry, (error, stream) => {
        if (error) { reject(error); return; }
        const chunks: Buffer[] = []; stream!.on('error', reject); stream!.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream!.on('end', () => {
          try {
            const content = Buffer.concat(chunks);
            expect(entries.has(entry.fileName)).toBe(false); expect(content.length).toBe(entry.uncompressedSize); expect(crc32(content)).toBe(entry.crc32);
            entries.set(entry.fileName, content); zip.readEntry();
          } catch (failure) { reject(failure); }
        });
      })); zip.readEntry();
    });
    return entries;
  } finally { zip.close(); }
}
/** Controlled serializer fixture, not a claim that these DTOs were produced by regulatory evaluation. */
function fixture(): ResultsExportData {
  const versionId = randomUUID(), runId = randomUUID(), fileId = randomUUID(), resultId = randomUUID();
  const profileId = 'ce-dpmxl-0.9-closed-v1';
  const coordinate = (row: string): Coordinate => ({ factKey: 'synthetic:' + row, contextId: 'demo', tableCode: 'C_01.00', sheetCode: '', rowCode: row, columnCode: '0010',
    dataType: 'number', unit: 'EUR', decimals: 'INF', axes: {}, sourceLocator: { fileId, sheet: 'Coordinates', row: 2, column: 'A' } });
  const amount = '123456789012345678901234567890.123456789';
  const exact = { numerator: '123456789012345678901234567890123456789', denominator: '1000000000' };
  const third = { numerator: '1', denominator: '3' };
  const result: RuleResultDTO = { id: resultId, runId, versionId, profileId, instanceId: 'synthetic-instance', coverageOnly: false, contextId: 'demo',
    code: 'SYNTHETIC_EXPORT', variantIds: ['synthetic-variant'], sourceRecordIds: ['synthetic-record'], tables: ['C_01.00'], status: 'not_evaluable', severity: 'warning', severityOriginal: 'Warning',
    expression: '1/3 = {tC_01.00,r0230,c0010}', precondition: '{v_C_01.00}',
    values: { left: { kind: 'number', nominal: third, interval: { lo: third, hi: third }, unit: 'EUR' },
      right: { kind: 'null', presence: 'explicit_null', dataType: 'number', unit: 'EUR' }, result: { kind: 'null', presence: 'derived_null', dataType: 'boolean' } },
    readKeys: ['synthetic:0230', 'synthetic:0240', 'synthetic:0250'],
    factReads: [
      { factKey: 'synthetic:0230', coordinate: coordinate('0230'), presence: 'value', originalText: amount, normalizedValue: exact, sourceLocator: { fileId, sheet: 'Facts', row: 2, column: 'G' } },
      { factKey: 'synthetic:0240', coordinate: coordinate('0240'), presence: 'explicit_null', sourceLocator: { fileId, sheet: 'Facts', row: 3, column: 'G' } },
      { factKey: 'synthetic:0250', coordinate: coordinate('0250'), presence: 'implicit_null', sourceLocator: { fileId, sheet: 'Coordinates', row: 4, column: 'A' } },
    ], metadataReads: [{ contextId: 'demo', code: 'C_01.00', presence: 'declared', value: false, sourceLocator: { fileId, sheet: 'Contexts', row: 2, column: 'H' } },
      { contextId: 'demo', code: 'NOT_DECLARED', presence: 'missing' }],
    sources: [{ fileId, sheet: 'Facts', row: 2, column: 'G' }],
    diagnostics: [{ code: 'SYNTHETIC_TEXT', message: '=HYPERLINK("https://example.invalid","texto literal")' }],
  };
  return { profileId, versionId, contentHash: 'b'.repeat(64), synthetic: true, results: [result],
    contexts: [{ canonicalContextKey: 'synthetic-context', contextId: 'demo', entityId: 'SYNTHETIC', referenceDate: '2026-06-30', framework: 'COREP', moduleVersion: 'COREP_OF_4.2', filingIndicators: { 'C_01.00': false } }],
    sources: [{ id: fileId, displayName: '=SUM(1,2).xlsx', kind: 'report', sha256: 'a'.repeat(64), size: 1234, importedAt: '2026-10-31T00:00:00.000Z' }],
    catalog: { records: [], variants: [], coverage: { rows: 0, variants: 0, applicableVariants: 0, supportedVariants: 0, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } },
    run: { id: runId, versionId, profileId, status: 'completed', startedAt: '2026-10-31T00:00:00.000Z', endedAt: '2026-10-31T00:00:01.000Z', resultIds: [resultId], diagnostics: [],
      summary: { complete: true, rows: 1, variants: 1, applicableVariants: 1, instances: 1, duplicateRows: 0, byStatus: { pass: 0, fail: 0, not_applicable: 0, not_evaluable: 1, error: 0 } } },
  };
}

describe('bounded JSON and real results export package', () => {
  it('preserves escaped Unicode across chunk boundaries and measures UTF-8 bytes exactly', () => {
    const text = 'a'.repeat(4095) + '😀' + '\n\t"\\\u0000' + 'á'.repeat(20_000) + '\ud800';
    const input = { text, data: [null, false, -0, 1e100], literal: '=SUM(1,2)' };
    const chunks = [...jsonChunks(input)]; const serialized = chunks.join('');
    expect(JSON.parse(serialized)).toEqual(JSON.parse(JSON.stringify(input))); expect(Buffer.byteLength(serialized)).toBe(Buffer.byteLength(JSON.stringify(input)));
    expect(Math.max(...chunks.map((chunk) => Buffer.byteLength(chunk)))).toBeLessThan(64 * 1024);
    const bytes = Buffer.byteLength(serialized); expect(jsonBytes(input, bytes)).toBe(bytes);
    expect(() => jsonBytes(input, bytes - 1)).toThrowError(expect.objectContaining({ code: 'EXPORT_LIMIT' }));
  });
  it('exports exactly two readable ZIP entries with valid CRC, exact JSON and literal XLSX cells', async () => {
    const data = fixture(), output = await paths(), progress: number[] = [];
    const artifact = await writeResultsExport(data, output, exportLimits(), () => {}, (completed) => progress.push(completed));
    const bytes = await readFile(output.zip), entries = await unzip(bytes);
    expect([...entries.keys()]).toEqual(['results.json', 'results.xlsx']);
    expect(artifact).toEqual({ size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); expect(progress).toEqual([1, 2, 3]);
    const json = JSON.parse(entries.get('results.json')!.toString('utf8'));
    expect(json).toEqual(data); expect(json.results[0].values.left.nominal).toEqual({ numerator: '1', denominator: '3' });
    expect(json.results[0].factReads.map((item: { presence: string }) => item.presence)).toEqual(['value', 'explicit_null', 'implicit_null']);
    expect(json.results[0].metadataReads).toContainEqual(expect.objectContaining({ presence: 'declared', value: false }));
    const xlsx = entries.get('results.xlsx')!, sheets = await readXlsxFile(xlsx, { parseNumber: (value) => value, trim: false });
    const cells = sheets.flatMap((sheet) => sheet.data.flat());
    expect(cells).toContain('123456789012345678901234567890.123456789'); expect(cells).toContain('123456789012345678901234567890123456789');
    expect(cells).toContain('1/3 [1/3, 1/3] EUR'); expect(cells).toContain('0230'); expect(cells).toContain('0010');
    expect(cells).toContain('=SUM(1,2).xlsx'); expect(cells).toContain('=HYPERLINK("https://example.invalid","texto literal")');
    const parts = await unzip(xlsx);
    for (const [name, xml] of parts) {
      if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue;
      const text = xml.toString('utf8'); expect(text).not.toMatch(/<(?:\w+:)?f\b|<hyperlink\b|TargetMode="External"/);
      if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
        const parser = sax.parser(true); let cellType: unknown;
        parser.onopentag = (node) => {
          if (node.name === 'c') cellType = node.attributes.t;
          if (node.name === 'v' || node.name === 'is') expect(['s', 'inlineStr', 'str']).toContain(cellType);
        };
        parser.onclosetag = (tag) => { if (tag === 'c') cellType = undefined; };
        parser.write(text).close();
      }
    }
  });
  it('rejects oversized JSON or spreadsheet cells before touching the empty output files', async () => {
    const data = fixture(), output = await paths();
    expect(checkExportData(data, exportLimits())).toBe(Buffer.byteLength([...jsonChunks(data as unknown as JsonValue)].join('')));
    await expect(writeResultsExport(data, output, exportLimits({ maxContentBytes: 20 }), () => {}, () => {})).rejects.toMatchObject({ code: 'EXPORT_LIMIT' });
    const hugeCell = { ...data, results: [{ ...data.results[0]!, expression: 'x'.repeat(32768) }] };
    await expect(writeResultsExport(hugeCell, output, exportLimits(), () => {}, () => {})).rejects.toMatchObject({ code: 'EXPORT_LIMIT' });
    for (const location of Object.values(output)) expect((await stat(location)).size).toBe(0);
  });
  it('counts bytes during writing and never reports a completed package after a total-budget failure', async () => {
    const data = fixture(), output = await paths(), progress: number[] = [];
    const jsonSize = checkExportData(data, exportLimits());
    await expect(writeResultsExport(data, output, exportLimits({ maxTotalBytes: jsonSize + 1 }), () => {}, (completed) => progress.push(completed))).rejects.toMatchObject({ code: 'EXPORT_LIMIT' });
    expect((await stat(output.json)).size).toBe(jsonSize); expect((await stat(output.zip)).size).toBe(0); expect(progress).toEqual([1]);
  });
  it('honors cancellation between contents without reporting a finished ZIP', async () => {
    const data = fixture(), output = await paths(); let cancelled = false; const progress: number[] = [];
    const cancellation = new Error('controlled cancellation');
    await expect(writeResultsExport(data, output, exportLimits(), () => { if (cancelled) throw cancellation; }, (completed) => { progress.push(completed); cancelled = completed === 1; })).rejects.toBe(cancellation);
    expect(progress).toEqual([1]); expect((await stat(output.zip)).size).toBe(0);
  });
});
