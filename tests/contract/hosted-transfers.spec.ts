import { randomBytes, randomUUID, createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { SessionService } from '../../apps/api/src/hosted/session-service.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { HostedUploadBatches } from '../../apps/api/src/storage/upload-batches.js';
import { registerUploadBatches } from '../../apps/api/src/routes/upload-batches.js';
import { installHostedBodyLimits, installHostedErrorHandler } from '../../apps/api/src/plugins/hosted-body-limits.js';
import { installHostedSession, requireHostedSession } from '../../apps/api/src/plugins/hosted-session.js';
import { installHostedCors } from '../../apps/api/src/plugins/hosted-cors.js';
import { ApiError } from '../../apps/api/src/errors.js';
import { TRANSFER_PART_MAX_BYTES, type UploadBatchDTO } from '@ce/contracts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'), secret = () => randomBytes(32).toString('base64url');
describe('authenticated binary upload routes with actual SQL authority', () => {
  let harness: HostedHarness, apps: readonly [FastifyInstance, FastifyInstance], token: string, otherToken: string, workspaceId: string, sessionId: string;
  beforeEach(async () => {
    harness = await createHostedHarness(); token = secret(); otherToken = secret(); workspaceId = randomUUID();
    const sessions = new SessionService(harness.databases[0], harness.config, new QuotaLedger(harness.databases[0], harness.config)); sessionId = (await sessions.create(token, secret(), harness.clock.date())).session.id; await sessions.create(otherToken, secret(), harness.clock.date());
    await harness.databases[0].query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [sessionId, workspaceId, 'SYNTHETIC']);
    apps = await harness.createApis(async ({ database, config, clock, objectTransport }) => {
      const app = Fastify({ logger: false, bodyLimit: 1024 * 1024, ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } } }), quota = new QuotaLedger(database, config);
      installHostedCors(app, config); installHostedSession(app, new SessionService(database, config, quota), () => clock.date()); installHostedBodyLimits(app); installHostedErrorHandler(app);
      registerUploadBatches(app, { service: new HostedUploadBatches(database, new ObjectLedger(database, objectTransport, quota, () => clock.date()), quota, () => clock.date()), owner: (request, id) => ({ sessionId: requireHostedSession(request).id, workspaceId: id }), seal: async () => { throw new ApiError('TRANSFER_INCOMPLETE'); } });
      await app.ready(); return app;
    });
  });
  afterEach(async () => { await harness?.close(); });
  const headers = (token: string) => ({ origin: 'http://127.0.0.1:3350', 'x-ce-session': token });
  it('accepts exactly 3 MiB as binary, replays from another API, and does not renew idle time for automatic parts', async () => {
    const bytes = Buffer.alloc(TRANSFER_PART_MAX_BYTES, 19), response = await apps[0].inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/upload-batches`, headers: { ...headers(token), 'idempotency-key': randomUUID(), 'if-match': `"${workspaceId}:1:empty"` }, payload: { baseVersionId: null, files: [{ clientFileId: 'catalog', role: 'catalog', name: 'catalog.xlsx', byteLength: bytes.length, sha256: sha(bytes) }, { clientFileId: 'report', role: 'report', name: 'report.xlsx', byteLength: 10, sha256: 'a'.repeat(64) }] } });
    expect(response.statusCode).toBe(201); const batch = response.json<UploadBatchDTO>(), file = batch.files.find(file => file.role === 'catalog')!; harness.clock.advance(40_000);
    const request = { method: 'POST' as const, url: `/api/v1/workspaces/${workspaceId}/upload-batches/${batch.id}/files/${file.id}/parts/0`, headers: { ...headers(token), 'content-type': 'application/octet-stream', 'x-ce-part-sha256': sha(bytes) }, payload: bytes };
    const first = await apps[0].inject(request), replay = await apps[1].inject(request); expect(first.statusCode).toBe(200); expect(replay.json()).toEqual(first.json()); expect(first.json()).toEqual({ index: 0, size: bytes.length, sha256: sha(bytes) });
    expect(harness.objectTransport.calls.filter(call => call.operation === 'put')).toHaveLength(1); expect(Number(first.headers['content-length'])).toBeLessThan(1024);
    const activity = (await harness.databases[1].query<{ last_meaningful_activity_at: Date }>('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1', [sessionId])).rows[0]!; expect(+activity.last_meaningful_activity_at).toBe(harness.clock.now() - 40_000);
    const foreign = await apps[1].inject({ ...request, headers: { ...request.headers, 'x-ce-session': otherToken } }); expect(foreign.statusCode).toBe(404);
    const oversized = await apps[1].inject({ ...request, payload: Buffer.alloc(TRANSFER_PART_MAX_BYTES + 1) }); expect(oversized.statusCode).toBe(413); expect(harness.objectTransport.calls.filter(call => call.operation === 'put')).toHaveLength(1);
  });
  it('refuses client paths, malformed IDs and unknown fields before accepting a batch', async () => {
    const body = { baseVersionId: null, files: [{ clientFileId: 'catalog', role: 'catalog', name: '../catalog.xlsx', byteLength: 8, sha256: 'a'.repeat(64) }, { clientFileId: 'report', role: 'report', name: 'report.xlsx', byteLength: 8, sha256: 'b'.repeat(64) }] };
    const response = await apps[0].inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/upload-batches`, headers: { ...headers(token), 'idempotency-key': randomUUID(), 'if-match': `"${workspaceId}:1:empty"` }, payload: body }); expect(response.statusCode).toBe(400);
    const malformed = await apps[0].inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/upload-batches/not-a-uuid/files/not-a-uuid/parts/0`, headers: { ...headers(token), 'content-type': 'application/octet-stream', 'x-ce-part-sha256': 'a'.repeat(64) }, payload: Buffer.from('x') }); expect([400,404]).toContain(malformed.statusCode); expect(harness.objectTransport.calls).toHaveLength(0);
  });
});
