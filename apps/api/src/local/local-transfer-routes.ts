import type { FastifyInstance } from 'fastify';
import { TRANSFER_PART_MAX_BYTES, uuidSchema } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from '../routes/jobs.js';
import { registerUploadBatches } from '../routes/upload-batches.js';
import { registerExportTransfers } from '../routes/exports.js';

export function registerLocalTransfers(app: FastifyInstance): void {
  const owner = (_request: unknown, workspaceId: string) => ({ sessionId: app.ce.store.sessionId, workspaceId });
  if (!app.hasContentTypeParser('application/octet-stream')) app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: TRANSFER_PART_MAX_BYTES }, (_request, bytes, done) => done(null, bytes));
  registerUploadBatches(app, { service: app.ce.adapters.uploads, owner });
  registerExportTransfers(app, app.ce.adapters.exports, owner);
  registerJobRoute(app, { path: '/workspaces/:workspaceId/upload-batches/:batchId/seal', kind: 'seal-upload',
    paramsSchema: { type: 'object', additionalProperties: false, required: ['workspaceId','batchId'], properties: { workspaceId: uuidSchema, batchId: uuidSchema } },
    bodySchema: { type: 'object', additionalProperties: false, required: ['baseVersionId'], properties: { baseVersionId: { anyOf: [uuidSchema, { type: 'null' }] } } },
    prepare: request => { const { batchId } = request.params as { batchId: string }, body = request.body as { baseVersionId: string|null }; return { input: { batchId, ...body }, bodyHash: canonicalHash({ batchId, ...body }) }; },
    accept: async ({ workspaceId, jobId, baseVersionId, input }) => {
      const body = input as { batchId: string; baseVersionId: string|null };
      if ((baseVersionId ?? null) !== body.baseVersionId) throw new ApiError('STALE_VERSION');
      const service = app.ce.adapters.uploads, batch = await service.get(owner(null, workspaceId), body.batchId);
      if (batch.baseVersionId !== body.baseVersionId) throw new ApiError('STALE_VERSION'); return service.prepareSeal(owner(null, workspaceId), body.batchId, jobId);
    },
  });
}
