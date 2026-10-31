import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, previewSelectionRequestSchema, uuidSchema } from '@ce/contracts';
import type { JsonValue } from '@ce/contracts';
import type { WorkLimits } from '@ce/engine';
import { ApiError } from '../errors.js';
import { requireCurrentVersion } from '../plugins/version-guard.js';
import { discardPreview, getPreview, selectPreview } from '../recalculation/preview-store.js';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from './jobs.js';
import { createPager, paginationProperties } from './pagination.js';
type Params = { workspaceId: string; previewId: string };
const params = { type: 'object', additionalProperties: false, required: ['workspaceId', 'previewId'], properties: { workspaceId: uuidSchema, previewId: uuidSchema } } as const;
export function registerPreviews(app: FastifyInstance, limits?: Partial<WorkLimits>): void {
  const page = createPager();
  registerJobRoute(app, { path: '/workspaces/:workspaceId/previews', kind: 'preview', bodySchema: { type: 'object', additionalProperties: false, required: ['baseVersionId'], properties: { baseVersionId: uuidSchema } },
    prepare: request => { const body = request.body as { baseVersionId: string }; return { input: body, baseVersionId: body.baseVersionId }; },
    accept: () => ({ input: { previewId: randomUUID(), ...(limits ? { limits: limits as unknown as JsonValue } : {}) } }) });
  app.get<{ Params: Params }>('/api/v1/workspaces/:workspaceId/previews/:previewId', { schema: { params, querystring: emptyQuerySchema } }, async request => getPreview(app.ce.store, request.params.workspaceId, request.params.previewId).preview);
  app.get<{ Params: Params; Querystring: { limit?: string; cursor?: string; status?: string; code?: string; table?: string } }>('/api/v1/workspaces/:workspaceId/previews/:previewId/proposals', {
    schema: { params, querystring: { type: 'object', additionalProperties: false, properties: { ...paginationProperties,
      status: { enum: ['available', 'blocked', 'accepted', 'applied', 'discarded', 'obsolete'] }, code: { type: 'string', maxLength: 128 }, table: { type: 'string', maxLength: 128 } } } },
  }, async request => {
    const { workspaceId, previewId } = request.params, query = request.query, bundle = getPreview(app.ce.store, workspaceId, previewId);
    const key = (proposal: (typeof bundle.proposals)[number]) => proposal.id;
    const rows = bundle.proposals.filter(proposal => (!query.status || proposal.state === query.status) && (!query.code || proposal.code.toLowerCase().includes(query.code.toLowerCase())) && (!query.table || proposal.before?.coordinate.tableCode === query.table))
      ; // Preserve the engine's topological order, including across filtered pages.
    return { ...page(rows, key, canonicalHash({ resource: 'proposals', workspaceId, previewId, state: bundle.preview.state, status: query.status ?? '', code: query.code ?? '', table: query.table ?? '' }), Number(query.limit ?? 50), query.cursor), versionId: bundle.preview.baseVersionId,
      sourceFiles: app.ce.store.snapshot(workspaceId, bundle.preview.baseVersionId).content.sources };
  });
  app.post<{ Params: Params; Body: { selectedIds: string[] } }>('/api/v1/workspaces/:workspaceId/previews/:previewId/selection', { schema: { params, querystring: emptyQuerySchema, body: previewSelectionRequestSchema } }, async request => selectPreview(getPreview(app.ce.store, request.params.workspaceId, request.params.previewId), request.body.selectedIds));
  app.delete<{ Params: Params }>('/api/v1/workspaces/:workspaceId/previews/:previewId', { schema: { params, querystring: emptyQuerySchema } }, async (request, reply) => {
    if (request.body !== undefined) throw new ApiError('INVALID_REQUEST'); const { workspaceId, previewId } = request.params;
    requireCurrentVersion(request, app.ce.store, workspaceId); const bundle = discardPreview(app.ce.store, workspaceId, previewId);
    return reply.header('ETag', app.ce.store.etag(workspaceId)).send(bundle.preview);
  });
}
