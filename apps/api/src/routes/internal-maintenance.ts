import type { FastifyInstance } from 'fastify';
import type { InternalSignatureVerifier } from '../hosted/qstash-dispatcher.js';
import type { MaintenanceResult } from '../hosted/maintenance.js';

export interface InternalMaintenanceDependencies {
  readonly publicApiOrigin: string; readonly verifier: InternalSignatureVerifier;
  readonly sweep: () => Promise<MaintenanceResult>;
}
export function registerInternalMaintenance(app: FastifyInstance, dependencies: InternalMaintenanceDependencies): void {
  app.register(async scope => {
    scope.removeContentTypeParser('application/json');
    scope.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 4096 }, (_request, bytes, done) => done(null, bytes));
    scope.post('/internal/maintenance', { bodyLimit: 4096 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      const signature = request.headers['upstash-signature'];
      if (typeof signature !== 'string' || signature.length > 8192 || !Buffer.isBuffer(request.body)) return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      let raw: string;
      try { raw = new TextDecoder('utf-8', { fatal: true }).decode(request.body); }
      catch { return reply.code(400).send({ error: 'INVALID_MESSAGE' }); }
      if (!await dependencies.verifier.verify({ signature, body: raw, url: dependencies.publicApiOrigin + request.raw.url }).catch(() => false)) return reply.code(401).send({ error: 'INVALID_SIGNATURE' });
      let message: unknown;
      try { message = JSON.parse(raw); } catch { return reply.code(400).send({ error: 'INVALID_MESSAGE' }); }
      if (!message || typeof message !== 'object' || Array.isArray(message) || Object.keys(message).length !== 2
        || !('kind' in message) || message.kind !== 'maintenance' || !('version' in message) || message.version !== 1
        || request.raw.url !== '/internal/maintenance') return reply.code(400).send({ error: 'INVALID_MESSAGE' });
      const result = await dependencies.sweep();
      if (result.state === 'busy') return reply.header('Retry-After', '5').code(503).send({ status: 'busy' });
      return { status: 'completed', removedObjects: result.removedObjects, deferredObjects: result.deferredObjects, completedTasks: result.completedTasks };
    });
  });
}
