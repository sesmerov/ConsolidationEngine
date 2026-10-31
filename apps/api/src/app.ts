import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';
import { WorkspaceStore } from './session/workspace-store.js';
import { IdempotencyStore } from './session/idempotency-store.js';
import { JobManager } from './jobs/job-manager.js';
import { PreparationManager } from './jobs/preparation-manager.js';
import type { JobManagerOptions } from './jobs/job-manager.js';
import { SessionFiles } from './storage/session-files.js';
import { installLocalSession } from './plugins/local-session.js';
import { registerBootstrap } from './routes/bootstrap.js';
import { registerWorkspaces } from './routes/workspaces.js';
import { registerJobs } from './routes/jobs.js';
import type { UploadLimits } from './import/multipart-staging.js';
import { UPLOAD_LIMITS } from './import/multipart-staging.js';
import { UploadManager } from './import/upload-manager.js';
import { registerImports } from './routes/imports.js';
import { registerRules } from './routes/rules.js';
import { registerCapabilities } from './routes/capabilities.js';
import { registerValidations } from './routes/validations.js';
import { registerResults } from './routes/results.js';
import { registerDirections } from './routes/directions.js';
import { registerPreviews } from './routes/previews.js';
import { registerHistory } from './routes/history.js';
import { registerApplications } from './routes/applications.js';
import type { WorkLimits } from '@ce/engine';
import { registerExports } from './routes/exports.js';
import type { ExportLimits } from './export/results-export.js';
import type { ReportExportLimits } from './export/recalculated-report.js';
export interface AppServices { readonly store: WorkspaceStore; readonly idempotency: IdempotencyStore; readonly jobs: JobManager; readonly files: SessionFiles; readonly uploads: UploadManager; readonly preparations: PreparationManager }
declare module 'fastify' { interface FastifyInstance { ce: AppServices } }
export interface AppOptions extends JobManagerOptions {
  mode?: 'development' | 'production'; apiPort?: number; webPort?: number;
  store?: WorkspaceStore; files?: SessionFiles; jobs?: JobManager;
  uploadLimits?: Partial<UploadLimits>;
  serveWeb?: boolean;
  validationLimits?: Partial<WorkLimits>;
  previewLimits?: Partial<WorkLimits>;
  applicationLimits?: Partial<WorkLimits>;
  exportLimits?: Partial<ExportLimits>; fileLimitBytes?: number;
  reportExportLimits?: Partial<ReportExportLimits>;
}
export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, requestIdHeader: false, genReqId: () => randomUUID(), bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } }, requestTimeout: 120_000 });
  await app.register(multipart, { limits: { fileSize: UPLOAD_LIMITS.maxFileBytes, files: UPLOAD_LIMITS.maxReports + 1, fields: 1 } });
  const store = options.store ?? new WorkspaceStore();
  const files = options.files ?? await SessionFiles.create(store.sessionId, undefined, options.fileLimitBytes);
  const jobs = options.jobs ?? new JobManager(store, { ...options, workerModules: { import: new URL('./workers/import.worker.js', import.meta.url), validate: new URL('./workers/validate.worker.js', import.meta.url), preview: new URL('./workers/preview.worker.js', import.meta.url), apply: new URL('./workers/apply.worker.js', import.meta.url), export: new URL('./workers/export.worker.js', import.meta.url), ...options.workerModules } });
  const uploads = new UploadManager(store);
  const preparations = new PreparationManager(store);
  app.decorate('ce', { store, files, jobs, uploads, preparations, idempotency: new IdempotencyStore(store) });
  const token = randomBytes(32).toString('base64url');
  installLocalSession(app, { token, mode: options.mode ?? 'production', apiPort: options.apiPort ?? 3000, webPort: options.webPort ?? 4200 });
  app.setErrorHandler((error, request, reply) => {
    const metadata = error && typeof error === 'object' ? error as { validation?: unknown; statusCode?: number } : {};
    const known = error instanceof ApiError ? error : new ApiError(metadata.validation || metadata.statusCode === 400 ? 'INVALID_REQUEST' : metadata.statusCode === 413 ? 'UPLOAD_LIMIT' : 'INTERNAL_ERROR');
    if ((known.code === 'UPLOAD_LIMIT' || known.code === 'RESOURCE_NOT_FOUND' || known.code === 'WORKSPACE_BUSY') && !request.raw.complete) { reply.header('Connection', 'close'); reply.raw.once('finish', () => request.raw.destroy()); }
    return reply.code(known.statusCode).send({ error: { code: known.code, message: known.publicMessage, requestId: request.id, locator: known.locator, details: known.details } });
  });
  if (options.serveWeb) await app.register(fastifyStatic, { root: fileURLToPath(new URL('../../../dist/web/browser/', import.meta.url)), dotfiles: 'ignore' });
  app.setNotFoundHandler((_request, reply) => {
    const pathname = _request.url.split('?')[0]!;
    if (options.serveWeb && _request.method === 'GET' && !pathname.startsWith('/api/') && !pathname.split('/').some((part) => part.includes('.')) && _request.headers.accept?.includes('text/html')) return reply.type('text/html').sendFile('index.html');
    const error = new ApiError('RESOURCE_NOT_FOUND'); return reply.code(404).send({ error: { code: error.code, message: error.publicMessage, requestId: _request.id, locator: null, details: {} } });
  });
  app.addHook('onSend', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); reply.header('X-Content-Type-Options', 'nosniff'); });
  registerBootstrap(app, token); registerWorkspaces(app); registerJobs(app);
  registerImports(app, options.uploadLimits); registerRules(app); registerCapabilities(app);
  registerValidations(app, options.validationLimits); registerResults(app);
  registerDirections(app);
  registerPreviews(app, options.previewLimits); registerHistory(app);
  registerApplications(app, options.applicationLimits);
  registerExports(app, options.exportLimits, options.reportExportLimits);
  app.addHook('preClose', async () => {
    const id = store.currentWorkspaceId; if (id) store.beginClose(id);
    await uploads.dispose(); if (id) await preparations.settle(id);
  });
  app.addHook('onClose', async () => { await jobs.dispose(); await files.close(); const id = store.currentWorkspaceId; if (id) store.close(id); });
  return app;
}
