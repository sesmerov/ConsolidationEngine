import type { Diagnostic, MetadataReadDTO } from '@ce/contracts';
import { PARSER_LIMITS, type Expression, type Selection } from '../ast/ast.js';
import { WorkLimitError, type WorkBudget } from '../execution/budget.js';
import { ordinal, reportIndex, resolveSelection, type ResolverReport } from './coordinates.js';
import { bindScope, mergeScope, type Binding } from './scope.js';
export interface StaticReads { readonly readKeys: readonly string[]; readonly metadataReads: readonly MetadataReadDTO[]; readonly diagnostics: readonly Diagnostic[] }
/** All syntactic branches contribute dependencies; with supplies context, not extra reads. */
export function collectExpressionReads(expression: Expression, context: { report: ResolverReport; binding: Binding; scope?: Selection; budget?: WorkBudget }): StaticReads {
  const readKeys = new Set<string>(), metadata = new Map<string, MetadataReadDTO>(), diagnostics: Diagnostic[] = [];
  function visit(node: Expression, scope: Selection | undefined, depth: number): void {
    context.budget?.check(); if (depth > PARSER_LIMITS.depth) throw new WorkLimitError('RESOURCE_LIMIT', 'AST dependency depth exceeded');
    switch (node.kind) {
      case 'number': case 'boolean': return;
      case 'group': visit(node.expression, scope, depth + 1); return;
      case 'with': visit(node.body, bindScope(mergeScope(node.scope, scope), context.binding), depth + 1); return;
      case 'unary': visit(node.operand, scope, depth + 1); return;
      case 'binary': visit(node.left, scope, depth + 1); visit(node.right, scope, depth + 1); return;
      case 'call': for (const argument of node.arguments) visit(argument, scope, depth + 1); return;
      case 'reference': {
        const selected = resolveSelection(node.selection, scope, context.report, context.binding, context.budget); diagnostics.push(...selected.diagnostics);
        for (const cell of selected.coordinates) { context.budget?.consume('reads'); readKeys.add(cell.factKey); } return;
      }
      case 'filing_indicator': {
        const reportContext = context.binding.contextId ? reportIndex(context.report, context.budget).contexts.get(context.binding.contextId) : undefined;
        if (!reportContext) { diagnostics.push({ code: 'AMBIGUOUS_REFERENCE', message: 'Filing indicators require one declared context', ...node.span }); return; }
        const declared = Object.hasOwn(reportContext.filingIndicators, node.code);
        metadata.set(JSON.stringify([reportContext.contextId, node.code]), { contextId: reportContext.contextId, code: node.code, presence: declared ? 'declared' : 'missing',
          ...(declared ? { value: reportContext.filingIndicators[node.code]! } : {}), ...(reportContext.filingIndicatorsLocator ? { sourceLocator: reportContext.filingIndicatorsLocator } : {}) }); return;
      }
    }
  }
  visit(expression, context.scope, 0);
  return { readKeys: [...readKeys].sort(ordinal), metadataReads: [...metadata.values()].sort((a, b) => ordinal(a.contextId, b.contextId) || ordinal(a.code, b.code)), diagnostics };
}
