import type { AxisSelector, Selection } from '../ast/ast.js';
export interface Binding {
  readonly contextId?: string; readonly contextIds?: readonly string[];
  readonly tableCode?: string; readonly sheetCode?: string; readonly rowCode?: string; readonly columnCode?: string;
}
/** A new table resets coordinates, but options have independent lexical inheritance. */
export function mergeScope(local: Selection, outer?: Selection): Selection {
  const sameTable = !local.tableCode || local.tableCode === outer?.tableCode;
  if (sameTable || !outer) return { ...outer, ...local };
  const { row: _row, column: _column, sheet: _sheet, ...options } = outer;
  return { ...options, ...local };
}
export function bindScope(selection: Selection, binding: Binding): Selection {
  if (binding.tableCode && selection.tableCode !== binding.tableCode) return selection;
  const bound = (axis: AxisSelector | undefined, value: string | undefined): AxisSelector | undefined =>
    value !== undefined && axis && axis.kind !== 'single' ? { kind: 'single', code: value, span: axis.span } : axis;
  const row = bound(selection.row, binding.rowCode), column = bound(selection.column, binding.columnCode), sheet = bound(selection.sheet, binding.sheetCode);
  return { ...selection, ...(row ? { row } : {}), ...(column ? { column } : {}), ...(sheet ? { sheet } : {}) };
}
