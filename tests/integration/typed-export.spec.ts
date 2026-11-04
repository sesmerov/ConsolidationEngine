import { afterAll, expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runValidation } from '@ce/engine';
import type { Snapshot } from '@ce/contracts';
import readXlsxFile from 'read-excel-file/node';
import { inspectReportWorkbook } from '../../apps/api/src/import/profiles/registry.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { exportLimits, writeResultsExport } from '../../apps/api/src/export/results-export.js';
import { changeXml, readZipParts, textCell } from '../helpers/xlsx-fixtures.js';
import { corepAmount, corepReplaceCell } from '../helpers/corep-fixtures.js';
import { cleanupVisualExports, exportVisual, importVisual, reimportVisual, visualBusiness, visualDemo, visualFile, visualHash, visualLegacy, visualOutput, visualSnapshot, visualStartedAt } from '../helpers/visual-export-harness.js';

afterAll(cleanupVisualExports);
const transport = (value: string) => value.replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_').replace(/\r/g, '_x000D_');
async function typedWith(cells: Readonly<Record<string, string>>) {
  const parts = changeXml(await readZipParts(path.resolve('assets/demos/demo-types-report.xlsx')), 'xl/worksheets/sheet2.xml', xml => Object.entries(cells).reduce((value, [address, replacement]) => corepReplaceCell(value, address, replacement), xml));
  return importVisual(await visualFile(parts), 'types');
}
async function typedResults(snapshot: Snapshot) {
  const bundle = runValidation(snapshot, { runId: randomUUID(), startedAt: visualStartedAt }), paths = await visualOutput();
  const data = { ...bundle, profileId: snapshot.content.profileId, versionId: snapshot.versionId, contentHash: snapshot.contentHash, contexts: snapshot.content.contexts,
    sources: snapshot.content.sources, catalog: { records: snapshot.content.catalog.records, variants: snapshot.content.catalog.variants, coverage: snapshot.content.catalog.coverage }, synthetic: true,
    ...(snapshot.content.reportSourceBindings ? { reportSourceBindings: snapshot.content.reportSourceBindings } : {}) };
  await writeResultsExport(data, paths, exportLimits(), () => {}, () => {});
  return { data, paths, json: JSON.parse(await readFile(paths.json, 'utf8')), sheets: await readXlsxFile(paths.xlsx, { parseNumber: text => text, trim: false }) };
}
test('typed report exports its visual Datos/Estado profile and all six business fields', async () => {
  const fixture = await visualDemo('types'), output = await exportVisual(fixture.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!);
  expect(inspected.profileId).toBe('ce-demo-types-1');
  expect(inspected.preflight.sheets.map(sheet => sheet.name).sort()).toEqual(['Contexto', 'Datos', 'Instrucciones']);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports))).toEqual(visualBusiness(fixture.snapshot.content));
});
test.each(['', '  Banco  ', 'NULL', 'é', 'e\u0301', '😀 &<>', '=SUM(A1:A2)', '@HYPERLINK("x")', '+1', '-1', 'A\rB\nC\tD', '_x0041_', '_x005F_x0041_'])('roundtrips exact informed text %j through two independent exports without double decoding', async value => {
  const fixture = await typedWith({ B4: textCell('B4', transport(value)) }), output = await exportVisual(fixture.snapshot);
  const first = await reimportVisual(fixture.files[0]!, output.paths.reports), secondOutput = await exportVisual(visualSnapshot(first)), second = await reimportVisual(fixture.files[0]!, secondOutput.paths.reports);
  for (const content of [fixture.snapshot.content, first, second]) {
    expect(content.facts.find(fact => fact.rowCode === '0010')).toMatchObject({ presence: 'value', originalText: value, normalizedValue: { kind: 'text', value } });
    expect(content.coordinates.every(coordinate => coordinate.unit === '' && coordinate.decimals === '')).toBe(true);
  }
  expect(visualBusiness(first)).toEqual(visualBusiness(fixture.snapshot.content)); expect(visualBusiness(second)).toEqual(visualBusiness(first));
  for (const part of await readZipParts(output.paths.reports[0]!)) expect(part.data.toString()).not.toMatch(/<(?:\w+:)?f\b|<hyperlink\b|TargetMode="External"/);
  for (const file of fixture.files) expect(visualHash(await readFile(file.path))).toBe(file.sha256);
});
test('Estado preserves empty informed text, explicit null text and explicit null date as different business facts', async () => {
  const fixture = await typedWith({ B4: textCell('B4', ''), B7: textCell('B7', ''), C7: textCell('C7', 'Sin dato'), B8: textCell('B8', ''), C8: textCell('C8', 'Sin dato') });
  const output = await exportVisual(fixture.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!), sheet = inspected.preflight.sheets.find(sheet => sheet.name === 'Datos')!;
  expect(sheet.cells.C4?.text).toBe('Informado'); expect(sheet.cells.B4?.text ?? '').toBe('');
  for (const row of [7, 8]) { expect(sheet.cells['C' + row]?.text).toBe('Sin dato'); expect(sheet.cells['B' + row]?.text ?? '').toBe(''); }
  const restored = await reimportVisual(fixture.files[0]!, output.paths.reports);
  expect(visualBusiness(restored)).toEqual(visualBusiness(fixture.snapshot.content));
  expect(restored.facts.find(fact => fact.rowCode === '0010')).toMatchObject({ presence: 'value', normalizedValue: { kind: 'text', value: '' } });
  expect(restored.facts.filter(fact => fact.presence === 'null')).toHaveLength(2);
});
test.each([['0001-01-01', 'd'], ['9999-12-31', 'd'], ['2024-02-29', 'inlineStr'], ['45351', 'n']] as const)('writes civil ISO dates from %s/%s without converting them to JS Date or serials', async (value, type) => {
  const fixture = await typedWith({ B8: corepAmount('B8', value, type) }), output = await exportVisual(fixture.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!);
  const raw = inspected.preflight.sheets.find(sheet => sheet.name === 'Datos')!.cells.B8!;
  expect(raw.text).toBe(type === 'n' ? '2024-02-29' : value); expect(['s', 'str', 'inlineStr', 'd']).toContain(raw.xmlType);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports))).toEqual(visualBusiness(fixture.snapshot.content));
});
test('typed source binding and manual context survive as explicit metadata without invented currency or precision', async () => {
  const fixture = await visualDemo('types'), manual = await importVisual(fixture.files[1]!, 'types', { source: 'form', declaration: { entityId: 'SYNTHETIC', referenceDate: '2025-12-31', submissionDate: '2025-12-31', filingIndicators: { DEMO_TYPES: true } } });
  expect(manual.snapshot.content.contexts[0]?.filingIndicatorsLocator).toBeUndefined();
  const output = await exportVisual(manual.snapshot), restored = await reimportVisual(manual.files[0]!, output.paths.reports);
  expect(output.log.reportSourceBindings).toEqual(manual.snapshot.content.reportSourceBindings);
  expect(restored.reportSourceBindings![0]).toMatchObject({ profileId: 'ce-demo-types-1', contextOrigin: 'workbook', contextIds: ['demo_types'] });
  expect(restored.reportSourceBindings![0]!.scaleExponent).toBeUndefined(); expect(restored.reportSourceBindings![0]!.displayDecimals).toBeUndefined();
  expect(restored.facts.every(fact => !fact.derivation)).toBe(true);
  expect(restored.sources.every(source => !manual.snapshot.content.sources.some(original => original.id === source.id))).toBe(true);
  expect(visualBusiness(restored)).toEqual(visualBusiness(manual.snapshot.content));
});
test('real typed validation results preserve JSON operands, reads, null presence and explicit text/date XLSX columns', async () => {
  const fixture = await typedWith({ B4: textCell('B4', '=SUM(A1:A2)'), B7: textCell('B7', ''), C7: textCell('C7', 'Sin dato') }), output = await typedResults(fixture.snapshot);
  expect(output.json).toEqual(output.data); expect(output.json.reportSourceBindings).toEqual(fixture.snapshot.content.reportSourceBindings);
  const facts = output.sheets.find(sheet => sheet.sheet === 'Facts')!, headers = facts.data[0]!.map(value => String(value));
  for (const header of ['dataType', 'text', 'date', 'presence', 'originalText', 'unit', 'decimals']) expect(headers).toContain(header);
  const rows = facts.data.slice(1).map(row => Object.fromEntries(headers.map((header, index) => [header, row[index] ?? ''])));
  expect(rows).toContainEqual(expect.objectContaining({ row: '0010', dataType: 'text', text: '=SUM(A1:A2)', originalText: '=SUM(A1:A2)', presence: 'value', unit: '', decimals: '' }));
  expect(rows).toContainEqual(expect.objectContaining({ row: '0040', dataType: 'text', text: '', presence: 'explicit_null' }));
  expect(rows).toContainEqual(expect.objectContaining({ row: '0050', dataType: 'date', date: '2024-02-29', unit: '', decimals: '' }));
  const binding = fixture.snapshot.content.reportSourceBindings![0]!;
  expect(output.sheets.find(sheet => sheet.sheet === 'ReportBindings')!.data[1]!.slice(0, 4)).toEqual([binding.sourceFileId, binding.profileId, binding.mappingSha256, 'workbook']);
  expect(output.sheets.find(sheet => sheet.sheet === 'ReportBindings')!.data[1]!.slice(4).every(value => value === null || value === '')).toBe(true);
  const readTypes = output.json.results.flatMap((result: { factReads: { coordinate: { dataType: string } }[] }) => result.factReads.map(read => read.coordinate.dataType));
  expect(readTypes).toContain('text'); expect(readTypes).toContain('date');
  for (const part of await readZipParts(output.paths.xlsx)) expect(part.data.toString()).not.toMatch(/<(?:\w+:)?f\b|<hyperlink\b|TargetMode="External"/);
});
test('result exports retain exact ST_Xstring literals once in the actual bounded workbook reader', async () => {
  const value = '_x005F_x0041_\r😀', fixture = await typedWith({ B4: textCell('B4', transport(value)) }), output = await typedResults(fixture.snapshot);
  const workbook = await preflightXlsx(output.paths.xlsx), values = workbook.sheets.flatMap(sheet => Object.values(sheet.cells).map(cell => cell.text));
  expect(values).toContain(value);
  expect(output.json.results.flatMap((result: { factReads: { originalText?: string }[] }) => result.factReads.map(read => read.originalText))).toContain(value);
});
test.each(['missing', 'wrong-type', 'invalid-date', 'non-xml-text'] as const)('rejects controlled incompatible typed state %s instead of silently changing its presence/type', async kind => {
  const fixture = await visualDemo('types'), facts = kind === 'missing' ? fixture.snapshot.content.facts.slice(1) : fixture.snapshot.content.facts.map((fact, index) => kind === 'invalid-date' && fact.rowCode === '0050' ? { ...fact, normalizedValue: { kind: 'date' as const, value: '2025-02-29' } } : index === 0 && kind === 'wrong-type' ? { ...fact, normalizedValue: { numerator: '1', denominator: '1' } } : index === 0 && kind === 'non-xml-text' ? { ...fact, normalizedValue: { kind: 'text' as const, value: '\u0000' }, originalText: '\u0000' } : fact);
  await expect(exportVisual(visualSnapshot({ ...fixture.snapshot.content, facts })).then(() => undefined)).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE' });
});
test('legacy v1 report and results retain their established output and exact numeric values', async () => {
  const fixture = await visualLegacy(), output = await exportVisual(fixture.snapshot), workbook = await preflightXlsx(output.paths.reports[0]!);
  expect(workbook.sheets.map(sheet => sheet.name)).toEqual(['Instructions', 'Contexts', 'Coordinates', 'Facts']);
  expect(output.log.reportSourceBindings).toBeUndefined();
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports, true))).toEqual(visualBusiness(fixture.snapshot.content));
  const results = await typedResults(fixture.snapshot);
  expect(results.json.profileId).toBe('ce-dpmxl-0.9-closed-v1'); expect(results.json.reportSourceBindings).toBeUndefined();
  const rows = results.sheets.find(sheet => sheet.sheet === 'Facts')!.data;
  expect(rows[0]).toContain('numerator'); expect(rows[0]).toContain('denominator');
  expect(results.json.results).toEqual(results.data.results);
  const restored = await reimportVisual(fixture.files[0]!, output.paths.reports, true);
  expect(restored.facts.some(fact => fact.originalText === '123456789012345678901234567890.123456789')).toBe(true);
});
