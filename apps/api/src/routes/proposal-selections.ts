import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, proposalDependenciesQuerySchema, proposalDependencyPageSchema, proposalExplanationItemsQuerySchema, proposalExplanationPageSchema, proposalExplanationSchema,
  proposalSelectionEditSchema, proposalSelectionPageSchema, proposalSelectionPrepareSchema, proposalSelectionRowsQuerySchema, proposalSelectionSummarySchema, uuidSchema } from '@ce/contracts';
import type { JsonValue, ProposalExplanationSection, ProposalSelectionEditDTO, ProposalSelectionPrepareDTO, ProposalSelectionRowsQueryDTO } from '@ce/contracts';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from './jobs.js';
import { proposalExplanation, proposalExplanationItems } from '../recalculation/proposal-explanation.js';
type Params = { workspaceId: string; previewId: string };
const params = { type: 'object', additionalProperties: false, required: ['workspaceId', 'previewId'], properties: { workspaceId: uuidSchema, previewId: uuidSchema } } as const;
const proposalParams = { ...params, required: [...params.required, 'proposalId'], properties: { ...params.properties, proposalId: uuidSchema } } as const;
const path = '/workspaces/:workspaceId/previews/:previewId/selection-state';
export function registerProposalSelections(app: FastifyInstance): void {
  const service = app.ce.proposalSelections;
  registerJobRoute(app, { path, kind: 'select-proposals', paramsSchema: params, bodySchema: proposalSelectionPrepareSchema,
    prepare: request => { const body = request.body as ProposalSelectionPrepareDTO, p = request.params as Params; return { input: { ...body, previewId: p.previewId }, baseVersionId: body.baseVersionId, bodyHash: canonicalHash({ body, previewId: p.previewId }) }; },
    accept: ({ workspaceId, input, jobId }) => { const data = input as unknown as ProposalSelectionPrepareDTO & { previewId: string }; return service.prepare(workspaceId, data.previewId, data.baseVersionId, jobId); } });
  registerJobRoute(app, { path: path + '/edits', kind: 'select-proposals', paramsSchema: params, bodySchema: proposalSelectionEditSchema,
    prepare: request => { const body = request.body as ProposalSelectionEditDTO, p = request.params as Params; return { input: { ...body, previewId: p.previewId } as unknown as JsonValue, bodyHash: canonicalHash({ body, previewId: p.previewId }) }; },
    accept: ({ workspaceId, input, jobId }) => { const data = input as unknown as ProposalSelectionEditDTO & { previewId: string }; return service.edit(workspaceId, data.previewId, data, jobId); } });
  app.get<{ Params: Params }>('/api/v1' + path, { schema: { params, querystring: emptyQuerySchema, response: { 200: proposalSelectionSummarySchema } } }, async request => service.summary(request.params.workspaceId, request.params.previewId));
  app.get<{ Params: Params; Querystring: ProposalSelectionRowsQueryDTO }>('/api/v1' + path + '/rows', { schema: { params, querystring: proposalSelectionRowsQuerySchema, response: { 200: proposalSelectionPageSchema } } }, async request => service.rows(request.params.workspaceId, request.params.previewId, request.query, () => request.raw.aborted));
  app.get<{ Params: Params & { proposalId: string }; Querystring: { scope?: 'all' | 'missing'; limit?: string; cursor?: string } }>('/api/v1' + path + '/proposals/:proposalId/dependencies', { schema: { params: proposalParams, querystring: proposalDependenciesQuerySchema, response: { 200: proposalDependencyPageSchema } } }, async request => service.dependencies(request.params.workspaceId, request.params.previewId, request.params.proposalId, request.query, () => request.raw.aborted));
  app.get<{ Params: Params & { proposalId: string } }>('/api/v1' + path + '/proposals/:proposalId/explanation', { schema: { params: proposalParams, querystring: emptyQuerySchema, response: { 200: proposalExplanationSchema } } }, async request => proposalExplanation(service, request.params.workspaceId, request.params.previewId, request.params.proposalId, () => request.raw.aborted));
  app.get<{ Params: Params & { proposalId: string }; Querystring: { section: ProposalExplanationSection; limit?: string; cursor?: string } }>('/api/v1' + path + '/proposals/:proposalId/explanation/items', { schema: { params: proposalParams, querystring: proposalExplanationItemsQuerySchema, response: { 200: proposalExplanationPageSchema } } }, async request => proposalExplanationItems(service, request.params.workspaceId, request.params.previewId, request.params.proposalId, request.query, () => request.raw.aborted));
}
