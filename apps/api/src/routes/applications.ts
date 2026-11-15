import type { FastifyInstance } from 'fastify';
import { applicationDetailSchema, applicationRequestSchema, changedOnlyQuerySchema, comparisonPageSchema, publicComparisonPageSchema, publicApplicationChangesPageSchema, emptyQuerySchema, uuidSchema } from '@ce/contracts';
import type { ApplicationRequestDTO, ApplyReceiptDTO, CompactApplyReceiptDTO, ComparisonRowDTO } from '@ce/contracts';
import { resultOrderKey, WorkBudget, WorkLimitError } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import { getApplication, prepareApplication } from '../recalculation/application-service.js';
import { getValidation } from '../validation/validation-service.js';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from './jobs.js';
import { createPager, paginationProperties } from './pagination.js';
import { publicResult } from '../presentation/public-values.js';
import { resultChanged } from '../presentation/result-change.js';
import { rulePresentation } from '../presentation/rule-presentation.js';
import { ApiError } from '../errors.js';
type Params = { workspaceId: string; receiptId: string };
const params = { type: 'object', additionalProperties: false, required: ['workspaceId', 'receiptId'], properties: { workspaceId: uuidSchema, receiptId: uuidSchema } } as const;
const includeAcceptedIds = { type: 'string', enum: ['true', 'false'] } as const;
function projectReceipt(receipt: ApplyReceiptDTO, include?: string): ApplyReceiptDTO | CompactApplyReceiptDTO {
  if (include !== 'false') return receipt; const { acceptedIds, ...rest } = receipt; return { ...rest, acceptedCount: acceptedIds.length };
}
export function registerApplications(app: FastifyInstance, limits?: Partial<WorkLimits>): void {
  const page = createPager();
  registerJobRoute(app, { path: '/workspaces/:workspaceId/applications', kind: 'apply', bodySchema: applicationRequestSchema,
    prepare: request => { const body = request.body as ApplicationRequestDTO; return { input: body as unknown as import('@ce/contracts').JsonValue, baseVersionId: body.baseVersionId }; },
    accept: ({ workspaceId, input, jobId }) => prepareApplication(app.ce.store, workspaceId, input as unknown as ApplicationRequestDTO, limits, jobId) });
  const detail = (workspaceId: string, receiptId: string) => {
    const bundle = getApplication(app.ce.store, workspaceId, receiptId), before = getValidation(app.ce.store, workspaceId, bundle.receipt.beforeValidationRunId), after = getValidation(app.ce.store, workspaceId, bundle.receipt.validationRunId);
    return { bundle, before, after };
  };
  app.get<{ Params: Params; Querystring: { includeAcceptedIds?: string } }>('/api/v1/workspaces/:workspaceId/applications/:receiptId', { schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { includeAcceptedIds } }, response: { 200: applicationDetailSchema } } }, async request => {
    const { bundle, before, after } = detail(request.params.workspaceId, request.params.receiptId);
    return { receipt: projectReceipt(bundle.receipt, request.query.includeAcceptedIds), changeCount: bundle.changes.filter(change => change.changed).length, beforeSummary: before.run.summary, afterSummary: after.run.summary };
  });
  app.get<{ Params: Params; Querystring: { limit?: string; cursor?: string; changedOnly?: string; includeAcceptedIds?: string;compact?:string } }>('/api/v1/workspaces/:workspaceId/applications/:receiptId/comparison', { schema: {
    params, querystring: { type: 'object', additionalProperties: false, properties: { ...paginationProperties, compact:{const:'true'},changedOnly: changedOnlyQuerySchema, includeAcceptedIds } },response:{200:{anyOf:[publicComparisonPageSchema,comparisonPageSchema]}},
  } }, async (request, reply) => {
    try {
    if(request.query.compact==='true')return app.ce.adapters.publicViews.comparison(request.params.workspaceId,request.params.receiptId,request.query);
    reply.serializer(reply.compileSerializationSchema(comparisonPageSchema));
    const budget = new WorkBudget({ cancelled: () => request.raw.aborted });
    const { workspaceId, receiptId } = request.params, { bundle, before, after } = detail(workspaceId, receiptId), rows = new Map<string, ComparisonRowDTO>();
    for (const result of before.results) { budget.check(); const key = resultOrderKey(result); rows.set(key, { key, before: result }); }
    for (const result of after.results) { budget.check(); const key = resultOrderKey(result); rows.set(key, { ...rows.get(key), key, after: result }); }
    const changedOnly = request.query.changedOnly === 'true';
    const ordered = [...rows.values()].filter(row => { budget.consume('instances'); return !changedOnly || resultChanged(row.before, row.after, budget); }).sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    budget.check();
    const result = page(ordered, row => row.key, canonicalHash({ resource: 'comparison', workspaceId, receiptId, beforeRunId: before.run.id, runId: after.run.id, changedOnly, includeAcceptedIds: request.query.includeAcceptedIds !== 'false' }), Number(request.query.limit ?? 50), request.query.cursor);
    const presentBefore = rulePresentation(app.ce.store.snapshot(workspaceId, bundle.receipt.baseVersionId).content), presentAfter = rulePresentation(app.ce.store.snapshot(workspaceId, bundle.receipt.newVersionId).content);
    const project = (value: import('@ce/contracts').RuleResultDTO, present: typeof presentBefore) => {
      const { presentation: _storedPresentation, ...row } = publicResult(value), presentation = present(row.variantIds, row.values.left?.coordinate ?? row.values.right?.coordinate ?? row.factReads[0]?.coordinate);
      return { ...row, ...(presentation ? { presentation } : {}) };
    };
    return { ...result, items: result.items.map(row => ({ key: row.key, ...(row.before ? { before: project(row.before, presentBefore) } : {}), ...(row.after ? { after: project(row.after, presentAfter) } : {}) })),
      receipt: projectReceipt(bundle.receipt, request.query.includeAcceptedIds), beforeSummary: before.run.summary, afterSummary: after.run.summary, sourceFiles: app.ce.store.snapshot(workspaceId, bundle.receipt.newVersionId).content.sources };
    } catch (error) { if (error instanceof WorkLimitError) throw new ApiError('EXPANSION_LIMIT', { reason: error.code }); throw error; }
  });
  app.get<{Params:Params;Querystring:{limit?:string;cursor?:string}}>('/api/v1/workspaces/:workspaceId/applications/:receiptId/changes',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{limit:{type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$'},cursor:{type:'string',maxLength:8192}}},response:{200:publicApplicationChangesPageSchema}}},req=>app.ce.adapters.publicViews.applicationChanges(req.params.workspaceId,req.params.receiptId,req.query));
}
