import { afterAll, expect, test } from 'vitest';
import { inspectReportWorkbook, normalizeInspectedReport } from '../../apps/api/src/import/profiles/registry.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { cleanupTypedDemoFiles, demoOracle, typedDemoFile } from '../helpers/typed-demo-fixtures.js';
import { changeXml, readZipParts, textCell } from '../helpers/xlsx-fixtures.js';
import { corepReplaceCell, corepAmount } from '../helpers/corep-fixtures.js';
import path from 'node:path';

async function patched(address: string, content: string, sheet = 2, epoch1904 = false) {
  const initial = await typedDemoFile(); let parts = changeXml(await readZipParts(initial.path), `xl/worksheets/sheet${sheet}.xml`, xml => corepReplaceCell(xml, address, content));
  if (epoch1904) parts = changeXml(parts, 'xl/workbook.xml', xml => xml.includes('<workbookPr') ? xml.replace(/<workbookPr\b[^>]*\/?\s*>/, tag => /date1904=/.test(tag) ? tag.replace(/date1904="[^"]*"/, 'date1904="1"') : tag.replace('<workbookPr', '<workbookPr date1904="1"')) : xml.replace('<sheets>', '<workbookPr date1904="1"/><sheets>'));
  return typedDemoFile(parts);
}
async function imported(file: Awaited<ReturnType<typeof typedDemoFile>>) { return normalizeInspectedReport(await inspectReportWorkbook(file.path), file.source); }
function dateFormat(parts: Awaited<ReturnType<typeof readZipParts>>, format: number) {
  return changeXml(parts, 'xl/styles.xml', xml => {
    const changed = xml.replace(/(<cellXfs\b[^>]*>\s*)<xf\b([^>]*)>/, (_match, start: string, attributes: string) => start + '<xf' + (/\bnumFmtId="/.test(attributes) ? attributes.replace(/\bnumFmtId="[^"]*"/, `numFmtId="${format}"`) : ` numFmtId="${format}"` + attributes) + '>');
    expect(changed).not.toBe(xml); return changed;
  });
}

afterAll(cleanupTypedDemoFiles);
test('recognizes a real typed workbook with readable fields and no user coordinates', async () => {
  const file = await typedDemoFile();
  const inspected = await inspectReportWorkbook(file.path);
  expect(inspected.profileId).toBe('ce-demo-types-1');
  expect(inspected.workbookContext).toMatchObject({ contextId: 'demo_types', framework: 'DEMO', moduleVersion: 'DEMO_TYPES_1' });
  const result = normalizeInspectedReport(inspected, file.source);
  expect(result.report.coordinates).toHaveLength(6); expect(result.report.facts).toHaveLength(6);
  for (const [index, field] of demoOracle.typed.fields.entries()) {
    expect(result.report.coordinates[index]).toMatchObject({ contextId: 'demo_types', tableCode: 'DEMO_TYPES', rowCode: field.rowCode, columnCode: '0010', dataType: field.type, unit: '', decimals: '', sourceLocator: { fileId: file.source.id, sheet: 'Datos', row: index + 4, column: 'A' } });
    expect(result.report.facts[index]).toMatchObject({ presence: 'value', normalizedValue: { kind: field.type, value: field.value }, sourceLocator: { fileId: file.source.id, sheet: 'Datos', row: index + 4, column: 'B' } });
  }
  expect(result.binding).toMatchObject({ sourceFileId: file.source.id, contextIds: ['demo_types'], profileId: 'ce-demo-types-1', selectedSheets: ['Datos'], excludedSheets: [], contextOrigin: 'workbook' });
  expect(result.binding.scaleExponent).toBeUndefined(); expect(result.binding.displayDecimals).toBeUndefined();
  expect(result.contextLocators?.filingIndicators).toEqual({ fileId: file.source.id, sheet: 'Contexto', row: 10, column: 'B' });
});

test('empty informed text is a value; Sin dato is explicit null and keeps its actual state locator', async () => {
  const informed = await imported(await typedDemoFile()), absent = await imported(await patched('C7', textCell('C7', 'Sin dato')));
  expect(informed.report.facts[3]).toMatchObject({ presence: 'value', normalizedValue: { kind: 'text', value: '' }, originalText: '' });
  expect(absent.report.facts[3]).toMatchObject({ presence: 'null', sourceLocator: { sheet: 'Datos', row: 7, column: 'C' } });
  expect(absent.report.facts[3]?.normalizedValue).toBeUndefined();
});
test.each([' Banco ', 'NULL', '=SUM(A1:A2)', '_x0041_', 'A\rB', 'é', 'e\u0301', '😀'])('text remains literal and exact: %s', async value => {
  const encoded = value.replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_').replace(/\r/g, '_x000D_');
  expect((await imported(await patched('B4', textCell('B4', encoded)))).report.facts[0]).toMatchObject({ originalText: value, normalizedValue: { kind: 'text', value } });
});
test.each([
  ['d', '0001-01-01', false, '0001-01-01'], ['d', '9999-12-31', false, '9999-12-31'],
  ['n', '45351', false, '2024-02-29'], ['n', '43889', true, '2024-02-29'],
  ['n', '59', false, '1900-02-28'], ['n', '61', false, '1900-03-01'], ['n', '0', true, '1904-01-01'],
  ['n', '45351.0', false, '2024-02-29'], ['n', '4.5351E4', false, '2024-02-29'],
] as const)('dates %s:%s with epoch1904=%s normalize to %s', async (type, value, epoch, expected) => {
  expect((await imported(await patched('B8', corepAmount('B8', value, type), 2, epoch))).report.facts[4]).toMatchObject({ originalText: value, normalizedValue: { kind: 'date', value: expected } });
});
test.each([['n', '60'], ['n', '45351.5'], ['n', '-1'], ['n', '999999999999999999'], ['d', '0000-01-01'], ['d', '2025-02-29'], ['d', '2024-02-29T00:00:00Z'], ['b', '1'], ['inlineStr', 'NULL'], ['inlineStr', '']])('rejects invalid informed date %s:%s at the value cell', async (type, value) => {
  await expect(imported(await patched('B8', corepAmount('B8', value, type)))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', locator: { sheet: 'Datos', row: 8, column: 'B' } });
});
test.each([
  ['C4', textCell('C4', '')], ['C4', textCell('C4', 'Otro')], ['C4', textCell('C4', 'Sin dato')],
  ['B4', corepAmount('B4', '23')], ['B4', corepAmount('B4', '1', 'b')], ['A4', textCell('A4', 'Categoría duplicada')],
  ['B4', corepAmount('B4', '', 'b')], ['B4', corepAmount('B4', '', 'e')],
  ['D4', textCell('D4', 'dato extra')],
])('rejects invalid state, type, label or extra content at %s', async (address, content) => {
  await expect(imported(await patched(address, content))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', locator: { sheet: 'Datos', row: Number(address.slice(1)), column: address[0] } });
});
test('context form must agree with workbook and cannot inject COREP metadata', async () => {
  const file = await typedDemoFile(), inspected = await inspectReportWorkbook(file.path);
  const form = { entityId: 'SYNTHETIC', referenceDate: '2025-12-31', submissionDate: '2025-12-31', filingIndicators: { DEMO_TYPES: true } };
  const result = normalizeInspectedReport(inspected, file.source, form);
  expect(result.binding.contextOrigin).toBe('form'); expect(result.contextLocators).toBeUndefined();
  expect(result.report.contexts[0]?.filingIndicatorsLocator).toBeUndefined();
  expect(() => normalizeInspectedReport(inspected, file.source, { ...form, entityId: 'OTHER' })).toThrowError('CONTEXT_MISMATCH');
  expect(() => normalizeInspectedReport(inspected, file.source, { ...form, currency: 'EUR' })).toThrowError('CONTEXT_MISMATCH');
  await expect(imported(await patched('B7', textCell('B7', 'COREP'), 3))).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH', locator: { sheet: 'Contexto', row: 7, column: 'B' } });
});
test('blank product template requires context and preserves six explicit missing fields when supplied by form', async () => {
  const template = await typedDemoFile(await readZipParts(path.resolve('assets/templates/demo-types.xlsx'))), inspected = await inspectReportWorkbook(template.path);
  expect(inspected.workbookContext).toBeUndefined();
  expect(() => normalizeInspectedReport(inspected, template.source)).toThrowError('MISSING_CONTEXT');
  const result = normalizeInspectedReport(inspected, template.source, { entityId: 'SYNTHETIC', referenceDate: '2025-12-31', filingIndicators: { DEMO_TYPES: false } });
  expect(result.report.facts).toHaveLength(6); expect(result.report.facts.every(fact => fact.presence === 'null')).toBe(true);
  expect(result.declaration).toMatchObject({ contextId: 'demo_types', filingIndicators: { DEMO_TYPES: false } }); expect(result.contextLocators).toBeUndefined();
});
test('date Sin dato with empty value is explicit null; incomplete workbook context is rejected', async () => {
  const initial = await typedDemoFile(), parts = changeXml(await readZipParts(initial.path), 'xl/worksheets/sheet2.xml', xml => corepReplaceCell(corepReplaceCell(xml, 'B8', textCell('B8', '')), 'C8', textCell('C8', 'Sin dato')));
  expect((await imported(await typedDemoFile(parts))).report.facts[4]).toMatchObject({ presence: 'null', sourceLocator: { sheet: 'Datos', row: 8, column: 'C' } });
  await expect(imported(await patched('B5', textCell('B5', ''), 3))).rejects.toMatchObject({ code: 'MISSING_CONTEXT', locator: { sheet: 'Contexto', row: 5, column: 'B' } });
});
test.each([9, 10, 18, 22, 45, 46, 47])('serial date with ambiguous number format %s is rejected', async format => {
  const initial = await patched('B8', corepAmount('B8', '45351', 'n', 0));
  const parts = dateFormat(await readZipParts(initial.path), format);
  await expect(imported(await typedDemoFile(parts))).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', locator: { sheet: 'Datos', row: 8, column: 'B' } });
});
test('date serial with a date-only visual format preserves the declared civil type', async () => {
  const initial = await patched('B8', corepAmount('B8', '45351', 'n', 0));
  const parts = dateFormat(await readZipParts(initial.path), 14);
  expect((await imported(await typedDemoFile(parts))).report.facts[4]?.normalizedValue).toEqual({ kind: 'date', value: '2024-02-29' });
});
test('typed profile remains strict for formulas, PI and external link parts', async () => {
  const file = await typedDemoFile(), original = await readZipParts(file.path);
  const variants = [
    changeXml(original, 'xl/worksheets/sheet2.xml', xml => corepReplaceCell(xml, 'B8', '<c r="B8"><f>1+1</f><v>2</v></c>')),
    [...original, { name: 'customXml/item2.xml', data: Buffer.from('<?mso-contentType?><root/>') }],
    [...original, { name: 'xl/externalLinks/externalLink1.xml', data: Buffer.from('<externalLink xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><externalBook/></externalLink>') }],
    [...original, { name: 'xl/worksheets/_rels/sheet2.xml.rels', data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="link" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.invalid/" TargetMode="External"/></Relationships>') }],
  ];
  for (const parts of variants) { const invalid = await typedDemoFile(parts); await expect(inspectReportWorkbook(invalid.path)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' }); await expect(preflightXlsx(invalid.path, { profile: 'demo-types' })).rejects.toMatchObject({ code: 'INVALID_WORKBOOK' }); }
});
test('cancellation and expanded byte accounting include both strict typed scans', async () => {
  const file = await typedDemoFile(), budget = { expandedBytes: 0 };
  const strict = await preflightXlsx(file.path), inspected = await inspectReportWorkbook(file.path, { budget });
  expect(inspected.preflight.expandedBytes).toBe(budget.expandedBytes); expect(budget.expandedBytes).toBeGreaterThanOrEqual(strict.expandedBytes);
  let checks = 0; await expect(inspectReportWorkbook(file.path, { check: () => { if (++checks > 3) throw new Error('cancelled'); } })).rejects.toThrow();
});
