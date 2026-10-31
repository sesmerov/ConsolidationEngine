import type { Diagnostic, FactReadDTO, RawRuleRecord, ReportContext, RuleResultDTO, RuleVariant, Snapshot, SourceLocator, ValidationBundle, ValidationStatus, ValidationValueDTO } from '@ce/contracts';
import type { Ast, Expression } from '../ast/ast.js';
import { evaluate, type EvaluationResult } from '../evaluator/evaluate.js';
import type { ScalarValue } from '../evaluator/value.js';
import { WorkBudget, WorkLimitError, type WorkLimits } from '../execution/budget.js';
import { NumericError, rationalToDTO } from '../numeric/rational.js';
import { formatUnit } from '../numeric/units.js';
import { parseRule, type ParseRuleResult } from '../parser/parse-rule.js';
import { ordinal, reportIndex } from '../resolver/coordinates.js';
import { expandRuleInstances, outerScope, stableId, type RuleInstance } from '../resolver/instances.js';
import type { Binding } from '../resolver/scope.js';

export interface RunValidationOptions {
  readonly runId: string; readonly startedAt: string; readonly cancelled?: () => boolean;
  readonly progress?: (completed: number, total: number) => void; readonly limits?: Partial<WorkLimits>; readonly now?: () => number;
}
class ProfileError extends Error { readonly code = 'PROFILE_MISMATCH'; }
/** Stable within a snapshot, including coverage rows with no instance or binding. */
export function resultOrderKey(result: RuleResultDTO): string {
  const binding = result.binding;
  return JSON.stringify([result.code, [...result.variantIds].sort(ordinal), result.contextId ?? binding?.contextId ?? null,
    binding ? [binding.contextId ?? null, [...(binding.contextIds ?? [])].sort(ordinal), binding.tableCode ?? null,
      binding.sheetCode ?? null, binding.rowCode ?? null, binding.columnCode ?? null] : null,
    result.coverageOnly, result.instanceId ?? null, [...result.sourceRecordIds].sort(ordinal)]);
}
export function valueToDTO(value: ScalarValue): ValidationValueDTO {
  const provenance = value.kind === 'unknown' ? {} : { ...(value.coordinate ? { coordinate: value.coordinate } : {}), ...(value.sourceLocator ? { sourceLocator: value.sourceLocator } : {}) };
  switch (value.kind) {
    case 'number': return { kind: 'number', nominal: rationalToDTO(value.nominal), interval: { lo: rationalToDTO(value.lo), hi: rationalToDTO(value.hi) }, unit: formatUnit(value.unit), ...provenance };
    case 'boolean': return { kind: 'boolean', value: value.value, ...provenance };
    case 'null': return { kind: 'null', presence: value.origin === 'explicit' ? 'explicit_null' : value.origin === 'implicit' ? 'implicit_null' : 'derived_null', dataType: value.dataType,
      ...(value.dataType === 'number' ? { unit: formatUnit(value.unit) } : {}), ...provenance };
    case 'unknown': return { kind: 'unknown', presence: 'unknown' };
  }
}
export function effectiveRuleKey(variant: RuleVariant): string {
  return stableId([variant.code, variant.expression, variant.precondition ?? null, [...variant.tables].sort(ordinal), variant.crossModule, variant.severity,
    variant.severity === 'unknown' ? variant.severityOriginal : null]);
}
function hasReference(node: Expression): boolean {
  switch (node.kind) {
    case 'reference': return true;
    case 'group': return hasReference(node.expression);
    case 'with': return hasReference(node.body);
    case 'unary': return hasReference(node.operand);
    case 'binary': return hasReference(node.left) || hasReference(node.right);
    case 'call': return node.arguments.some(hasReference);
    default: return false;
  }
}
function rawText(record: RawRuleRecord, field: string): string {
  const data = record.originalFields[field];
  return typeof data === 'string' ? data : data && typeof data === 'object' && !Array.isArray(data) && 'value' in data && typeof data.value === 'string' ? data.value : '';
}
const uniqueSources = (sources: readonly SourceLocator[]): SourceLocator[] => [...new Map(sources.map(source => [JSON.stringify(source), source])).entries()].sort(([a], [b]) => ordinal(a, b)).map(([, value]) => value);

