import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';
import { readRuntimeConfig, type HostedConfig } from './hosted/config.js';
import { HostedDatabase } from './hosted/database.js';
import { QuotaLedger } from './hosted/quota-ledger.js';
import { SessionService } from './hosted/session-service.js';
import { HostedWorkspaceService } from './hosted/workspace-service.js';
import { BlobObjectTransport, type PrivateObjectTransport } from './hosted/blob-object-store.js';
import { ObjectLedger } from './hosted/object-ledger.js';
import { QstashDispatcher, QstashSignatureVerifier, type InternalSignatureVerifier } from './hosted/qstash-dispatcher.js';
import { HostedOutbox } from './hosted/outbox.js';
import { HostedJobAcceptance } from './hosted/job-acceptance.js';
import { HostedJobCoordinator } from './hosted/job-coordinator.js';
import { HostedPublication, type PublicationHandlers } from './hosted/publication.js';
import { HostedRetainedSources } from './hosted/retained-sources.js';
import { HostedWorkerRunner, type HostedRunnerOptions } from './hosted/worker-runner.js';
import { createOperationalLogger, type OperationalLogger } from './hosted/operational-log.js';
import type { JobDispatcher } from './ports/job-dispatcher.js';
import { installHostedSession } from './plugins/hosted-session.js';
import { installHostedCors } from './plugins/hosted-cors.js';
import { installHostedBodyLimits, installHostedErrorHandler } from './plugins/hosted-body-limits.js';
import { registerHostedBootstrap } from './routes/hosted-bootstrap.js';
import { registerHostedSessions } from './routes/hosted-sessions.js';
import { registerHostedCommon } from './routes/hosted-common.js';
import { registerCapabilities } from './routes/capabilities.js';
import { registerInternalJobs } from './routes/internal-jobs.js';
import { HostedDomainAdmission } from './hosted/domain-admission.js';
import { constructHostedDomain } from './hosted/worker-runtime.js';
import { transferPublicationHandlers } from './hosted/transfer-commands.js';
import { regulatoryPublicationHandlers } from './hosted/application-commands.js';
import { registerHostedDomain } from './routes/hosted-domain.js';
import { registerHostedTransfers } from './routes/hosted-transfers.js';
import { registerHostedViews } from './routes/hosted-views.js';
import { registerHostedSelection } from './routes/hosted-selection.js';
import { registerHostedReviews } from './routes/hosted-reviews.js';
import { registerHostedApplications } from './routes/hosted-applications.js';
import { HostedMaintenance } from './hosted/maintenance.js';
import { registerInternalMaintenance } from './routes/internal-maintenance.js';

export interface HostedAppOptions {
  readonly config: HostedConfig; readonly database?: HostedDatabase; readonly schema?: string; readonly instanceId?: string;
  readonly objectTransport?: PrivateObjectTransport; readonly dispatcher?: JobDispatcher; readonly signatureVerifier?: InternalSignatureVerifier;
  readonly workerOptions?: Omit<HostedRunnerOptions, 'schema' | 'now'>; readonly publicationHandlers?: PublicationHandlers;
  readonly now?: () => number; readonly log?: OperationalLogger;
}
/** No listener, static frontend or singleton visitor. Only infrastructure pools/SDKs are reusable across requests. */
export async function createHostedApp(options: HostedAppOptions): Promise<FastifyInstance> {
  const { config } = options, now = options.now ?? Date.now, date = () => new Date(now());
  const database = options.database ?? new HostedDatabase({ databaseUrl: config.databaseUrl, tls: config.databaseTls, schema: options.schema ?? 'ce_demo', poolMaximum: 1 });
  const ownDatabase = !options.database;
  const app = Fastify({ logger: false, requestIdHeader: false, genReqId: () => randomUUID(), bodyLimit: config.limits.jsonBytes,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } }, requestTimeout: 120_000 });
  let runner: HostedWorkerRunner | undefined;
  try {
    const provider = config.providers;
    if ((!options.objectTransport || !options.dispatcher || !options.signatureVerifier) && !provider) throw new TypeError('Hosted providers or explicit test adapters are required');
    const transport = options.objectTransport ?? new BlobObjectTransport(provider!.blobReadWriteToken);
    const dispatcher = options.dispatcher ?? new QstashDispatcher({ publicApiOrigin: config.publicApiOrigin, token: provider!.qstashToken });
    const verifier = options.signatureVerifier ?? new QstashSignatureVerifier(provider!.qstashCurrentSigningKey, provider!.qstashNextSigningKey);
    await database.migrate();
    const quotas = new QuotaLedger(database, config), sessions = new SessionService(database, config, quotas), workspaces = new HostedWorkspaceService(database, quotas, date);
    const objects = new ObjectLedger(database, transport, quotas, date), retained = new HostedRetainedSources(database, objects, date);
    const outbox = new HostedOutbox(database, quotas, dispatcher, { config, now });
    const acceptance = new HostedJobAcceptance(database, quotas, outbox, { config, now });
    const coordinator = new HostedJobCoordinator(database, { config, instanceId: options.instanceId ?? randomUUID(), now });
    const domain=constructHostedDomain({db:database,config,transport,now});
    const publication = new HostedPublication(database, quotas, objects, { now, retainSources: (tx, claim, version, sourceIds) => retained.promote(tx, claim, version, sourceIds),
      handlers:{...transferPublicationHandlers(domain),...regulatoryPublicationHandlers(),...options.publicationHandlers} });
    runner = new HostedWorkerRunner(coordinator, publication, { commandModule: new URL('./hosted/domain-commands.js', import.meta.url),runtime:{config}, ...options.workerOptions, schema: database.schema, now });
    const runtime = runner;
    installHostedCors(app, config); installHostedSession(app, sessions, date); installHostedBodyLimits(app);
    const log=options.log??createOperationalLogger();installHostedErrorHandler(app,log);
    registerHostedBootstrap(app, config); registerHostedSessions(app, sessions, date); registerHostedCommon(app, { workspaces, acceptance, coordinator });
    registerHostedDomain(app,{admission:new HostedDomainAdmission(acceptance),coordinator,workspaces});
    registerHostedTransfers(app,domain,{acceptance,coordinator,workspaces});registerHostedViews(app,domain);
    registerHostedSelection(app,domain,{acceptance,coordinator,workspaces});registerHostedReviews(app,domain);registerHostedApplications(app,domain);
    const maintenance=new HostedMaintenance(database,config,{quotas,transport,coordinator,outbox,now,log});
    registerInternalMaintenance(app,{publicApiOrigin:config.publicApiOrigin,verifier,sweep:()=>maintenance.sweep()});
    registerCapabilities(app); registerInternalJobs(app, { publicApiOrigin: config.publicApiOrigin, verifier, run: reference => runtime.run(reference) });
    app.setNotFoundHandler(async () => { throw new ApiError('RESOURCE_NOT_FOUND'); });
    app.addHook('onClose', async () => { await runtime.close(); if (ownDatabase) await database.close(); });
    await app.ready(); return app;
  } catch (error) {
    await runner?.close().catch(() => undefined); await app.close().catch(() => undefined);
    if (ownDatabase) await database.close().catch(() => undefined); throw error;
  }
}

let application: Promise<FastifyInstance> | undefined;
export function getHostedApplication(): Promise<FastifyInstance> {
  if (!application) application = (async () => {
    const config = readRuntimeConfig(); if (config.mode !== 'hosted') throw new TypeError('The Vercel API requires CE_MODE=hosted');
    return createHostedApp({ config });
  })().catch(error => { application = undefined; throw error; });
  return application;
}
