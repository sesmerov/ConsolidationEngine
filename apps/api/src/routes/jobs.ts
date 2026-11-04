import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { emptyQuerySchema, isTerminalJob, jobParamsSchema, workspaceParamsSchema, UUID_PATTERN } from '@ce/contracts';
import type { JobKind, JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { requireCurrentVersion } from '../plugins/version-guard.js';
import { hashJsonBody } from '../session/idempotency-store.js';
import type { JobAcceptance } from '../jobs/job-manager.js';
export interface JobPreparation { readonly input: JsonValue; readonly bodyHash?: string; readonly baseVersionId?: string;
  readonly cleanup?: () => Promise<void>; readonly release?: () => void }
export interface JobRouteDefinition {
  readonly path: string; readonly kind: JobKind; readonly bodySchema?: object;
  readonly paramsSchema?: object;
  // Parse/normalize/hash only: version/snapshot checks must remain AFTER idempotency lookup.
  // Future multipart adapters must clean staging on replay/conflict/error and transfer ownership only to an accepted job.
  readonly prepare: (request: FastifyRequest) => JobPreparation | Promise<JobPreparation>;
  readonly accept?: (input: { workspaceId: string; jobId: string; baseVersionId?: string; input: JsonValue }) => JobAcceptance | Promise<JobAcceptance>;
}
/** Operation routes reuse authentication, idempotency, CAS and the same job/store services. */
export function registerJobRoute(app: FastifyInstance, definition: JobRouteDefinition): void {
  app.post<{ Params: { workspaceId: string } }>('/api/v1' + definition.path, {
    schema: { params: definition.paramsSchema ?? workspaceParamsSchema, querystring: emptyQuerySchema, ...(definition.bodySchema ? { body: definition.bodySchema } : {}) },
  }, async (request, reply) => {
    const workspaceId = request.params.workspaceId;
    const key = request.headers['idempotency-key']; if (typeof key !== 'string' || !UUID_PATTERN.test(key)) throw new ApiError('INVALID_REQUEST');
    const prepared = await definition.prepare(request);
    let transferred = false; let acceptance: JobAcceptance | undefined; let releasePreparation: (() => void) | undefined;
    try {
    const bodyHash = prepared.bodyHash ?? hashJsonBody(request.body);
    const scope = { workspaceId, key, operation: definition.kind + ':' + definition.path };
    // onRequest already authenticated. A replay must precede any If-Match/base-version rejection.
    const priorId = app.ce.idempotency.lookup(scope, bodyHash);
    if (priorId) { await prepared.cleanup?.(); await app.ce.jobs.settle(priorId); return reply.header('ETag', app.ce.store.etag(workspaceId)).code(202).send(app.ce.jobs.get(workspaceId, priorId)); }
    requireCurrentVersion(request, app.ce.store, workspaceId);
    const baseVersionId = prepared.baseVersionId ?? app.ce.store.get(workspaceId).currentVersionId;
    app.ce.store.assertBase(workspaceId, baseVersionId);
    const jobId = randomUUID(); let remembered = false;
    try {
      if (definition.accept) releasePreparation = app.ce.preparations.acquire(workspaceId);
      acceptance = await definition.accept?.({ workspaceId, jobId, input: prepared.input, ...(baseVersionId ? { baseVersionId } : {}) });
      // Acceptance may allocate bounded files asynchronously. Recheck replay/CAS before its single commit.
      const concurrentPrior = app.ce.idempotency.lookup(scope, bodyHash);
      if (concurrentPrior) { await acceptance?.finalize?.(); await prepared.cleanup?.(); await app.ce.jobs.settle(concurrentPrior); return reply.header('ETag', app.ce.store.etag(workspaceId)).code(202).send(app.ce.jobs.get(workspaceId, concurrentPrior)); }
      requireCurrentVersion(request, app.ce.store, workspaceId); app.ce.store.assertBase(workspaceId, baseVersionId);
      app.ce.idempotency.remember(scope, bodyHash, jobId); remembered = true;
      const job = app.ce.jobs.start({ ...acceptance, workspaceId, jobId, kind: definition.kind, input: acceptance?.input ?? prepared.input, ...(baseVersionId ? { baseVersionId } : {}),
        finalize: async () => { await acceptance?.finalize?.(); await prepared.cleanup?.(); } });
      transferred = true;
      return reply.header('ETag', app.ce.store.etag(workspaceId)).code(202).send(job);
    } catch (error) { if (remembered) app.ce.idempotency.forget(scope); throw error; }
    } finally { try { if (!transferred) { await acceptance?.finalize?.(); await prepared.cleanup?.(); } } finally { try { prepared.release?.(); } finally { releasePreparation?.(); } } }
  });
}
export function registerJobs(app: FastifyInstance): void {
  app.get<{ Params: { workspaceId: string; jobId: string } }>('/api/v1/workspaces/:workspaceId/jobs/:jobId', { schema: { params: jobParamsSchema, querystring: emptyQuerySchema } }, async (request) => {
    const { workspaceId, jobId } = request.params; const job = app.ce.jobs.get(workspaceId, jobId);
    if (isTerminalJob(job.status)) { await app.ce.jobs.settle(jobId); await app.ce.inspections.settle(workspaceId); } return app.ce.jobs.get(workspaceId, jobId);
  });
  app.delete<{ Params: { workspaceId: string; jobId: string } }>('/api/v1/workspaces/:workspaceId/jobs/:jobId', { schema: { params: jobParamsSchema, querystring: emptyQuerySchema } }, async (request, reply) => {
    const { workspaceId, jobId } = request.params; const previous = app.ce.jobs.get(workspaceId, jobId);
    const job = await app.ce.jobs.cancel(workspaceId, jobId); return reply.code(isTerminalJob(previous.status) ? 200 : 202).send(job);
  });
}
