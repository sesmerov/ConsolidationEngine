import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { createHostedSessionApp } from '../helpers/hosted-session-app.js';

describe('two hosted Fastify APIs with independent visitor sessions', () => {
  let harness: HostedHarness, apps: readonly [FastifyInstance, FastifyInstance];
  beforeEach(async () => { harness = await createHostedHarness(); apps = await harness.createApis(createHostedSessionApp); });
  afterEach(async () => { await harness.close(); });
  const origin = 'http://127.0.0.1:3350';
  it('returns a public bootstrap, then recovers the same creation after response loss across instances', async () => {
    const bootstrap = await apps[0].inject({ method: 'GET', url: '/api/v1/bootstrap', headers: { origin } });
    expect(bootstrap.statusCode).toBe(200); expect(bootstrap.json()).not.toHaveProperty('sessionToken'); expect(bootstrap.json().mode).toBe('hosted');
    const token = secret(), creationNonce = secret(), request = { method: 'POST' as const, url: '/api/v1/sessions', headers: { origin, 'x-ce-session': token }, payload: { creationNonce } };
    const first = await apps[0].inject(request), replay = await apps[1].inject(request);
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200); expect(first.json()).toEqual(replay.json());
    expect(JSON.stringify(first.json())).not.toContain(token); expect(JSON.stringify(first.json())).not.toContain(creationNonce);
    expect(first.headers['cache-control']).toBe('private, no-store');
    const crossed = await apps[1].inject({ ...request, payload: { creationNonce: secret() } });
    expect(crossed.statusCode).toBe(409); expect(crossed.json().error.code).toBe('SESSION_CREATION_CONFLICT');
  });
  it('does not leak another visitor workspace and never refreshes GET inactivity', async () => {
    const tokenA = secret(), tokenB = secret();
    const first = await apps[0].inject({ method: 'POST', url: '/api/v1/sessions', headers: { origin, 'x-ce-session': tokenA }, payload: { creationNonce: secret() } });
    await apps[1].inject({ method: 'POST', url: '/api/v1/sessions', headers: { origin, 'x-ce-session': tokenB }, payload: { creationNonce: secret() } });
    const workspace = randomUUID();
    await harness.databases[0].query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [first.json().id, workspace, 'Private']);
    const own = await apps[1].inject({ url: `/api/v1/probe/${workspace}`, headers: { origin, 'x-ce-session': tokenA } });
    expect(own.statusCode).toBe(200);
    const other = await apps[0].inject({ url: `/api/v1/probe/${workspace}`, headers: { origin, 'x-ce-session': tokenB } });
    const missing = await apps[0].inject({ url: `/api/v1/probe/${randomUUID()}`, headers: { origin, 'x-ce-session': tokenB } });
    expect(other.statusCode).toBe(404); expect(missing.statusCode).toBe(404); expect(other.json().error.code).toBe(missing.json().error.code);
    harness.clock.advance(59 * 60_000);
    const metadata = await apps[1].inject({ url: '/api/v1/session', headers: { origin, 'x-ce-session': tokenA } });
    expect(metadata.json().lastMeaningfulActivityAt).toBe(first.json().lastMeaningfulActivityAt);
    harness.clock.advance(60_000);
    const expired = await apps[0].inject({ url: '/api/v1/session', headers: { origin, 'x-ce-session': tokenA } });
    expect(expired.statusCode).toBe(410);
  });
  it('revokes across instances and keeps DELETE idempotent without resurrecting the pair', async () => {
    const token = secret(), creationNonce = secret(), headers = { origin, 'x-ce-session': token, 'idempotency-key': randomUUID() };
    await apps[0].inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { creationNonce } });
    expect((await apps[1].inject({ method: 'DELETE', url: '/api/v1/session', headers })).statusCode).toBe(204);
    expect((await apps[0].inject({ method: 'DELETE', url: '/api/v1/session', headers })).statusCode).toBe(204);
    expect((await apps[0].inject({ url: '/api/v1/session', headers })).statusCode).toBe(410);
    expect((await apps[1].inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { creationNonce } })).statusCode).toBe(410);
  });
});
function secret(): string { return randomBytes(32).toString('base64url'); }
