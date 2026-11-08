import { LANGUAGE_PROFILE_V2 } from '@ce/contracts';
import type { DirectionChoiceDTO, DirectionDTO, DirectionEligibilityDTO, ProposalDTO, RuleResultDTO, Snapshot, ValidationBundle } from '@ce/contracts';
import { assertRecalculationConfiguration, getRecalculationPolicy, ProfileError, RecalculationConfigurationError, replacedDirectionDecisionState, resolveDirection, WorkBudget, WorkLimitError } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import { ApiError } from '../errors.js';
import { canonicalStringify, directionConfigurationVersion } from '../session/canonical-state.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { validationMatchesBasis } from '../validation/validation-service.js';

/** Public and final-publication guard; the worker repeats this against its private input. */
export function assertDirectionsAllowed(snapshot: Snapshot, limits?: Partial<WorkLimits>): void {
  try { assertRecalculationConfiguration(snapshot, { budget: new WorkBudget({ ...(limits ? { limits } : {}) }) }); }
  catch (error) {
    if (error instanceof RecalculationConfigurationError || error instanceof ProfileError) throw new ApiError('INVALID_DIRECTION', {
      reason: error.diagnostics[0]?.code ?? error.code, diagnostics: error.diagnostics.map(issue => ({ code: issue.code, message: issue.message })),
    });
    if (error instanceof WorkLimitError) throw new ApiError('INVALID_DIRECTION', { reason: error.code });
    throw error;
  }
}

/** Stored proposal metadata is checked independently of the configured direction it claims to represent. */
export function assertSelectedProposalsAllowed(snapshot: Snapshot, proposals: readonly ProposalDTO[], limits?: Partial<WorkLimits>): void {
  const budget = new WorkBudget({ ...(limits ? { limits } : {}) }), directions = new Map(snapshot.content.directions.map(direction => [direction.id, direction]));
  const variants = new Map(snapshot.content.catalog.variants.map(variant => [variant.variantId, variant]));
  try {
    for (const proposal of proposals) {
      budget.check();
      if (snapshot.content.profileId === LANGUAGE_PROFILE_V2) {
        const result = getRecalculationPolicy(snapshot, proposal, { budget });
        if (result.policy.mode !== 'standard') throw new ApiError('INVALID_DIRECTION', { reason: result.diagnostics[0]?.code ?? 'INVALID_DIRECTION', diagnostics: result.diagnostics.map(issue => ({ code: issue.code, message: issue.message })) });
      }
      const direction = directions.get(proposal.directionId), codes = new Set(direction?.variantIds.map(id => variants.get(id)?.code));
      if (!direction || proposal.instanceId !== direction.instanceId || proposal.targetKey !== direction.targetKey
        || canonicalStringify([...proposal.variantIds].sort()) !== canonicalStringify([...direction.variantIds].sort())
        || canonicalStringify(proposal.binding) !== canonicalStringify(direction.binding)
        || proposal.code !== (codes.size === 1 ? [...codes][0] : '')) throw new ApiError('PREVIEW_NOT_APPLICABLE');
    }
  } catch (error) { if (error instanceof WorkLimitError) throw new ApiError('INVALID_DIRECTION', { reason: error.code }); throw error; }
}

export function directionEligibility(snapshot: Snapshot, result: RuleResultDTO, targetSide: 'left' | 'right', budget: WorkBudget): DirectionEligibilityDTO {
  if (!result.instanceId || !result.binding || result.coverageOnly) return { eligible: false, diagnostics: [{ code: 'INVALID_DIRECTION', message: 'Este resultado no tiene una instancia estructural admitida.', severity: 'info' }] };
  try {
    const resolution = resolveDirection(snapshot, { instanceId: result.instanceId, variantIds: result.variantIds, binding: result.binding, targetSide }, { budget });
    return resolution.resolved ? { eligible: true, target: resolution.resolved.target, diagnostics: [] } : { eligible: false, diagnostics: resolution.diagnostics };
  } catch (error) {
    if (error instanceof WorkLimitError) return { eligible: false, diagnostics: [{ code: error.code, message: 'No se ha podido completar la comprobación de este lado dentro del presupuesto de la consulta.', severity: 'warning' }] };
    throw error;
  }
}
export function replaceDirections(store: WorkspaceStore, workspaceId: string, choices: readonly DirectionChoiceDTO[]): Snapshot {
  store.assertAccepting(workspaceId); store.assertIdle(workspaceId); const snapshot = store.current(workspaceId);
  if (!snapshot) throw new ApiError('INVALID_DIRECTION', { reason: 'VALIDATION_REQUIRED' });
  const runs = store.listRecords<ValidationBundle>('validation:' + workspaceId + ':').map(entry => entry.value)
    .filter(bundle => validationMatchesBasis(bundle, snapshot));
  if (!runs.length) throw new ApiError('INVALID_DIRECTION', { reason: 'VALIDATION_REQUIRED' });
  const instances = new Map(runs.flatMap(bundle => bundle.results).flatMap(result => result.instanceId && result.binding && !result.coverageOnly ? [[result.instanceId, result] as const] : []));
  const seen = new Set<string>(), directions: DirectionDTO[] = []; const budget = new WorkBudget();
  for (const choice of choices) {
    if (seen.has(choice.instanceId)) throw new ApiError('INVALID_DIRECTION', { reason: 'DUPLICATE_DIRECTION' }); seen.add(choice.instanceId);
    const result = instances.get(choice.instanceId); if (!result?.binding) throw new ApiError('INVALID_DIRECTION', { reason: 'UNKNOWN_INSTANCE' });
    try {
      const resolved = resolveDirection(snapshot, { instanceId: choice.instanceId, variantIds: result.variantIds, binding: result.binding, targetSide: choice.targetSide }, { budget });
      if (!resolved.resolved) throw new ApiError('INVALID_DIRECTION', { reason: resolved.diagnostics[0]?.code ?? 'INVALID_DIRECTION',
        diagnostics: resolved.diagnostics.map(diagnostic => ({ code: diagnostic.code, message: diagnostic.message })) }, result.sources[0]);
      directions.push(resolved.resolved.direction);
    } catch (error) { if (error instanceof WorkLimitError) throw new ApiError('INVALID_DIRECTION', { reason: error.code }); throw error; }
  }
  directions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Snapshot and preview invalidation share the store's single quota-checked publication.
  const directionDecisionState = replacedDirectionDecisionState();
  const configVersion = directionConfigurationVersion(directions, directionDecisionState);
  return store.publish(workspaceId, snapshot.versionId, { ...snapshot.content, configVersion, directionDecisionState, directions }, [], 'configuration');
}
