import { ApplicationError, NumericError, ProfileError, RecalculationConfigurationError, WorkLimitError, WorkBudget, selectedProposalIds, applyCandidate } from '@ce/engine';
import type { ApplyCandidateOptions, ProposalSelectionProjection, WorkLimits } from '@ce/engine';
import type { JsonValue, PreviewBundle, ValidationBundle } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { OperationContext, WorkerOutput } from './protocol.js';

export function execute(input: JsonValue, context: OperationContext): WorkerOutput {
  if (!context.snapshot || !input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('INVALID_REQUEST');
  const data = input as Record<string, JsonValue>;
  if (['receiptId', 'newVersionId', 'beforeRunId', 'runId', 'startedAt', 'closureHash'].some(key => typeof data[key] !== 'string')
    || (!data.selectionProjection && (!Array.isArray(data.selectedIds) || !data.selectedIds.every(id => typeof id === 'string')))
    || !data.preview || typeof data.preview !== 'object' || Array.isArray(data.preview) || !('preview' in data.preview) || !('proposals' in data.preview)) throw new ApiError('INVALID_REQUEST');
  try {
    const budget = new WorkBudget({ cancelled: context.cancelled, ...('limits' in data ? { limits: data.limits as Partial<WorkLimits> } : {}) });
    const selectedIds = data.selectionProjection ? selectedProposalIds(data.preview as unknown as PreviewBundle, data.selectionProjection as unknown as ProposalSelectionProjection, budget) : data.selectedIds as string[];
    const options: ApplyCandidateOptions = { receiptId: data.receiptId as string, newVersionId: data.newVersionId as string, beforeRunId: data.beforeRunId as string,
      runId: data.runId as string, startedAt: data.startedAt as string, selectedIds, closureHash: data.closureHash as string, budget,
      cancelled: context.cancelled, progress: context.progress, ...('limits' in data ? { limits: data.limits as Partial<WorkLimits> } : {}),
      ...('beforeValidation' in data ? { beforeValidation: data.beforeValidation as unknown as ValidationBundle } : {}) };
    const applicationCandidate = applyCandidate(context.snapshot, data.preview as unknown as PreviewBundle, options);
    return { complete: true, applicationCandidate, ...(data.selectionProjection ? { applicationSelectedIds: selectedIds } : {}), resultRef: { type: 'application', id: options.receiptId } };
  } catch (error) {
    if (error instanceof RecalculationConfigurationError || error instanceof ProfileError) return { complete: false, diagnostics: [{ code: error.code, message: error.message }, ...error.diagnostics] };
    if (error instanceof WorkLimitError || error instanceof NumericError && error.code === 'RESOURCE_LIMIT' || error instanceof ApplicationError)
      return { complete: false, diagnostics: [{ code: error.code, message: 'No se completó la aplicación.' }] };
    throw error;
  }
}
