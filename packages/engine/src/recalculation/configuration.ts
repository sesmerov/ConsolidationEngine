import { LANGUAGE_PROFILE_V2 } from '@ce/contracts';
import type { Diagnostic, Snapshot } from '@ce/contracts';
import { WorkLimitError, type WorkBudget } from '../execution/budget.js';
import { assertSnapshotProfile } from '../profiles/registry.js';
import { resolveDirection } from './direction.js';
import { getRecalculationPolicy } from './policy.js';

export class RecalculationConfigurationError extends Error {
  readonly code = 'INVALID_DIRECTION';
  constructor(readonly diagnostics: readonly Diagnostic[]) { super('La configuración completa de recálculo no es admisible para esta versión.'); }
}
/** Run before graph creation and at publication. Legacy numeric blocked nodes retain their meaning. */
export function assertRecalculationConfiguration(snapshot: Snapshot, options: { budget?: WorkBudget } = {}): void {
  assertSnapshotProfile(snapshot, options.budget);
  if (snapshot.content.profileId !== LANGUAGE_PROFILE_V2) return;
  for (const direction of snapshot.content.directions) {
    options.budget?.check();
    const classified = getRecalculationPolicy(snapshot, direction, options);
    if (classified.policy.mode !== 'standard') {
      const limit = classified.diagnostics.find(d => d.code === 'RESOURCE_LIMIT' || d.code === 'CANCELLED' || d.code === 'DEADLINE_EXCEEDED');
      if (limit) throw new WorkLimitError(limit.code as 'RESOURCE_LIMIT' | 'CANCELLED' | 'DEADLINE_EXCEEDED', limit.message);
      throw new RecalculationConfigurationError(classified.diagnostics);
    }
    const resolution = resolveDirection(snapshot, direction, options);
    if (!resolution.resolved) throw new RecalculationConfigurationError(resolution.diagnostics);
  }
}
