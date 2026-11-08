import type { FastifyInstance } from 'fastify';
import { createDemoSessionSchema, demoSessionSchema, emptyQuerySchema, type CreateDemoSessionDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { SessionService } from '../hosted/session-service.js';
import { requireHostedSession } from '../plugins/hosted-session.js';

export function registerHostedSessions(app: FastifyInstance, service: SessionService, now: () => Date = () => new Date()): void {
  app.post<{ Body: CreateDemoSessionDTO }>('/api/v1/sessions', { schema: { body: createDemoSessionSchema, querystring: emptyQuerySchema,
    response: { 200: demoSessionSchema, 201: demoSessionSchema } } }, async (request, reply) => {
    const token = request.headers['x-ce-session']; if (typeof token !== 'string') throw new ApiError('SESSION_UNAUTHENTICATED');
    const result = await service.create(token, request.body.creationNonce, now()); return reply.code(result.statusCode).send(result.session);
  });
  app.get('/api/v1/session', { schema: { querystring: emptyQuerySchema, response: { 200: demoSessionSchema } } },
    request => service.metadata(requireHostedSession(request).id, now()));
  app.delete('/api/v1/session', { schema: { querystring: emptyQuerySchema } }, async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new ApiError('INVALID_REQUEST', { reason: 'IDEMPOTENCY_KEY_REQUIRED' });
    await service.revoke(requireHostedSession(request).id, now()); return reply.code(204).send();
  });
}
