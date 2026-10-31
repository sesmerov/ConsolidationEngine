import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook, readSheetRows, type RawSheetRow } from '../../apps/api/src/import/xlsx-reader.js';
import { zipBytes, type ZipPart } from '../helpers/xlsx-fixtures.js';

let directory: string;
beforeAll(async () => { await mkdir('.cache', { recursive: true }); directory = await mkdtemp(path.resolve('.cache/xlsx-text-')); });
afterAll(async () => {
  const relative = path.relative(path.resolve('.cache'), path.resolve(directory));
  if (!relative.startsWith('xlsx-text-') || relative.includes(path.sep)) throw new Error('Unsafe fixture cleanup');
  await rm(directory, { recursive: true, force: true });
});
type Format = 'inlineStr' | 'str' | 's';
const main = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', relations = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const xmlEscape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Minimal real OOXML; content is intentionally authored independently of the production encoder. */
async function workbook(format: Format, content: string, options: { rich?: boolean; rawValue?: boolean; boundary?: number } = {}) {
  const is = options.rich ? content : `<t xml:space="preserve">${xmlEscape(content)}</t>`;
  const cell = format === 's' ? '<c r="A2" t="s"><v>0</v></c>' : format === 'str'
    ? `<c r="A2" t="str"><v>${options.rawValue ? content : xmlEscape(content)}</v></c>` : `<c r="A2" t="inlineStr"><is>${is}</is></c>`;
  const prefix = `<worksheet xmlns="${main}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>header</t></is></c></row><row r="2">`;
  let padding = '';
  if (options.boundary !== undefined) {
    const textOffset = Buffer.byteLength(prefix + cell.slice(0, cell.indexOf(xmlEscape(content))));
    if (format === 's' || options.rich || options.rawValue || textOffset + 7 > options.boundary) throw new Error('Unsupported boundary fixture');
    padding = '<!--' + 'p'.repeat(options.boundary - textOffset - 7) + '-->';
    expect(Buffer.byteLength(prefix + padding + cell.slice(0, cell.indexOf(xmlEscape(content))))).toBe(options.boundary);
  }
  const sheet = prefix + padding + cell + '</row></sheetData></worksheet>';
  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' + (format === 's' ? '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' : '') + '</Types>'), compress: true },
    { name: '_rels/.rels', data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="root" Type="${relations}/officeDocument" Target="xl/workbook.xml"/></Relationships>`), compress: true },
    { name: 'xl/workbook.xml', data: Buffer.from(`<workbook xmlns="${main}" xmlns:r="${relations}"><sheets><sheet name="Text" sheetId="1" r:id="sheet"/></sheets></workbook>`), compress: true },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="sheet" Type="${relations}/worksheet" Target="worksheets/sheet1.xml"/>` + (format === 's' ? `<Relationship Id="strings" Type="${relations}/sharedStrings" Target="sharedStrings.xml"/>` : '') + '</Relationships>'), compress: true },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheet), compress: true },
  ];
  if (format === 's') parts.push({ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst xmlns="${main}" count="1" uniqueCount="1"><si>${is}</si></sst>`), compress: true });
  const location = path.join(directory, randomUUID() + '.xlsx'); await writeFile(location, zipBytes(parts)); return location;
}
async function text(location: string) {
  const preflight = await preflightXlsx(location), loaded = await readWorkbook(location, preflight);
  const metadata = await preflightXlsx(location, { retainCells: false });
  expect(metadata.sheets[0]!.cells.A1?.text).toBe('header'); expect(metadata.sheets[0]!.cells.A2).toBeUndefined();
  const rows: RawSheetRow[] = []; for await (const row of readSheetRows(location, metadata, 'Text')) rows.push(row);
  expect(rows.map(row => row.row)).toEqual([1, 2]);
  expect(rows.flatMap(row => row.cells)).toEqual(Object.values(preflight.sheets[0]!.cells));
  expect(loaded.sheets[0]!.cells.A2).toEqual(preflight.sheets[0]!.cells.A2);
  return rows[1]!.cells[0]!.text;
}

describe('OOXML text boundary regressions not covered by ordinary string imports', () => {
  it.each(['inlineStr', 'str', 's'] as const)('decodes overlapping escape-looking literals exactly once in %s', async format => {
    const encoded = '_x005F_x005F_x005F_x0041_ | _x005F_x0001_ | _x005F_xD800_';
    expect(await text(await workbook(format, encoded))).toBe('_x005F_x0041_ | _x0001_ | _xD800_');
  });
  it.each(['inlineStr', 's'] as const)('joins rich-text runs before decoding and ignores phonetic annotations in %s', async format => {
    const rich = '<r><t xml:space="preserve"> _x005</t></r><r><t>F_x00</t></r><r><t>41_</t></r>'
      + '<r><t>_xD83</t></r><r><t>D__xDE</t></r><r><t>00__x000</t></r><r><t xml:space="preserve">D_\n\t </t></r>'
      + '<rPh sb="0" eb="1"><t>_x0001_</t></rPh>';
    expect(await text(await workbook(format, rich, { rich: true }))).toBe(' _x0041_😀\r\n\t ');
  });
  it('concatenates CDATA and ordinary XML text before decoding str cells', async () => {
    const value = ' _x00<![CDATA[41]]>_ &amp; _x005<![CDATA[F_x0041_]]>_x000D_\n\t ';
    expect(await text(await workbook('str', value, { rawValue: true }))).toBe(' A & _x0041_\r\n\t ');
  });
  it.each(['inlineStr', 'str', 's'] as const)('preserves combined whitespace and XML entities in %s', async format => {
    expect(await text(await workbook(format, ' \t_x000D_\nÁ & < > 😀 \t '))).toBe(' \t\r\nÁ & < > 😀 \t ');
  });
  it.each(['inlineStr', 'str'] as const)('preserves an escape token crossing a 64 KiB decompression boundary in %s', async format => {
    expect(await text(await workbook(format, '_x005F_x0041_', { boundary: 65_533 }))).toBe('_x0041_');
  });
  it.each(['inlineStr', 'str'] as const)('preserves a UTF-8 character crossing a 64 KiB decompression boundary in %s', async format => {
    expect(await text(await workbook(format, '😀 & Ω', { boundary: 65_535 }))).toBe('😀 & Ω');
  });
});
