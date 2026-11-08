import { UUID_PATTERN } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { AcceptedJobReference, JobDispatcher } from '../ports/job-dispatcher.js';

/** In-process delivery only. The local authority, rather than a transport cache, deduplicates it. */
export class LocalJobDispatcher implements JobDispatcher {
  constructor(private readonly deliver: (reference: AcceptedJobReference) => void | Promise<void>) {}
  async dispatch(reference: AcceptedJobReference): Promise<void> {
    const { sessionId, workspaceId, jobId } = reference;
    if (![sessionId, workspaceId, jobId].every(id => UUID_PATTERN.test(id))) throw new ApiError('INVALID_REQUEST');
    await Promise.resolve();
    await this.deliver(Object.freeze({ sessionId, workspaceId, jobId }));
  }
}
