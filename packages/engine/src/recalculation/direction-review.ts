import { isDeepStrictEqual } from 'node:util';
import type {
  Diagnostic, DirectionDecisionState, DirectionDTO, DirectionOrigin, DirectionReviewClass,
  DirectionReviewRowDTO, Snapshot, ValidationBinding,
} from '@ce/contracts';
import { WorkBudget, WorkLimitError } from '../execution/budget.js';
import { ordinal } from '../resolver/coordinates.js';
import { stableId } from '../resolver/instances.js';
import { resolveDirection } from './direction.js';
import { getRecalculationPolicy } from './policy.js';
import {
  choiceAt, decisionCode, DirectionReviewError, indexProjection, selectedOrigin, selectedSide, singleSuggestion,
  type DirectionReviewProjection, type ReviewGroup, type ReviewOption, type ReviewRow, type ReviewSeed,
} from './direction-review-index.js';

export { DirectionReviewError, editDirectionProjection, readDirectionRows, readDirectionGroups, readDirectionCandidates, readDirectionCandidate } from './direction-review-index.js';
export type { DirectionReviewProjection, ReviewSeed } from './direction-review-index.js';

type ReviewedState = Extract<DirectionDecisionState, { mode: 'reviewed' }>;
type Reasons = DirectionReviewRowDTO['reasons'];
interface Classification {
  classification: DirectionReviewClass;
  options: ReviewOption[];
  reasons: Reasons;
}
interface TargetIndex {
  keys: Map<string, number>;
  groups: ReviewGroup[];
}

function location(binding?: ValidationBinding): string {
  return [binding?.tableCode, binding?.sheetCode && 's' + binding.sheetCode,
  binding?.rowCode && 'r' + binding.rowCode, binding?.columnCode && 'c' + binding.columnCode]
    .filter(Boolean).join(' · ').slice(0, 2048);
}

function boundedReasons(diagnostics: readonly Diagnostic[]): Reasons {
  const reasons = new Map<string, { code: string; message: string }>();
  for (const { code, message } of diagnostics) {
    if (code === 'RESOURCE_LIMIT' || code === 'CANCELLED' || code === 'DEADLINE_EXCEEDED') throw new WorkLimitError(code, message);
    if (reasons.size < 8) reasons.set(code + '\0' + message, { code, message: message.slice(0, 2048) });
  }
  return [...reasons.values()];
}

function classify(snapshot: Snapshot, seed: ReviewSeed, index: TargetIndex, reviewId: string, budget: WorkBudget): Classification {
  if (seed.coverageOnly || !seed.instanceId) return {
    classification: 'none', options: [],
    reasons: [{ code: 'COVERAGE_ONLY', message: 'Fila de cobertura sin instancia de cálculo.' }]
  };
  if (!seed.binding) return {
    classification: 'undetermined', options: [],
    reasons: [{ code: 'INVALID_DIRECTION', message: 'Falta el ámbito de la instancia.' }]
  };
  const policy = getRecalculationPolicy(snapshot, seed, { budget });
  if (policy.policy.mode !== 'standard') return {
    classification: policy.policy.mode === 'validation_only' ? 'none' : 'undetermined',
    options: [], reasons: boundedReasons(policy.diagnostics),
  };
  const options: ReviewOption[] = [], diagnostics: Diagnostic[] = [];
  let inconclusive = false;
  for (const targetSide of ['left', 'right'] as const) {
    const resolution = resolveDirection(snapshot, {
      instanceId: seed.instanceId, variantIds: seed.variantIds, binding: seed.binding, targetSide,
    }, { budget });
    const { resolved } = resolution;
    if (!resolved) {
      diagnostics.push(...resolution.diagnostics);
      if (resolution.inconclusive) inconclusive = true;
      continue;
    }
    budget.consume('edges');
    const key = resolved.target.factKey;
    let group = index.keys.get(key);
    if (group === undefined) {
      group = index.groups.length;
      index.keys.set(key, group);
      index.groups.push({ id: stableId([reviewId, key]), targetKey: key });
    }
    options.push({ side: targetSide, group, directionId: resolved.direction.id, label: location(resolved.target) });
  }
  const reasons = boundedReasons(diagnostics);
  if (inconclusive) return { classification: 'undetermined', options: [], reasons };
  const classification = options.length === 2 ? 'both' : options.length === 0 ? 'none'
    : options[0]!.side === 'left' ? 'singleLeft' : 'singleRight';
  return { classification, options, reasons: options.length ? [] : reasons };
}

