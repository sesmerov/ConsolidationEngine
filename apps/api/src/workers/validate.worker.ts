import { runValidation } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { validationKey } from '../validation/validation-service.js';
import type { OperationContext, WorkerOutput } from './protocol.js';
export function execute(input: JsonValue, context: OperationContext): WorkerOutput {
  if (!context.snapshot || !input || typeof input !== 'object' || Array.isArray(input) || !('runId' in input) || !('startedAt' in input) || typeof input.runId !== 'string' || typeof input.startedAt !== 'string') throw new ApiError('INVALID_REQUEST');
  const bundle = runValidation(context.snapshot, { runId: input.runId, startedAt: input.startedAt, cancelled: context.cancelled, progress: context.progress,
    ...('limits' in input ? { limits: input.limits as Partial<WorkLimits> } : {}) });
  if (bundle.run.status !== 'completed') return { complete: false, diagnostics: bundle.run.diagnostics };
  return { complete: true, resultRef: { type: 'validation', id: bundle.run.id }, records: [{ key: validationKey(context.job.workspaceId, bundle.run.id), value: bundle as unknown as JsonValue }] };
}
