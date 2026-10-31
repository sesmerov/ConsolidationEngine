import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ApiError } from '../errors.js';
export interface LocalSessionOptions { readonly token: string; readonly mode: 'development' | 'production'; readonly apiPort: number; readonly webPort: number }
export function installLocalSession(app: FastifyInstance, options: LocalSessionOptions): void {
  const hosts = new Set(['127.0.0.1:' + options.apiPort]);
  if (options.mode === 'development') hosts.add('127.0.0.1:' + options.webPort);
  const origins = new Set(Array.from(hosts, (host) => 'http://' + host));
  const expected = Buffer.from(options.token);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (!hosts.has(request.headers.host ?? '') || (origin !== undefined && !origins.has(origin)) || request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError('ORIGIN_NOT_ALLOWED');
    if (origin) { reply.header('Access-Control-Allow-Origin', origin); reply.header('Access-Control-Expose-Headers', 'ETag'); reply.header('Vary', 'Origin'); }
    if (request.method === 'OPTIONS' && origin) {
      reply.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'Content-Type,X-CE-Session,If-Match,Idempotency-Key');
      return reply.code(204).send();
    }
    if (request.method === 'GET' && request.url.split('?')[0] === '/api/v1/bootstrap') return;
    const supplied = request.headers['x-ce-session'];
    if (typeof supplied !== 'string') throw new ApiError('INVALID_SESSION');
    const bytes = Buffer.from(supplied);
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) throw new ApiError('INVALID_SESSION');
  });
}
