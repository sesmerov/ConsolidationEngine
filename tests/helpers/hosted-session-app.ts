import Fastify from 'fastify';
import { SessionService } from '../../apps/api/src/hosted/session-service.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { installHostedSession } from '../../apps/api/src/plugins/hosted-session.js';
import { installHostedCors } from '../../apps/api/src/plugins/hosted-cors.js';
import { installHostedBodyLimits, installHostedErrorHandler } from '../../apps/api/src/plugins/hosted-body-limits.js';
import { registerHostedSessions } from '../../apps/api/src/routes/hosted-sessions.js';
import { registerHostedBootstrap } from '../../apps/api/src/routes/hosted-bootstrap.js';
import { ApiError } from '../../apps/api/src/errors.js';
import type { HostedInstanceDependencies } from './hosted-harness.js';

/** Actual Fastify session routes over real SQL; no in-memory authority or global mutable visitor state. */
export async function createHostedSessionApp(dependencies: HostedInstanceDependencies) {
  const { database, config, clock } = dependencies;
  const app = Fastify({ logger: false, requestIdHeader: false, bodyLimit: 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } });
  const service = new SessionService(database, config, new QuotaLedger(database, config));
  installHostedCors(app, config); installHostedSession(app, service, () => clock.date());
  installHostedBodyLimits(app); installHostedErrorHandler(app);
  registerHostedBootstrap(app, config); registerHostedSessions(app, service, () => clock.date());
  app.get('/api/v1/probe/:id', async request => {
    const id = (request.params as { id: string }).id;
    const row = (await database.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2', [request.hostedSession!.id, id])).rows[0];
    if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
  });
  app.post('/api/v1/echo', async request => ({ bytes: Buffer.byteLength(JSON.stringify(request.body)) }));
  app.post('/api/v1/parts', { bodyLimit: 3 * 1024 * 1024 }, async request => ({ bytes: (request.body as Buffer).byteLength }));
  app.get('/api/v1/large', async () => ({ value: '€'.repeat(400_000) }));
  await app.ready(); return app;
}
