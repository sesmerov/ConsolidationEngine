import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, uuidSchema, versionExportSummarySchema } from '@ce/contracts';
import { WorkBudget } from '@ce/engine';
import type { ApplicationBundle, JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { checkExportData, exportLimits } from '../export/results-export.js';
import type { ExportLimits, ResultsExportData } from '../export/results-export.js';
import { prepareReportExportData, reportExportLimits } from '../export/recalculated-report.js';
import type { ReportExportLimits } from '../export/recalculated-report.js';
import { getValidation } from '../validation/validation-service.js';
import { exportKey } from '../workers/export.worker.js';
import type { ExportArtifact } from '../workers/export.worker.js';
import { registerJobRoute } from './jobs.js';
import { versionExportSummary } from '../export/report-ownership.js';
export function registerExports(app: FastifyInstance, overrides?: Partial<ExportLimits>, reportOverrides?: Partial<ReportExportLimits>): void {
  const resultsLimits = exportLimits(overrides), reportLimits = reportExportLimits(reportOverrides);
  app.get<{ Params: { workspaceId: string; versionId: string } }>('/api/v1/workspaces/:workspaceId/versions/:versionId/export-summary', { schema: {
    querystring: emptyQuerySchema, params: { type: 'object', additionalProperties: false, required: ['workspaceId', 'versionId'], properties: { workspaceId: uuidSchema, versionId: uuidSchema } },
    response: { 200: versionExportSummarySchema },
  } }, request => {
    const snapshot = app.ce.store.snapshot(request.params.workspaceId, request.params.versionId), budget = new WorkBudget({ cancelled: () => request.raw.aborted });
    return versionExportSummary(snapshot, () => budget.check());
  });
  registerJobRoute(app, { path: '/workspaces/:workspaceId/exports', kind: 'export', bodySchema: { oneOf: [
    { type: 'object', additionalProperties: false, required: ['versionId', 'runId', 'kind'], properties: { versionId: uuidSchema, runId: uuidSchema, kind: { const: 'results' } } },
    { type: 'object', additionalProperties: false, required: ['versionId', 'kind'], properties: { versionId: uuidSchema, kind: { const: 'report' } } },
  ] }, prepare: (request) => ({ input: request.body as JsonValue }),
    accept: async ({ workspaceId, input }) => {
      const body = input as { kind: 'results'; versionId: string; runId: string } | { kind: 'report'; versionId: string };
      const snapshot = app.ce.store.snapshot(workspaceId, body.versionId);
      const prepared = (() => {
        if (body.kind === 'report') {
          const data = prepareReportExportData(snapshot, { snapshot: versionId => app.ce.store.snapshot(workspaceId, versionId),
            applications: app.ce.store.listRecords<ApplicationBundle>('application:' + workspaceId + ':').map(record => record.value) }, reportLimits);
          return { kind: 'report' as const, data, limits: reportLimits, reportCount: data.partitions.length };
        }
        const bundle = getValidation(app.ce.store, workspaceId, body.runId);
        if (bundle.run.versionId !== snapshot.versionId) throw new ApiError('STALE_VERSION'); if (bundle.run.status === 'running') throw new ApiError('WORKSPACE_BUSY');
        const data: ResultsExportData = { ...bundle, profileId: snapshot.content.profileId, versionId: snapshot.versionId, contentHash: snapshot.contentHash,
          ...(snapshot.content.reportSourceBindings ? { reportSourceBindings: snapshot.content.reportSourceBindings } : {}),
          contexts: snapshot.content.contexts, sources: snapshot.content.sources, catalog: { records: snapshot.content.catalog.records, variants: snapshot.content.catalog.variants, coverage: snapshot.content.catalog.coverage },
          synthetic: snapshot.content.contexts.some((context) => context.entityId === 'SYNTHETIC') };
        checkExportData(data, resultsLimits); return { kind: 'results' as const, data, limits: resultsLimits, reportCount: 0 };
      })();
      // Reject before structuredClone transfers the chosen resource to a worker; no current-snapshot clone is needed.
      const lease = app.ce.files.reserve(workspaceId, 2 * prepared.limits.maxTotalBytes); const allocated: { id: string; path: string }[] = [];
      try {
        for (let i = 0; i < prepared.reportCount + 3; i++) { const file = await app.ce.files.openFile(workspaceId, lease); allocated.push({ id: file.id, path: file.path }); await file.handle.close(); }
        const id = randomUUID(), [json, xlsx, zip] = allocated.slice(-3), paths = { json: json!.path, xlsx: xlsx!.path, zip: zip!.path }; let finalized = false;
        return { includeSnapshot: false, input: { exportId: id, fileId: zip!.id, kind: prepared.kind, data: prepared.data,
          paths: prepared.kind === 'report' ? { ...paths, reports: allocated.slice(0, prepared.reportCount).map(file => file.path) } : paths, limits: prepared.limits } as unknown as JsonValue,
          finalize: async () => { if (finalized) return;
            const published = app.ce.store.getRecord<ExportArtifact>(exportKey(workspaceId, id));
            await app.ce.files.removeFiles(workspaceId, allocated.filter(file => !published || file.id !== zip!.id).map(file => file.id));
            if (published) await app.ce.files.retain(lease, [zip!.id]); else lease.release(); finalized = true;
          } };
      } catch (error) { await app.ce.files.removeFiles(workspaceId, allocated.map((file) => file.id)); lease.release(); throw error; }
    } });
  app.get<{ Params: { workspaceId: string; exportId: string } }>('/api/v1/workspaces/:workspaceId/exports/:exportId', { schema: { querystring: emptyQuerySchema,
    params: { type: 'object', additionalProperties: false, required: ['workspaceId', 'exportId'], properties: { workspaceId: uuidSchema, exportId: uuidSchema } } } }, async (request, reply) => {
    const { workspaceId, exportId } = request.params; app.ce.store.get(workspaceId); const artifact = app.ce.store.getRecord<ExportArtifact>(exportKey(workspaceId, exportId));
    if (!artifact) throw new ApiError('RESOURCE_NOT_FOUND'); await app.ce.jobs.settle(artifact.jobId);
    const location = await app.ce.files.filePath(workspaceId, artifact.fileId);
    return reply.type(artifact.mimeType).header('Content-Disposition', 'attachment; filename="' + artifact.filename + '"').header('Content-Length', artifact.size).send(createReadStream(location));
  });
}
