import type { FastifyInstance } from 'fastify';
import { createWorkspaceSchema, emptyQuerySchema, compactWorkspaceQuerySchema,operationReceiptSchema, uuidSchema, workspaceParamsSchema } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { requireHostedSession } from '../plugins/hosted-session.js';
import type { HostedWorkspaceService } from '../hosted/workspace-service.js';
import type { HostedJobAcceptance } from '../hosted/job-acceptance.js';
import type { HostedJobCoordinator } from '../hosted/job-coordinator.js';

export function registerHostedCommon(app: FastifyInstance, services: { workspaces: HostedWorkspaceService; acceptance: HostedJobAcceptance; coordinator: HostedJobCoordinator }): void {
  const header = (value: unknown, missing: 'PRECONDITION_REQUIRED' | 'INVALID_REQUEST'): string => {
    if (typeof value !== 'string' || !value) throw new ApiError(missing); return value;
  };
  app.post<{ Body: { name: string } }>('/api/v1/workspaces', { schema: { body: createWorkspaceSchema, querystring: emptyQuerySchema } }, async (request, reply) => {
    const sessionId = requireHostedSession(request).id, created = await services.workspaces.create(sessionId, request.body.name, header(request.headers['idempotency-key'], 'INVALID_REQUEST'));
    const result = await services.workspaces.metadata({ sessionId, workspaceId: created.id });
    return reply.code(201).header('ETag', result.etag).send(result.body);
  });
  app.get<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId', { schema: { params: workspaceParamsSchema, querystring: compactWorkspaceQuerySchema } }, async (request, reply) => {
    const result = await services.workspaces.metadata({ sessionId: requireHostedSession(request).id, workspaceId: request.params.workspaceId });
    return reply.header('ETag', result.etag).send(result.body);
  });
  app.delete<{ Params: { workspaceId: string } }>('/api/v1/workspaces/:workspaceId', { schema: { params: workspaceParamsSchema, querystring: emptyQuerySchema } }, async (request, reply) => {
    await services.workspaces.close({ sessionId: requireHostedSession(request).id, workspaceId: request.params.workspaceId },
      header(request.headers['if-match'], 'PRECONDITION_REQUIRED'), header(request.headers['idempotency-key'], 'INVALID_REQUEST'));
    return reply.code(204).send();
  });
  const jobParams = { type: 'object', additionalProperties: false, required: ['workspaceId','jobId'], properties: { workspaceId: uuidSchema, jobId: uuidSchema } };
  for (const method of ['GET', 'DELETE'] as const) app.route<{ Params: { workspaceId: string; jobId: string } }>({ method, url: '/api/v1/workspaces/:workspaceId/jobs/:jobId',
    schema: { params: jobParams, querystring: emptyQuerySchema }, handler: request => {
      const reference = { sessionId: requireHostedSession(request).id, workspaceId: request.params.workspaceId, jobId: request.params.jobId };
      return method === 'GET' ? services.coordinator.get(reference) : services.coordinator.cancel(reference);
    } });
  for (const [path, param] of [['operations','operationId'], ['operation-receipts','key']] as const) app.get<{ Params: Record<string, string> }>(`/api/v1/${path}/:${param}`, {
    schema: { params: { type: 'object', additionalProperties: false, required: [param], properties: { [param]: uuidSchema } }, querystring: emptyQuerySchema, response: { 200: operationReceiptSchema } },
  }, request => param === 'operationId' ? services.acceptance.receiptByOperation(requireHostedSession(request).id, request.params[param]!)
    : services.acceptance.receiptByKey(requireHostedSession(request).id, request.params[param]!));
}
