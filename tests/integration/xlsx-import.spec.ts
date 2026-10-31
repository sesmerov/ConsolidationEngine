import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SourceFile } from '@ce/contracts';
import { isTerminalJob } from '@ce/contracts';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import { importReport } from '../../apps/api/src/import/ce-report.js';
import { excelDate } from '../../apps/api/src/import/excel-dates.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { JobManager } from '../../apps/api/src/jobs/job-manager.js';
import { changeXml, readZipParts, replaceCell, textCell, zipBytes } from '../helpers/xlsx-fixtures.js';
import type { ZipPart } from '../helpers/xlsx-fixtures.js';

const fixtures = path.resolve('tests/fixtures/generated');
const reportPath = path.join(fixtures, 'report-42.xlsx');
const factsXml = 'xl/worksheets/sheet4.xml';
const coordinatesXml = 'xl/worksheets/sheet3.xml';
let testDirectory: string; let reportParts: ZipPart[];
beforeAll(async () => {
  await mkdir(path.resolve('.cache'), { recursive: true });
  testDirectory = await mkdtemp(path.resolve('.cache/xlsx-import-'));
  reportParts = await readZipParts(reportPath);
});
afterAll(async () => {
  if (!testDirectory) return;
  const relative = path.relative(path.resolve('.cache'), path.resolve(testDirectory));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe fixture cleanup');
  await rm(testDirectory, { recursive: true, force: true });
});
async function save(parts: readonly ZipPart[]): Promise<string> {
  const location = path.join(testDirectory, randomUUID() + '.xlsx'); await writeFile(location, zipBytes(parts)); return location;
}
async function source(location: string, kind: 'catalog' | 'report' = 'report'): Promise<SourceFile> {
  const bytes = await readFile(location);
  return { id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), displayName: path.basename(location), kind,
    size: bytes.length, importedAt: '2026-10-31T12:00:00.000Z' };
}
async function report(location = reportPath) {
  const preflight = await preflightXlsx(location);
  return importReport(await readWorkbook(location, preflight), await source(location));
}
async function changedReport(sheet: string, transform: (xml: string) => string) { return report(await save(changeXml(reportParts, sheet, transform))); }
function dateCell(lexeme: string, xmlType = 'n') {
  return { address: 'K2', row: 2, column: 11, xmlType, lexeme, text: lexeme, style: '1' };
}

