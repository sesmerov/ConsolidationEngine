import type { JsonValue, PreviewBundle, PreviewSelectionDTO } from '@ce/contracts';
import { selectionClosureHash, WorkBudget, WorkLimitError } from '@ce/engine';
import { ApiError } from '../errors.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { proposalSelectionCacheKey, proposalSelectionKey, terminalSelection, type ProposalSelectionRecord } from './proposal-selection-record.js';
export const previewKey = (workspaceId: string, previewId: string) => 'preview:' + workspaceId + ':' + previewId;
export function getPreview(store: WorkspaceStore, workspaceId: string, previewId: string): PreviewBundle {
  store.get(workspaceId); const bundle = store.getRecord<PreviewBundle>(previewKey(workspaceId, previewId));
  if (!bundle) throw new ApiError('RESOURCE_NOT_FOUND'); return bundle;
}
/** Read-only exact transitive closure. Missing ancestors are reported, never selected implicitly. */
export function selectPreview(bundle: PreviewBundle, selection: readonly string[], budget = new WorkBudget()): PreviewSelectionDTO {
  const { preview, proposals } = bundle;
  if (preview.state !== 'ready' && preview.state !== 'obsolete') throw new ApiError('PREVIEW_NOT_APPLICABLE');
  try {
    const byId = new Map(proposals.map(proposal => [proposal.id, proposal]));
    const selectedIds = [...new Set(selection)].sort(), selected = new Set(selectedIds), visited = new Set<string>(), pending = [...selectedIds];
    for (const id of selectedIds) if (!byId.has(id)) throw new ApiError('INVALID_REQUEST');
    while (pending.length) {
      const id = pending.pop()!; if (visited.has(id)) continue; budget.consume('instances'); visited.add(id);
      const proposal = byId.get(id); if (!proposal || proposal.state !== (preview.state === 'ready' ? 'available' : 'obsolete')) throw new ApiError('PREVIEW_NOT_APPLICABLE');
      for (const ancestor of proposal.predecessorIds) { budget.consume('edges'); if (!visited.has(ancestor)) pending.push(ancestor); }
    }
    const requiredIds = [...visited].filter(id => !selected.has(id)).sort();
    return { selectedIds, requiredIds, complete: requiredIds.length === 0, state: preview.state,
      closureHash: selectionClosureHash(preview, selectedIds, requiredIds) };
  } catch (error) { if (error instanceof WorkLimitError) throw new ApiError('EXPANSION_LIMIT', { reason: error.code }); throw error; }
}
/** Build the history transition; the caller publishes it with receipt, runs and snapshot in one commit. */
export function markPreviewApplied(bundle: PreviewBundle, receiptId: string, acceptedIds: readonly string[]): PreviewBundle {
  if (bundle.preview.state !== 'ready') throw new ApiError('PREVIEW_NOT_APPLICABLE');
  const selected = new Set(acceptedIds);
  return { preview: { ...bundle.preview, state: 'applied', appliedReceiptId: receiptId },
    proposals: bundle.proposals.map(proposal => ({ ...proposal, state: selected.has(proposal.id) ? 'applied' : 'obsolete' })) };
}
export function discardPreview(store: WorkspaceStore, workspaceId: string, previewId: string): PreviewBundle {
  store.assertAccepting(workspaceId); store.assertIdle(workspaceId); const bundle = getPreview(store, workspaceId, previewId);
  if (bundle.preview.state === 'discarded') return bundle;
  if (bundle.preview.state !== 'ready') throw new ApiError('PREVIEW_NOT_APPLICABLE');
  const discarded: PreviewBundle = { preview: { ...bundle.preview, state: 'discarded' }, proposals: bundle.proposals.map(proposal => proposal.state === 'available' ? { ...proposal, state: 'discarded' } : proposal) };
  const selection = store.getRecord<ProposalSelectionRecord>(proposalSelectionKey(workspaceId, previewId));
  store.putRecords([{ key: previewKey(workspaceId, previewId), value: discarded as unknown as JsonValue },
    ...(selection ? [{ key: proposalSelectionKey(workspaceId, previewId), value: (selection.projection ? terminalSelection(selection, 'discarded') : { summary: { ...selection.summary, state: 'failed' } }) as unknown as JsonValue },
      { key: proposalSelectionCacheKey(workspaceId, previewId), value: { entries: [] } }] : [])]); return discarded;
}