/** Whitelist run identities even when the caller holds complete validation results. */
function reduceSeed(input: ReviewSeed): ReviewSeed {
  return {
    id: input.id, code: input.code, variantIds: [...input.variantIds].sort(ordinal), coverageOnly: input.coverageOnly,
    ...(input.instanceId ? { instanceId: input.instanceId } : {}), ...(input.binding ? { binding: input.binding } : {})
  };
}

function initialChoice(row: ReviewRow, saved: DirectionDTO | undefined, savedOption: ReviewOption | undefined, decisionState: DirectionDecisionState | undefined,
  unselectedExceptions: ReadonlySet<string>): string {
  if (row.classification === 'undetermined') return decisionCode.undetermined;
  if (!row.options.length) return decisionCode.excluded;
  if (saved) {
    if (!savedOption) return decisionCode.pending;
    return savedOption.side === 'left' ? decisionCode.savedLeft : decisionCode.savedRight;
  }
  if (decisionState?.mode === 'new') return singleSuggestion(row.classification);
  if (decisionState?.mode !== 'reviewed') return decisionCode.pending;
  const normallyOmitted = decisionState.unselectedDefault === 'omitted';
  return normallyOmitted !== unselectedExceptions.has(row.seed.instanceId!) ? decisionCode.omitted : decisionCode.pending;
}

export function prepareDirectionProjection(snapshot: Snapshot, input: readonly ReviewSeed[],
  options: { budget?: WorkBudget; reviewId: string }): DirectionReviewProjection {
  const budget = options.budget ?? new WorkBudget();
  budget.check();
  if (input.length > budget.limits.instances) throw new WorkLimitError('RESOURCE_LIMIT', 'Demasiadas filas en la revisión.');
  const decisionState = snapshot.content.directionDecisionState;
  const reviewed = decisionState?.mode === 'reviewed' ? decisionState : undefined;
  const origins = new Map(reviewed?.originExceptions.map(item => [item.instanceId, item.origin]));
  const unselected = new Set(reviewed?.unselectedExceptions);
  const savedDirections = new Map(snapshot.content.directions.map(item => [item.instanceId, item]));
  const contexts = new Map(snapshot.content.contexts.map(ctx => [ctx.contextId,
  [ctx.entityId, ctx.referenceDate, ctx.framework, ctx.moduleVersion].join(' · ').slice(0, 2048)]));
  const index: TargetIndex = { groups: [], keys: new Map() };
  const byInstance: Record<string, number> = Object.create(null), byGroup: Record<string, number> = Object.create(null);
  const rows: ReviewRow[] = [], choices: string[] = [], resultIds = new Set<string>();
  const seeds = input.map(reduceSeed).sort((a, b) => ordinal(a.code, b.code) || ordinal(a.id, b.id));
  for (const seed of seeds) {
    budget.check();
    if (resultIds.has(seed.id) || seed.instanceId && Object.hasOwn(byInstance, seed.instanceId)) throw new DirectionReviewError('DUPLICATE_INSTANCE');
    resultIds.add(seed.id);
    if (seed.instanceId) byInstance[seed.instanceId] = rows.length;
    const classification = classify(snapshot, seed, index, options.reviewId, budget);
    const saved = seed.instanceId ? savedDirections.get(seed.instanceId) : undefined;
    const savedOption = saved && classification.options.find(option => option.directionId === saved.id
      && index.groups[option.group]!.targetKey === saved.targetKey && option.side === saved.targetSide
      && isDeepStrictEqual(seed.binding, saved.binding) && isDeepStrictEqual(seed.variantIds, [...saved.variantIds].sort(ordinal)));
    const row: ReviewRow = {
      seed, ...classification, location: location(seed.binding) || classification.options.map(option => option.label).join(' / ').slice(0, 2048),
      contextLabel: contexts.get(seed.binding?.contextId ?? '') ?? '',
      ...(savedOption && seed.instanceId ? { savedOrigin: origins.get(seed.instanceId) ?? reviewed?.originDefault ?? 'previous' } : {}),
      ...(saved && !savedOption ? { reasons: [{ code: 'INVALID_DIRECTION', message: 'Vuelve a revisar el destino guardado.' }, ...classification.reasons].slice(0, 8) } : {}),
    };
    rows.push(row);
    choices.push(initialChoice(row, saved, savedOption, decisionState, unselected));
  }
  index.groups.forEach((group, i) => { byGroup[group.id] = i; });
  return indexProjection({ reviewId: options.reviewId, baseVersionId: snapshot.versionId, rows, groups: index.groups, byInstance, byGroup }, choices, budget);
}

