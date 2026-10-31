import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../../apps/api/src/errors.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { importReport, importReportStream } from '../../apps/api/src/import/ce-report.js';
import { readSheetRows } from '../../apps/api/src/import/xlsx-reader.js';
import { changeXml, readZipParts, replaceCell, zipBytes } from '../helpers/xlsx-fixtures.js';
let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.resolve('.cache/stream-import-')); });
afterAll(async () => {
  const relative = path.relative(path.resolve('.cache'), path.resolve(directory));
  if (!relative.startsWith('stream-import-') || relative.includes('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup');
  await rm(directory, { recursive: true, force: true });
});
const source = { id: randomUUID(), kind: 'report' as const, displayName: 'SYNTHETIC.xlsx', sha256: 'a'.repeat(64), size: 1, importedAt: '2026-10-31T00:00:00.000Z' };
async function fixture(transform: (xml: string) => string = xml => xml, sheet = 3) {
  const parts = changeXml(await readZipParts(path.resolve('tests/fixtures/generated/report-42.xlsx')), `xl/worksheets/sheet${sheet}.xml`, transform);
  const location = path.join(directory, randomUUID() + '.xlsx'); await writeFile(location, zipBytes(parts)); return location;
}
const rowNodes = (xml: string) => xml.match(/<row\b[^>]*>[\s\S]*?<\/row>/g)!;
function reorder(xml: string) { return xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, '<sheetData>' + rowNodes(xml).reverse().join('') + '</sheetData>'); }
function fragment(xml: string) {
  const rows = rowNodes(xml), target = rows.find(row => /^<row\b[^>]*\br="2"/.test(row))!;
  const cells = target.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)!;
  const first = `<row r="2">${cells.slice(0, 3).join('')}</row>`, last = `<row r="2">${cells.slice(3).join('')}</row>`;
  return xml.replace(/<sheetData>[\s\S]*?<\/sheetData>/, '<sheetData>' + first + rows.filter(row => row !== target).reverse().join('') + last + '</sheetData>');
}
describe('bounded report row import', () => {
  it.each(['utf-16le', 'utf-16be'] as const)('preserves BOM-based %s decoding in both passes', async encoding => {
    const parts = await readZipParts(path.resolve('tests/fixtures/generated/report-42.xlsx'));
    const changed = parts.map(part => {
      if (part.name !== 'xl/worksheets/sheet2.xml') return part;
      const text = part.data.toString('utf8').replace(/encoding="[^"]+"/, 'encoding="UTF-16"');
      const bytes = Buffer.from(text, 'utf16le'); if (encoding === 'utf-16be') bytes.swap16();
      return { ...part, data: Buffer.concat([Buffer.from(encoding === 'utf-16be' ? [0xfe, 0xff] : [0xff, 0xfe]), bytes]) };
    });
    const location = path.join(directory, randomUUID() + '.xlsx'); await writeFile(location, zipBytes(changed));
    const metadata = await preflightXlsx(location, { retainCells: false });
    expect((await importReportStream(location, metadata, source)).contexts[0]!.entityId).toBe('SYNTHETIC');
  });
  it('retains only header cells in metadata mode and produces the same normalized report', async () => {
    const location = await fixture(), raw = await preflightXlsx(location), metadata = await preflightXlsx(location, { retainCells: false });
    expect(metadata.expandedBytes).toBe(raw.expandedBytes);
    expect(metadata.sheets.every(sheet => Object.values(sheet.cells).every(cell => cell.row === 1))).toBe(true);
    const expected = importReport({ date1904: raw.date1904, sheets: raw.sheets.map(sheet => ({ ...sheet, rows: [] })) }, source);
    expect(await importReportStream(location, metadata, source)).toEqual(expected);
  });
  it.each([2, 3, 4])('resolves out-of-order rows and a trailing header in worksheet %i by identity', async sheet => {
    const location = await fixture(reorder, sheet), raw = await preflightXlsx(location), metadata = await preflightXlsx(location, { retainCells: false });
    const expected = importReport({ date1904: raw.date1904, sheets: raw.sheets.map(item => ({ ...item, rows: [] })) }, source);
    const actual = await importReportStream(location, metadata, source); expect(actual).toEqual(expected);
    expect(actual.coordinates[0]!.sourceLocator).toMatchObject({ sheet: 'Coordinates', row: 2, column: 'A' });
  });
  it.each([2, 3, 4])('merges only disjoint fragments of one row in worksheet %i and preserves locators', async sheet => {
    const location = await fixture(fragment, sheet), raw = await preflightXlsx(location), metadata = await preflightXlsx(location, { retainCells: false });
    expect(metadata.sheets[sheet - 1]!.fragmentedRows).toEqual({ 2: 2 });
    const expected = importReport({ date1904: raw.date1904, sheets: raw.sheets.map(item => ({ ...item, rows: [] })) }, source);
    const actual = await importReportStream(location, metadata, source); expect(actual).toEqual(expected);
    expect(actual.facts[0]!.sourceLocator).toMatchObject({ sheet: 'Facts', row: 2, column: 'G' });
  });
  it.each([
    ['duplicate cell', (xml: string) => xml.replace('</sheetData>', '<row r="2"><c r="D2" t="inlineStr"><is><t>0230</t></is></c></row></sheetData>')],
    ['formula', (xml: string) => replaceCell(xml, 'D2', '<c r="D2"><f>1+1</f><v>2</v></c>')],
    ['invalid style in an unretained data cell', (xml: string) => replaceCell(xml, 'D2', '<c r="D2" s="999999" t="inlineStr"><is><t>0230</t></is></c>')],
    ['invalid shared-string index in an unretained data cell', (xml: string) => replaceCell(xml, 'D2', '<c r="D2" t="s"><v>999999</v></c>')],
  ] as const)('preserves preflight rejection of %s in both modes', async (_name, transform) => {
    const location = await fixture(transform);
    for (const retainCells of [true, false]) await expect(preflightXlsx(location, { retainCells })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('checks cancellation/deadline callbacks during preflight and during row normalization', async () => {
    const location = await fixture(); let firstChecks = 0;
    await expect(preflightXlsx(location, { retainCells: false, check() { if (++firstChecks === 10) throw new ApiError('INTERNAL_ERROR'); } })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(firstChecks).toBe(10);
    const metadata = await preflightXlsx(location, { retainCells: false }); let secondChecks = 0;
    await expect(importReportStream(location, metadata, source, { check() { if (++secondChecks === 10) throw new ApiError('INTERNAL_ERROR'); } })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(secondChecks).toBe(10);
    expect((await importReportStream(location, metadata, source)).facts).toHaveLength(5);
  });
  it('rejects a changed sheet between the verified pass and the row pass', async () => {
    const location = await fixture(), metadata = await preflightXlsx(location, { retainCells: false });
    const changed = changeXml(await readZipParts(location), 'xl/worksheets/sheet3.xml', xml => replaceCell(xml, 'D2', '<c r="D2" t="inlineStr"><is><t>0999</t></is></c>'));
    await writeFile(location, zipBytes(changed));
    const read = async () => { for await (const _row of readSheetRows(location, metadata, 'Coordinates')) { /* force the verified row pass */ } };
    await expect(read()).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
});
