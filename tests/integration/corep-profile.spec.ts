import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { afterAll, expect, test, vi } from 'vitest';
import type { ImportContextFormDTO } from '@ce/contracts';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import { normalizeCorepCa1, COREP_MAPPING_SHA256 } from '../../apps/api/src/import/profiles/corep-ca1.js';
import { inspectReportWorkbook } from '../../apps/api/src/import/profiles/registry.js';
import { corepParts, corepFile, corepChange, corepReplaceCell, corepAmount, cleanupCorepFiles } from '../helpers/corep-fixtures.js';
import { changeXml, textCell } from '../helpers/xlsx-fixtures.js';

const official = path.resolve('tests/fixtures/eba/official-annexes-4.0.xlsx');
const form: ImportContextFormDTO = { entityId: 'TEST_ENTITY', referenceDate: '2026-06-30', currency: 'EUR', scaleExponent: 0, displayDecimals: 2, filingIndicators: { 'C_01.00': true } };
const oracle = JSON.parse(await readFile(path.resolve('specs/002-ui-eba-demo/contracts/corep-ca1-mapping.json'), 'utf8'));
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
afterAll(cleanupCorepFiles);

test('visual registry preserves the formula location in a COREP extract', async () => {
  const file = await corepFile(corepChange(await corepParts(), xml => corepReplaceCell(xml, 'E7', '<c r="E7"><f>1+1</f><v>2</v></c>')));
  await expect(inspectReportWorkbook(file.path)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', details: { reason: 'FORMULA_IN_SELECTED_SHEET' }, locator: { sheet: 'CA1', row: 7, column: 'E' } });
});

test('visual registry reports a rejected requested COREP profile without rejecting FINREP over its excluded formula', async () => {
  const source = await preflightXlsx(official, { profile: 'corep-ca1' });
  const file = await corepFile(corepChange(await corepParts('tests/fixtures/eba/official-annexes-4.0.xlsx'), xml => corepReplaceCell(xml, 'E5', '<c r="E5"><f>1+1</f><v>2</v></c>'), source.sheets.find(sheet => sheet.name === 'CA1')!.part!.name));
  for (const options of [{ formDeclaration: form }, { profileId: 'eba-corep-of-4.0-ca1-v1' }]) {
    const diagnostic = await inspectReportWorkbook(file.path, options).then(() => null, error => ({ code: error.code, details: error.details, locator: error.locator }));
    expect(diagnostic).toMatchObject({ code: 'INVALID_WORKBOOK', details: { reason: 'FORMULA_IN_SELECTED_SHEET' }, locator: { sheet: 'CA1', row: 5, column: 'E' } });
  }
  expect((await inspectReportWorkbook(file.path, { profileId: 'eba-finrep-4.0-f0101-v1' })).profileId).toBe('eba-finrep-4.0-f0101-v1');
});

test('visual registry keeps a concrete COREP anchor diagnostic instead of replacing it with an unknown-profile message', async () => {
  const file = await corepFile(corepChange(await corepParts(), xml => corepReplaceCell(xml, 'D5', textCell('D5', 'ALTERED'))));
  await expect(inspectReportWorkbook(file.path)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', details: { reason: 'ALTERED_CA1_ANCHOR' }, locator: { sheet: 'CA1', row: 5, column: 'D' } });
});

test('COREP official source recognizes 191 sheets and retains CA1 without relaxing legacy import', async () => {
  const workbook = await preflightXlsx(official, { profile: 'corep-ca1' });
  expect(workbook.sheets).toHaveLength(191);
  const ca1 = workbook.sheets.find(sheet => sheet.name === 'CA1')!;
  expect(Object.keys(ca1.cells).length).toBeGreaterThanOrEqual(335); expect(ca1.mergeRanges).toEqual(['B2:E2']);
  for (const [address, expected] of oracle.structureAnchors) expect(ca1.cells[address]?.text).toBe(expected);
  expect(workbook.scan).toEqual({ physicalCells: 166645, externalLinkXmlParts: 22, externalRelations: 26, formulas: 72 });
  expect(workbook.sheets.some(sheet => sheet.maxColumn === 16384)).toBe(true);
  expect(workbook.sheets.filter(sheet => sheet.name !== 'CA1').every(sheet => Object.keys(sheet.cells).length === 0)).toBe(true);
  await expect(readWorkbook(official, workbook)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  await expect(preflightXlsx(official)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
});

test('110 exact mappings agree between complete source and safe extract; identity excludes source and visual labels', async () => {
  const replace = (xml: string) => oracle.mapping.reduce((next: string, cell: { amountCell: string }, index: number) => corepReplaceCell(next, cell.amountCell, corepAmount(cell.amountCell, `${index + 1}.25`)), xml);
  const original = await preflightXlsx(official, { profile: 'corep-ca1' });
  const complete = await corepFile(corepChange(await corepParts('tests/fixtures/eba/official-annexes-4.0.xlsx'), replace, original.sheets.find(sheet => sheet.name === 'CA1')!.part!.name), 'full.xlsx');
  const extract = await corepFile(corepChange(await corepParts(), replace), 'extract.xlsx');
  const a = normalizeCorepCa1((await inspectReportWorkbook(complete.path,{profileId:'eba-corep-of-4.0-ca1-v1'})).preflight, complete.source, form);
  const inspected = await inspectReportWorkbook(extract.path), b = normalizeCorepCa1(inspected.preflight, extract.source, form);
  expect(a.report.coordinates).toHaveLength(110); expect(a.report.facts).toHaveLength(110); expect(a.binding.excludedSheets).toHaveLength(190); expect(b.binding.excludedSheets).toEqual([]);
  expect(a.declaration).toMatchObject({ contextId: 'corep', framework: 'COREP', moduleVersion: 'COREP_OF_4.0' });
  expect(a.binding).toMatchObject({ sourceFileId: complete.source.id, mappingSha256: COREP_MAPPING_SHA256, contextOrigin: 'form', selectedSheets: ['CA1'] });
  expect(a.report.contexts[0]?.filingIndicatorsLocator).toBeUndefined(); expect(a.contextLocators).toBeUndefined();
  for (const [index, cell] of oracle.mapping.entries()) {
    const coordinate = a.report.coordinates[index]!, fact = a.report.facts[index]!;
    expect(coordinate).toMatchObject({ tableCode: cell.tableCode, sheetCode: '', rowCode: cell.rowCode, columnCode: cell.columnCode, dataType: 'number', unit: 'EUR', decimals: '2', sourceLocator: { fileId: complete.source.id, sheet: 'CA1', row: index + 5, column: 'B' } });
    expect(fact).toMatchObject({ factKey: coordinate.factKey, originalText: `${index + 1}.25`, normalizedValue: { numerator: String((index + 1) * 4 + 1), denominator: '4' }, sourceLocator: { fileId: complete.source.id, sheet: 'CA1', row: index + 5, column: 'E' } });
    expect(b.report.coordinates[index]?.factKey).toBe(coordinate.factKey); expect(b.report.facts[index]?.normalizedValue).toEqual(fact.normalizedValue);
  }
  expect(b.report.contexts).toEqual(a.report.contexts);
});

test('zero, blank, scientific numeric lexemes and long exact decimals retain input and base scale', async () => {
  const exact = '123456789012345678901234567890.123456789';
  const file = await corepFile(corepChange(await corepParts(), xml => corepReplaceCell(corepReplaceCell(corepReplaceCell(xml, 'E5', corepAmount('E5', '0')), 'E6', corepAmount('E6', '1.234E+2')), 'E7', textCell('E7', exact))));
  const workbook = await preflightXlsx(file.path, { profile: 'corep-ca1' });
  const result = normalizeCorepCa1(workbook, file.source, { ...form, scaleExponent: 3, displayDecimals: 2 });
  expect(result.report.coordinates).toHaveLength(110); expect(result.report.facts).toHaveLength(3); expect(result.report.coordinates.every(cell => cell.decimals === '-1')).toBe(true);
  expect(result.report.facts[0]?.normalizedValue).toEqual({ numerator: '0', denominator: '1' });
  expect(result.report.facts[1]).toMatchObject({ originalText: '1.234E+2', normalizedValue: { numerator: '123400', denominator: '1' } });
  expect(result.report.facts[2]).toMatchObject({ originalText: exact, normalizedValue: { numerator: '123456789012345678901234567890123456789', denominator: '1000000' } });
  expect(() => normalizeCorepCa1(workbook, file.source, { ...form, scaleExponent: 6, displayDecimals: -18 })).toThrowError('INVALID_WORKBOOK');
  expect(normalizeCorepCa1(workbook, file.source, { ...form, displayDecimals: 'INF', filingIndicators: { 'C_01.00': false } }).report.contexts[0]?.filingIndicators).toEqual({ 'C_01.00': false });
});

test.each(['1,23', '1 234', ' 1', '+1', '1e3', '1%', 'NULL', '9'.repeat(129), '0.' + '0'.repeat(128) + '1'])('rejects ambiguous or out-of-domain decimal text %s', async value => {
  const file = await corepFile(corepChange(await corepParts(), xml => corepReplaceCell(xml, 'E5', textCell('E5', value))));
  const workbook = await preflightXlsx(file.path, { profile: 'corep-ca1' });
  expect(() => normalizeCorepCa1(workbook, file.source, form)).toThrowError('INVALID_WORKBOOK');
});
test.each([['b', '1'], ['e', '#VALUE!'], ['d', '2026-06-30']])('rejects %s amount cells', async (type, value) => {
  const file = await corepFile(corepChange(await corepParts(), xml => corepReplaceCell(xml, 'E5', corepAmount('E5', value!, type))));
  const workbook = await preflightXlsx(file.path, { profile: 'corep-ca1' }); expect(() => normalizeCorepCa1(workbook, file.source, form)).toThrowError('INVALID_WORKBOOK');
});
test.each([9, 14, 22, 46])('rejects numeric amounts with ambiguous number format %s', async numFmt => {
  const parts = await corepParts(); let index = 0;
  const styled = changeXml(parts, 'xl/styles.xml', xml => { index = Number(/<cellXfs count="([0-9]+)"/.exec(xml)![1]); return xml.replace(/<cellXfs count="[0-9]+"/, `<cellXfs count="${index + 1}"`).replace('</cellXfs>', `<xf numFmtId="${numFmt}" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>`); });
  const file = await corepFile(corepChange(styled, xml => corepReplaceCell(xml, 'E5', corepAmount('E5', '1', 'n', index))));
  const workbook = await preflightXlsx(file.path, { profile: 'corep-ca1' }); expect(() => normalizeCorepCa1(workbook, file.source, form)).toThrowError('INVALID_WORKBOOK');
});

test('Contexto supports exact workbook declaration, real locators, blank template and disagreement rejection', async () => {
  const values = ['TEST_ENTITY', '2026-06-30', '2026-07-10', 'EUR', '3', '2', 'false'];
  const parts = await corepParts(); const file = await corepFile(corepChange(parts, xml => values.reduce((next, value, index) => corepReplaceCell(next, 'B' + (index + 5), textCell('B' + (index + 5), value)), xml), 'xl/worksheets/sheet2.xml'));
  const inspected = await inspectReportWorkbook(file.path), result = normalizeCorepCa1(inspected.preflight, file.source);
  expect(inspected.workbookContext).toMatchObject({ entityId: 'TEST_ENTITY', contextId: 'corep', currency: 'EUR', scaleExponent: 3, displayDecimals: 2 });
  expect(result.binding.contextOrigin).toBe('workbook'); expect(result.report.contexts[0]?.filingIndicatorsLocator).toEqual({ fileId: file.source.id, sheet: 'Contexto', column: 'B', row: 11 });
  expect(result.contextLocators?.referenceDate).toEqual({ fileId: file.source.id, sheet: 'Contexto', column: 'B', row: 6 });
  expect(() => normalizeCorepCa1(inspected.preflight, file.source, form)).toThrowError('CONTEXT_MISMATCH');
  const blank = await corepFile(parts), blankBook = (await inspectReportWorkbook(blank.path)).preflight;
  expect(() => normalizeCorepCa1(blankBook, blank.source)).toThrowError('MISSING_CONTEXT');
  expect(normalizeCorepCa1(blankBook, blank.source, form).binding.contextOrigin).toBe('form');
  const partial = await corepFile(corepChange(parts, xml => corepReplaceCell(xml, 'B5', textCell('B5', 'TEST_ENTITY')), 'xl/worksheets/sheet2.xml'));
  await expect(inspectReportWorkbook(partial.path)).rejects.toMatchObject({ code: 'MISSING_CONTEXT' });
});

test.each([
  ['anchor', (xml: string) => corepReplaceCell(xml, 'D5', textCell('D5', 'OWN FUNDS '))],
  ['numeric label', (xml: string) => corepReplaceCell(xml, 'D5', corepAmount('D5', 'OWN FUNDS'))],
  ['numeric row code', (xml: string) => corepReplaceCell(xml, 'B5', corepAmount('B5', '0010'))],
  ['merge', (xml: string) => xml.replace('ref="B2:E2"', 'ref="B2:D2"')],
  ['duplicate', (xml: string) => xml.replace(/(<row r="2"[^>]*>[\s\S]*?)(<\/row>)/, '$1<c r="B2"/>$2')],
  ['extra content', (xml: string) => xml.replace('</sheetData>', '<row r="115"><c r="E115" t="inlineStr"><is><t>unexpected</t></is></c></row></sheetData>')],
  ['selected formula', (xml: string) => corepReplaceCell(xml, 'E5', '<c r="E5"><f>1+1</f><v>2</v></c>')],
  ['DTD', (xml: string) => xml.replace('?>', '?><!DOCTYPE worksheet [<!ENTITY e "x">]>')],
  ['PI', (xml: string) => xml.replace('?>', '?><?foreign run?>')],
])('rejects changed structure or active XML: %s', async (_name, transform) => {
  const file = await corepFile(corepChange(await corepParts(), transform)); await expect(preflightXlsx(file.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
});
test('allows harmless presentation changes and decodes ST_Xstring exactly once, excluding phonetic runs', async () => {
  const parts = await corepParts();
  const file = await corepFile(corepChange(parts, xml => corepReplaceCell(xml.replace('width="', 'hidden="0" width="'), 'D5', '<c r="D5" t="inlineStr"><is><r><t>_x004F_WN </t></r><rPh sb="0" eb="1"><t>ignored</t></rPh><r><t>FUNDS</t></r></is></c>')));
  expect((await preflightXlsx(file.path, { profile: 'corep-ca1' })).sheets[0]?.cells.D5?.text).toBe('OWN FUNDS');
  const escaped = await corepFile(corepChange(parts, xml => corepReplaceCell(xml, 'D5', '<c r="D5" t="inlineStr"><is><t>_x005F_x004F_WN FUNDS</t></is></c>')));
  await expect(preflightXlsx(escaped.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
});

test('bounds physical cells and all XML/ZIP work, with cancellation even on excluded sheets', async () => {
  const extract = await corepFile(await corepParts()), read = await preflightXlsx(extract.path, { profile: 'corep-ca1' });
  const cells = read.scan!.physicalCells, largest = Math.max(...read.sheets.map(sheet => sheet.physicalCellCount!));
  await expect(preflightXlsx(extract.path, { profile: 'corep-ca1', limits: { maxPhysicalCellsPerBook: cells, maxPhysicalCellsPerSheet: largest } })).resolves.toBeDefined();
  await expect(preflightXlsx(extract.path, { profile: 'corep-ca1', limits: { maxPhysicalCellsPerBook: cells - 1 } })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  await expect(preflightXlsx(extract.path, { profile: 'corep-ca1', limits: { maxPhysicalCellsPerSheet: largest - 1 } })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  for (const limits of [{ maxSheets: 190 }, { maxExternalLinkXmlParts: 21 }, { maxExternalRelations: 25 }, { maxRows: 440 }, { maxColumns: 16383 }]) await expect(preflightXlsx(official, { profile: 'corep-ca1', limits })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  await expect(preflightXlsx(official, { profile: 'corep-ca1', limits: { maxSheets: 257 } })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
  let checks = 0; await expect(preflightXlsx(official, { profile: 'corep-ca1', check() { if (++checks > 20) throw new Error('cancel'); } })).rejects.toBeDefined(); expect(checks).toBe(21);
  await expect(preflightXlsx(extract.path, { profile: 'corep-ca1', budget: { expandedBytes: 100 * 1024 * 1024 - 1 } })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
});
test('source compatibility cannot authorize unsafe parts, DDE, other PIs, unsafe paths or annotated layouts', async () => {
  const parts = await corepParts('tests/fixtures/eba/official-annexes-4.0.xlsx');
  for (const extra of [{ name: 'xl/vbaProject.bin', data: Buffer.from('macro') }, { name: '../unsafe.xml', data: Buffer.from('<x/>') }, { name: 'duplicate.xml', data: Buffer.from('<x/>'), flags: 1 }]) {
    const file = await corepFile([...parts, extra]); await expect(preflightXlsx(file.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  }
  for (const pi of ['<?mso-contentType injected?>', '<?other?>']) {
    const file = await corepFile(changeXml(parts, 'customXml/item2.xml', xml => xml.replace('<?mso-contentType?>', pi)));
    await expect(preflightXlsx(file.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  }
  const dde = await corepFile(changeXml(parts, 'xl/externalLinks/externalLink1.xml', xml => xml.replace(/externalBook/g, 'ddeLink')));
  await expect(preflightXlsx(dde.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  await expect(preflightXlsx(path.resolve('tests/fixtures/eba/annotated-corep-of-4.0.xlsx'), { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
});
test('safe template reproducibly preserves anchors/styles and packages only selected sheets without network/cache', async () => {
  const before = await readFile(path.resolve('assets/templates/corep-ca1.xlsx')), manifestBefore = await readFile(path.resolve('assets/templates/manifest.json'));
  const sources = JSON.parse(await readFile(path.resolve('tests/fixtures/eba/source-manifest.json'), 'utf8'));
  execFileSync(process.execPath, ['scripts/prepare-visual-templates.mjs'], { cwd: path.resolve('.'), stdio: 'pipe' });
  expect(hash(await readFile(path.resolve('assets/templates/corep-ca1.xlsx')))).toBe(hash(before)); expect(await readFile(path.resolve('assets/templates/manifest.json'))).toEqual(manifestBefore);
  const parts = await corepParts(); expect(parts.some(part => /external|customXml|vba|connections/i.test(part.name))).toBe(false);
  const workbook = await preflightXlsx(path.resolve('assets/templates/corep-ca1.xlsx'), { profile: 'corep-ca1' });
  expect(workbook.sheets.map(sheet => sheet.name)).toEqual(['CA1', 'Contexto', 'Instrucciones']); expect(workbook.scan?.formulas).toBe(0); expect(workbook.scan?.externalRelations).toBe(0);
  expect(parts.find(part => part.name === 'xl/worksheets/sheet1.xml')?.data.toString('utf8')).toContain('<cols>'); expect(workbook.styleCount).toBeGreaterThan(1);
  for (const source of sources.sources) expect(hash(await readFile(path.resolve('tests/fixtures/eba', source.file)))).toBe(source.sha256);
});

test('sheet and ZIP order do not decide recognition or data, and excluded metadata makes no network requests', async () => {
  const parts = await corepParts();
  const reversed = changeXml(parts, 'xl/workbook.xml', xml => xml.replace(/<sheets>([\s\S]*?)<\/sheets>/, (_match, sheets: string) => '<sheets>' + sheets.match(/<sheet\b[^>]*\/>/g)!.reverse().join('') + '</sheets>'));
  const file = await corepFile([...reversed].reverse()); const inspected = await inspectReportWorkbook(file.path);
  expect(inspected.preflight.sheets.map(sheet => sheet.name)).toEqual(['Instrucciones', 'Contexto', 'CA1']); expect(normalizeCorepCa1(inspected.preflight, file.source, form).report.coordinates).toHaveLength(110);
  const fetchSpy = vi.spyOn(globalThis, 'fetch'), httpSpy = vi.spyOn(http, 'request'), httpsSpy = vi.spyOn(https, 'request');
  try { await preflightXlsx(official, { profile: 'corep-ca1' }); expect(fetchSpy).not.toHaveBeenCalled(); expect(httpSpy).not.toHaveBeenCalled(); expect(httpsSpy).not.toHaveBeenCalled(); }
  finally { fetchSpy.mockRestore(); httpSpy.mockRestore(); httpsSpy.mockRestore(); }
});
test('physical XFD/1024 bounds are sparse, while nonempty extras and XFE/1025 are rejected', async () => {
  const parts = await corepParts();
  const within = await corepFile(corepChange(parts, xml => xml.replace('</sheetData>', '<row r="1024"><c r="XFD1024"/></row></sheetData>')));
  const workbook = await preflightXlsx(within.path, { profile: 'corep-ca1' }); expect(workbook.sheets[0]?.maxColumn).toBe(16384); expect(workbook.sheets[0]?.maxRow).toBe(1024);
  for (const [row, column] of [[1025, 'XFD'], [1024, 'XFE']]) {
    const file = await corepFile(corepChange(parts, xml => xml.replace('</sheetData>', `<row r="${row}"><c r="${column}${row}"/></row></sheetData>`)));
    await expect(preflightXlsx(file.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'EXPANSION_LIMIT' });
  }
});
test('own metadata sheets never inherit formula, external relationship or processing-instruction exceptions', async () => {
  const parts = await corepParts();
  const cases = [
    corepChange(parts, xml => corepReplaceCell(xml, 'B5', '<c r="B5"><f>1</f><v>1</v></c>'), 'xl/worksheets/sheet2.xml'),
    corepChange(parts, xml => xml.replace('?>', '?><?mso-contentType?>'), 'xl/worksheets/sheet3.xml'),
    [...parts, { name: 'xl/worksheets/_rels/sheet2.xml.rels', data: Buffer.from('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid" TargetMode="External"/></Relationships>'), compress: true }],
  ];
  for (const parts of cases) { const file = await corepFile(parts); await expect(preflightXlsx(file.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' }); }
});
test('CRC, duplicate entry and symbolic-link protections cover the whole package', async () => {
  const parts = await corepParts();
  const checksum = await corepFile(parts), bytes = await readFile(checksum.path); const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); bytes.writeUInt32LE(bytes.readUInt32LE(central + 16) ^ 1, central + 16); await writeFile(checksum.path, bytes);
  await expect(preflightXlsx(checksum.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  const duplicate = await corepFile([...parts, parts[0]!]); await expect(preflightXlsx(duplicate.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
  const link = await corepFile([...parts, { name: 'linked.xml', data: Buffer.from('target'), externalAttributes: 0xa0000000 }]); await expect(preflightXlsx(link.path, { profile: 'corep-ca1' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' });
});