export function replacedDirectionDecisionState(): ReviewedState {
  return {
    schemaVersion: 1, mode: 'reviewed', source: 'replace', originDefault: 'explicit', originExceptions: [],
    unselectedDefault: 'omitted', unselectedExceptions: []
  };
}

function effectiveOrigin(row: ReviewRow, choice: string): DirectionOrigin | undefined {
  switch (selectedOrigin(choice)) {
    case 'automatic': return 'automatic';
    case 'manual': return 'explicit';
    case 'saved': return row.savedOrigin ?? 'previous';
    default: return undefined;
  }
}

interface DirectionConfiguration { directions: DirectionDTO[]; decisionState: ReviewedState }

function majorityOrigin(totals: Record<DirectionOrigin, number>): DirectionOrigin {
  let preferred: DirectionOrigin = 'explicit';
  for (const origin of ['automatic', 'previous'] as const) if (totals[origin] > totals[preferred]) preferred = origin;
  return preferred;
}

function expectedDirection(projection: DirectionReviewProjection, row: ReviewRow, choice: string): DirectionDTO {
  const option = row.options.find(item => item.side === selectedSide(choice));
  if (!option || !row.seed.instanceId || !row.seed.binding) throw new DirectionReviewError('INVALID_DIRECTION');
  return {
    id: option.directionId, instanceId: row.seed.instanceId, binding: row.seed.binding,
    variantIds: row.seed.variantIds, targetSide: option.side, targetKey: projection.groups[option.group]!.targetKey
  };
}

export function compileDirectionConfiguration(snapshot: Snapshot, projection: DirectionReviewProjection, options: { budget?: WorkBudget } = {}): DirectionConfiguration {
  const budget = options.budget ?? new WorkBudget();
  budget.check();
  if (projection.conflictGroupCount || projection.counts.conflicted) throw new DirectionReviewError('UNRESOLVED_CONFLICT');
  if (projection.baseVersionId !== snapshot.versionId) throw new DirectionReviewError('BASE_MISMATCH');
  const directions: DirectionDTO[] = [], claimed = new Set<string>();
  const totals: Record<DirectionOrigin, number> = { explicit: 0, automatic: 0, previous: 0 };
  for (const [i, row] of projection.rows.entries()) {
    budget.check();
    const choice = choiceAt(projection, i), origin = effectiveOrigin(row, choice);
    if (!origin) continue;
    const direction = expectedDirection(projection, row, choice);
    if (claimed.has(direction.targetKey)) throw new DirectionReviewError('UNRESOLVED_CONFLICT');
    claimed.add(direction.targetKey);
    if (!resolveDirection(snapshot, direction, { budget }).resolved) throw new DirectionReviewError('INVALID_DIRECTION');
    directions.push(direction);
    totals[origin]++;
  }
  if (directions.length !== projection.counts.included) throw new DirectionReviewError('INVALID_DECISION');
  const originDefault = majorityOrigin(totals);
  const unselectedDefault = projection.counts.omitted > projection.counts.pending ? 'omitted' : 'pending';
  const minority = unselectedDefault === 'pending' ? decisionCode.omitted : decisionCode.pending;
  const originExceptions: { instanceId: string; origin: DirectionOrigin }[] = [], unselectedExceptions: string[] = [];
  for (const [i, row] of projection.rows.entries()) {
    budget.check();
    const choice = choiceAt(projection, i), origin = effectiveOrigin(row, choice);
    if (choice === minority) unselectedExceptions.push(row.seed.instanceId!);
    if (origin && origin !== originDefault) originExceptions.push({ instanceId: row.seed.instanceId!, origin });
  }
  directions.sort((a, b) => ordinal(a.id, b.id));
  originExceptions.sort((a, b) => ordinal(a.instanceId, b.instanceId));
  unselectedExceptions.sort(ordinal);
  return { directions, decisionState: { schemaVersion: 1, mode: 'reviewed', source: 'review', originDefault, originExceptions, unselectedDefault, unselectedExceptions } };
}

function hasKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

/** Verify the worker output in bounded extra space, directly against the sealed review indexes. */
export function verifyDirectionCompilation(projection: DirectionReviewProjection, candidate: unknown, options: { budget?: WorkBudget } = {}): boolean {
  const budget = options.budget ?? new WorkBudget();
  budget.check();
  if (projection.conflictGroupCount || !hasKeys(candidate, ['directions', 'decisionState'])) return false;
  const { directions, decisionState } = candidate;
  if (!Array.isArray(directions) || directions.length !== projection.counts.included) return false;
  if (!hasKeys(decisionState, ['schemaVersion', 'mode', 'source', 'originDefault', 'originExceptions', 'unselectedDefault', 'unselectedExceptions'])
    || decisionState.schemaVersion !== 1 || decisionState.mode !== 'reviewed' || decisionState.source !== 'review') return false;
  const totals: Record<DirectionOrigin, number> = { automatic: 0, explicit: 0, previous: 0 };
  let previousId = '';
  for (const direction of directions) {
    budget.check();
    if (!direction || typeof direction.instanceId !== 'string' || !Object.hasOwn(projection.byInstance, direction.instanceId)) return false;
    const index = projection.byInstance[direction.instanceId]!, row = projection.rows[index]!, choice = choiceAt(projection, index);
    const origin = effectiveOrigin(row, choice);
    if (!origin || !isDeepStrictEqual(direction, expectedDirection(projection, row, choice)) || direction.id <= previousId) return false;
    totals[origin]++;
    previousId = direction.id;
  }
  const originDefault = majorityOrigin(totals), { originExceptions, unselectedExceptions } = decisionState;
  if (decisionState.originDefault !== originDefault || !Array.isArray(originExceptions)
    || originExceptions.length !== directions.length - totals[originDefault]) return false;
  previousId = '';
  for (const exception of originExceptions) {
    budget.check();
    if (!hasKeys(exception, ['instanceId', 'origin']) || typeof exception.instanceId !== 'string'
      || exception.instanceId <= previousId || !Object.hasOwn(projection.byInstance, exception.instanceId)) return false;
    const index = projection.byInstance[exception.instanceId]!;
    const origin = effectiveOrigin(projection.rows[index]!, choiceAt(projection, index));
    if (!origin || origin === originDefault || exception.origin !== origin) return false;
    previousId = exception.instanceId;
  }
  const unselectedDefault = projection.counts.omitted > projection.counts.pending ? 'omitted' : 'pending';
  const expectedChoice = unselectedDefault === 'pending' ? decisionCode.omitted : decisionCode.pending;
  if (decisionState.unselectedDefault !== unselectedDefault || !Array.isArray(unselectedExceptions)
    || unselectedExceptions.length !== Math.min(projection.counts.omitted, projection.counts.pending)) return false;
  previousId = '';
  for (const id of unselectedExceptions) {
    budget.check();
    if (typeof id !== 'string' || id <= previousId || !Object.hasOwn(projection.byInstance, id)
      || choiceAt(projection, projection.byInstance[id]!) !== expectedChoice) return false;
    previousId = id;
  }
  return true;
}
