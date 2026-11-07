import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  directionReviewActiveSchema, directionReviewCollectionParamsSchema, directionReviewCommitSchema,
  directionReviewMutationResponseSchema, directionReviewPageSchema, directionReviewParamsSchema, directionReviewPatchSchema,
  directionReviewPrepareSchema, directionReviewRowsQuerySchema, directionReviewSummarySchema, emptyQuerySchema,
  directionConflictGroupParamsSchema, directionConflictCandidateParamsSchema, directionConflictPageQuerySchema,
  directionConflictGroupsPageSchema, directionConflictCandidatesPageSchema, directionConflictCandidateDetailSchema,
} from '@ce/contracts';
import type { DirectionReviewCommitDTO, DirectionReviewDecision, DirectionReviewPatchDTO, DirectionReviewPrepareDTO, JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { requireCurrentVersion } from '../plugins/version-guard.js';
import { canonicalHash } from '../session/canonical-state.js';
import { registerJobRoute } from './jobs.js';

interface Params { workspaceId: string; reviewId: string }
interface RowsQuery { limit?: string; cursor?: string; state?: DirectionReviewDecision; groupId?: string }
interface PageQuery { limit?: string; cursor?: string }
export function registerDirectionReviews(app: FastifyInstance): void {
  const path = '/workspaces/:workspaceId/direction-reviews', collection = '/api/v1' + path, member = collection + '/:reviewId';
  const reviews = app.ce.directionReviews;
  const secret = randomBytes(32);
  const signature = (text: string) => createHmac('sha256', secret).update(text).digest('base64url');
  function cursorOffset(cursor: string | undefined, scope: string): number {
    if (!cursor) return 0;
    try {
      const [payload, mac, extra] = cursor.split('.');
      if (!payload || !mac || extra !== undefined || mac.length !== 43 || !/^[A-Za-z0-9_-]+$/.test(mac)) throw Error();
      if (!timingSafeEqual(Buffer.from(mac), Buffer.from(signature(payload)))) throw Error();
      const { fingerprint, offset } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (fingerprint !== scope || !Number.isSafeInteger(offset) || offset <= 0 || offset > 1_000_000) throw Error();
      return offset;
    } catch { throw new ApiError('INVALID_CURSOR'); }
  }
  registerJobRoute(app, {
    path, kind: 'prepare-directions', bodySchema: directionReviewPrepareSchema,
    prepare: request => {
      const { workspaceId } = request.params as Params, body = request.body as DirectionReviewPrepareDTO;
      return { input: body as unknown as JsonValue, baseVersionId: body.baseVersionId, bodyHash: canonicalHash({ workspaceId, operation: 'prepare-directions', body }) };
    },
    accept: ({ workspaceId, input, jobId }) => reviews.prepare(workspaceId, input as unknown as DirectionReviewPrepareDTO, jobId),
  });
  app.get<{ Params: Pick<Params,'workspaceId'> }>(collection, {
    schema: { params: directionReviewCollectionParamsSchema, querystring: emptyQuerySchema, response: { 200: directionReviewActiveSchema } },
  }, request => reviews.active(request.params.workspaceId));
  app.get<{ Params: Params }>(member, {
    schema: { params: directionReviewParamsSchema, querystring: emptyQuerySchema, response: { 200: directionReviewSummarySchema } },
  }, request => reviews.get(request.params.workspaceId, request.params.reviewId));
  app.get<{ Params: Params; Querystring: RowsQuery }>(member + '/rows', {
    schema: { params: directionReviewParamsSchema, querystring: directionReviewRowsQuerySchema, response: { 200: directionReviewPageSchema } },
  }, request => {
    const { workspaceId, reviewId } = request.params, { cursor, limit, state, groupId } = request.query;
    const { revision } = reviews.get(workspaceId, reviewId);
    const scope = canonicalHash({ resource: 'direction-review-rows', workspaceId, reviewId, revision, state: state ?? '', groupId: groupId ?? '' });
    const offset = cursorOffset(cursor, scope);
    const page = reviews.rows(workspaceId, reviewId, { offset, limit: Number(limit ?? 50), ...(state ? { state } : {}), ...(groupId ? { groupId } : {}) });
    const nextOffset = offset + page.items.length;
    const payload = Buffer.from(JSON.stringify({ fingerprint: scope, offset: nextOffset })).toString('base64url');
    return { ...page, nextCursor: nextOffset < page.total ? payload + '.' + signature(payload) : null };
  });
  function withCursor<T extends { items: readonly unknown[]; total: number }>(page: T, offset: number, scope: string) {
    const nextOffset = offset + page.items.length;
    const payload = Buffer.from(JSON.stringify({ fingerprint: scope, offset: nextOffset })).toString('base64url');
    return { ...page, nextCursor: nextOffset < page.total ? payload + '.' + signature(payload) : null };
  }
  app.get<{ Params: Params; Querystring: PageQuery }>(member + '/groups', {
    schema: { params: directionReviewParamsSchema, querystring: directionConflictPageQuerySchema, response: { 200: directionConflictGroupsPageSchema } },
  }, request => {
    const { workspaceId, reviewId } = request.params, { cursor, limit } = request.query;
    const { revision } = reviews.get(workspaceId, reviewId);
    const scope = canonicalHash({ resource: 'direction-conflict-groups', workspaceId, reviewId, revision });
    const offset = cursorOffset(cursor, scope);
    return withCursor(reviews.groups(workspaceId, reviewId, { offset, limit: Number(limit ?? 50) }), offset, scope);
  });
  app.get<{ Params: Params & { groupId: string }; Querystring: PageQuery }>(member + '/groups/:groupId/candidates', {
    schema: { params: directionConflictGroupParamsSchema, querystring: directionConflictPageQuerySchema, response: { 200: directionConflictCandidatesPageSchema } },
  }, request => {
    const { workspaceId, reviewId, groupId } = request.params, { cursor, limit } = request.query;
    const { revision } = reviews.get(workspaceId, reviewId);
    const scope = canonicalHash({ resource: 'direction-conflict-candidates', workspaceId, reviewId, revision, groupId });
    const offset = cursorOffset(cursor, scope);
    return withCursor(reviews.candidates(workspaceId, reviewId, groupId, { offset, limit: Number(limit ?? 50) }), offset, scope);
  });
  app.get<{ Params: Params & { groupId: string; instanceId: string } }>(member + '/groups/:groupId/candidates/:instanceId', {
    schema: { params: directionConflictCandidateParamsSchema, querystring: emptyQuerySchema, response: { 200: directionConflictCandidateDetailSchema } },
  }, request => {
    const { workspaceId, reviewId, groupId, instanceId } = request.params;
    return reviews.candidate(workspaceId, reviewId, groupId, instanceId);
  });
  app.patch<{ Params: Params; Body: DirectionReviewPatchDTO }>(member, {
    schema: { params: directionReviewParamsSchema, body: directionReviewPatchSchema, querystring: emptyQuerySchema, response: { 200: directionReviewMutationResponseSchema } },
  }, (request, reply) => {
    const { workspaceId, reviewId } = request.params;
    requireCurrentVersion(request, app.ce.store, workspaceId);
    return reply.header('ETag', app.ce.store.etag(workspaceId)).send(reviews.patch(workspaceId, reviewId, request.body));
  });
  registerJobRoute(app, {
    path: path + '/:reviewId/commit', kind: 'commit-directions', bodySchema: directionReviewCommitSchema, paramsSchema: directionReviewParamsSchema,
    prepare: request => {
      const { workspaceId, reviewId } = request.params as Params, body = request.body as DirectionReviewCommitDTO;
      const input = { ...body, reviewId };
      return { input, bodyHash: canonicalHash({ workspaceId, operation: 'commit-directions', ...input }) };
    },
    accept: ({ workspaceId, input, jobId }) => {
      const body = input as unknown as DirectionReviewCommitDTO & { reviewId: string };
      return reviews.commit(workspaceId, body.reviewId, body, jobId);
    },
  });
  app.delete<{ Params: Params }>(member, {
    schema: { params: directionReviewParamsSchema, querystring: emptyQuerySchema, response: { 200: directionReviewSummarySchema } },
  }, (request, reply) => {
    if (request.body !== undefined) throw new ApiError('INVALID_REQUEST');
    const { workspaceId, reviewId } = request.params;
    requireCurrentVersion(request, app.ce.store, workspaceId);
    return reply.header('ETag', app.ce.store.etag(workspaceId)).send(reviews.discard(workspaceId, reviewId));
  });
}
