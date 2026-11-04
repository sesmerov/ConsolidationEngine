import type { Coordinate, Diagnostic, DirectionDTO, RuleVariant, Snapshot } from '@ce/contracts';
import type { Ast, Expression, Selection } from '../ast/ast.js';
import { WorkLimitError, type WorkBudget } from '../execution/budget.js';
import { parseRule, type ParseRuleResult } from '../parser/parse-rule.js';
import { ordinal, reportIndex, resolveSelection } from '../resolver/coordinates.js';
import { expandRuleInstances, stableId, type RuleInstance } from '../resolver/instances.js';
import { bindScope, mergeScope, type Binding } from '../resolver/scope.js';
import { collectExpressionReads } from '../resolver/static-reads.js';
import { effectiveRuleKey } from '../validation/run.js';
import { LANGUAGE_PROFILE_V2 } from '@ce/contracts';
import { getRecalculationPolicy, inspectExpression } from './policy.js';
import { snapshotProfileDiagnostics } from '../profiles/registry.js';

export type DirectionInput = Pick<DirectionDTO, 'instanceId' | 'variantIds' | 'binding' | 'targetSide'> & Partial<Pick<DirectionDTO, 'id' | 'targetKey'>>;
export interface ResolvedDirection {
  readonly direction: DirectionDTO; readonly ast: Ast; readonly precondition?: Ast; readonly binding: Binding;
  readonly target: Coordinate; readonly source: Expression; readonly scope?: Selection;
}
interface ResolutionCache { parses: Map<string, ParseRuleResult>; expansions: Map<string, readonly RuleInstance[]> }
// Reuse only within one bounded operation; nothing is retained across HTTP requests.
const workCaches = new WeakMap<WorkBudget, WeakMap<Snapshot, ResolutionCache>>();
function workCache(snapshot: Snapshot, budget?: WorkBudget): ResolutionCache {
  if (!budget) return { parses: new Map(), expansions: new Map() };
  let snapshots = workCaches.get(budget); if (!snapshots) workCaches.set(budget, snapshots = new WeakMap());
  let cache = snapshots.get(snapshot); if (!cache) snapshots.set(snapshot, cache = { parses: new Map(), expansions: new Map() }); return cache;
}
function parse(cache: ResolutionCache, source: string, profileId: string): ParseRuleResult {
  const key = JSON.stringify([profileId, source]); let result = cache.parses.get(key); if (!result) cache.parses.set(key, result = parseRule(source, { profileId })); return result;
}
function unwrap(node: Expression, initial: Selection | undefined, binding: Binding): { node: Expression; scope?: Selection } {
  let scope = initial;
  while (node.kind === 'group' || node.kind === 'with') {
    if (node.kind === 'group') node = node.expression;
    else { scope = bindScope(mergeScope(node.scope, scope), binding); node = node.body; }
  }
  return { node, ...(scope ? { scope } : {}) };
}
const sameBinding = (a: Binding, b: Binding) => JSON.stringify([a.contextId, [...(a.contextIds ?? [])].sort(ordinal), a.tableCode, a.sheetCode, a.rowCode, a.columnCode]) === JSON.stringify([b.contextId, [...(b.contextIds ?? [])].sort(ordinal), b.tableCode, b.sheetCode, b.rowCode, b.columnCode]);
/** Resolve structure only: a false/null current precondition does not remove eligibility. */
export function resolveDirection(snapshot: Snapshot, input: DirectionInput, options: { budget?: WorkBudget } = {}): { resolved?: ResolvedDirection; diagnostics: readonly Diagnostic[] } {
  const invalid = (message: string, diagnostics: readonly Diagnostic[] = []): { diagnostics: readonly Diagnostic[] } => ({ diagnostics: diagnostics.length ? diagnostics : [{ code: 'INVALID_DIRECTION', message, severity: 'error' }] });
  options.budget?.check();
  if (input.targetSide !== 'left' && input.targetSide !== 'right') return invalid('Elige un único lado de la igualdad.');
  const profileDiagnostics = snapshotProfileDiagnostics(snapshot, options.budget);
  if (profileDiagnostics.length) return invalid('Los datos no pertenecen al perfil declarado.', profileDiagnostics);
  if (snapshot.content.profileId === LANGUAGE_PROFILE_V2) {
    const policy = getRecalculationPolicy(snapshot, input, options);
    if (policy.policy.mode !== 'standard') {
      const limit = policy.diagnostics.find(issue => issue.code === 'RESOURCE_LIMIT' || issue.code === 'CANCELLED' || issue.code === 'DEADLINE_EXCEEDED');
      if (limit) throw new WorkLimitError(limit.code as 'RESOURCE_LIMIT' | 'CANCELLED' | 'DEADLINE_EXCEEDED', limit.message);
      return invalid('La regla no admite una dirección de recálculo.', policy.diagnostics);
    }
  }
  const variants = input.variantIds.map(id => snapshot.content.catalog.variants.find(variant => variant.variantId === id));
  if (!variants.length || variants.some(variant => !variant) || new Set(input.variantIds).size !== input.variantIds.length) return invalid('La instancia no identifica una variante válida.');
  const variant = variants[0]!, index = reportIndex(snapshot.content, options.budget), context = input.binding.contextId ? index.contexts.get(input.binding.contextId) : undefined;
  if (!context) return invalid('La instancia necesita un contexto declarado.');
  const applies = (candidate: RuleVariant, contextId: string): boolean => {
    const ctx = index.contexts.get(contextId); return !!ctx && candidate.active && candidate.framework === ctx.framework && candidate.modules.includes(ctx.moduleVersion)
      && (!candidate.referenceWindow.from || ctx.referenceDate >= candidate.referenceWindow.from) && (!candidate.referenceWindow.to || ctx.referenceDate <= candidate.referenceWindow.to)
      && (!candidate.submissionFrom || !!ctx.submissionDate && ctx.submissionDate >= candidate.submissionFrom);
  };
  const fullyApplies = (candidate: RuleVariant): boolean => applies(candidate, context.contextId) && (!candidate.crossModule || candidate.modules.every(module => snapshot.content.contexts.some(ctx =>
    ctx.moduleVersion === module && ctx.entityId === context.entityId && ctx.referenceDate === context.referenceDate && applies(candidate, ctx.contextId))));
  const key = effectiveRuleKey(variant);
  if (variants.some(item => !fullyApplies(item!) || effectiveRuleKey(item!) !== key)) return invalid('La regla no es activa, vigente y compatible con el contexto.');
  const compatible = input.binding.contextIds ?? [context.contextId];
  if (!compatible.includes(context.contextId) || compatible.some(id => !applies(variant, id) || index.contexts.get(id)!.entityId !== context.entityId || index.contexts.get(id)!.referenceDate !== context.referenceDate)
    || (!variant.crossModule && compatible.some(id => index.contexts.get(id)!.canonicalContextKey !== context.canonicalContextKey))
    || (variant.crossModule && variant.modules.some(module => !compatible.some(id => index.contexts.get(id)!.moduleVersion === module)))) return invalid('Los contextos de resolución no corresponden a esta regla.');
  if (snapshot.content.catalog.variants.some(candidate => candidate.code === variant.code && fullyApplies(candidate) && effectiveRuleKey(candidate) !== key)) return invalid('Hay variantes incompatibles para el mismo código y contexto.');
  const cache = workCache(snapshot, options.budget);
  const parsed = parse(cache, variant.expression, snapshot.content.profileId), condition = variant.precondition ? parse(cache, variant.precondition, snapshot.content.profileId) : undefined;
  if (!parsed.ast || parsed.supportStatus !== 'supported' || condition && (!condition.ast || condition.supportStatus !== 'supported')) return invalid('La expresión o precondición no pertenece al perfil admitido.', [...parsed.diagnostics, ...(condition?.diagnostics ?? [])]);
  const expansionKey = JSON.stringify([key, context.contextId, [...compatible].sort(ordinal)]); let instances = cache.expansions.get(expansionKey);
  if (!instances) {
    const expanded = expandRuleInstances(parsed.ast, snapshot.content, { contextId: context.contextId, ruleKey: key, ...(variant.crossModule ? { contextIds: compatible } : {}), ...(options.budget ? { budget: options.budget } : {}) });
    if (expanded.diagnostics.length) return invalid('La regla no tiene un ámbito finito válido.', expanded.diagnostics);
    instances = expanded.instances; cache.expansions.set(expansionKey, instances);
  }
  if (!instances.some(instance => instance.instanceId === input.instanceId && sameBinding(instance.binding, input.binding))) return invalid('La identidad de instancia no corresponde al snapshot.');
  const equality = unwrap(parsed.ast.body, undefined, input.binding);
  if (equality.node.kind !== 'binary' || equality.node.op !== '=') {
    const message = 'Solo una igualdad admite una dirección de recálculo.';
    return invalid(message, snapshot.content.profileId === LANGUAGE_PROFILE_V2 ? [{ code: 'NOT_EQUALITY', message, severity: 'error' }] : []);
  }
  const targetNode = unwrap(input.targetSide === 'left' ? equality.node.left : equality.node.right, equality.scope, input.binding);
  if (targetNode.node.kind !== 'reference') return invalid('El lado elegido debe ser una única celda declarada.');
  const selected = resolveSelection(targetNode.node.selection, targetNode.scope, snapshot.content, input.binding, options.budget);
  if (selected.diagnostics.length || selected.coordinates.length !== 1) return invalid('El destino no identifica una única celda declarada.', selected.diagnostics);
  const target = selected.coordinates[0]!, source = input.targetSide === 'left' ? equality.node.right : equality.node.left;
  if (snapshot.content.profileId === LANGUAGE_PROFILE_V2) {
    const type = inspectExpression(source, { snapshot, binding: input.binding, ...(equality.scope ? { scope: equality.scope } : {}), ...(options.budget ? { budget: options.budget } : {}) });
    if (target.dataType !== 'number' || type.dataType !== 'number' || type.multiple || type.diagnostics.length) return invalid('El perfil v2 solo admite destino y expresión calculada numéricos compatibles.', type.diagnostics);
  }
  const reads = collectExpressionReads(source, { report: snapshot.content, binding: input.binding, ...(equality.scope ? { scope: equality.scope } : {}), ...(options.budget ? { budget: options.budget } : {}) });
  if (reads.diagnostics.length) return invalid('El lado calculado contiene referencias no resueltas.', reads.diagnostics);
  if (reads.readKeys.includes(target.factKey)) return invalid('El lado calculado lee su propio destino.');
  const id = stableId([input.instanceId, input.targetSide, target.factKey]);
  if (input.targetKey !== undefined && input.targetKey !== target.factKey || input.id !== undefined && input.id !== id) return invalid('La dirección no coincide con su destino canónico.');
  const direction: DirectionDTO = { id, instanceId: input.instanceId, variantIds: [...input.variantIds].sort(ordinal), binding: input.binding, targetSide: input.targetSide, targetKey: target.factKey };
  return { resolved: { direction, ast: parsed.ast, ...(condition?.ast ? { precondition: condition.ast } : {}), binding: input.binding, target, source, ...(equality.scope ? { scope: equality.scope } : {}) }, diagnostics: [] };
}
