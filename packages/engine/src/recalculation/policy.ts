import { LANGUAGE_PROFILE_V2 } from '@ce/contracts';
import type { DataType, Diagnostic, RecalculationPolicyDTO, RecalculationPolicyReason, Snapshot, ValidationBinding } from '@ce/contracts';
import { PARSER_LIMITS, type Expression, type Selection } from '../ast/ast.js';
import { WorkLimitError, type WorkBudget } from '../execution/budget.js';
import { parseRule } from '../parser/parse-rule.js';
import { languageProfile, snapshotProfileDiagnostics } from '../profiles/registry.js';
import { reportIndex, resolveSelection } from '../resolver/coordinates.js';
import { bindScope, mergeScope, type Binding } from '../resolver/scope.js';
import { outerScope } from '../resolver/instances.js';

export interface PolicyInput { readonly variantIds: readonly string[]; readonly binding?: ValidationBinding; readonly instanceId?: string }
export interface PolicyResult { readonly policy: RecalculationPolicyDTO; readonly diagnostics: readonly Diagnostic[] }
export interface ExpressionType { readonly dataType?: DataType; readonly multiple?: boolean }
export interface ExpressionInspection extends ExpressionType { readonly reasons: readonly RecalculationPolicyReason[]; readonly diagnostics: readonly Diagnostic[] }
const reasonOrder: readonly RecalculationPolicyReason[] = ['CONDITIONAL', 'TEXT', 'DATE'];

/** Resolve declarations and structure only. No fact values are read or added to execution traces. */
export function inspectExpression(expression: Expression, context: { snapshot: Snapshot; binding: Binding; scope?: Selection; budget?: WorkBudget }): ExpressionInspection {
  const reasons = new Set<RecalculationPolicyReason>(), diagnostics: Diagnostic[] = [];
  const issue = (message: string): ExpressionType => { if (diagnostics.length < 32) diagnostics.push({ code: 'TYPE_MISMATCH', message, severity: 'error' }); return {}; };
  const feature = (type: DataType): void => { if (type === 'text') reasons.add('TEXT'); if (type === 'date') reasons.add('DATE'); };
  const scalar = (type: ExpressionType): boolean => type.dataType !== undefined && !type.multiple;
  function visit(node: Expression, scope: Selection | undefined, depth: number): ExpressionType {
    context.budget?.check(); if (depth > PARSER_LIMITS.depth) throw new WorkLimitError('RESOURCE_LIMIT', 'Policy AST depth exceeded');
    switch (node.kind) {
      case 'number': return { dataType: 'number' };
      case 'boolean': return { dataType: 'boolean' };
      case 'group': return visit(node.expression, scope, depth + 1);
      case 'with': return visit(node.body, bindScope(mergeScope(node.scope, scope), context.binding), depth + 1);
      case 'reference': {
        const selected = resolveSelection(node.selection, scope, context.snapshot.content, context.binding, context.budget);
        diagnostics.push(...selected.diagnostics.slice(0, Math.max(0, 32 - diagnostics.length)));
        const types = new Set<DataType>();
        for (const cell of selected.coordinates) { context.budget?.consume('reads'); types.add(cell.dataType); feature(cell.dataType); }
        if (!selected.coordinates.length || types.size !== 1) return issue('Las referencias no tienen un tipo único resuelto.');
        const dataType = [...types][0]!, options = mergeScope(node.selection, scope);
        if (options.default && options.default.kind !== 'null' && options.default.kind !== dataType) issue('El valor por defecto no corresponde al tipo de la referencia.');
        if (options.interval && (dataType === 'text' || dataType === 'date')) issue('Los intervalos solo se admiten sobre datos numéricos.');
        return { dataType, ...(selected.coordinates.length > 1 ? { multiple: true } : {}) };
      }
      case 'filing_indicator': {
        if (!context.binding.contextId || !reportIndex(context.snapshot.content, context.budget).contexts.has(context.binding.contextId)) return issue('El indicador requiere un contexto declarado.');
        return { dataType: 'boolean' };
      }
      case 'unary': {
        const operand = visit(node.operand, scope, depth + 1), required = node.op === 'not' ? 'boolean' : 'number';
        return scalar(operand) && operand.dataType === required ? { dataType: required } : issue('El operando no corresponde al tipo del operador.');
      }
      case 'binary': {
        const left = visit(node.left, scope, depth + 1), right = visit(node.right, scope, depth + 1);
        if (!scalar(left) || !scalar(right) || left.dataType !== right.dataType) return issue('Los operandos no tienen tipos escalares compatibles.');
        if (node.op === 'and' || node.op === 'or') return left.dataType === 'boolean' ? { dataType: 'boolean' } : issue('Los operadores lógicos requieren booleanos.');
        if (['+', '-', '*', '/'].includes(node.op)) return left.dataType === 'number' ? { dataType: 'number' } : issue('La aritmética requiere números.');
        if (left.dataType === 'text' && node.op !== '=' && node.op !== '!=') return issue('El texto solo admite igualdad y desigualdad exactas.');
        if (left.dataType === 'boolean' && node.op !== '=' && node.op !== '!=') return issue('Los booleanos solo admiten igualdad y desigualdad.');
        return { dataType: 'boolean' };
      }
      case 'call': {
        const args = node.arguments.map(argument => visit(argument, scope, depth + 1));
        if (node.name === 'sum') return args.every(arg => arg.dataType === 'number') ? { dataType: 'number' } : issue('Sum requiere argumentos numéricos.');
        if (node.name === 'isnull') return args.length === 1 && scalar(args[0]!) ? { dataType: 'boolean' } : issue('Isnull requiere un argumento escalar resuelto.');
        return args.length === 2 && args.every(scalar) && args[0]!.dataType === args[1]!.dataType ? { dataType: args[0]!.dataType! } : issue('Nvl requiere dos argumentos del mismo tipo.');
      }
    }
  }
  const type = visit(expression, context.scope, 0);
  return { ...type, reasons: reasonOrder.filter(reason => reasons.has(reason)), diagnostics };
}

