import { randomUUID } from 'node:crypto';
import { NumericError, ProfileError, RecalculationConfigurationError, SimulationError, WorkLimitError, WorkBudget, createProposalSelection, simulate } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { previewKey } from '../recalculation/preview-store.js';
import { proposalSelectionKey, selectionSummary } from '../recalculation/proposal-selection-record.js';
import type { OperationContext, WorkerOutput } from './protocol.js';
export function execute(input: JsonValue, context: OperationContext): WorkerOutput {
  if (!context.snapshot || !input || typeof input !== 'object' || Array.isArray(input) || !('previewId' in input) || typeof input.previewId !== 'string') throw new ApiError('INVALID_REQUEST');
  try {
    const bundle = simulate(context.snapshot, { previewId: input.previewId, cancelled: context.cancelled, progress: context.progress,
      ...('limits' in input ? { limits: input.limits as Partial<WorkLimits> } : {}) });
    const projection = createProposalSelection(bundle, 'available', new WorkBudget({ cancelled: context.cancelled, ...('limits' in input ? { limits: input.limits as Partial<WorkLimits> } : {}) }));
    const selection = { summary: selectionSummary({ id: randomUUID(), workspaceId: context.job.workspaceId, previewId: bundle.preview.id,
      baseVersionId: bundle.preview.baseVersionId, revision: 1, state: 'ready', initializationJobId: context.job.jobId }, projection), projection };
    return { complete: true, resultRef: { type: 'preview', id: bundle.preview.id }, records: [
      { key: previewKey(context.job.workspaceId, bundle.preview.id), value: bundle as unknown as JsonValue },
      { key: proposalSelectionKey(context.job.workspaceId, bundle.preview.id), value: selection as unknown as JsonValue },
    ] };
  } catch (error) {
    if (error instanceof RecalculationConfigurationError || error instanceof ProfileError) return { complete: false, diagnostics: [{ code: error.code, message: error.message }, ...error.diagnostics] };
    if (error instanceof WorkLimitError || error instanceof NumericError && error.code === 'RESOURCE_LIMIT' || error instanceof SimulationError && error.code === 'PROFILE_MISMATCH')
      return { complete: false, diagnostics: [{ code: error.code, message: 'No se completó la previsualización.' }] };
    if (error instanceof SimulationError) throw new ApiError('INVALID_REQUEST'); throw error;
  }
}
