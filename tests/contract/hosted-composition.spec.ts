import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { createHostedApp } from '../../apps/api/src/hosted-entry.js';

let harness: HostedHarness | undefined;
afterEach(async () => { await harness?.close(); });
it('composes two actual APIs with shared SQL and request-local owners, without global bootstrap credentials', async () => {
  harness = await createHostedHarness();
  const apps = await harness.createApis(deps => createHostedApp({ config: deps.config, database: deps.database,
    objectTransport: deps.objectTransport, dispatcher: deps.queue, signatureVerifier: { verify: async () => false },
    now: deps.clock.now, instanceId: deps.instanceId, log: () => {} }));
  const [first, second] = apps, origin = harness.config.allowedOrigins[0]!;
  for (const app of apps) {
    expect(app.hasDecorator('ce')).toBe(false);
    const bootstrap = await app.inject('/api/v1/bootstrap'); expect(bootstrap.statusCode).toBe(200);
    expect(bootstrap.json()).toMatchObject({ mode: 'hosted' }); expect(bootstrap.json()).not.toHaveProperty('sessionToken');
  }
  const visitor = async (app: typeof first) => {
    const token = randomBytes(32).toString('base64url'), headers = { origin, 'x-ce-session': token };
    expect((await app.inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { creationNonce: randomBytes(32).toString('base64url') } })).statusCode).toBe(201);
    return headers;
  };
  const owner = await visitor(first), stranger = await visitor(second), key = randomUUID();
  const response = await first.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { ...owner, 'idempotency-key': key }, payload: { name: 'SYNTHETIC' } });
  expect(response.statusCode, response.body).toBe(201); const workspace = response.json();
  expect(workspace).toMatchObject({ state: 'empty', versionIds: [], contextCount: 0 }); expect(workspace).not.toHaveProperty('contexts');
  const own = await second.inject({ url: '/api/v1/workspaces/' + workspace.id, headers: owner });
  expect(own.statusCode).toBe(200); expect(own.json()).toEqual(workspace); expect(own.headers.etag).toBe(response.headers.etag);
  const replay = await second.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { ...owner, 'idempotency-key': key }, payload: { name: 'SYNTHETIC' } });
  expect(replay.json().id).toBe(workspace.id);
  const foreign = await second.inject({ url: '/api/v1/workspaces/' + workspace.id, headers: stranger });
  const absent = await second.inject({ url: '/api/v1/workspaces/' + randomUUID(), headers: stranger });
  expect(foreign.statusCode).toBe(404); expect(absent.json().error.code).toBe(foreign.json().error.code);
  expect(foreign.headers['access-control-allow-origin']).toBe(origin);
  const close = await first.inject({ method: 'DELETE', url: '/api/v1/session', headers: { ...owner, 'idempotency-key': randomUUID() } });
  expect(close.statusCode).toBe(204);
  expect((await second.inject({ url: '/api/v1/workspaces/' + workspace.id, headers: owner })).statusCode).toBe(410);
  expect((await second.inject({ url: '/api/v1/session', headers: stranger })).statusCode).toBe(200);
  expect((await first.inject('/missing-asset.js')).statusCode).toBe(404);
});
