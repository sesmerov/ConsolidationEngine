import { LANGUAGE_PROFILE_V2 } from '@ce/contracts';
import type { Diagnostic, RecalculationPolicyDTO, RecalculationPolicyReason, Snapshot, ValidationBinding } from '@ce/contracts';
import type { Expression, Selection } from '../ast/ast.js';
import { WorkLimitError, type WorkBudget } from '../execution/budget.js';
import { parseRule } from '../parser/parse-rule.js';
import { languageProfile, snapshotProfileDiagnostics } from '../profiles/registry.js';
import type { Binding } from '../resolver/scope.js';
import { outerScope } from '../resolver/instances.js';
import { checkExpression, type ExpressionType } from '../evaluator/type-check.js';

export interface PolicyInput { readonly variantIds: readonly string[]; readonly binding?: ValidationBinding; readonly instanceId?: string }
export interface PolicyResult { readonly policy: RecalculationPolicyDTO; readonly diagnostics: readonly Diagnostic[] }
export type { ExpressionType } from '../evaluator/type-check.js';
export interface ExpressionInspection extends ExpressionType { readonly reasons: readonly RecalculationPolicyReason[]; readonly diagnostics: readonly Diagnostic[] }
const reasonOrder: readonly RecalculationPolicyReason[] = ['CONDITIONAL', 'TEXT', 'DATE'];

/** Resolve declarations and structure only. No fact values are read or added to execution traces. */
export function inspectExpression(expression: Expression, context: { snapshot: Snapshot; binding: Binding; scope?: Selection; budget?: WorkBudget }): ExpressionInspection {
  const { nodeTypes: _nodes, ...result } = checkExpression(expression, { profileId: context.snapshot.content.profileId, report: context.snapshot.content,
    binding: context.binding, ...(context.scope ? { scope: context.scope } : {}), ...(context.budget ? { budget: context.budget } : {}) });
  return result;
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
