import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiError } from '../errors.js';
import { sessionSecretHash, type AuthorizedSession, type SessionService } from '../hosted/session-service.js';

declare module 'fastify' { interface FastifyRequest { hostedSession: AuthorizedSession | null } }
export function requireHostedSession(request: FastifyRequest): AuthorizedSession {
  if (!request.hostedSession) throw new ApiError('SESSION_UNAUTHENTICATED'); return request.hostedSession;
}
/** Request-scoped identity only. No app.ce workspace store or singleton visitor state is installed. */
export function installHostedSession(app: FastifyInstance, sessions: SessionService, now: () => Date = () => new Date()): void {
  app.decorateRequest('hostedSession', null);
  app.addHook('onRequest', async request => {
    const path = request.url.split('?')[0];
    if (!path?.startsWith('/api/v1/') || request.method === 'OPTIONS') return;
    if (request.method === 'GET' && path === '/api/v1/bootstrap') return;
    const token = request.headers['x-ce-session'];
    if (typeof token !== 'string') throw new ApiError('SESSION_UNAUTHENTICATED');
    if (request.method === 'POST' && path === '/api/v1/sessions') { sessionSecretHash(token); return; }
    request.hostedSession = await sessions.authorize(token, now(), { allowClosed: request.method === 'DELETE' && path === '/api/v1/session' });
  });
}
