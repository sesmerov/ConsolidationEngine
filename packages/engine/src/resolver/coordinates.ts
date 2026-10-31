import type { Coordinate, Diagnostic, ReportContext, ReportedFact, SnapshotContent } from '@ce/contracts';
import type { AxisSelector, Selection } from '../ast/ast.js';
import type { WorkBudget } from '../execution/budget.js';
import { bindScope, mergeScope, type Binding } from './scope.js';
export type ResolverReport = Pick<SnapshotContent, 'contexts' | 'coordinates' | 'facts'>;
export const ordinal = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export interface ResolverIndex {
  readonly contexts: ReadonlyMap<string, ReportContext>;
  readonly tables: ReadonlyMap<string, ReadonlyMap<string, readonly Coordinate[]>>;
  readonly facts: ReadonlyMap<string, readonly ReportedFact[]>;
}
const indexes = new WeakMap<ResolverReport, ResolverIndex>();
export function reportIndex(report: ResolverReport, budget?: WorkBudget): ResolverIndex {
  const cached = indexes.get(report); if (cached) return cached;
  const contexts = new Map(report.contexts.map(context => [context.contextId, context]));
  const tables = new Map<string, Map<string, Coordinate[]>>(); const facts = new Map<string, ReportedFact[]>();
  for (const cell of report.coordinates) {
    budget?.check(); let table = tables.get(cell.contextId); if (!table) tables.set(cell.contextId, table = new Map());
    const cells = table.get(cell.tableCode); if (cells) cells.push(cell); else table.set(cell.tableCode, [cell]);
  }
  for (const table of tables.values()) for (const cells of table.values()) cells.sort((a, b) => ordinal(a.sheetCode, b.sheetCode) || ordinal(a.rowCode, b.rowCode) || ordinal(a.columnCode, b.columnCode) || ordinal(a.factKey, b.factKey));
  for (const fact of report.facts) { budget?.check(); const values = facts.get(fact.factKey); if (values) values.push(fact); else facts.set(fact.factKey, [fact]); }
  const result = { contexts, tables, facts }; indexes.set(report, result); return result;
}
function matches(axis: AxisSelector | undefined, code: string): boolean {
  if (!axis) return true;
  switch (axis.kind) {
    case 'single': return code === axis.code;
    case 'list': return axis.codes.includes(code);
    case 'range': return ordinal(code, axis.from) >= 0 && ordinal(code, axis.to) <= 0;
    case 'all': return code !== '';
  }
}
export function resolveSelection(local: Selection, outer: Selection | undefined, report: ResolverReport, binding: Binding, budget?: WorkBudget): { coordinates: readonly Coordinate[]; diagnostics: Diagnostic[] } {
  budget?.check(); const selection = mergeScope(local, bindScope(outer ?? { span: local.span }, binding));
  const index = reportIndex(report, budget);
  const contextIds = binding.contextIds ?? (binding.contextId ? [binding.contextId] : [...index.contexts.keys()]);
  const keys = new Set(contextIds.map(id => index.contexts.get(id)?.canonicalContextKey));
  const aliases = [...index.contexts.values()].filter(context => keys.has(context.canonicalContextKey)).map(context => context.contextId);
  const candidates = aliases.filter(id => selection.tableCode && index.tables.get(id)?.has(selection.tableCode));
  const diagnostic = (code: string, message: string) => ({ coordinates: [], diagnostics: [{ code, message, ...selection.span, severity: 'error' as const }] });
  if (new Set(candidates.map(id => index.contexts.get(id)!.canonicalContextKey)).size > 1) return diagnostic('AMBIGUOUS_REFERENCE', 'Reference matches several module contexts');
  if (!candidates.length || !selection.tableCode) return diagnostic('UNKNOWN_COORDINATE', 'Table or context is not declared in the coordinate catalog');
  const source = candidates.length === 1 ? index.tables.get(candidates[0]!)!.get(selection.tableCode)!
    : candidates.flatMap(id => index.tables.get(id)!.get(selection.tableCode!)!).sort((a, b) => ordinal(a.sheetCode, b.sheetCode) || ordinal(a.rowCode, b.rowCode) || ordinal(a.columnCode, b.columnCode));
  const coordinates = source.filter(cell => { budget?.check(); return matches(selection.sheet, cell.sheetCode) && matches(selection.row, cell.rowCode) && matches(selection.column, cell.columnCode); });
  if (new Set(coordinates.map(cell => cell.factKey)).size !== coordinates.length) return diagnostic('AMBIGUOUS_REFERENCE', 'Coordinate catalog contains duplicate identities');
  const finite = [selection.sheet, selection.row, selection.column].some(axis => axis && axis.kind !== 'single');
  if (!coordinates.length && !finite) return diagnostic('UNKNOWN_COORDINATE', 'Coordinate is not declared in the catalog');
  return { coordinates, diagnostics: [] };
}
