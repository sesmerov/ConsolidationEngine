import type { UUID } from '@ce/contracts';
import type { WorkspaceOwner } from './workspace-repository.js';

/** The job and its inputs must already be accepted by the authority. No closures or input data. */
export interface AcceptedJobReference extends WorkspaceOwner { readonly jobId: UUID }
export interface JobDispatcher {
  /** Resolves after delivery acknowledgement, not after calculation. Callers handle uncertainty. */
  dispatch(reference: AcceptedJobReference): Promise<void>;
}
