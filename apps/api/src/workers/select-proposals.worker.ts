import type { JsonValue, PreviewBundle, ProposalSelectionOperationDTO } from '@ce/contracts';
import { createProposalSelection, editProposalSelection, ProposalSelectionError, WorkBudget, WorkLimitError } from '@ce/engine';
import type { ProposalSelectionProjection, WorkLimits } from '@ce/engine';
import type { OperationContext, WorkerOutput } from './protocol.js';
import { ApiError } from '../errors.js';
export function execute(input: JsonValue, context: OperationContext): WorkerOutput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('INVALID_REQUEST');
  const data = input as unknown as { selectionId: string; preview: PreviewBundle; prior?: ProposalSelectionProjection; operations?: readonly ProposalSelectionOperationDTO[]; limits?: Partial<WorkLimits> };
  if (typeof data.selectionId !== 'string' || !data.preview?.preview || data.preview.preview.baseVersionId !== context.job.baseVersionId || data.preview.preview.state !== 'ready') throw new ApiError('INVALID_REQUEST');
  try {
    const budget = new WorkBudget({ cancelled: context.cancelled, ...(data.limits ? { limits: data.limits } : {}) }); context.progress(0, 1);
    const selectionProjection = data.prior && data.operations ? editProposalSelection(data.preview, data.prior, data.operations, budget) : createProposalSelection(data.preview, 'empty', budget);
    context.progress(1, 1); return { complete: true, resultRef: { type: 'proposal-selection', id: data.selectionId }, selectionProjection };
  } catch (error) {
    if (error instanceof ProposalSelectionError || error instanceof WorkLimitError) return { complete: false, diagnostics: [{ code: error.code, message: 'No se completó la selección. Se conserva la decisión anterior.' }] };
    throw error;
  }
}
