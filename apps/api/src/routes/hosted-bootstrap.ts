import type { FastifyInstance } from 'fastify';
import { API_VERSION, emptyQuerySchema, hostedBootstrapSchema, type HostedBootstrapDTO } from '@ce/contracts';
import type { HostedConfig } from '../hosted/config.js';

export function registerHostedBootstrap(app: FastifyInstance, config: HostedConfig): void {
  const bootstrap: HostedBootstrapDTO = { mode: 'hosted', apiVersion: API_VERSION, limits: config.limits };
  app.get('/api/v1/bootstrap', { schema: { querystring: emptyQuerySchema, response: { 200: hostedBootstrapSchema } } }, async () => bootstrap);
}
