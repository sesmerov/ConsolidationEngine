import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { registerInternalMaintenance } from '../../apps/api/src/routes/internal-maintenance.js';

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
describe('signed maintenance endpoint', () => {
  it('verifies the unmodified body and exact URL, without accepting a visitor bearer as authority', async () => {
    const app = Fastify(); apps.push(app); const verified: unknown[] = []; let sweeps = 0;
    registerInternalMaintenance(app, { publicApiOrigin: 'https://api.example.test', verifier: { async verify(value) { verified.push(value); return value.signature === 'signed'; } },
      async sweep() { sweeps++; return { state: 'completed', expiredSessions: 0, reconciledJobs: 0, dispatched: 0, removedObjects: 0, deferredObjects: 0, completedTasks: 0 }; } });
    const raw = '{ "kind": "maintenance", "version": 1 }';
    expect((await app.inject({ method: 'POST', url: '/internal/maintenance', headers: { 'content-type': 'application/json', 'x-ce-session': 'visitor' }, payload: raw })).statusCode).toBe(401);
    expect(sweeps).toBe(0);
    const accepted = await app.inject({ method: 'POST', url: '/internal/maintenance', headers: { 'content-type': 'application/json', 'upstash-signature': 'signed' }, payload: raw });
    expect(accepted.statusCode).toBe(200); expect(sweeps).toBe(1);
    expect(verified).toEqual([{ signature: 'signed', body: raw, url: 'https://api.example.test/internal/maintenance' }]);
    expect(accepted.headers['cache-control']).toBe('no-store');
  });
  it('rejects added body fields and waits for a complete sweep response', async () => {
    const app = Fastify(); apps.push(app); let sweeps = 0;
    registerInternalMaintenance(app, { publicApiOrigin: 'https://api.example.test', verifier: { async verify() { return true; } },
      async sweep() { sweeps++; return { state: 'busy', expiredSessions: 0, reconciledJobs: 0, dispatched: 0, removedObjects: 0, deferredObjects: 0, completedTasks: 0 }; } });
    const headers = { 'upstash-signature': 'signed', 'content-type': 'application/json' };
    expect((await app.inject({ method: 'POST', url: '/internal/maintenance', headers, payload: { kind: 'maintenance', version: 1, sessionId: 'visitor' } })).statusCode).toBe(400);
    expect(sweeps).toBe(0);
    const busy = await app.inject({ method: 'POST', url: '/internal/maintenance', headers, payload: { kind: 'maintenance', version: 1 } });
    expect(busy.statusCode).toBe(503); expect(busy.headers['retry-after']).toBe('5');
  });
});
