import type { FastifyInstance, HTTPMethods } from 'fastify';
import { ApiError } from '../errors.js';
import type { HostedConfig } from '../hosted/config.js';

const methods = ['GET','POST','PATCH','PUT','DELETE','OPTIONS'];
const headers = ['content-type','x-ce-session','if-match','idempotency-key','x-ce-part-sha256'];
/** Install before authentication: authorized CORS headers survive application error responses. */
export function installHostedCors(app: FastifyInstance, config: HostedConfig): void {
  const origins = new Set(config.allowedOrigins);
  app.addHook('onRequest', async (request, reply) => {
    const path = request.url.split('?')[0]!;
    if (!path.startsWith('/api/v1/')) return;
    reply.header('Cache-Control', 'private, no-store'); reply.header('Vary', 'Origin');
    const origin = request.headers.origin;
    if (origin !== undefined && !origins.has(origin)) throw new ApiError('ORIGIN_NOT_ALLOWED');
    if (origin) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Access-Control-Expose-Headers', 'ETag, Content-Disposition, X-CE-Part-SHA256, Retry-After');
    }
    if (request.method === 'POST' && path === '/api/v1/sessions' && !origin) throw new ApiError('ORIGIN_NOT_ALLOWED');
    if (request.method !== 'OPTIONS') return;
    const method = request.headers['access-control-request-method'];
    const requestedHeaders = request.headers['access-control-request-headers'];
    if (!origin || typeof method !== 'string' || !methods.includes(method) || method === 'OPTIONS'
      || !app.findRoute({ method: method as HTTPMethods, url: path })
      || (requestedHeaders !== undefined && (typeof requestedHeaders !== 'string'
        || requestedHeaders.split(',').some(value => !headers.includes(value.trim().toLowerCase()))))) throw new ApiError('ORIGIN_NOT_ALLOWED');
    reply.header('Access-Control-Allow-Methods', methods.join(', '));
    reply.header('Access-Control-Allow-Headers', headers.join(', '));
    reply.header('Access-Control-Max-Age', '600');
    return reply.code(204).send();
  });
  app.options('/api/v1/*', async (_request, reply) => reply.code(204).send());
}
