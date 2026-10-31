import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ReportContext, SourceFile } from '@ce/contracts';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import type { RawCell } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import type { RawWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import { importCatalog, variantApplicability, conflictingVariants } from '../../apps/api/src/import/eba-catalog.js';
import { excelDate } from '../../apps/api/src/import/excel-dates.js';
const file = 'tests/fixtures/generated/eba-subset.xlsx'; let workbook: RawWorkbook;
const source = (): SourceFile => ({ id: randomUUID(), sha256: 'a'.repeat(64), kind: 'catalog', displayName: 'subset.xlsx', size: 1, importedAt: '2026-10-31T00:00:00.000Z' });
const context: ReportContext = { canonicalContextKey: 'synthetic-context', contextId: 'demo', entityId: 'SYNTHETIC', framework: 'COREP', moduleVersion: 'COREP_OF_4.2', referenceDate: '2026-06-30', submissionDate: '2026-06-30', filingIndicators: { 'C_01.00': true, 'C_05.01': true } };
beforeAll(async () => { workbook = await readWorkbook(file, await preflightXlsx(file)); });
function changed(edit: (cells: Record<string, RawCell>) => void, maxRow = 4): RawWorkbook {
  const sheet = workbook.sheets[0]!; const cells = { ...sheet.cells }; edit(cells); return { ...workbook, sheets: [{ ...sheet, cells, maxRow }] };
}
function set(cells: Record<string, RawCell>, key: string, text: string) { cells[key] = { ...cells[key]!, xmlType: 'inlineStr', text, lexeme: text }; }
function copyRow(cells: Record<string, RawCell>, from: number, to: number) {
  for (const cell of Object.values(cells).filter((item) => item.row === from)) { const address = cell.address.replace(/\d+$/, String(to)); cells[address] = { ...cell, address, row: to }; }
}
describe('EBA catalogue metadata and variants', () => {
  it.each(['n', 'e', 'b', 'd'])('does not erase a date window when non-text XML type %s contains NULL', (xmlType) => {
    const cell: RawCell = { address: 'K3', row: 3, column: 11, xmlType, lexeme: 'NULL', text: 'NULL' };
    expect(() => excelDate(cell, false)).toThrowError(/INVALID_WORKBOOK/);
    const catalog = importCatalog(changed((cells) => { cells['K3'] = cell; }), source());
    expect(catalog.records[1]!.variantId).toBeUndefined();
    expect(catalog.records[1]!.diagnostics.some((item) => item.code === 'INVALID_RULE_DATE' && item.locator?.column === 'K')).toBe(true);
  });
  it('preserves three source rows, exact expressions/preconditions and their independent windows', () => {
    const catalog = importCatalog(workbook, source()); expect(catalog.records).toHaveLength(3); expect(catalog.variants).toHaveLength(3);
    const current = catalog.variants.find((rule) => rule.modules.includes('COREP_OF_4.2'))!;
    expect(current.tables).toEqual(['C_01.00', 'C_05.01']); expect(current.precondition).toBe('{v_C_01.00} and {v_C_05.01} ');
    expect(current.referenceWindow).toEqual({ from: '2026-03-31' }); expect(current.severity).toBe('warning');
    expect(catalog.records[1]!.originalFields['Description']).toBeNull();
    expect(variantApplicability(current, [context])).toBe('applicable');
    expect(variantApplicability(current, [{ ...context, referenceDate: '2026-03-31' }])).toBe('applicable');
    const { submissionDate: _submission, ...withoutSubmission } = context;
    expect(variantApplicability(current, [withoutSubmission])).toBe('not_evaluable');
    expect(catalog.variants.filter((rule) => variantApplicability(rule, [context]) === 'applicable')).toHaveLength(1);
  });
  it('keeps duplicate provenance and makes variant identity independent of source row/file', () => {
    const base = importCatalog(workbook, source());
    const duplicated = importCatalog(changed((cells) => copyRow(cells, 3, 5), 5), source());
    expect(duplicated.records).toHaveLength(4); expect(duplicated.variants).toHaveLength(3);
    expect(duplicated.records[3]!.diagnostics.some((item) => item.code === 'DUPLICATE_RULE')).toBe(true);
    expect(duplicated.variants.find((rule) => rule.sourceRecords.length === 2)?.sourceLocators.map((item) => item.row)).toEqual([3, 5]);
    expect(duplicated.variants.map((rule) => rule.variantId)).toEqual(base.variants.map((rule) => rule.variantId));
    const swapped = changed((cells) => { const original = { ...cells }; for (const cell of Object.values(original).filter((item) => item.row > 1)) { const row = 6 - cell.row; const address = cell.address.replace(/\d+$/, String(row)); cells[address] = { ...cell, row, address }; } });
    expect(importCatalog(swapped, source()).variants.map((rule) => rule.variantId)).toEqual(base.variants.map((rule) => rule.variantId));
  });
  it('keeps a malformed record and unknown severity visible without discarding valid rows', () => {
    const catalog = importCatalog(changed((cells) => { set(cells, 'J2', 'maybe'); set(cells, 'M3', 'critical'); }), source());
    expect(catalog.records).toHaveLength(3); expect(catalog.variants).toHaveLength(2);
    expect(catalog.records[0]!.diagnostics[0]?.code).toBe('INVALID_RULE_METADATA');
    expect(catalog.variants.find((rule) => rule.modules.includes('COREP_OF_4.2'))?.severity).toBe('unknown');
  });
  it('requires exact unambiguous headers and tokenizes only commas', () => {
    expect(() => importCatalog(changed((cells) => set(cells, 'H1', 'Precondition')), source())).toThrowError(/INVALID_WORKBOOK/);
    expect(() => importCatalog({ ...workbook, sheets: [workbook.sheets[0]!, { ...workbook.sheets[0]!, name: 'Second' }] }, source())).toThrowError(/INVALID_WORKBOOK/);
    const invalid = importCatalog(changed((cells) => set(cells, 'D3', 'COREP_OF_4.2,,COREP_LE_4.2')), source());
    expect(invalid.records[1]!.variantId).toBeUndefined();
    expect(invalid.records[1]!.diagnostics.some((item) => item.locator?.column === 'D')).toBe(true);
  });
  it('diagnoses incompatible overlapping variants instead of choosing one by row order', () => {
    const catalog = importCatalog(changed((cells) => { copyRow(cells, 3, 5); set(cells, 'G5', '1 = 2'); }, 5), source());
    const conflicts = conflictingVariants(catalog.variants, [context]); expect(conflicts.size).toBe(2);
    expect(conflictingVariants([...catalog.variants].reverse(), [context])).toEqual(conflicts);
  });
});
