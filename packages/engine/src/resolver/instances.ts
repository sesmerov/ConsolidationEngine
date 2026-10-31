/// <reference types="node" />
import { createHash } from 'node:crypto';
import type { Diagnostic } from '@ce/contracts';
import type { Ast, Expression, Selection } from '../ast/ast.js';
import type { WorkBudget } from '../execution/budget.js';
import { ordinal, reportIndex, resolveSelection, type ResolverReport } from './coordinates.js';
import { mergeScope, type Binding } from './scope.js';
export interface RuleInstance { readonly instanceId: string; readonly binding: Binding }
export function stableId(parts: unknown): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }
export function outerScope(ast: Ast | Expression): Selection | undefined {
  let expression: Expression = ast.kind === 'rule' ? ast.body : ast; let scope: Selection | undefined;
  while (expression.kind === 'group' || expression.kind === 'with') {
    if (expression.kind === 'group') expression = expression.expression;
    else { scope = mergeScope(expression.scope, scope); expression = expression.body; }
  }
  return scope;
}
export function expandRuleInstances(ast: Ast, report: ResolverReport, options: { contextId: string; contextIds?: readonly string[]; ruleKey: string; budget?: WorkBudget }): { instances: RuleInstance[]; diagnostics: Diagnostic[] } {
  const context = reportIndex(report, options.budget).contexts.get(options.contextId);
  if (!context) return { instances: [], diagnostics: [{ code: 'UNKNOWN_CONTEXT', message: 'Context is not declared' }] };
  const scope = outerScope(ast); const base: Binding = { contextId: options.contextId, ...(options.contextIds ? { contextIds: options.contextIds } : {}) }; let bindings: Binding[] = [base];
  if (scope) {
    const multiple = [scope.row, scope.column, scope.sheet].some(axis => axis && axis.kind !== 'single');
    if (multiple) {
      const resolved = resolveSelection(scope, undefined, report, bindings[0]!, options.budget);
      if (resolved.diagnostics.length) return { instances: [], diagnostics: resolved.diagnostics };
      const unique = new Map<string, Binding>();
      for (const cell of resolved.coordinates) {
        options.budget?.check();
        const binding: Binding = { ...base, ...(scope.tableCode ? { tableCode: scope.tableCode } : {}),
          ...(scope.sheet ? { sheetCode: cell.sheetCode } : {}), ...(scope.row ? { rowCode: cell.rowCode } : {}), ...(scope.column ? { columnCode: cell.columnCode } : {}) };
        unique.set(JSON.stringify(binding), binding);
      }
      bindings = [...unique.values()].sort((a, b) => ordinal(a.sheetCode ?? '', b.sheetCode ?? '') || ordinal(a.rowCode ?? '', b.rowCode ?? '') || ordinal(a.columnCode ?? '', b.columnCode ?? ''));
      if (!bindings.length) return { instances: [], diagnostics: [{ code: 'EMPTY_SELECTION', message: 'The rule has no declared binding in the coordinate catalog', ...scope.span }] };
    } else bindings = [{ ...base, ...(scope.tableCode ? { tableCode: scope.tableCode } : {}),
      ...(scope.sheet?.kind === 'single' ? { sheetCode: scope.sheet.code } : {}), ...(scope.row?.kind === 'single' ? { rowCode: scope.row.code } : {}), ...(scope.column?.kind === 'single' ? { columnCode: scope.column.code } : {}) }];
  }
  const instances = bindings.map(binding => {
    options.budget?.consume('instances');
    const compatibleKeys = [...new Set((options.contextIds ?? [options.contextId]).map(id => reportIndex(report).contexts.get(id)?.canonicalContextKey ?? id))].sort(ordinal);
    return { instanceId: stableId([options.ruleKey, context.canonicalContextKey, compatibleKeys, binding.tableCode ?? '', binding.sheetCode ?? '', binding.rowCode ?? '', binding.columnCode ?? '']), binding };
  });
  return { instances, diagnostics: [] };
}
