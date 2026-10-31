import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, uuidSchema } from '@ce/contracts';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { checkExportData, exportLimits } from '../export/results-export.js';
import type { ExportLimits, ResultsExportData } from '../export/results-export.js';
import { getValidation } from '../validation/validation-service.js';
import { exportKey } from '../workers/export.worker.js';
import type { ExportArtifact } from '../workers/export.worker.js';
import { registerJobRoute } from './jobs.js';
export function registerExports(app: FastifyInstance, overrides?: Partial<ExportLimits>): void {
  const limits = exportLimits(overrides);
  registerJobRoute(app, { path: '/workspaces/:workspaceId/exports', kind: 'export', bodySchema: { type: 'object', additionalProperties: false, required: ['versionId', 'runId', 'kind'],
    properties: { versionId: uuidSchema, runId: uuidSchema, kind: { const: 'results' } } }, prepare: (request) => ({ input: request.body as JsonValue }),
    accept: async ({ workspaceId, input }) => {
      const body = input as { versionId: string; runId: string }; const snapshot = app.ce.store.snapshot(workspaceId, body.versionId), bundle = getValidation(app.ce.store, workspaceId, body.runId);
      if (bundle.run.versionId !== snapshot.versionId) throw new ApiError('STALE_VERSION'); if (bundle.run.status === 'running') throw new ApiError('WORKSPACE_BUSY');
      const data: ResultsExportData = { ...bundle, profileId: snapshot.content.profileId, versionId: snapshot.versionId, contentHash: snapshot.contentHash,
        contexts: snapshot.content.contexts, sources: snapshot.content.sources, catalog: { records: snapshot.content.catalog.records, variants: snapshot.content.catalog.variants, coverage: snapshot.content.catalog.coverage },
        synthetic: snapshot.content.contexts.some((context) => context.entityId === 'SYNTHETIC') };
      // Reject before structuredClone transfers the chosen resource to a worker; no current-snapshot clone is needed.
      checkExportData(data, limits); const lease = app.ce.files.reserve(workspaceId, 2 * limits.maxTotalBytes); const allocated: { id: string; path: string }[] = [];
      try {
        for (let i = 0; i < 3; i++) { const file = await app.ce.files.openFile(workspaceId, lease); allocated.push({ id: file.id, path: file.path }); await file.handle.close(); }
        const id = randomUUID(), [json, xlsx, zip] = allocated; let finalized = false;
        return { includeSnapshot: false, input: { exportId: id, fileId: zip!.id, data, paths: { json: json!.path, xlsx: xlsx!.path, zip: zip!.path }, limits } as unknown as JsonValue,
          finalize: async () => { if (finalized) return;
            const published = app.ce.store.getRecord<ExportArtifact>(exportKey(workspaceId, id));
            await app.ce.files.removeFiles(workspaceId, published ? [json!.id, xlsx!.id] : allocated.map((file) => file.id));
            if (published) await app.ce.files.retain(lease, [zip!.id]); else lease.release(); finalized = true;
          } };
      } catch (error) { await app.ce.files.removeFiles(workspaceId, allocated.map((file) => file.id)); lease.release(); throw error; }
    } });
  app.get<{ Params: { workspaceId: string; exportId: string } }>('/api/v1/workspaces/:workspaceId/exports/:exportId', { schema: { querystring: emptyQuerySchema,
    params: { type: 'object', additionalProperties: false, required: ['workspaceId', 'exportId'], properties: { workspaceId: uuidSchema, exportId: uuidSchema } } } }, async (request, reply) => {
    const { workspaceId, exportId } = request.params; app.ce.store.get(workspaceId); const artifact = app.ce.store.getRecord<ExportArtifact>(exportKey(workspaceId, exportId));
    if (!artifact) throw new ApiError('RESOURCE_NOT_FOUND'); await app.ce.jobs.settle(artifact.jobId);
    const location = await app.ce.files.filePath(workspaceId, artifact.fileId);
    return reply.type(artifact.mimeType).header('Content-Disposition', 'attachment; filename="results.zip"').header('Content-Length', artifact.size).send(createReadStream(location));
  });
}