describe('report data fidelity and closed coordinate catalogue', () => {
  it('keeps explicit null, missing fact, zero and more than 15 digits distinct', async () => {
    const imported = await report();
    expect(imported.contexts).toHaveLength(1); expect(imported.contexts[0]).toMatchObject({ entityId: 'SYNTHETIC', referenceDate: '2026-06-30', moduleVersion: 'COREP_OF_4.2' });
    expect(imported.coordinates).toHaveLength(6); expect(imported.facts).toHaveLength(5);
    expect(imported.coordinates.find((item) => item.rowCode === '0230')).toMatchObject({ columnCode: '0010', decimals: '2' });
    expect(imported.facts.find((item) => item.rowCode === '0260')).toMatchObject({ presence: 'null' });
    expect(imported.coordinates.some((item) => item.rowCode === '0270')).toBe(true);
    expect(imported.facts.some((item) => item.rowCode === '0270')).toBe(false);
    expect(imported.facts.find((item) => item.rowCode === '0250')).toMatchObject({ presence: 'value', originalText: '0', normalizedValue: { numerator: '0', denominator: '1' } });
    expect(imported.facts.find((item) => item.rowCode === '0240')).toMatchObject({ originalText: '123456789012345678901234567890.123456789',
      normalizedValue: { numerator: '123456789012345678901234567890123456789', denominator: '1000000000' } });
  });
  it('keeps both declared sheets of the 4.0 synthetic report', async () => {
    const imported = await report(path.join(fixtures, 'report-40.xlsx'));
    expect(imported.coordinates).toHaveLength(6); expect(imported.facts).toHaveLength(6);
    expect([...new Set(imported.coordinates.map((item) => item.sheetCode))].sort()).toEqual(['001', '002']);
    expect(imported.contexts[0]).toMatchObject({ referenceDate: '2025-12-31', moduleVersion: 'COREP_OF_4.0' });
  });
  it('does not trim an amount or accept a numeric Excel cell with a text-looking style', async () => {
    await expect(changedReport(factsXml, (xml) => replaceCell(xml, 'G2', textCell('G2', ' 10.00 ')))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(changedReport(factsXml, (xml) => replaceCell(xml, 'G2', '<c r="G2" s="0"><v>12345678901234567</v></c>'))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects numeric coordinate codes instead of padding lost zeroes', async () => {
    await expect(changedReport(coordinatesXml, (xml) => replaceCell(xml, 'D2', '<c r="D2"><v>230</v></c>'))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects a fact outside the coordinate catalogue and a blank value, without converting either to null', async () => {
    await expect(changedReport(factsXml, (xml) => replaceCell(xml, 'D2', textCell('D2', '9999')))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(changedReport(factsXml, (xml) => replaceCell(xml, 'G2', textCell('G2', '')))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects a value attached to presence=null', async () => {
    await expect(changedReport(factsXml, (xml) => xml.replace('</sheetData>', '<row r="7">' +
      textCell('A7', 'demo') + textCell('B7', 'C_01.00') + textCell('D7', '0270') + textCell('E7', '0010') + textCell('F7', 'null') + textCell('G7', '0') + '</row></sheetData>'))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it.each([factsXml, coordinatesXml])('rejects duplicate logical keys even when their values agree: %s', async (sheet) => {
    await expect(changedReport(sheet, (xml) => {
      const row = xml.match(/<row r="2">([\s\S]*?)<\/row>/)?.[1]; if (!row) throw new Error('Missing fixture row');
      return xml.replace('</sheetData>', '<row r="20">' + row.replace(/r="([A-Z]+)2"/g, (_match, column: string) => 'r="' + column + '20"') + '</row></sheetData>');
    })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it.each(['1'.repeat(129), '0.' + '0'.repeat(128) + '1', '1e3', '10,00'])('rejects invalid/oversized decimal text (%s)', async (amount) => {
    await expect(changedReport(factsXml, (xml) => replaceCell(xml, 'G2', textCell('G2', amount)))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('accepts additional fractional digits beyond decimals without rounding the input', async () => {
    const imported = await changedReport(factsXml, (xml) => replaceCell(xml, 'G2', textCell('G2', '10.001')));
    expect(imported.facts.find((item) => item.rowCode === '0230')).toMatchObject({ originalText: '10.001', normalizedValue: { numerator: '10001', denominator: '1000' } });
  });
  it.each(['{"C_01.00":"true"}', '{"C_01.00":1}', '{"C_01.00":null}', '{"C_01.00":true,"C_01.00":false}', '{"C_01.00":true,"C_01.\\u0030\\u0030":false}', '{"v_C_01.00":true}', '[]'])('requires a duplicate-free map of actual booleans: %s', async (metadata) => {
    await expect(changedReport('xl/worksheets/sheet2.xml', (xml) => replaceCell(xml, 'H2', textCell('H2', metadata)))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('does not infer filing indicators from facts, and their changes preserve coordinate identities', async () => {
    const base = await report();
    const empty = await changedReport('xl/worksheets/sheet2.xml', (xml) => replaceCell(xml, 'H2', textCell('H2', '')));
    expect(empty.contexts[0]?.filingIndicators).toEqual({});
    expect(empty.contexts[0]?.canonicalContextKey).toBe(base.contexts[0]?.canonicalContextKey);
    expect(empty.coordinates.map((item) => item.factKey)).toEqual(base.coordinates.map((item) => item.factKey));
    expect(base.contexts[0]?.filingIndicatorsLocator).toMatchObject({ sheet: 'Contexts', row: 2, column: 'H' });
    const noFacts = await changedReport(factsXml, (xml) => xml.replace(/<row r="[2-9][0-9]*">[\s\S]*?<\/row>/g, ''));
    expect(noFacts.facts).toHaveLength(0); expect(noFacts.contexts[0]?.filingIndicators).toEqual({ 'C_01.00': true, 'C_05.01': true });
  });
  it('accepts input bounds exactly and normalizes signed zero without losing its source text', async () => {
    const largest = '9'.repeat(128); const smallest = '0.' + '0'.repeat(127) + '1';
    for (const [input, numerator, denominator] of [[largest, largest, '1'], [smallest, '1', '1' + '0'.repeat(128)], ['-000.000', '0', '1']]) {
      const imported = await changedReport(factsXml, (xml) => replaceCell(xml, 'G2', textCell('G2', input!)));
      expect(imported.facts.find((item) => item.rowCode === '0230')).toMatchObject({ originalText: input, normalizedValue: { numerator, denominator } });
    }
  });
  it.each(['EUR*EUR', 'USD*EUR', 'EUR^0', 'EUR^1', 'EUR^9', 'eur', 'EUR USD'])('rejects noncanonical units: %s', async (unit) => {
    await expect(changedReport(coordinatesXml, (xml) => replaceCell(xml, 'G2', textCell('G2', unit)))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', details: { reason: 'INVALID_UNIT' } });
  });
  it.each(['-19', '19', '-0', '02', ''])('rejects invalid numeric precision: %s', async (precision) => {
    await expect(changedReport(coordinatesXml, (xml) => replaceCell(xml, 'H2', textCell('H2', precision)))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('requires identical axes on the same sheet and rejects duplicate JSON keys', async () => {
    await expect(changedReport(coordinatesXml, (xml) => replaceCell(xml, 'I2', textCell('I2', '{"axis":"member"}')))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(changedReport(coordinatesXml, (xml) => replaceCell(xml, 'I2', textCell('I2', '{"axis":"one","axis":"two"}')))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('imports a false boolean as a value and requires empty numeric metadata', async () => {
    let parts = changeXml(reportParts, coordinatesXml, (xml) => replaceCell(replaceCell(replaceCell(xml, 'F4', textCell('F4', 'boolean')), 'G4', textCell('G4', '')), 'H4', textCell('H4', '')));
    parts = changeXml(parts, factsXml, (xml) => replaceCell(xml, 'G4', textCell('G4', 'false')));
    const imported = await report(await save(parts));
    expect(imported.facts.find((item) => item.rowCode === '0240')).toMatchObject({ presence: 'value', originalText: 'false', normalizedValue: false });
    const withUnit = changeXml(parts, coordinatesXml, (xml) => replaceCell(xml, 'G4', textCell('G4', 'EUR')));
    await expect(report(await save(withUnit))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects a second context with a different entity in the same report', async () => {
    await expect(changedReport('xl/worksheets/sheet2.xml', (xml) => {
      const row = xml.match(/<row r="2">([\s\S]*?)<\/row>/)?.[1]; if (!row) throw new Error('Missing fixture context');
      let extra = row.replace(/r="([A-Z]+)2"/g, (_match, column: string) => 'r="' + column + '3"');
      extra = replaceCell(extra, 'B3', textCell('B3', 'other')); extra = replaceCell(extra, 'C3', textCell('C3', 'ANOTHER_SYNTHETIC'));
      return xml.replace('</sheetData>', '<row r="3">' + extra + '</row></sheetData>');
    })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
});

describe('raw XML metadata and civil Excel dates', () => {
  it.each([['59', false, '1900-02-28'], ['61', false, '1900-03-01'], ['0', true, '1904-01-01'], ['60', true, '1904-03-01'], ['46112', false, '2026-03-31']] as const)('converts raw serial %s with date1904=%s', (serial, date1904, expected) => {
    expect(excelDate(dateCell(serial), date1904)).toBe(expected);
  });
  it.each(['60', '61.5', 'NaN'])('rejects an invalid 1900 serial %s', (serial) => {
    expect(() => excelDate(dateCell(serial), false)).toThrow();
  });
  it('uses civil ISO text and keeps absent date bounds absent', () => {
    expect(excelDate(dateCell('2026-06-30', 'inlineStr'), false)).toBe('2026-06-30');
    expect(excelDate(dateCell('NULL', 'inlineStr'), false)).toBeUndefined(); expect(excelDate(undefined, false)).toBeUndefined();
    expect(() => excelDate(dateCell('2026-02-30', 'inlineStr'), false)).toThrow();
  });
  it('retains the numeric lexeme, style and workbook epoch through the high-level reader', async () => {
    let parts = changeXml(reportParts, 'xl/workbook.xml', (xml) => xml.replace('<sheets>', '<workbookPr date1904="1"/><sheets>'));
    parts = changeXml(parts, factsXml, (xml) => replaceCell(xml, 'G2', '<c r="G2" s="0"><v>60</v></c>'));
    const location = await save(parts); const checked = await preflightXlsx(location); const workbook = await readWorkbook(location, checked);
    expect(checked.date1904).toBe(true); expect(workbook.date1904).toBe(true);
    const raw = workbook.sheets.find((sheet) => sheet.name === 'Facts')?.cells['G2'];
    expect(raw).toMatchObject({ address: 'G2', xmlType: 'n', lexeme: '60', style: '0' });
    expect(excelDate(raw, workbook.date1904)).toBe('1904-03-01');
  });
});

describe('XLSX preflight rejects dangerous or ambiguous containers before materializing tables', () => {
  it('reads a valid re-packed fixture through the same production preflight', async () => {
    const location = await save(reportParts); const checked = await preflightXlsx(location);
    expect(checked.sheets.map((sheet) => sheet.name)).toEqual(['Instructions', 'Contexts', 'Coordinates', 'Facts']);
  });
  it.each(['../outside.xml', '/absolute.xml', 'C:/outside.xml', 'xl/../outside.xml', 'xl\\outside.xml'])('rejects unsafe ZIP path %s', async (name) => {
    await expect(preflightXlsx(await save([...reportParts, { name, data: Buffer.from('outside') }]))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects duplicate ZIP entries and symbolic-link entries', async () => {
    await expect(preflightXlsx(await save([...reportParts, reportParts[0]!]))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(preflightXlsx(await save([...reportParts, { name: 'xl/link.xml', data: Buffer.from('/outside'), externalAttributes: (0xa1ff << 16) >>> 0 }]))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects encryption flags and inconsistent declared entry sizes', async () => {
    await expect(preflightXlsx(await save(reportParts.map((part, i) => i === 0 ? { ...part, flags: 0x801 } : part)))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(preflightXlsx(await save(reportParts.map((part, i) => i === 0 ? { ...part, declaredSize: 1 } : part)))).rejects.toThrow();
  });
  it.each([
    (xml: string) => xml.replace('</worksheet>', '</not-the-root>'),
    (xml: string) => xml.replace('<worksheet', '<!DOCTYPE worksheet [<!ENTITY x "secret">]><worksheet'),
    (xml: string) => xml.replace('<worksheet', '<!ENTITY x "secret"><worksheet'),
  ])('rejects malformed XML and declarations without recovering', async (transform) => {
    await expect(preflightXlsx(await save(changeXml(reportParts, factsXml, transform)))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it.each([factsXml, 'xl/worksheets/sheet1.xml'])('rejects formulas even outside Facts: %s', async (sheet) => {
    const address = sheet === factsXml ? 'G2' : 'A1';
    await expect(preflightXlsx(await save(changeXml(reportParts, sheet, (xml) => replaceCell(xml, address, '<c r="' + address + '"><f>1+1</f><v>2</v></c>'))))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it.each(['xl/vbaProject.bin', 'xl/activeX/activeX1.bin', 'xl/embeddings/oleObject1.bin'])('rejects active payload %s', async (name) => {
    await expect(preflightXlsx(await save([...reportParts, { name, data: Buffer.from('payload') }]))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects external data relationships but accepts informational hyperlinks without fetching them', async () => {
    const relationships = (type: string) => Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdUnsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type + '" Target="http://127.0.0.1:1/must-never-fetch" TargetMode="External"/></Relationships>');
    const name = 'xl/worksheets/_rels/sheet4.xml.rels';
    await expect(preflightXlsx(await save(changeXml(reportParts, name, () => relationships('externalLink').toString('utf8'))))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(preflightXlsx(await save(changeXml(reportParts, name, () => relationships('hyperlink').toString('utf8'))))).resolves.toBeDefined();
  });
  it('rejects internal relationship traversal outside the ZIP', async () => {
    const parts = changeXml(reportParts, 'xl/_rels/workbook.xml.rels', (xml) => xml.replace(/Target="[^"]*sheet1.xml"/, 'Target="../../outside.xml"'));
    await expect(preflightXlsx(await save(parts))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('rejects a shared-string index outside the table and an actual sparse cell beyond row/column limits', async () => {
    await expect(preflightXlsx(await save(changeXml(reportParts, factsXml, (xml) => replaceCell(xml, 'G2', '<c r="G2" t="s"><v>999999999</v></c>'))))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
    await expect(preflightXlsx(await save(changeXml(reportParts, factsXml, (xml) => xml.replace('</sheetData>', '<row r="1048576">' + textCell('XFD1048576', 'x') + '</row></sheetData>'))))).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  });
  it.each(['maxEntries', 'maxSheets', 'maxSharedStrings', 'maxCellChars', 'maxXmlDepth', 'maxRows', 'maxColumns'] as const)('enforces %s using deliberately small limits', async (limit) => {
    await expect(preflightXlsx(reportPath, { limits: { [limit]: 1 } })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  });
  it('enforces compressed, entry and shared batch expansion limits on real bytes', async () => {
    await expect(preflightXlsx(reportPath, { limits: { maxCompressedBytes: 10 } })).rejects.toMatchObject({ code: 'UPLOAD_LIMIT' });
    const location = await save([...reportParts, { name: 'xl/media/padding.bin', data: Buffer.alloc(200_000, 65), compress: true }]);
    expect((await readFile(location)).length).toBeLessThan(30_000);
    await expect(preflightXlsx(location, { limits: { maxEntryBytes: 100_000 } })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
    const budget = { expandedBytes: 0 }; await preflightXlsx(reportPath, { budget }); const firstSize = budget.expandedBytes;
    expect(firstSize).toBeGreaterThan((await readFile(reportPath)).length);
    await expect(preflightXlsx(reportPath, { budget, limits: { maxExpandedBytes: firstSize + 1 } })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  });
});

describe('real import worker publication', () => {
  it('retains the current snapshot and source bytes after a structurally invalid replacement', async () => {
    const store = new WorkspaceStore(); const workspace = store.create('Prueba de importación');
    const jobs = new JobManager(store, { workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
      workerModules: { import: new URL('../../apps/api/dist/workers/import.worker.js', import.meta.url) } });
    const catalogPath = path.join(fixtures, 'eba-subset.xlsx');
    const original = await readFile(reportPath);
    const staged = async (location: string, kind: 'catalog' | 'report') => ({ ...await source(location, kind), path: location });
    const waitFor = async (jobId: string) => {
      const until = Date.now() + 15_000;
      while (!isTerminalJob(jobs.get(workspace.id, jobId).status) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 10));
      return jobs.get(workspace.id, jobId);
    };
    try {
      const accepted = jobs.start({ workspaceId: workspace.id, kind: 'import', input: { files: [await staged(catalogPath, 'catalog'), await staged(reportPath, 'report')] } });
      const completed = await waitFor(accepted.jobId); expect(completed.status).toBe('succeeded');
      const version = store.get(workspace.id).currentVersionId!; const snapshot = store.snapshot(workspace.id, version);
      const invalid = await save(changeXml(reportParts, factsXml, (xml) => replaceCell(xml, 'G2', '<c r="G2"><f>1+1</f><v>2</v></c>')));
      const attempted = jobs.start({ workspaceId: workspace.id, kind: 'import', baseVersionId: version,
        input: { files: [await staged(catalogPath, 'catalog'), await staged(invalid, 'report')] } });
      const failed = await waitFor(attempted.jobId); expect(failed.status).toBe('failed');
      expect(failed.diagnostics[0]?.code).toBe('INVALID_WORKBOOK');
      expect(store.get(workspace.id).currentVersionId).toBe(version); expect(store.snapshot(workspace.id, version)).toBe(snapshot);
      const numeric = await save(changeXml(reportParts, factsXml, (xml) => replaceCell(xml, 'G2', '<c r="G2"><v>12345678901234567890</v></c>')));
      const retry = jobs.start({ workspaceId: workspace.id, kind: 'import', baseVersionId: version,
        input: { files: [await staged(catalogPath, 'catalog'), { ...await staged(numeric, 'report'), displayName: 'importe.xlsx' }] } });
      const diagnostic = (await waitFor(retry.jobId)).diagnostics[0];
      expect(diagnostic).toMatchObject({ code: 'INVALID_WORKBOOK', fileName: 'importe.xlsx', locator: { sheet: 'Facts', row: 2, column: 'G' } });
      expect(diagnostic?.message).toContain('texto'); expect(JSON.stringify(diagnostic)).not.toContain(testDirectory);
      expect(store.get(workspace.id).currentVersionId).toBe(version);
      expect(await readFile(reportPath)).toEqual(original);
    } finally { await jobs.dispose(); }
  });
});
