import type { FastifyInstance } from 'fastify';
import { applicationDetailSchema, applicationRequestSchema, comparisonPageSchema, emptyQuerySchema, uuidSchema } from '@ce/contracts';
import type { ApplicationRequestDTO, ComparisonRowDTO } from '@ce/contracts';
import { resultOrderKey } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import { getApplication, prepareApplication } from '../recalculation/application-service.js';
import { getValidation } from '../validation/validation-service.js';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from './jobs.js';
import { createPager, paginationProperties } from './pagination.js';
type Params = { workspaceId: string; receiptId: string };
const params = { type: 'object', additionalProperties: false, required: ['workspaceId', 'receiptId'], properties: { workspaceId: uuidSchema, receiptId: uuidSchema } } as const;
export function registerApplications(app: FastifyInstance, limits?: Partial<WorkLimits>): void {
  const page = createPager();
  registerJobRoute(app, { path: '/workspaces/:workspaceId/applications', kind: 'apply', bodySchema: applicationRequestSchema,
    prepare: request => { const body = request.body as ApplicationRequestDTO; return { input: body as unknown as import('@ce/contracts').JsonValue, baseVersionId: body.baseVersionId }; },
    accept: ({ workspaceId, input }) => prepareApplication(app.ce.store, workspaceId, input as unknown as ApplicationRequestDTO, limits) });
  const detail = (workspaceId: string, receiptId: string) => {
    const bundle = getApplication(app.ce.store, workspaceId, receiptId), before = getValidation(app.ce.store, workspaceId, bundle.receipt.beforeValidationRunId), after = getValidation(app.ce.store, workspaceId, bundle.receipt.validationRunId);
    return { bundle, before, after };
  };
  app.get<{ Params: Params }>('/api/v1/workspaces/:workspaceId/applications/:receiptId', { schema: { params, querystring: emptyQuerySchema, response: { 200: applicationDetailSchema } } }, async request => {
    const { bundle, before, after } = detail(request.params.workspaceId, request.params.receiptId);
    return { receipt: bundle.receipt, changeCount: bundle.changes.filter(change => change.changed).length, beforeSummary: before.run.summary, afterSummary: after.run.summary };
  });
  app.get<{ Params: Params; Querystring: { limit?: string; cursor?: string } }>('/api/v1/workspaces/:workspaceId/applications/:receiptId/comparison', { schema: {
    params, querystring: { type: 'object', additionalProperties: false, properties: paginationProperties }, response: { 200: comparisonPageSchema },
  } }, async request => {
    const { workspaceId, receiptId } = request.params, { bundle, before, after } = detail(workspaceId, receiptId), rows = new Map<string, ComparisonRowDTO>();
    for (const result of before.results) { const key = resultOrderKey(result); rows.set(key, { key, before: result }); }
    for (const result of after.results) { const key = resultOrderKey(result); rows.set(key, { ...rows.get(key), key, after: result }); }
    const ordered = [...rows.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    return { ...page(ordered, row => row.key, canonicalHash({ resource: 'comparison', workspaceId, receiptId, beforeRunId: before.run.id, runId: after.run.id }), Number(request.query.limit ?? 50), request.query.cursor),
      receipt: bundle.receipt, beforeSummary: before.run.summary, afterSummary: after.run.summary, sourceFiles: app.ce.store.snapshot(workspaceId, bundle.receipt.newVersionId).content.sources };
  });
}
