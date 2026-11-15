import { ApplicationError, NumericError, ProposalSelectionError, WorkLimitError } from '@ce/engine';
export async function executeHostedCommand(request) {
  const mode = request.claim.inputRefs.mode;
  if (mode === 'quota') throw new NumericError('RESOURCE_LIMIT');
  if (mode === 'selection') throw new ProposalSelectionError('PROPOSAL_SELECTION_NOT_APPLICABLE', 'Private calculation details');
  if (mode === 'application') throw new ApplicationError('SELECTION_NOT_CLOSED', 'Private calculation details');
  if (mode === 'unknown') throw Object.assign(new Error('Private provider credentials'), { code: 'INVALID_DIRECTION' });
  if (mode === 'cancelled') throw new WorkLimitError('CANCELLED', 'Private worker details');
  if (mode === 'deadline') throw new WorkLimitError('DEADLINE_EXCEEDED', 'Private worker details');
  if (mode === 'late-deadline') { request.claim.deadlineAt = new Date(Date.now() - 1).toISOString(); throw new WorkLimitError('CANCELLED', 'Private worker details'); }
  if (mode === 'late-cancel') { Atomics.store(new Int32Array(request.cancellation), 0, 1); return {}; }
  return { kind: 'validate', resultRef: { type: 'validation', id: 'synthetic' }, canonicalRoots: [], indexes: [], domain: { oversized: 'x'.repeat(262144) } };
}
