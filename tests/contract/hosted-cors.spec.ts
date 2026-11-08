import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { createHostedSessionApp } from '../helpers/hosted-session-app.js';

describe('hosted exact-origin CORS and transport bounds', () => {
  let harness: HostedHarness, apps: readonly [FastifyInstance, FastifyInstance];
  const origin = 'http://127.0.0.1:3350';
  beforeEach(async () => { harness = await createHostedHarness(); apps = await harness.createApis(createHostedSessionApp); });
  afterEach(async () => { await harness.close(); });
  it('authorizes real preflight routes and headers without a session but never permits a foreign origin', async () => {
    const options = { method: 'OPTIONS' as const, url: '/api/v1/session', headers: { origin, 'access-control-request-method': 'DELETE', 'access-control-request-headers': 'X-CE-Session,Idempotency-Key' } };
    const allowed = await apps[0].inject(options);
    expect(allowed.statusCode).toBe(204); expect(allowed.headers['access-control-allow-origin']).toBe(origin);
    expect(allowed.headers['access-control-allow-credentials']).toBeUndefined(); expect(allowed.headers.vary).toContain('Origin');
    expect(allowed.headers['access-control-expose-headers']).toContain('Content-Disposition');
    const rejected = await apps[0].inject({ ...options, headers: { ...options.headers, origin: 'https://evil.example' } });
    expect(rejected.statusCode).toBe(403); expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
    expect((await apps[0].inject({ ...options, headers: { ...options.headers, 'access-control-request-headers': 'Authorization' } })).statusCode).toBe(403);
    expect((await apps[0].inject({ ...options, url: '/api/v1/no-route' })).statusCode).toBe(403);
  });
  it('preserves allowed CORS on application errors and authenticates before parsing private bytes', async () => {
    const response = await apps[0].inject({ method: 'POST', url: '/api/v1/echo', headers: { origin, 'content-type': 'application/json' }, payload: '{invalid' });
    expect(response.statusCode).toBe(401); expect(response.json().error.code).toBe('SESSION_UNAUTHENTICATED');
    expect(response.headers['access-control-allow-origin']).toBe(origin); expect(response.headers['cache-control']).toBe('private, no-store');
    const foreign = await apps[0].inject({ method: 'POST', url: '/api/v1/sessions', headers: { origin: 'null', 'x-ce-session': randomBytes(32).toString('base64url') }, payload: { creationNonce: randomBytes(32).toString('base64url') } });
    expect(foreign.statusCode).toBe(403); expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
  });
  it('counts actual UTF-8/chunked bytes and uses separate JSON and binary limits', async () => {
    const token = randomBytes(32).toString('base64url'), headers = { origin, 'x-ce-session': token };
    await apps[0].inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { creationNonce: randomBytes(32).toString('base64url') } });
    const excessiveJson = await apps[0].inject({ method: 'POST', url: '/api/v1/echo', headers: { ...headers, 'content-type': 'application/json' }, payload: Readable.from(['{"value":"', '€'.repeat(400_000), '"}']) });
    expect(excessiveJson.statusCode).toBe(413);
    const part = await apps[1].inject({ method: 'POST', url: '/api/v1/parts', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Buffer.alloc(3 * 1024 * 1024) });
    expect(part.statusCode).toBe(200); expect(part.json().bytes).toBe(3 * 1024 * 1024);
    const tooLarge = await apps[1].inject({ method: 'POST', url: '/api/v1/parts', headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: Readable.from([Buffer.alloc(3 * 1024 * 1024), Buffer.from('x')]) });
    expect(tooLarge.statusCode).toBe(413);
    const publicOutput = await apps[0].inject({ url: '/api/v1/large', headers });
    expect(publicOutput.statusCode).toBe(413); expect(Buffer.byteLength(publicOutput.payload)).toBeLessThan(1024 * 1024);
  });
});
