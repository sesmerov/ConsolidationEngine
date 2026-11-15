import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, transferPartSchema, uploadBatchCreateSchema, uploadBatchSchema, uuidSchema, TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
import type { JobDTO, UploadBatchCreateDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { UploadBatchService } from '../storage/upload-batches.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';

interface BatchParams { workspaceId: string; batchId: string }
interface PartParams extends BatchParams { fileId: string; index: string }
const params = (extra: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required: ['workspaceId', ...Object.keys(extra)], properties: { workspaceId: uuidSchema, ...extra } });
export interface UploadBatchRouteDependencies {
  readonly service: UploadBatchService;
  readonly owner: (request: FastifyRequest, workspaceId: string) => WorkspaceOwner;
  readonly seal?: (request: FastifyRequest, owner: WorkspaceOwner, batchId: string) => Promise<{ status: 202|503; job: JobDTO }>;
}
/** Request identity is supplied by the selected local/hosted composition, never stored globally here. */
export function registerUploadBatches(app: FastifyInstance, deps: UploadBatchRouteDependencies): void {
  app.post<{ Params: { workspaceId: string }; Body: UploadBatchCreateDTO }>('/api/v1/workspaces/:workspaceId/upload-batches', { schema: { params: params({}), querystring: emptyQuerySchema, body: uploadBatchCreateSchema, response: { 201: uploadBatchSchema } } }, async (request, reply) => {
    const etag = request.headers['if-match']; if (typeof etag !== 'string') throw new ApiError('PRECONDITION_REQUIRED');
    const key = request.headers['idempotency-key']; if (typeof key !== 'string') throw new ApiError('INVALID_REQUEST', { reason: 'IDEMPOTENCY_KEY_REQUIRED' });
    return reply.code(201).send(await deps.service.create(deps.owner(request, request.params.workspaceId), request.body, etag, key));
  });
  app.get<{ Params: BatchParams }>('/api/v1/workspaces/:workspaceId/upload-batches/:batchId', { schema: { params: params({ batchId: uuidSchema }), querystring: emptyQuerySchema, response: { 200: uploadBatchSchema } } }, request => deps.service.get(deps.owner(request, request.params.workspaceId), request.params.batchId));
  app.post<{ Params: PartParams; Body: Buffer }>('/api/v1/workspaces/:workspaceId/upload-batches/:batchId/files/:fileId/parts/:index', {
    bodyLimit: TRANSFER_PART_MAX_BYTES,
    schema: { params: params({ batchId: uuidSchema, fileId: uuidSchema, index: { type: 'string', pattern: '^[0-3]$' } }), querystring: emptyQuerySchema, response: { 200: transferPartSchema } },
    onRequest: async request => {
      const { workspaceId, batchId, fileId, index } = request.params, rawSize = request.headers['content-length'];
      if ((request.headers['content-type'] ?? '').split(';')[0] !== 'application/octet-stream') throw new ApiError('INVALID_REQUEST');
      if (rawSize !== undefined && !/^[1-9][0-9]*$/.test(rawSize)) throw new ApiError('INVALID_REQUEST');
      const size = rawSize === undefined ? undefined : Number(rawSize); if (size !== undefined && (!Number.isSafeInteger(size) || size > TRANSFER_PART_MAX_BYTES)) throw new ApiError('UPLOAD_LIMIT');
      await deps.service.authorizePart(deps.owner(request, workspaceId), batchId, fileId, Number(index), size);
    },
  }, request => { const { workspaceId, batchId, fileId, index } = request.params, hash = request.headers['x-ce-part-sha256'];
    if (!Buffer.isBuffer(request.body) || typeof hash !== 'string') throw new ApiError('INVALID_REQUEST');
    return deps.service.putPart(deps.owner(request, workspaceId), batchId, fileId, Number(index), request.body, hash);
  });
  app.delete<{ Params: BatchParams }>('/api/v1/workspaces/:workspaceId/upload-batches/:batchId', { schema: { params: params({ batchId: uuidSchema }), querystring: emptyQuerySchema } }, async (request, reply) => { await deps.service.cancel(deps.owner(request, request.params.workspaceId), request.params.batchId); return reply.code(204).send(); });
  if (deps.seal) app.post<{ Params: BatchParams }>('/api/v1/workspaces/:workspaceId/upload-batches/:batchId/seal', { schema: { params: params({ batchId: uuidSchema }), querystring: emptyQuerySchema, body: { type: 'object', additionalProperties: false, required: ['baseVersionId'], properties: { baseVersionId: { anyOf: [uuidSchema, { type: 'null' }] } } } } }, async (request, reply) => {
    const accepted = await deps.seal!(request, deps.owner(request, request.params.workspaceId), request.params.batchId); return reply.code(accepted.status).send(accepted.job);
  });
}
