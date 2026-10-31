import { randomBytes, randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';
import { WorkspaceStore } from './session/workspace-store.js';
import { IdempotencyStore } from './session/idempotency-store.js';
import { JobManager } from './jobs/job-manager.js';
import type { JobManagerOptions } from './jobs/job-manager.js';
import { SessionFiles } from './storage/session-files.js';
import { installLocalSession } from './plugins/local-session.js';
import { registerBootstrap } from './routes/bootstrap.js';
import { registerWorkspaces } from './routes/workspaces.js';
import { registerJobs } from './routes/jobs.js';
export interface AppServices { readonly store: WorkspaceStore; readonly idempotency: IdempotencyStore; readonly jobs: JobManager; readonly files: SessionFiles }
declare module 'fastify' { interface FastifyInstance { ce: AppServices } }
export interface AppOptions extends JobManagerOptions {
  mode?: 'development' | 'production'; apiPort?: number; webPort?: number;
  store?: WorkspaceStore; files?: SessionFiles; jobs?: JobManager;
}
export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, requestIdHeader: false, genReqId: () => randomUUID(), bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } }, requestTimeout: 120_000 });
  const store = options.store ?? new WorkspaceStore();
  const files = options.files ?? await SessionFiles.create(store.sessionId);
  const jobs = options.jobs ?? new JobManager(store, options);
  app.decorate('ce', { store, files, jobs, idempotency: new IdempotencyStore(store) });
  const token = randomBytes(32).toString('base64url');
  installLocalSession(app, { token, mode: options.mode ?? 'production', apiPort: options.apiPort ?? 3000, webPort: options.webPort ?? 4200 });
  app.setErrorHandler((error, request, reply) => {
    const metadata = error && typeof error === 'object' ? error as { validation?: unknown; statusCode?: number } : {};
    const known = error instanceof ApiError ? error : new ApiError(metadata.validation || metadata.statusCode === 400 ? 'INVALID_REQUEST' : metadata.statusCode === 413 ? 'UPLOAD_LIMIT' : 'INTERNAL_ERROR');
    return reply.code(known.statusCode).send({ error: { code: known.code, message: known.publicMessage, requestId: request.id, locator: known.locator, details: known.details } });
  });
  app.setNotFoundHandler((_request, reply) => { const error = new ApiError('RESOURCE_NOT_FOUND'); return reply.code(404).send({ error: { code: error.code, message: error.publicMessage, requestId: _request.id, locator: null, details: {} } }); });
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); });
  registerBootstrap(app, token); registerWorkspaces(app); registerJobs(app);
  app.addHook('onClose', async () => { await jobs.dispose(); await files.close(); const id = store.currentWorkspaceId; if (id) store.close(id); });
  return app;
}
