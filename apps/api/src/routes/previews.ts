import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { compactPreviewSchema, emptyQuerySchema, previewSchema, previewSelectionRequestSchema, proposalSchema, proposalsPageSchema, uuidSchema } from '@ce/contracts';
import type { CompactPreviewDTO, JsonValue, PreviewDTO, ProposalSelectionFilterDTO } from '@ce/contracts';
import { proposalMatchesFilter } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import { ApiError } from '../errors.js';
import { requireCurrentVersion } from '../plugins/version-guard.js';
import { discardPreview, getPreview, selectPreview } from '../recalculation/preview-store.js';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from './jobs.js';
import { createPager, paginationProperties } from './pagination.js';
import { assertDirectionsAllowed } from '../recalculation/directions-service.js';
import { publicProposal } from '../presentation/public-values.js';
import { rulePresentation } from '../presentation/rule-presentation.js';
type Params = { workspaceId: string; previewId: string };
const params = { type: 'object', additionalProperties: false, required: ['workspaceId', 'previewId'], properties: { workspaceId: uuidSchema, previewId: uuidSchema } } as const;
const compactQuery = { type: 'object', additionalProperties: false, properties: { compact: { type: 'string', enum: ['true', 'false'] } } } as const;
function compactPreview(preview: PreviewDTO): CompactPreviewDTO {
  const { proposalIds: _ids, diagnostics, graphSummary, ...rest } = preview;
  return { ...rest, graphSummary: { nodes: graphSummary.nodes, edges: graphSummary.edges, blocked: graphSummary.blocked, conflictCount: graphSummary.conflicts.length, cycleCount: graphSummary.cycles.length }, diagnosticCount: diagnostics.length };
}
export function registerPreviews(app: FastifyInstance, limits?: Partial<WorkLimits>): void {
  const page = createPager();
  registerJobRoute(app, { path: '/workspaces/:workspaceId/previews', kind: 'preview', bodySchema: { type: 'object', additionalProperties: false, required: ['baseVersionId'], properties: { baseVersionId: uuidSchema } },
    prepare: request => { const body = request.body as { baseVersionId: string }; return { input: body, baseVersionId: body.baseVersionId }; },
    accept: ({ workspaceId, baseVersionId }) => {
      if (!baseVersionId) throw new ApiError('INVALID_REQUEST');
      const snapshot = app.ce.store.snapshot(workspaceId, baseVersionId); assertDirectionsAllowed(snapshot, limits);
      return { input: { previewId: randomUUID(), ...(limits ? { limits: limits as unknown as JsonValue } : {}) },
        preparePublication: (_job, output) => ({ output, assertCommit: () => assertDirectionsAllowed(app.ce.store.snapshot(workspaceId, baseVersionId), limits) }) };
    } });
  app.get<{ Params: Params; Querystring: { compact?: string } }>('/api/v1/workspaces/:workspaceId/previews/:previewId', { schema: { params, querystring: compactQuery, response: { 200: { anyOf: [previewSchema, compactPreviewSchema] } } } }, async request => {
    const preview = getPreview(app.ce.store, request.params.workspaceId, request.params.previewId).preview; return request.query.compact === 'true' ? compactPreview(preview) : preview;
  });
  app.get<{ Params: Params; Querystring: ProposalSelectionFilterDTO & { limit?: string; cursor?: string } }>('/api/v1/workspaces/:workspaceId/previews/:previewId/proposals', {
    schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { ...paginationProperties,
      status: { enum: ['available', 'blocked', 'accepted', 'applied', 'discarded', 'obsolete'] }, code: { type: 'string', maxLength: 128 }, table: { type: 'string', maxLength: 128 }, contextId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } } }, response: { 200: proposalsPageSchema } },
  }, async request => {
    const { workspaceId, previewId } = request.params, query = request.query, bundle = getPreview(app.ce.store, workspaceId, previewId);
    const key = (proposal: (typeof bundle.proposals)[number]) => proposal.id;
    if (query.contextId && !app.ce.store.snapshot(workspaceId, bundle.preview.baseVersionId).content.contexts.some(c => c.contextId === query.contextId)) throw new ApiError('INVALID_REQUEST');
    const rows = bundle.proposals.filter(proposal => proposalMatchesFilter(proposal, query))
      ; // Preserve the engine's topological order, including across filtered pages.
    const snapshot = app.ce.store.snapshot(workspaceId, bundle.preview.baseVersionId), present = rulePresentation(snapshot.content);
    const result = page(rows, key, canonicalHash({ resource: 'proposals', workspaceId, previewId, baseVersionId: bundle.preview.baseVersionId, state: bundle.preview.state, status: query.status ?? '', code: query.code ?? '', table: query.table ?? '', contextId: query.contextId ?? '' }), Number(query.limit ?? 50), query.cursor);
    return { ...result, items: result.items.map(item => {
      const { presentation: _storedPresentation, ...proposal } = publicProposal(item), presentation = present(proposal.variantIds, proposal.before?.coordinate);
      return { ...proposal, ...(presentation ? { presentation } : {}) };
    }), versionId: bundle.preview.baseVersionId, sourceFiles: snapshot.content.sources };
  });
  app.get<{ Params: Params & { proposalId: string } }>('/api/v1/workspaces/:workspaceId/previews/:previewId/proposals/:proposalId', { schema: {
    params: { ...params, required: [...params.required, 'proposalId'], properties: { ...params.properties, proposalId: uuidSchema } }, querystring: emptyQuerySchema, response: { 200: proposalSchema },
  } }, async request => {
    const { workspaceId, previewId, proposalId } = request.params, bundle = getPreview(app.ce.store, workspaceId, previewId);
    const stored = bundle.proposals.find(proposal => proposal.id === proposalId && proposal.previewId === previewId);
    if (!stored) throw new ApiError('RESOURCE_NOT_FOUND');
    const { presentation: _storedPresentation, ...proposal } = publicProposal(stored, true);
    const presentation = rulePresentation(app.ce.store.snapshot(workspaceId, bundle.preview.baseVersionId).content)(proposal.variantIds, proposal.before?.coordinate);
    return { ...proposal, ...(presentation ? { presentation } : {}) };
  });
  app.post<{ Params: Params; Body: { selectedIds: string[] } }>('/api/v1/workspaces/:workspaceId/previews/:previewId/selection', { schema: { params, querystring: emptyQuerySchema, body: previewSelectionRequestSchema } }, async request => selectPreview(getPreview(app.ce.store, request.params.workspaceId, request.params.previewId), request.body.selectedIds));
  app.delete<{ Params: Params; Querystring: { compact?: string } }>('/api/v1/workspaces/:workspaceId/previews/:previewId', { schema: { params, querystring: compactQuery } }, async (request, reply) => {
    if (request.body !== undefined) throw new ApiError('INVALID_REQUEST'); const { workspaceId, previewId } = request.params;
    requireCurrentVersion(request, app.ce.store, workspaceId); const bundle = discardPreview(app.ce.store, workspaceId, previewId);
    return reply.header('ETag', app.ce.store.etag(workspaceId)).send(request.query.compact === 'true' ? compactPreview(bundle.preview) : bundle.preview);
  });
}
