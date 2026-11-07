import type { ProposalSelectionSummaryDTO } from '@ce/contracts';
import type { ProposalSelectionProjection } from '@ce/engine';
export interface ProposalSelectionRecord { readonly summary: ProposalSelectionSummaryDTO; readonly projection?: ProposalSelectionProjection }
export const proposalSelectionKey = (workspaceId: string, previewId: string) => `proposal-selection:${workspaceId}:${previewId}`;
export const proposalSelectionCacheKey = (workspaceId: string, previewId: string) => `proposal-selection-cache:${workspaceId}:${previewId}`;
export function selectionSummary(summary: ProposalSelectionSummaryDTO, projection: ProposalSelectionProjection): ProposalSelectionSummaryDTO {
  return { ...summary, availableCount: projection.availableCount, selectedCount: projection.selectedCount, requiredCount: projection.requiredCount,
    complete: projection.complete, closureHash: projection.closureHash };
}
export function terminalSelection(record: ProposalSelectionRecord, state: 'applied' | 'obsolete' | 'discarded'): ProposalSelectionRecord {
  const { pendingJobId: _pending, ...summary } = record.summary;
  return { ...record, summary: { ...summary, state, ...(record.projection ? { availableCount: 0 } : {}) } };
}
