import type { FastifyInstance } from 'fastify';
import { API_VERSION, emptyQuerySchema } from '@ce/contracts';
export function registerBootstrap(app: FastifyInstance, token: string): void {
  app.get('/api/v1/bootstrap', { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const activeWorkspaceId = app.ce.store.currentWorkspaceId;
    return { sessionToken: token, apiVersion: API_VERSION, sessionPersistence: 'ephemeral', ...(activeWorkspaceId ? { activeWorkspaceId } : {}) };
  });
}
