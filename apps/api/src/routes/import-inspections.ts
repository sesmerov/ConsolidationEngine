import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { activeImportInspectionSchema, emptyQuerySchema, importInspectionCommitSchema, importInspectionSchema, uuidSchema, workspaceParamsSchema } from '@ce/contracts';
import type { ImportContextInputDTO, ImportInspectionCommitDTO, JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { StagedFile, UploadLimits } from '../import/multipart-staging.js';
import { stageMultipart } from '../import/multipart-staging.js';
import { requireCurrentVersion } from '../plugins/version-guard.js';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from './jobs.js';
const params = { type: 'object', additionalProperties: false, required: ['workspaceId', 'inspectionId'], properties: { workspaceId: uuidSchema, inspectionId: uuidSchema } } as const;
export function registerImportInspections(app: FastifyInstance, limits?: Partial<UploadLimits>): void {
  registerJobRoute(app, { path: '/workspaces/:workspaceId/import-inspections', kind: 'inspect-import',
    prepare: async request => {
      const workspaceId = (request.params as { workspaceId: string }).workspaceId, key = request.headers['idempotency-key'] as string;
      const replay = app.ce.idempotency.has({ workspaceId, key, operation: 'inspect-import:/workspaces/:workspaceId/import-inspections' });
      if (!replay) { await app.ce.inspections.assertAvailable(workspaceId); if (app.ce.store.get(workspaceId).activeJobId) throw new ApiError('WORKSPACE_BUSY'); }
      const reception = app.ce.uploads.acquire(workspaceId), id = randomUUID();
      try {
        const staged = await stageMultipart(request, app.ce.files, workspaceId, limits, reception.signal, 'inspection');
        try { await staged.retain(); } catch (error) { await staged.cleanup(); throw error; }
        return { input: { inspectionId: id, files: staged.files, context: staged.context! } as unknown as JsonValue, bodyHash: staged.bodyHash,
          cleanup: () => app.ce.inspections.cleanupStaged(workspaceId, id, staged), release: reception.release };
      } catch (error) { reception.release(); throw error; }
    }, accept: ({ workspaceId, baseVersionId, input }) => {
      const value = input as unknown as { inspectionId: string; files: readonly StagedFile[]; context: ImportContextInputDTO };
      return app.ce.inspections.prepareInspection(workspaceId, value.inspectionId, value, baseVersionId);
    },
  });
  app.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId/import-inspections', { schema: { params: workspaceParamsSchema, querystring: emptyQuerySchema, response: { 200: activeImportInspectionSchema } } }, async request => ({ active: await app.ce.inspections.active(request.params.workspaceId) }));
  app.get<{ Params: { workspaceId: string; inspectionId: string } }>('/api/v1/workspaces/:workspaceId/import-inspections/:inspectionId', { schema: { params, querystring: emptyQuerySchema, response: { 200: importInspectionSchema } } }, async request => app.ce.inspections.get(request.params.workspaceId, request.params.inspectionId));
  registerJobRoute(app, { path: '/workspaces/:workspaceId/import-inspections/:inspectionId/commit', kind: 'import', bodySchema: importInspectionCommitSchema, paramsSchema: params,
    prepare: request => {
      const inspectionId = (request.params as { inspectionId: string }).inspectionId, body = request.body as ImportInspectionCommitDTO;
      const input = { inspectionId, ...body };
      return { input, bodyHash: canonicalHash(input) };
    }, accept: ({ workspaceId, input, jobId }) => {
      const body = input as unknown as ImportInspectionCommitDTO & { inspectionId: string };
      return app.ce.inspections.prepareCommit(workspaceId, body.inspectionId, body, jobId);
    },
  });
  app.delete<{ Params: { workspaceId: string; inspectionId: string } }>('/api/v1/workspaces/:workspaceId/import-inspections/:inspectionId', { schema: { params, querystring: emptyQuerySchema, response: { 200: importInspectionSchema } } }, async (request, reply) => {
    if (request.body !== undefined) throw new ApiError('INVALID_REQUEST');
    const { workspaceId, inspectionId } = request.params; requireCurrentVersion(request, app.ce.store, workspaceId);
    return reply.header('ETag', app.ce.store.etag(workspaceId)).send(await app.ce.inspections.discard(workspaceId, inspectionId));
  });
}
