import type { JsonValue } from '@ce/contracts';
import { compileDirectionConfiguration } from '@ce/engine';
import { ApiError } from '../errors.js';
import { runDirectionWork } from './direction-review-worker.js';
import type { CommitDirectionsInput, OperationContext, WorkerOutput } from './protocol.js';

export function execute(input: JsonValue, context: OperationContext): WorkerOutput {
  const snapshot = context.snapshot;
  if (!snapshot) throw new ApiError('INVALID_REQUEST');
  const { projection, limits } = input as unknown as CommitDirectionsInput;
  return runDirectionWork(context, limits, budget => ({
    complete: true, directionCompilation: compileDirectionConfiguration(snapshot, projection, { budget }),
    resultRef: { type: 'direction-review', id: projection.reviewId },
  }));
}
