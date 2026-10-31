import type { FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
export function requireCurrentVersion(request: FastifyRequest, store: WorkspaceStore, workspaceId: string): void {
  const etag = request.headers['if-match'];
  if (!etag) throw new ApiError('PRECONDITION_REQUIRED');
  if (etag !== store.etag(workspaceId)) throw new ApiError('STALE_VERSION');
  store.assertAccepting(workspaceId);
}
