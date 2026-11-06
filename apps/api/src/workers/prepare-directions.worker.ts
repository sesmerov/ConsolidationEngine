import type { JsonValue } from '@ce/contracts';
import { prepareDirectionProjection } from '@ce/engine';
import { ApiError } from '../errors.js';
import { runDirectionWork } from './direction-review-worker.js';
import type { OperationContext, PrepareDirectionsInput, WorkerOutput } from './protocol.js';

export function execute(input: JsonValue, context: OperationContext): WorkerOutput {
  const snapshot = context.snapshot;
  if (!snapshot) throw new ApiError('INVALID_REQUEST');
  const { seeds, reviewId, limits } = input as unknown as PrepareDirectionsInput;
  return runDirectionWork(context, limits, budget => ({
    complete: true, directionReviewProjection: prepareDirectionProjection(snapshot, seeds, { budget, reviewId }),
    resultRef: { type: 'direction-review', id: reviewId },
  }));
}
