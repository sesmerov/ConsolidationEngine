import type { FastifyInstance } from 'fastify';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { stageMultipart } from '../import/multipart-staging.js';
import type { UploadLimits } from '../import/multipart-staging.js';
import { registerJobRoute } from './jobs.js';
export function registerImports(app: FastifyInstance, limits?: Partial<UploadLimits>): void {
  registerJobRoute(app, { path: '/workspaces/:workspaceId/imports', kind: 'import', prepare: async (request) => {
    const workspaceId = (request.params as { workspaceId: string }).workspaceId;
    const key = request.headers['idempotency-key'] as string;
    const recognized = app.ce.idempotency.has({ workspaceId, key, operation: 'import:/workspaces/:workspaceId/imports' });
    if (!recognized && app.ce.store.get(workspaceId).activeJobId) throw new ApiError('WORKSPACE_BUSY');
    const reception = app.ce.uploads.acquire(workspaceId);
    try {
      const staged = await stageMultipart(request, app.ce.files, workspaceId, limits, reception.signal);
      return { input: { files: staged.files } as unknown as JsonValue, bodyHash: staged.bodyHash, cleanup: staged.cleanup, release: reception.release };
    } catch (error) { reception.release(); throw error; }
  } });
}