/** No IO and no snapshot mutation. A completed run may contain business failures or errors. */
export function runValidation(snapshot: Snapshot, options: RunValidationOptions): ValidationBundle {
  const { content } = snapshot; const results: RuleResultDTO[] = [], diagnostics: Diagnostic[] = [], applicable = new Set<string>();
  const parsed = new Map<string, ParseRuleResult>(); let complete = true; let budget: WorkBudget | undefined;
  const coordinateByKey = new Map<string, (typeof content.coordinates)[number]>();
  const parse = (source: string): ParseRuleResult => { let result = parsed.get(source); if (!result) { result = parseRule(source); parsed.set(source, result); } return result; };
  const parseProblem = (result: ParseRuleResult): ValidationStatus | undefined => result.syntaxStatus === 'error' ? 'error' : result.supportStatus === 'unsupported' || !result.ast ? 'not_evaluable' : undefined;
  const counts: Record<ValidationStatus, number> = { pass: 0, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 };
  const valueStatus = (evaluation: EvaluationResult, precondition: boolean): ValidationStatus | undefined => {
    if (!evaluation.value) return 'error';
    if (evaluation.value.kind === 'null' || evaluation.value.kind === 'unknown') return 'not_evaluable';
    if (evaluation.value.kind !== 'boolean') return 'error';
    return evaluation.value.value ? precondition ? undefined : 'pass' : precondition ? 'not_applicable' : 'fail';
  };
  function append(variants: readonly RuleVariant[], context: ReportContext | undefined, status: ValidationStatus, extra: {
    instance?: RuleInstance; body?: EvaluationResult; precondition?: EvaluationResult; diagnostics?: readonly Diagnostic[]; coverageKey?: unknown;
  } = {}): void {
    const variant = variants[0]!;
    const evaluations = [extra.precondition, extra.body].filter((item): item is EvaluationResult => item !== undefined);
    const readKeys = [...new Set(evaluations.flatMap(item => item.readKeys))].sort(ordinal);
    const metadataReads = [...new Map(evaluations.flatMap(item => item.metadataReads).map(item => [JSON.stringify([item.contextId, item.code]), item])).values()]
      .sort((a, b) => ordinal(a.contextId, b.contextId) || ordinal(a.code, b.code));
    const index = reportIndex(content);
    const factReads = readKeys.flatMap<FactReadDTO>(factKey => {
      budget?.check(); const coordinate = coordinateByKey.get(factKey)!; const facts = index.facts.get(factKey) ?? [];
      // A declared coordinate with no Facts row keeps its own source and implicit absence.
      // Preserve every source if an invalid internal snapshot contains duplicate facts; never select the first.
      return facts.length ? facts.map(fact => ({ factKey, coordinate, presence: fact.presence === 'value' ? 'value' as const : 'explicit_null' as const,
        ...(fact.normalizedValue !== undefined ? { normalizedValue: fact.normalizedValue } : {}), ...(fact.originalText !== undefined ? { originalText: fact.originalText } : {}), sourceLocator: fact.sourceLocator }))
        : [{ factKey, coordinate, presence: 'implicit_null' as const, sourceLocator: coordinate.sourceLocator }];
    });
    const sources = uniqueSources([...variants.flatMap(item => item.sourceLocators), ...readKeys.flatMap(key => {
      const facts = index.facts.get(key); return [...(coordinateByKey.has(key) ? [coordinateByKey.get(key)!.sourceLocator] : []), ...(facts ?? []).map(fact => fact.sourceLocator)];
    }), ...metadataReads.flatMap(item => item.sourceLocator ? [item.sourceLocator] : [])]);
    const issues = [...(extra.diagnostics ?? []), ...evaluations.flatMap(item => item.diagnostics)];
    if (evaluations.some(item => item.value?.kind === 'number')) issues.push({ code: 'TYPE_MISMATCH', message: 'Validation and precondition results must be boolean or null', severity: 'error' });
    const variantIds = [...new Set(variants.map(item => item.variantId))].sort(ordinal);
    const body = extra.body;
    results.push({ id: stableId([options.runId, extra.instance?.instanceId ?? ['coverage', variantIds, context?.canonicalContextKey ?? null, extra.coverageKey ?? status]]),
      runId: options.runId, versionId: snapshot.versionId, profileId: content.profileId, coverageOnly: !extra.instance,
      ...(extra.instance ? { instanceId: extra.instance.instanceId, binding: extra.instance.binding } : {}), ...(context ? { contextId: context.contextId } : {}),
      code: variant.code, variantIds, sourceRecordIds: [...new Set(variants.flatMap(item => item.sourceRecords))].sort(ordinal), tables: [...variant.tables].sort(ordinal),
      status, severity: variant.severity, severityOriginal: variant.severityOriginal, expression: variant.expression, ...(variant.precondition ? { precondition: variant.precondition } : {}),
      ...(extra.precondition?.value ? { preconditionResult: valueToDTO(extra.precondition.value) } : {}),
      values: { ...(body?.operands?.left ? { left: valueToDTO(body.operands.left) } : {}), ...(body?.operands?.right ? { right: valueToDTO(body.operands.right) } : {}), ...(body?.value ? { result: valueToDTO(body.value) } : {}) },
      readKeys, factReads, metadataReads, sources, diagnostics: issues });
  }
  try {
    budget = new WorkBudget({ ...(options.limits ? { limits: options.limits } : {}), ...(options.cancelled ? { cancelled: options.cancelled } : {}), ...(options.now ? { now: options.now } : {}) });
    budget.check();
    if (content.profileId !== 'ce-dpmxl-0.9-closed-v1') throw new ProfileError('Snapshot profile does not match this engine');
    for (const cell of content.coordinates) { budget.check(); coordinateByKey.set(cell.factKey, cell); }
    reportIndex(content, budget);
    for (const record of content.catalog.records) if (!record.variantId || !content.catalog.variants.some(variant => variant.variantId === record.variantId)) {
      budget.check();
      const synthetic: RuleVariant = { variantId: '', code: record.code, framework: '', modules: [], crossModule: false, tables: [], expression: rawText(record, 'Expression'),
        ...(rawText(record, 'Precondtion') ? { precondition: rawText(record, 'Precondtion') } : {}), active: false, referenceWindow: {}, severityOriginal: rawText(record, 'Severity'), severity: 'unknown', sourceRecords: [record.id], sourceLocators: [record.sourceLocator] };
      append([synthetic], undefined, 'error', { diagnostics: record.diagnostics.length ? record.diagnostics : [{ code: 'INVALID_RULE_METADATA', message: 'The row has no interpretable rule variant' }], coverageKey: record.id });
      const last = results.pop()!; results.push({ ...last, variantIds: [] });
    }
    // Alias contexts share one logical identity. Import already requires their metadata to agree.
    const contexts = [...new Map([...content.contexts].sort((a, b) => ordinal(a.canonicalContextKey, b.canonicalContextKey) || ordinal(a.contextId, b.contextId)).map(context => [context.canonicalContextKey, context])).values()];
    type Group = { context: ReportContext; compatible: readonly ReportContext[]; variants: RuleVariant[]; key: string };
    const groups = new Map<string, Group>();
    const matches = (variant: RuleVariant, context: ReportContext) => context.framework === variant.framework && variant.modules.includes(context.moduleVersion);
    const inWindow = (variant: RuleVariant, context: ReportContext) => (!variant.referenceWindow.from || context.referenceDate >= variant.referenceWindow.from) && (!variant.referenceWindow.to || context.referenceDate <= variant.referenceWindow.to);
    for (const variant of [...content.catalog.variants].sort((a, b) => ordinal(a.variantId, b.variantId))) {
      budget.check(); const matching = contexts.filter(context => matches(variant, context));
      if (!matching.length) { append([variant], undefined, 'not_applicable', { diagnostics: [{ code: 'CONTEXT_NOT_APPLICABLE', message: 'No declared context matches the framework and module' }] }); continue; }
      for (const context of matching) {
        budget.check();
        const compatible = contexts.filter(candidate => matches(variant, candidate) && candidate.entityId === context.entityId && candidate.referenceDate === context.referenceDate && inWindow(variant, candidate));
        if (!variant.active || !inWindow(variant, context) || (variant.crossModule && variant.modules.some(module => !compatible.some(candidate => candidate.moduleVersion === module)))) {
          append([variant], context, 'not_applicable', { diagnostics: [{ code: 'RULE_NOT_APPLICABLE', message: 'Rule is inactive, outside its reference window, or lacks a required module' }] }); continue;
        }
        const required = variant.crossModule ? compatible : [context];
        if (variant.submissionFrom && required.some(candidate => !candidate.submissionDate)) {
          append([variant], context, 'not_evaluable', { diagnostics: [{ code: 'MISSING_SUBMISSION_DATE', message: 'An applicable submission window requires the declared submission date' }] }); continue;
        }
        if (variant.submissionFrom && required.some(candidate => candidate.submissionDate! < variant.submissionFrom!)) {
          append([variant], context, 'not_applicable', { diagnostics: [{ code: 'RULE_NOT_APPLICABLE', message: 'The submission date precedes the rule window' }] }); continue;
        }
        applicable.add(variant.variantId);
        const key = effectiveRuleKey(variant); const identity = JSON.stringify([variant.code, context.canonicalContextKey, required.map(item => item.canonicalContextKey), key]);
        const group = groups.get(identity); if (group) group.variants.push(variant); else groups.set(identity, { context, compatible: required, variants: [variant], key });
      }
    }
    const conflicts = new Map<string, Set<string>>();
    for (const group of groups.values()) { const identity = JSON.stringify([group.variants[0]!.code, group.context.canonicalContextKey]); const keys = conflicts.get(identity) ?? new Set(); keys.add(group.key); conflicts.set(identity, keys); }
    let completed = 0;
    for (const [, group] of [...groups].sort(([a], [b]) => ordinal(a, b))) {
      budget.check(); const { context, variants, key } = group; const variant = variants[0]!;
      if (conflicts.get(JSON.stringify([variant.code, context.canonicalContextKey]))!.size > 1) {
        append(variants, context, 'not_evaluable', { diagnostics: [{ code: 'CONFLICTING_VARIANTS', message: 'Incompatible variants apply to the same code and context', severity: 'error' }] });
        options.progress?.(++completed, groups.size); continue;
      }
      const compatibleIds = group.compatible.map(item => item.contextId);
      const binding: Binding = { contextId: context.contextId, ...(variant.crossModule ? { contextIds: compatibleIds } : {}) };
      const body = parse(variant.expression), condition = variant.precondition ? parse(variant.precondition) : undefined;
      if (condition && parseProblem(condition)) { append(variants, context, parseProblem(condition)!, { diagnostics: condition.diagnostics }); options.progress?.(++completed, groups.size); continue; }
      const scope = body.ast ? outerScope(body.ast) : undefined;
      const multiple = scope && [scope.row, scope.column, scope.sheet].some(axis => axis && axis.kind !== 'single');
      let early: EvaluationResult | undefined; let earlyStatus: ValidationStatus | undefined;
      if (condition?.ast && (!hasReference(condition.ast.body) || !multiple)) {
        early = evaluate(condition.ast, { report: content, binding, budget, ...(scope ? { scope } : {}) });
        earlyStatus = valueStatus(early, true);
        // Keep finite structural identities for later snapshots where the condition can change.
        // A failed condition still precedes body syntax/support and never executes the body.
        if (earlyStatus && (earlyStatus === 'error' || parseProblem(body))) { append(variants, context, earlyStatus, { precondition: early }); options.progress?.(++completed, groups.size); continue; }
      }
      const bodyProblem = parseProblem(body);
      if (bodyProblem) { append(variants, context, bodyProblem, { diagnostics: body.diagnostics, ...(early ? { precondition: early } : {}) }); options.progress?.(++completed, groups.size); continue; }
      const expanded = expandRuleInstances(body.ast!, content, { contextId: context.contextId, ruleKey: key, budget, ...(variant.crossModule ? { contextIds: compatibleIds } : {}) });
      if (!expanded.instances.length) append(variants, context, earlyStatus ?? 'not_evaluable', { diagnostics: expanded.diagnostics, ...(early ? { precondition: early } : {}) });
      for (const instance of expanded.instances) {
        budget.check(); const precondition = early ?? (condition?.ast ? evaluate(condition.ast, { report: content, binding: instance.binding, budget, ...(scope ? { scope } : {}) }) : undefined);
        const status = precondition ? valueStatus(precondition, true) : undefined;
        if (status && precondition) { append(variants, context, status, { instance, precondition }); continue; }
        const evaluation = evaluate(body.ast!, { report: content, binding: instance.binding, budget });
        append(variants, context, valueStatus(evaluation, false)!, { instance, body: evaluation, ...(precondition ? { precondition } : {}) });
      }
      options.progress?.(++completed, groups.size);
    }
    budget.check();
  } catch (error) {
    complete = false;
    if (error instanceof WorkLimitError || error instanceof NumericError || error instanceof ProfileError) diagnostics.push({ code: error.code, message: error.message, severity: 'error' });
    else throw error;
  }
  const orderKeys = new Map(results.map(result => [result, resultOrderKey(result)]));
  results.sort((a, b) => ordinal(orderKeys.get(a)!, orderKeys.get(b)!)); for (const result of results) counts[result.status]++;
  const ended = Math.max(Date.parse(options.startedAt), (options.now ?? Date.now)());
  return { run: { id: options.runId, versionId: snapshot.versionId, profileId: content.profileId, status: complete ? 'completed' : 'incomplete', startedAt: options.startedAt, endedAt: new Date(ended).toISOString(),
    summary: { complete, rows: content.catalog.records.length, variants: content.catalog.variants.length, applicableVariants: applicable.size, instances: results.filter(result => !result.coverageOnly).length,
      duplicateRows: content.catalog.variants.reduce((sum, variant) => sum + Math.max(0, variant.sourceRecords.length - 1), 0), byStatus: counts }, resultIds: results.map(result => result.id), diagnostics }, results };
}
