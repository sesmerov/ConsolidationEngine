import type { RecalculationStateDTO } from '@ce/contracts';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { ApiError } from '../errors.js';
import { findCompatibleValidation, getValidation } from '../validation/validation-service.js';
import type { DirectionReviewService } from './direction-review-service.js';

/** Uses the current input identity, independently of any history selected by a browser. */
export function recalculationState(store: WorkspaceStore, reviews: DirectionReviewService, workspaceId: string): RecalculationStateDTO {
  const snapshot = store.current(workspaceId);
  if (!snapshot) throw new ApiError('RESOURCE_NOT_FOUND');
  const review = reviews.peekCompatible(workspaceId);
  const validation = review ? getValidation(store, workspaceId, review.summary.runId) : findCompatibleValidation(store, workspaceId, snapshot);
  const counts = review?.projection?.counts ?? null;
  const state = !validation ? 'needs_validation' : !counts ? 'preparation_required'
    : counts.pending || counts.conflicted || counts.undetermined ? 'pending' : counts.included || counts.omitted ? 'ready' : 'no_candidates';
  return { workspaceId, currentVersionId: snapshot.versionId, validationBasisId: snapshot.validationBasisId ?? snapshot.versionId,
    configuration: { configVersion: snapshot.content.configVersion, directionCount: snapshot.content.directions.length },
    ...(validation ? { compatibleRun: { id: validation.run.id, versionId: validation.run.versionId,
      validationBasisId: validation.run.validationBasisId ?? snapshot.validationBasisId ?? snapshot.versionId,
      ...(validation.run.endedAt ? { endedAt: validation.run.endedAt } : {}) } } : {}),
    ...(review ? { review: review.summary } : {}), counts, state };
}
