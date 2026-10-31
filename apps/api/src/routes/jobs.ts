import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, isTerminalJob, jobParamsSchema, workspaceParamsSchema, UUID_PATTERN } from '@ce/contracts';
import type { JobKind, JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { requireCurrentVersion } from '../plugins/version-guard.js';
import { hashJsonBody } from '../session/idempotency-store.js';
export interface JobPreparation { readonly input: JsonValue; readonly bodyHash?: string; readonly baseVersionId?: string }
export interface JobRouteDefinition {
  readonly path: string; readonly kind: JobKind; readonly bodySchema?: object;
  // Parse/normalize/hash only: version/snapshot checks must remain AFTER idempotency lookup.
  // Future multipart adapters must clean staging on replay/conflict/error and transfer ownership only to an accepted job.
  readonly prepare: (request: FastifyRequest) => JobPreparation | Promise<JobPreparation>;
}
/** Operation routes reuse authentication, idempotency, CAS and the same job/store services. */
export function registerJobRoute(app: FastifyInstance, definition: JobRouteDefinition): void {
  app.post<{ Params: { workspaceId: string } }>('/api/v1' + definition.path, {
    schema: { params: workspaceParamsSchema, querystring: emptyQuerySchema, ...(definition.bodySchema ? { body: definition.bodySchema } : {}) },
  }, async (request, reply) => {
    const workspaceId = request.params.workspaceId;
    const key = request.headers['idempotency-key']; if (typeof key !== 'string' || !UUID_PATTERN.test(key)) throw new ApiError('INVALID_REQUEST');
    const prepared = await definition.prepare(request);
    const bodyHash = prepared.bodyHash ?? hashJsonBody(request.body);
    const scope = { workspaceId, key, operation: definition.kind + ':' + definition.path };
    // onRequest already authenticated. A replay must precede any If-Match/base-version rejection.
    const priorId = app.ce.idempotency.lookup(scope, bodyHash);
    if (priorId) return reply.code(202).send(app.ce.jobs.get(workspaceId, priorId));
    requireCurrentVersion(request, app.ce.store, workspaceId);
    const baseVersionId = prepared.baseVersionId ?? app.ce.store.get(workspaceId).currentVersionId;
    app.ce.store.assertBase(workspaceId, baseVersionId);
    const jobId = randomUUID(); app.ce.idempotency.remember(scope, bodyHash, jobId);
    try {
      const job = app.ce.jobs.start({ workspaceId, jobId, kind: definition.kind, input: prepared.input, ...(baseVersionId ? { baseVersionId } : {}) });
      return reply.code(202).send(job);
    } catch (error) { app.ce.idempotency.forget(scope); throw error; }
  });
}
export function registerJobs(app: FastifyInstance): void {
  app.get<{ Params: { workspaceId: string; jobId: string } }>('/api/v1/workspaces/:workspaceId/jobs/:jobId', { schema: { params: jobParamsSchema, querystring: emptyQuerySchema } }, async (request) => app.ce.jobs.get(request.params.workspaceId, request.params.jobId));
  app.delete<{ Params: { workspaceId: string; jobId: string } }>('/api/v1/workspaces/:workspaceId/jobs/:jobId', { schema: { params: jobParamsSchema, querystring: emptyQuerySchema } }, async (request, reply) => {
    const { workspaceId, jobId } = request.params; const previous = app.ce.jobs.get(workspaceId, jobId);
    const job = await app.ce.jobs.cancel(workspaceId, jobId); return reply.code(isTerminalJob(previous.status) ? 200 : 202).send(job);
  });
}
