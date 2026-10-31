import type { Coordinate, Diagnostic, SourceLocator } from '@ce/contracts';
import { PARSER_LIMITS, type Ast, type BinaryOperator, type Expression, type Selection } from '../ast/ast.js';
import { WorkBudget, WorkLimitError } from '../execution/budget.js';
import { fromPrecision, intervalAdd, intervalSubtract, intervalMultiply, intervalDivide, intervalNegate, intervalCompare } from '../numeric/interval.js';
import { NumericError, parseLanguageNumber, rational } from '../numeric/rational.js';
import { contextualUnits, parseUnit } from '../numeric/units.js';
import { ordinal, reportIndex, resolveSelection, type ResolverReport } from '../resolver/coordinates.js';
import { bindScope, mergeScope, type Binding } from '../resolver/scope.js';
import { applyDefault, isNull, logicalAnd, logicalOr, logicalNot, nvl, sumValues } from './nulls.js';
import { ValueError, type NumericScalar, type NullScalar, type ScalarValue } from './value.js';

export interface MetadataRead { readonly contextId: string; readonly code: string; readonly presence: 'declared' | 'missing'; readonly value?: boolean; readonly sourceLocator?: SourceLocator }
export interface EvaluationContext { readonly report: ResolverReport; readonly binding: Binding; readonly scope?: Selection; readonly budget?: WorkBudget }
export interface EvaluationResult {
  readonly value?: ScalarValue; readonly readKeys: readonly string[]; readonly metadataReads: readonly MetadataRead[];
  readonly diagnostics: readonly Diagnostic[]; readonly operands?: { readonly left?: ScalarValue; readonly right?: ScalarValue };
}
type NumericOperand = NumericScalar | (NullScalar & { readonly dataType: 'number' });
const comparisons = new Set<BinaryOperator>(['=', '!=', '<', '<=', '>', '>=']);
function numeric(value: ScalarValue): asserts value is NumericOperand {
  if (value.kind !== 'number' && !(value.kind === 'null' && value.dataType === 'number')) throw new ValueError('TYPE_MISMATCH', 'Numeric operand required');
}
function binary(op: Exclude<BinaryOperator, 'and' | 'or'>, left: ScalarValue, right: ScalarValue): ScalarValue {
  const type = (value: ScalarValue) => value.kind === 'null' || value.kind === 'unknown' ? value.dataType : value.kind;
  if (type(left) === 'boolean' || type(right) === 'boolean') {
    if (type(left) !== 'boolean' || type(right) !== 'boolean' || (op !== '=' && op !== '!=')) throw new ValueError('TYPE_MISMATCH');
    if (left.kind === 'unknown' || right.kind === 'unknown') return { kind: 'unknown', dataType: 'boolean' };
    if (left.kind === 'null' || right.kind === 'null') return { kind: 'null', origin: 'derived', dataType: 'boolean' };
    if (left.kind !== 'boolean' || right.kind !== 'boolean') throw new ValueError('TYPE_MISMATCH');
    return { kind: 'boolean', value: op === '=' ? left.value === right.value : left.value !== right.value };
  }
  if (left.kind === 'unknown' || right.kind === 'unknown') return { kind: 'unknown', dataType: comparisons.has(op) ? 'boolean' : 'number' };
  numeric(left); numeric(right);
  const unit = contextualUnits(op, left.unit, right.unit, left.kind === 'number' && left.literal, right.kind === 'number' && right.literal);
  if (left.kind === 'null' || right.kind === 'null') return comparisons.has(op)
    ? { kind: 'null', origin: 'derived', dataType: 'boolean' }
    : { kind: 'null', origin: 'derived', dataType: 'number', unit: unit.result };
  if (comparisons.has(op)) return { kind: 'boolean', value: intervalCompare(op as '=' | '!=' | '<' | '<=' | '>' | '>=', left, right) };
  const value = op === '+' ? intervalAdd(left, right) : op === '-' ? intervalSubtract(left, right) : op === '*' ? intervalMultiply(left, right) : intervalDivide(left, right);
  return { kind: 'number', ...value, unit: unit.result, literal: unit.resultLiteral };
}
/** Evaluates the closed AST only. Errors are diagnostics; job-wide limits propagate to the caller. */
export function evaluate(ast: Ast | Expression, context: EvaluationContext): EvaluationResult {
  const budget = context.budget ?? new WorkBudget(); budget.check();
  const index = reportIndex(context.report, budget), readKeys = new Set<string>(), metadata = new Map<string, MetadataRead>(), diagnostics: Diagnostic[] = [];
  let operands: EvaluationResult['operands'];
  const root = ast.kind === 'rule' ? ast.body : ast;
  let comparisonRoot = root;
  while (comparisonRoot.kind === 'with' || comparisonRoot.kind === 'group') comparisonRoot = comparisonRoot.kind === 'with' ? comparisonRoot.body : comparisonRoot.expression;
  function scalar(value: ScalarValue | readonly ScalarValue[] | undefined): ScalarValue | undefined {
    if (Array.isArray(value)) {
      if (value.length !== 1) { diagnostics.push({ code: 'AMBIGUOUS_REFERENCE', message: 'A scalar expression requires exactly one coordinate', severity: 'error' }); return undefined; }
      return value[0];
    }
    return value as ScalarValue | undefined;
  }
  function read(cell: Coordinate, selection: Selection): ScalarValue {
    budget.consume('reads'); readKeys.add(cell.factKey);
    const facts = index.facts.get(cell.factKey) ?? [];
    if (facts.length > 1) throw new ValueError('TYPE_MISMATCH', 'Several facts have the same canonical identity');
    const fact = facts[0]; const provenance = { coordinate: cell, sourceLocator: fact?.sourceLocator ?? cell.sourceLocator };
    let value: ScalarValue;
    if (!fact || fact.presence === 'null') {
      const base = { kind: 'null' as const, origin: fact ? 'explicit' as const : 'implicit' as const, ...provenance };
      value = cell.dataType === 'boolean' ? { ...base, dataType: 'boolean' } : { ...base, dataType: 'number', unit: parseUnit(cell.unit) };
    } else if (cell.dataType === 'boolean') {
      if (typeof fact.normalizedValue !== 'boolean') throw new ValueError('TYPE_MISMATCH');
      value = { kind: 'boolean', value: fact.normalizedValue, ...provenance };
    } else {
      if (!fact.normalizedValue || typeof fact.normalizedValue === 'boolean') throw new ValueError('TYPE_MISMATCH');
      const nominal = rational(BigInt(fact.normalizedValue.numerator), BigInt(fact.normalizedValue.denominator));
      value = { kind: 'number', ...fromPrecision(nominal, cell.decimals || undefined, selection.interval ?? false), unit: parseUnit(cell.unit), literal: false, ...provenance };
    }
    return applyDefault(value, selection.default);
  }
  function visit(node: Expression, scope: Selection | undefined, depth: number): ScalarValue | readonly ScalarValue[] | undefined {
    budget.check(); if (depth > PARSER_LIMITS.depth) throw new WorkLimitError('RESOURCE_LIMIT', 'AST evaluation depth exceeded');
    try {
      switch (node.kind) {
        case 'number': { const value = parseLanguageNumber(node.lexeme); return { kind: 'number', nominal: value, lo: value, hi: value, unit: {}, literal: true }; }
        case 'boolean': return { kind: 'boolean', value: node.value };
        case 'group': return visit(node.expression, scope, depth + 1);
        case 'with': return visit(node.body, bindScope(mergeScope(node.scope, scope), context.binding), depth + 1);
        case 'reference': {
          const resolved = resolveSelection(node.selection, scope, context.report, context.binding, budget);
          diagnostics.push(...resolved.diagnostics); if (resolved.diagnostics.length) return undefined;
          const selection = mergeScope(node.selection, bindScope(scope ?? { span: node.span }, context.binding));
          return resolved.coordinates.map(cell => read(cell, selection));
        }
        case 'filing_indicator': {
          const ctx = context.binding.contextId ? index.contexts.get(context.binding.contextId) : undefined;
          if (!ctx) { diagnostics.push({ code: 'AMBIGUOUS_REFERENCE', message: 'Filing indicators require one declared context', ...node.span }); return undefined; }
          const declared = Object.hasOwn(ctx.filingIndicators, node.code);
          const trace: MetadataRead = { contextId: ctx.contextId, code: node.code, presence: declared ? 'declared' : 'missing',
            ...(declared ? { value: ctx.filingIndicators[node.code]! } : {}), ...(ctx.filingIndicatorsLocator ? { sourceLocator: ctx.filingIndicatorsLocator } : {}) };
          metadata.set(JSON.stringify([ctx.contextId, node.code]), trace);
          return declared ? { kind: 'boolean', value: ctx.filingIndicators[node.code]! } : { kind: 'unknown', dataType: 'boolean' };
        }
        case 'unary': {
          const value = scalar(visit(node.operand, scope, depth + 1)); if (!value) return undefined;
          if (node.op === 'not') return logicalNot(value);
          numeric(value); if (value.kind === 'null' || node.op === '+') return value;
          return { ...value, ...intervalNegate(value) };
        }
        case 'binary': {
          const left = scalar(visit(node.left, scope, depth + 1)), right = scalar(visit(node.right, scope, depth + 1));
          if (node === comparisonRoot && comparisons.has(node.op)) operands = { ...(left ? { left } : {}), ...(right ? { right } : {}) };
          if (!left || !right) return undefined;
          return node.op === 'and' ? logicalAnd(left, right) : node.op === 'or' ? logicalOr(left, right) : binary(node.op, left, right);
        }
        case 'call': {
          const args = node.arguments.map(argument => visit(argument, scope, depth + 1));
          if (args.some(value => value === undefined)) return undefined;
          if (node.name === 'sum') {
            const result = sumValues(args.flatMap(value => Array.isArray(value) ? value : [value as ScalarValue]));
            diagnostics.push(...result.diagnostics.map(item => ({ ...item, ...node.span }))); return result.value;
          }
          const values = args.map(scalar); if (values.some(value => !value)) return undefined;
          return node.name === 'isnull' ? isNull(values[0]!) : nvl(values[0]!, values[1]!);
        }
      }
    } catch (error) {
      if (error instanceof WorkLimitError || (error instanceof NumericError && error.code === 'RESOURCE_LIMIT')) throw error;
      if (!(error instanceof NumericError) && !(error instanceof ValueError)) throw error;
      diagnostics.push({ code: error.code, message: error.message, severity: 'error', ...node.span }); return undefined;
    }
  }
  const value = scalar(visit(root, context.scope, 0));
  if (value?.kind === 'unknown' && [...metadata.values()].some(item => item.presence === 'missing')) diagnostics.push({ code: 'MISSING_FILING_INDICATOR', message: 'A required filing indicator is not declared', severity: 'warning' });
  return { ...(value ? { value } : {}), readKeys: [...readKeys].sort(ordinal), metadataReads: [...metadata.values()].sort((a, b) => ordinal(a.contextId, b.contextId) || ordinal(a.code, b.code)), diagnostics, ...(operands ? { operands } : {}) };
}