const memo = new WeakMap<WorkBudget, WeakMap<Snapshot, { content: Snapshot['content']; decisions: Map<string, PolicyResult> }>>();
/** Policy is never inferred from a result status, description or administrative validity date. */
export function getRecalculationPolicy(snapshot: Snapshot, input: PolicyInput, options: { budget?: WorkBudget } = {}): PolicyResult {
  const profileId = snapshot.content.profileId;
  const undetermined = (diagnostics: readonly Diagnostic[]): PolicyResult => ({ policy: { mode: 'undetermined', profileId, reasons: [] },
    diagnostics: diagnostics.length ? diagnostics : [{ code: 'INVALID_DIRECTION', message: 'No se ha completado la clasificación de la regla.', severity: 'error' }] });
  try {
    options.budget?.check();
    if (!languageProfile(profileId)) return undetermined([{ code: 'PROFILE_MISMATCH', message: 'El perfil del snapshot no está admitido.', severity: 'error' }]);
    const invalid = snapshotProfileDiagnostics(snapshot, options.budget); if (invalid.length) return undetermined(invalid);
    let cache: Map<string, PolicyResult> | undefined;
    if (options.budget) {
      let snapshots = memo.get(options.budget); if (!snapshots) memo.set(options.budget, snapshots = new WeakMap());
      let entry = snapshots.get(snapshot); if (!entry || entry.content !== snapshot.content) snapshots.set(snapshot, entry = { content: snapshot.content, decisions: new Map() });
      cache = entry.decisions;
    }
    const key = JSON.stringify([profileId, input.instanceId ?? null, [...input.variantIds].sort(), input.binding ?? null]);
    const cached = cache?.get(key); if (cached) return cached;
    const variants = input.variantIds.map(id => snapshot.content.catalog.variants.find(variant => variant.variantId === id));
    if (!variants.length || variants.some(v => !v) || new Set(input.variantIds).size !== input.variantIds.length) return undetermined([{ code: 'INVALID_DIRECTION', message: 'La regla no identifica variantes válidas.', severity: 'error' }]);
    const reasons = new Set<RecalculationPolicyReason>(), diagnostics: Diagnostic[] = [];
    for (const variant of variants) {
      options.budget?.check();
      const parsed = parseRule(variant!.expression, { profileId }), condition = variant!.precondition ? parseRule(variant!.precondition, { profileId }) : undefined;
      for (const expression of [parsed, condition]) if (expression) {
        if (!expression.ast || expression.supportStatus !== 'supported') { diagnostics.push(...expression.diagnostics); continue; }
        const result = inspectExpression(expression.ast.body, { snapshot, binding: input.binding ?? {}, ...(expression === condition && parsed.ast && outerScope(parsed.ast) ? { scope: outerScope(parsed.ast)! } : {}), ...(options.budget ? { budget: options.budget } : {}) });
        result.reasons.forEach(reason => reasons.add(reason)); diagnostics.push(...result.diagnostics);
      }
    }
    const excluded = profileId === LANGUAGE_PROFILE_V2 ? reasonOrder.filter(reason => reasons.has(reason)) : [];
    const result: PolicyResult = excluded.length ? { policy: { mode: 'validation_only', profileId, reasons: excluded }, diagnostics: [{ code: 'RULE_VALIDATION_ONLY', message: 'Esta regla contiene condicionales, texto o fechas y solo admite validación.', severity: 'info' }] }
      : diagnostics.length ? undetermined(diagnostics.slice(0, 32)) : { policy: { mode: 'standard', profileId, reasons: [] }, diagnostics: [] };
    cache?.set(key, result); return result;
  } catch (error) {
    if (error instanceof WorkLimitError) return undetermined([{ code: error.code, message: 'No se completó la clasificación dentro del presupuesto disponible.', severity: 'warning' }]);
    throw error;
  }
}
