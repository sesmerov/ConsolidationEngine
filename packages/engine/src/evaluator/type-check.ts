import { isCivilDateV2, LANGUAGE_PROFILE_V1, LANGUAGE_PROFILE_V2, type DataType, type Diagnostic, type RecalculationPolicyReason } from '@ce/contracts';
import { PARSER_LIMITS, type Expression, type Selection, type SourceSpan } from '../ast/ast.js';
import { WorkLimitError, type WorkBudget } from '../execution/budget.js';
import { contextualUnits, parseUnit, unitsEqual, type UnitMap } from '../numeric/units.js';
import { reportIndex, resolveSelection, type ResolverReport } from '../resolver/coordinates.js';
import { bindScope, mergeScope, type Binding } from '../resolver/scope.js';
import { ValueError } from './value.js';

export interface ExpressionType { readonly dataType?: DataType; readonly multiple?: boolean; readonly unit?: UnitMap; readonly literal?: boolean }
export interface TypeCheckResult extends ExpressionType {
  readonly reasons: readonly RecalculationPolicyReason[]; readonly diagnostics: readonly Diagnostic[];
  readonly nodeTypes: ReadonlyMap<Expression, ExpressionType>;
}
export interface TypeCheckContext {
  readonly profileId?: string; readonly report?: ResolverReport; readonly binding?: Binding; readonly scope?: Selection;
  readonly budget?: WorkBudget; readonly requireBoolean?: boolean;
  /** Evaluation can preserve a numeric empty aggregation; eligibility still requires resolved declarations. */
  readonly allowEmptyAggregation?: boolean;
}
const reasonOrder: readonly RecalculationPolicyReason[] = ['CONDITIONAL', 'TEXT', 'DATE'];
/** Partial without report metadata, complete after binding. Never evaluates a fact or a branch. */
export function checkExpression(expression: Expression, context: TypeCheckContext = {}): TypeCheckResult {
  const profileId = context.profileId ?? LANGUAGE_PROFILE_V1, binding = context.binding ?? {};
  const reasons = new Set<RecalculationPolicyReason>(), diagnostics: Diagnostic[] = [], nodeTypes = new Map<Expression, ExpressionType>();
  function issue(code: string, message: string, span: SourceSpan): ExpressionType {
    if (diagnostics.length < 32) diagnostics.push({ code, message, severity: 'error', ...span }); return {};
  }
  function feature(type: DataType, span: SourceSpan): void {
    if (type === 'text' || type === 'date') {
      reasons.add(type === 'text' ? 'TEXT' : 'DATE');
      if (profileId !== LANGUAGE_PROFILE_V2) issue('UNSUPPORTED_CONSTRUCT', 'El perfil v1 no admite texto ni fechas.', span);
    }
  }
  function options(selection: Selection): void {
    const value = selection.default;
    if (value && value.kind !== 'null') { feature(value.kind, value.span); if (value.kind === 'date' && !isCivilDateV2(value.value)) issue('INVALID_DATE', 'La fecha civil no es válida entre 0001 y 9999.', value.span); }
  }
  function scalar(type: ExpressionType, span: SourceSpan): boolean {
    if (type.multiple) { issue('AMBIGUOUS_REFERENCE', 'La expresión requiere una sola coordenada.', span); return false; }
    return true;
  }
  function expected(type: ExpressionType, required: DataType, span: SourceSpan): void {
    scalar(type, span); if (type.dataType !== undefined && type.dataType !== required) issue('TYPE_MISMATCH', `El operando debe tener tipo ${required}.`, span);
  }
  function compatible(a: ExpressionType, b: ExpressionType, span: SourceSpan): ExpressionType {
    scalar(a, span); scalar(b, span);
    if (a.dataType && b.dataType && a.dataType !== b.dataType) return issue('TYPE_MISMATCH', 'Los operandos o ramas deben tener el mismo tipo.', span);
    const dataType = a.dataType ?? b.dataType;
    if (dataType === 'number' && a.unit && b.unit) {
      const units = contextualUnits('nvl', a.unit, b.unit, a.literal, b.literal);
      return { dataType, unit: units.result, literal: units.resultLiteral };
    }
    return dataType ? { ...(!a.dataType ? b : a), dataType } : {};
  }
  function visit(node: Expression, scope: Selection | undefined, depth: number, aggregation = false): ExpressionType {
    context.budget?.check(); if (depth > PARSER_LIMITS.depth) throw new WorkLimitError('RESOURCE_LIMIT', 'AST type-check depth exceeded');
    let result: ExpressionType;
    try { result = infer(node, scope, depth, aggregation); }
    catch (error) { if (!(error instanceof ValueError)) throw error; result = issue(error.code, error.message, node.span); }
    nodeTypes.set(node, result); return result;
  }
  function infer(node: Expression, scope: Selection | undefined, depth: number, aggregation: boolean): ExpressionType {
    switch (node.kind) {
      case 'number': return { dataType: 'number', unit: {}, literal: true };
      case 'boolean': return { dataType: 'boolean' };
      case 'filing_indicator':
        if (context.report && (!binding.contextId || !reportIndex(context.report, context.budget).contexts.has(binding.contextId))) return issue('AMBIGUOUS_REFERENCE', 'El indicador requiere un contexto declarado.', node.span);
        return { dataType: 'boolean' };
      case 'text': case 'date': {
        feature(node.kind, node.span);
        if (node.kind === 'date' && !isCivilDateV2(node.value)) issue('INVALID_DATE', 'La fecha civil no es válida entre 0001 y 9999.', node.span);
        return { dataType: node.kind };
      }
      case 'group': return visit(node.expression, scope, depth + 1, aggregation);
      case 'with': options(node.scope); return visit(node.body, bindScope(mergeScope(node.scope, scope), binding), depth + 1, aggregation);
      case 'reference': {
        options(node.selection);
        if (!context.report) return {};
        const selected = resolveSelection(node.selection, scope, context.report, binding, context.budget);
        diagnostics.push(...selected.diagnostics.slice(0, Math.max(0, 32 - diagnostics.length)));
        if (!selected.coordinates.length) {
          if (aggregation && context.allowEmptyAggregation && !selected.diagnostics.length) return { dataType: 'number', unit: {}, multiple: true };
          return issue('TYPE_MISMATCH', 'La referencia no tiene un tipo declarado resuelto.', node.span);
        }
        const types = new Set<DataType>(); let unit: UnitMap | undefined;
        for (const cell of selected.coordinates) {
          context.budget?.consume('reads'); types.add(cell.dataType); feature(cell.dataType, node.span);
          if (cell.dataType === 'number') { const current = parseUnit(cell.unit); if (unit && !unitsEqual(unit, current)) issue('UNIT_MISMATCH', 'La selección mezcla unidades incompatibles.', node.span); unit ??= current; }
        }
        if (types.size !== 1) return issue('TYPE_MISMATCH', 'La selección mezcla tipos incompatibles.', node.span);
        const dataType = [...types][0]!, selection = mergeScope(node.selection, bindScope(scope ?? { span: node.span }, binding));
        if (selection.default && selection.default.kind !== 'null' && selection.default.kind !== dataType) issue('TYPE_MISMATCH', 'El valor por defecto no corresponde al tipo de la coordenada.', selection.default.span);
        if (selection.interval && (dataType === 'text' || dataType === 'date')) issue('TYPE_MISMATCH', 'Los intervalos no se admiten sobre texto ni fechas.', node.span);
        return { dataType, ...(unit ? { unit, literal: false } : {}), ...(selected.coordinates.length > 1 ? { multiple: true } : {}) };
      }
      case 'unary': {
        const operand = visit(node.operand, scope, depth + 1), required = node.op === 'not' ? 'boolean' : 'number'; expected(operand, required, node.operand.span);
        return { ...operand, dataType: required };
      }
      case 'binary': {
        const a = visit(node.left, scope, depth + 1), b = visit(node.right, scope, depth + 1);
        scalar(a, node.left.span); scalar(b, node.right.span);
        if (node.op === 'and' || node.op === 'or') { expected(a, 'boolean', node.left.span); expected(b, 'boolean', node.right.span); return { dataType: 'boolean' }; }
        const arithmetic = ['+', '-', '*', '/'].includes(node.op);
        if (arithmetic) { expected(a, 'number', node.left.span); expected(b, 'number', node.right.span); }
        else {
          if (a.dataType && b.dataType && a.dataType !== b.dataType) issue('TYPE_MISMATCH', 'No se pueden comparar tipos incompatibles.', node.span);
          if (node.op !== '=' && node.op !== '!=' && [a.dataType, b.dataType].some(type => type === 'text' || type === 'boolean')) issue('TYPE_MISMATCH', 'Este tipo solo admite igualdad y desigualdad.', node.span);
        }
        if (a.dataType === 'number' && b.dataType === 'number' && a.unit && b.unit) {
          const units = contextualUnits(node.op, a.unit, b.unit, a.literal, b.literal);
          return arithmetic ? { dataType: 'number', unit: units.result, literal: units.resultLiteral } : { dataType: 'boolean' };
        }
        return { dataType: arithmetic ? 'number' : 'boolean' };
      }
      case 'call': {
        const args = node.arguments.map(arg => visit(arg, scope, depth + 1, node.name === 'sum'));
        if (node.name === 'sum') {
          for (const type of args) if (type.dataType && type.dataType !== 'number') issue('TYPE_MISMATCH', 'Sum requiere argumentos numéricos.', node.span);
          return { dataType: 'number', ...(args[0]?.unit ? { unit: args[0].unit, literal: false } : {}) };
        }
        if (node.name === 'isnull') { if (args[0]) scalar(args[0], node.span); return { dataType: 'boolean' }; }
        return compatible(args[0] ?? {}, args[1] ?? {}, node.span);
      }
      case 'if': {
        reasons.add('CONDITIONAL'); if (profileId !== LANGUAGE_PROFILE_V2) issue('UNSUPPORTED_CONSTRUCT', 'El perfil v1 no admite condicionales.', node.span);
        expected(visit(node.condition, scope, depth + 1), 'boolean', node.condition.span);
        const then = visit(node.then, scope, depth + 1), otherwise = node.else ? visit(node.else, scope, depth + 1) : undefined;
        scalar(then, node.then.span); return otherwise ? compatible(then, otherwise, node.span) : then;
      }
    }
    const unhandled: never = node; return issue('UNSUPPORTED_CONSTRUCT', 'Nodo fuera del AST cerrado.', (unhandled as Expression).span);
  }
  if (profileId !== LANGUAGE_PROFILE_V1 && profileId !== LANGUAGE_PROFILE_V2) issue('PROFILE_MISMATCH', 'El perfil del lenguaje no está admitido.', expression.span);
  const type = visit(expression, context.scope, 0);
  if (context.requireBoolean) expected(type, 'boolean', expression.span);
  return { ...type, reasons: reasonOrder.filter(reason => reasons.has(reason)), diagnostics, nodeTypes };
}
