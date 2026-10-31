import type { Coordinate, FactIdentity, ImportedReport, ReportContext, ReportedFact, SourceLocator } from '@ce/contracts';
import type { Ast, Expression, Selection } from '../../src/ast/ast.js';
import { parseRule } from '../../src/parser/parse-rule.js';
import { parseDecimal, rationalToDTO } from '../../src/numeric/rational.js';

/** Synthetic, in-memory ce-report-1 data; no official reporting claims or inferred indicators. */
export const SOURCE_FILE_ID = '00000000-0000-4000-8000-000000000032';
export const INDICATOR_LOCATOR: SourceLocator = { fileId: SOURCE_FILE_ID, sheet: 'Contexts', row: 2, column: 'H' };
export function context(overrides: Partial<ReportContext> = {}): ReportContext {
  const defaults = { contextId: 'demo', entityId: 'SYNTHETIC', referenceDate: '2026-06-30', submissionDate: '2026-06-30',
    framework: 'COREP', moduleVersion: 'COREP_OF_4.2', filingIndicators: {}, filingIndicatorsLocator: INDICATOR_LOCATOR };
  const data = { ...defaults, ...overrides };
  return { ...data, canonicalContextKey: overrides.canonicalContextKey ?? `synthetic:${data.entityId}:${data.referenceDate}:${data.moduleVersion}` };
}
export const DEMO_CONTEXT = context();

export type CoordinateOptions = {
  context?: ReportContext; table?: string; sheet?: string; row?: string; column?: string;
  dataType?: 'number' | 'boolean'; unit?: string; decimals?: string; sourceRow?: number;
};
export function coordinate(options: CoordinateOptions = {}): Coordinate {
  const ctx = options.context ?? DEMO_CONTEXT;
  const tableCode = options.table ?? 'T'; const sheetCode = options.sheet ?? '';
  const rowCode = options.row ?? '0010'; const columnCode = options.column ?? '0010';
  const dataType = options.dataType ?? 'number';
  return { factKey: JSON.stringify([ctx.canonicalContextKey, tableCode, sheetCode, rowCode, columnCode]), contextId: ctx.contextId,
    tableCode, sheetCode, rowCode, columnCode, dataType,
    unit: options.unit ?? (dataType === 'number' ? 'pure' : ''), decimals: options.decimals ?? (dataType === 'number' ? 'INF' : ''), axes: {},
    sourceLocator: { fileId: SOURCE_FILE_ID, sheet: 'Coordinates', row: options.sourceRow ?? 2, column: 'A' } };
}
export function identity(value: Coordinate): FactIdentity {
  const { factKey, contextId, tableCode, sheetCode, rowCode, columnCode } = value;
  return { factKey, contextId, tableCode, sheetCode, rowCode, columnCode };
}
export function fact(cell: Coordinate, value: string | boolean | null, sourceRow = 2): ReportedFact {
  const base = { ...identity(cell), sourceLocator: { fileId: SOURCE_FILE_ID, sheet: 'Facts', row: sourceRow, column: 'G' } };
  if (value === null) return { ...base, presence: 'null' };
  return { ...base, presence: 'value', originalText: String(value),
    normalizedValue: typeof value === 'boolean' ? value : rationalToDTO(parseDecimal(value)) };
}
export function report(coordinates: readonly Coordinate[], facts: readonly ReportedFact[] = [], contexts: readonly ReportContext[] = [DEMO_CONTEXT]): ImportedReport {
  return { contexts, coordinates, facts, diagnostics: [] };
}
export function rule(source: string): Ast {
  const parsed = parseRule(source);
  if (!parsed.ast) throw new Error(`Invalid test rule ${source}: ${JSON.stringify(parsed.diagnostics)}`);
  return parsed.ast;
}
/** Obtain an operand using real grammar without pretending numeric roots are validation rules. */
export function operand(source: string): Expression {
  const parsed = rule(`isnull(${source})`).body;
  if (parsed.kind !== 'call' || parsed.name !== 'isnull' || !parsed.arguments[0]) throw new Error('Expected operand wrapper.');
  return parsed.arguments[0];
}
export function selection(source: string): Selection {
  const node = operand(source);
  if (node.kind !== 'reference') throw new Error('Expected a coordinate selection.');
  return node.selection;
}
export function scope(source: string): Selection {
  const parsed = rule(`with ${source}: true`).body;
  if (parsed.kind !== 'with') throw new Error('Expected with scope.');
  return parsed.scope;
}
export function ref(cell: Coordinate): string {
  return `{t${cell.tableCode},r${cell.rowCode},c${cell.columnCode}${cell.sheetCode ? `,s${cell.sheetCode}` : ''}}`;
}
export function fraction(n: bigint, d = 1n) { return { n, d }; }

/** Proposed engine seams agreed for T037/T038; these are fixtures/types, not implementations. */
export type TestBinding = { contextId?: string; contextIds?: readonly string[]; tableCode?: string; sheetCode?: string; rowCode?: string; columnCode?: string };
export type ExpectedMetadataRead = { contextId: string; code: string; presence: 'declared' | 'missing'; value?: boolean; sourceLocator?: SourceLocator };
export const G113 = 'with{tC_18.00, c0060, s*, default: 0, interval: true}: {r0011} = {r0020} + {r0210}';
export function twoSheetReport(): ImportedReport {
  const ctx = context({ referenceDate: '2025-12-31', submissionDate: '2025-12-31', moduleVersion: 'COREP_OF_4.0', filingIndicators: { 'C_18.00': true } });
  const cells = ['0002', '0001'].flatMap(sheet => ['0210', '0011', '0020'].map(row => coordinate({ context: ctx, table: 'C_18.00', sheet, row, column: '0060', unit: 'EUR', decimals: '2' })));
  return report(cells, cells.map((cell, index) => fact(cell, cell.rowCode === '0011' ? '12' : cell.rowCode === '0020' ? '5' : '7', index + 2)), [ctx]);
}
