import type { DirectionChoiceDTO, DirectionDTO, DirectionEligibilityDTO, RuleResultDTO, Snapshot, ValidationBundle } from '@ce/contracts';
import { resolveDirection, WorkBudget, WorkLimitError } from '@ce/engine';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { WorkspaceStore } from '../session/workspace-store.js';

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
    .filter(bundle => bundle.run.versionId === snapshot.versionId && bundle.run.status === 'completed' && bundle.run.summary.complete);
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
  return store.publish(workspaceId, snapshot.versionId, { ...snapshot.content, configVersion: canonicalHash(directions), directions });
}
