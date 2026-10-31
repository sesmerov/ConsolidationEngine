import type { Diagnostic, DirectionDTO, FactReadDTO, MetadataReadDTO, ProposalAfterDTO, Rational, ReportedFact, Snapshot, SourceLocator } from '@ce/contracts';
import { evaluate, type EvaluationContext, type EvaluationResult } from '../evaluator/evaluate.js';
import { ValueError } from '../evaluator/value.js';
import { WorkBudget } from '../execution/budget.js';
import { NumericError, rationalToDTO } from '../numeric/rational.js';
import { contextualUnits, parseUnit } from '../numeric/units.js';
import { ordinal, reportIndex } from '../resolver/coordinates.js';
import { collectExpressionReads } from '../resolver/static-reads.js';
import { resolveDirection } from './direction.js';
import { quantize, RecalculationError } from './quantize.js';

export interface CandidateResult {
  readonly state: 'available' | 'blocked'; readonly before?: FactReadDTO; readonly after?: ProposalAfterDTO;
  readonly exactNominal?: Rational; readonly derivedInterval?: { readonly lo: Rational; readonly hi: Rational };
  readonly readKeys: readonly string[]; readonly metadataReads: readonly MetadataReadDTO[];
  readonly sources: readonly SourceLocator[]; readonly diagnostics: readonly Diagnostic[];
  /** Present only after original-rule revalidation; consumers must use this quantized fact. */
  readonly fact?: ReportedFact;
}
const diagnostic = (code: string, message: string): Diagnostic => ({ code, message, severity: 'error' });
const uniqueSources = (sources: readonly SourceLocator[]): SourceLocator[] => [...new Map(sources.map(source => [JSON.stringify(source), source])).entries()].sort(([a], [b]) => ordinal(a, b)).map(([, source]) => source);
/** Pure single-direction evaluation against the current simulated snapshot. Job limits propagate. */
export function evaluateCandidate(snapshot: Snapshot, direction: DirectionDTO, options: { budget?: WorkBudget } = {}): CandidateResult {
  const budget = options.budget ?? new WorkBudget(); budget.check();
  const resolution = resolveDirection(snapshot, direction, { budget });
  if (!resolution.resolved) return { state: 'blocked', readKeys: [], metadataReads: [], sources: [], diagnostics: resolution.diagnostics };
  const { target, source, precondition, ast, binding, scope } = resolution.resolved;
  const environment: EvaluationContext = { report: snapshot.content, binding, budget, ...(scope ? { scope } : {}) };
  const sourceReads = collectExpressionReads(source, environment), conditionReads = precondition ? collectExpressionReads(precondition.body, environment) : undefined;
  const readKeys = [...new Set([...sourceReads.readKeys, ...(conditionReads?.readKeys ?? [])])].sort(ordinal);
  const metadataReads = [...new Map([...sourceReads.metadataReads, ...(conditionReads?.metadataReads ?? [])].map(read => [JSON.stringify([read.contextId, read.code]), read])).values()]
    .sort((a, b) => ordinal(a.contextId, b.contextId) || ordinal(a.code, b.code));
  const index = reportIndex(snapshot.content, budget), targetFacts = index.facts.get(target.factKey) ?? [], previous = targetFacts[0];
  const before: FactReadDTO = { factKey: target.factKey, coordinate: target,
    presence: previous ? previous.presence === 'null' ? 'explicit_null' : 'value' : 'implicit_null',
    ...(previous?.originalText !== undefined ? { originalText: previous.originalText } : {}),
    ...(previous?.normalizedValue !== undefined ? { normalizedValue: previous.normalizedValue } : {}), sourceLocator: previous?.sourceLocator ?? target.sourceLocator };
  const readSet = new Set([...readKeys, target.factKey]);
  const sources = uniqueSources([...snapshot.content.catalog.variants.filter(variant => direction.variantIds.includes(variant.variantId)).flatMap(variant => variant.sourceLocators),
    ...snapshot.content.coordinates.filter(cell => readSet.has(cell.factKey)).map(cell => cell.sourceLocator),
    ...snapshot.content.facts.filter(fact => readSet.has(fact.factKey)).map(fact => fact.sourceLocator),
    ...metadataReads.flatMap(read => read.sourceLocator ? [read.sourceLocator] : [])]);
  const diagnostics: Diagnostic[] = [...sourceReads.diagnostics, ...(conditionReads?.diagnostics ?? [])];
  const details = { before, readKeys, metadataReads, sources };
  let numeric: Pick<CandidateResult, 'exactNominal' | 'derivedInterval'> = {};
  const blocked = (...issues: Diagnostic[]): CandidateResult => ({ ...details, ...numeric, state: 'blocked', diagnostics: [...diagnostics, ...issues] });
  function conditionPasses(evaluation: EvaluationResult): boolean {
    diagnostics.push(...evaluation.diagnostics);
    if (evaluation.value?.kind === 'boolean' && evaluation.value.value) return true;
    diagnostics.push(diagnostic(evaluation.value?.kind === 'boolean' ? 'PRECONDITION_FALSE' : 'PRECONDITION_NOT_EVALUABLE', 'La precondición no es true en la versión simulada.'));
    return false;
  }
  if (targetFacts.length > 1) return blocked(diagnostic('AMBIGUOUS_REFERENCE', 'El destino contiene hechos duplicados.'));
  if (diagnostics.length) return blocked();
  try {
    if (precondition && !conditionPasses(evaluate(precondition, environment))) return blocked();
    const evaluated = evaluate(source, environment); diagnostics.push(...evaluated.diagnostics);
    const value = evaluated.value;
    if (!value || value.kind === 'null' || value.kind === 'unknown') return blocked(diagnostic('CANDIDATE_NOT_EVALUABLE', 'El lado calculado no tiene un valor conocido.'));
    if (value.kind !== target.dataType) return blocked(diagnostic('TYPE_MISMATCH', 'El valor calculado no coincide con el tipo del destino.'));
    let after: ProposalAfterDTO;
    if (value.kind === 'boolean') after = { normalizedValue: value.value, originalText: value.value ? 'true' : 'false' };
    else {
      contextualUnits('=', parseUnit(target.unit), value.unit, false, value.literal);
      numeric = { exactNominal: rationalToDTO(value.nominal), derivedInterval: { lo: rationalToDTO(value.lo), hi: rationalToDTO(value.hi) } };
      const quantized = quantize(value.nominal, target.decimals);
      after = { normalizedValue: rationalToDTO(quantized.value), originalText: quantized.text, decimals: target.decimals, unit: target.unit };
    }
    const { factKey, contextId, tableCode, sheetCode, rowCode, columnCode } = target;
    const fact: ReportedFact = { factKey, contextId, tableCode, sheetCode, rowCode, columnCode, presence: 'value',
      normalizedValue: after.normalizedValue, originalText: after.originalText, sourceLocator: before.sourceLocator };
    const report = { ...snapshot.content, facts: [...snapshot.content.facts.filter(item => item.factKey !== target.factKey), fact] };
    // Revalidate the complete original expression, preserving with/default/interval options.
    const candidateEnvironment = { ...environment, report };
    if (precondition && !conditionPasses(evaluate(precondition, candidateEnvironment))) return blocked(diagnostic('CANDIDATE_DOES_NOT_SATISFY_RULE', 'El candidato no conserva la precondición de la regla.'));
    const validation = evaluate(ast, { report, binding, budget }); diagnostics.push(...validation.diagnostics);
    if (validation.value?.kind !== 'boolean' || !validation.value.value) return blocked(diagnostic('CANDIDATE_DOES_NOT_SATISFY_RULE', 'El valor exportable no satisface la igualdad original.'));
    budget.check();
    return { ...details, ...numeric, state: 'available', after, fact, diagnostics };
  } catch (error) {
    if (error instanceof NumericError && error.code === 'RESOURCE_LIMIT') throw error;
    if (!(error instanceof RecalculationError) && !(error instanceof NumericError) && !(error instanceof ValueError)) throw error;
    return blocked(diagnostic(error.code, error.message));
  }
}
