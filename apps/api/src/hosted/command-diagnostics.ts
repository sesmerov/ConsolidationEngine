import type { Diagnostic } from '@ce/contracts';
import { ApplicationError, DirectionReviewError, NumericError, ProfileError, ProposalSelectionError, RecalculationConfigurationError, SimulationError, WorkLimitError } from '@ce/engine';
import { ApiError } from '../errors.js';
import { receivedDiagnostic } from '../public-diagnostic.js';

/** Only recognized error classes supply codes; provider errors and arbitrary objects never supply public text. */
export function hostedCommandDiagnostic(error: unknown): Diagnostic {
  let code = 'INTERNAL_ERROR';
  if (error instanceof ApiError || error instanceof WorkLimitError || error instanceof ProfileError || error instanceof RecalculationConfigurationError
    || error instanceof ProposalSelectionError || error instanceof ApplicationError) code = error.code;
  else if (error instanceof NumericError && error.code === 'RESOURCE_LIMIT') code = error.code;
  else if (error instanceof SimulationError) code = error.code === 'INVALID_PREVIEW_ID' ? 'INVALID_REQUEST' : error.code;
  else if (error instanceof DirectionReviewError) code = ['UNKNOWN_GROUP', 'UNKNOWN_CANDIDATE', 'UNKNOWN_INSTANCE'].includes(error.reason) ? 'RESOURCE_NOT_FOUND'
    : error.reason === 'GROUP_CANDIDATE_ASSIGNED_ELSEWHERE' ? error.reason : 'INVALID_DIRECTION';
  return receivedDiagnostic({ code });
}
export function assertHostedCommandActive(deadline: string, cancelled: boolean, now = Date.now()): void {
  if (!Number.isFinite(Date.parse(deadline))) throw new ApiError('INTERNAL_ERROR');
  if (now >= Date.parse(deadline)) throw new WorkLimitError('DEADLINE_EXCEEDED', '');
  if (cancelled) throw new WorkLimitError('CANCELLED', '');
}
