import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import { importReport } from '../../apps/api/src/import/ce-report.js';
import { changeXml, readZipParts, replaceCell, textCell, zipBytes } from '../helpers/xlsx-fixtures.js';

let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.resolve('.cache/string-import-')); });
afterAll(async () => {
  const relative = path.relative(path.resolve('.cache'), path.resolve(directory));
  if (!relative.startsWith('string-import-') || relative.includes('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup');
  await rm(directory, { recursive: true, force: true });
});
type Format = 'inlineStr' | 'str' | 's';
const formats: Format[] = ['inlineStr', 'str', 's'];
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
async function file(format: Format, encoded: string, target = 'C2', sheet = 2, rich = false) {
  let parts = await readZipParts(path.resolve('tests/fixtures/generated/report-42.xlsx'));
  let replacement: string;
  if (format === 'inlineStr') replacement = textCell(target, encoded);
  else if (format === 'str') replacement = `<c r="${target}" t="str"><v>${escape(encoded)}</v></c>`;
  else {
    const existing = parts.find(p => p.name === 'xl/sharedStrings.xml');
    const entry = rich ? '<si><r><t>E_x00</t></r><r><t>0D_X</t></r></si>' : `<si><t xml:space="preserve">${escape(encoded)}</t></si>`;
    const index = existing ? (existing.data.toString('utf8').match(/<si(?:\s|>)/g) ?? []).length : 0;
    if (existing) parts = changeXml(parts, existing.name, xml => xml.replace('</sst>', entry + '</sst>'));
    else {
      parts.push({ name: 'xl/sharedStrings.xml', data: Buffer.from(`<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${entry}</sst>`), compress: true });
      parts = changeXml(parts, 'xl/_rels/workbook.xml.rels', xml => xml.replace('</Relationships>', '<Relationship Id="rIdStringProbe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'));
      parts = changeXml(parts, '[Content_Types].xml', xml => xml.replace('</Types>', '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'));
    }
    replacement = `<c r="${target}" t="s"><v>${index}</v></c>`;
  }
  parts = changeXml(parts, `xl/worksheets/sheet${sheet}.xml`, xml => replaceCell(xml, target, replacement));
  const location = path.join(directory, randomUUID() + '.xlsx'); const bytes = zipBytes(parts); await writeFile(location, bytes);
  return { location, source: { id: randomUUID(), kind: 'report' as const, displayName: 'string-probe.xlsx', sha256: 'a'.repeat(64), size: bytes.length, importedAt: '2026-10-31T00:00:00.000Z' } };
}
describe.each(formats)('independent ST_Xstring import via %s', format => {
  it.each([['_x000D_', '\r'], ['_x005F_x0041_', '_x0041_'], ['_x00E9__xD83D__xDE00_', 'é😀'], ['Á Ω 😀 & <>', 'Á Ω 😀 & <>']])('decodes %s once and preserves exact semantic text', async (encoded, expected) => {
    const { location, source } = await file(format, 'E' + encoded + 'X'), preflight = await preflightXlsx(location);
    const raw = preflight.sheets.find(s => s.name === 'Contexts')!.cells.C2!;
    expect(raw.text).toBe('E' + expected + 'X'); if (format !== 's') expect(raw.lexeme).toBe('E' + encoded + 'X');
    const report = importReport(await readWorkbook(location, preflight), source); expect(report.contexts[0]!.entityId).toBe('E' + expected + 'X');
  });
  it('keeps an escaped numeric text exact beyond Number integer precision', async () => {
    const { location, source } = await file(format, '_x0039_007199254740993', 'G2', 4), preflight = await preflightXlsx(location);
    const report = importReport(await readWorkbook(location, preflight), source);
    expect(report.facts[0]).toMatchObject({ originalText: '9007199254740993', normalizedValue: { numerator: '9007199254740993', denominator: '1' } });
  });
  it.each(['_xD800_', '_x0001_', '_xFFFE_'])('rejects non-representable decoded text %s', async encoded => {
    const { location } = await file(format, 'E' + encoded + 'X'); await expect(preflightXlsx(location)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  });
  it('enforces the decoded 32767-character limit without treating its seven-character escapes as logical content', async () => {
    const valid = await file(format, '_x0041_'.repeat(32_767)); const parsed = await preflightXlsx(valid.location);
    expect(parsed.sheets.find(s => s.name === 'Contexts')!.cells.C2!.text).toHaveLength(32_767);
    const invalid = await file(format, '_x0041_'.repeat(32_768)); await expect(preflightXlsx(invalid.location)).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  });
});
it('decodes a shared-string escape spanning rich-text runs only after concatenation', async () => {
  const { location, source } = await file('s', '', 'C2', 2, true), preflight = await preflightXlsx(location);
  expect(importReport(await readWorkbook(location, preflight), source).contexts[0]!.entityId).toBe('E\rX');
});
