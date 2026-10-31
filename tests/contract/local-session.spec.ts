import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { access } from 'node:fs/promises';
import { createApp } from '../../apps/api/src/app.js';
import { registerJobRoute } from '../../apps/api/src/routes/jobs.js';
import { content, controlledFactory, nextTurn } from '../helpers/foundation.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
async function setup() {
  const controlled = controlledFactory();
  const app = await createApp({ mode: 'development', workerFactory: controlled.factory }); apps.push(app);
  registerJobRoute(app, { path: '/workspaces/:workspaceId/test-jobs', kind: 'import', bodySchema: {
    type: 'object', additionalProperties: false, required: ['label'], properties: { label: { type: 'string' } },
  }, prepare: (request) => ({ input: request.body as { label: string } }) });
  const baseHeaders = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:4200' };
  const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers: baseHeaders });
  const headers = { ...baseHeaders, 'x-ce-session': bootstrap.json().sessionToken as string };
  const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Prueba' } });
  return { app, controlled, headers, baseHeaders, workspace: created.json(), bootstrap, created };
}

describe('local session HTTP contract', () => {
  it('issues an ephemeral 256-bit token and rejects host/origin/token spoofing without exposing state', async () => {
    const { app, bootstrap, headers } = await setup();
    expect(bootstrap.statusCode).toBe(200);
    expect(Buffer.from(bootstrap.json().sessionToken, 'base64url')).toHaveLength(32);
    expect(bootstrap.json().sessionPersistence).toBe('ephemeral');
    expect(bootstrap.json().activeWorkspaceId).toBeUndefined();
    for (const url of ['/api/v1/workspaces/' + randomUUID(), '/api/v1/jobs', '/api/v1/health']) {
      const reply = await app.inject({ url, headers: { host: headers.host } });
      expect(reply.statusCode).toBe(403);
      expect(reply.json().error.code).toBe('INVALID_SESSION');
    }
    for (const extra of [{ host: 'evil.example' }, { origin: 'null' }, { origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }]) {
      const reply = await app.inject({ url: '/api/v1/bootstrap', headers: { ...headers, ...extra } });
      expect(reply.statusCode).toBe(403);
      expect(reply.body).not.toContain(bootstrap.json().sessionToken);
    }
  });
  it('uses closed schemas, one active workspace, and protects close with the current ETag', async () => {
    const { app, headers, workspace, created } = await setup();
    expect(created.statusCode).toBe(201); expect(created.headers.etag).toBe('"empty"');
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Otro', extra: true } });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.message).toBe('La petición no tiene el formato esperado.');
    expect(invalid.json().error).not.toHaveProperty('stack');
    const duplicate = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Otro' } });
    expect(duplicate.statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers })).statusCode).toBe(428);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers: { ...headers, 'if-match': '"v-stale"' } })).statusCode).toBe(412);
  });
  it('replays an accepted job before rejecting its old ETag and detects a reused key with other content', async () => {
    const { app, controlled, headers, workspace } = await setup();
    const url = `/api/v1/workspaces/${workspace.id}/test-jobs`;
    const key = randomUUID(); const jobHeaders = { ...headers, 'if-match': '"empty"', 'idempotency-key': key };
    const first = await app.inject({ method: 'POST', url, headers: jobHeaders, payload: { label: 'one' } });
    expect(first.statusCode).toBe(202); await nextTurn();
    controlled.workers[0]!.complete({ snapshotContent: content() });
    const replay = await app.inject({ method: 'POST', url, headers: jobHeaders, payload: { label: 'one' } });
    expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(first.json().jobId);
    expect(replay.json().status).toBe('succeeded'); expect(controlled.workers).toHaveLength(1);
    const conflict = await app.inject({ method: 'POST', url, headers: jobHeaders, payload: { label: 'two' } });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    const stale = await app.inject({ method: 'POST', url, headers: { ...jobHeaders, 'idempotency-key': randomUUID() }, payload: { label: 'one' } });
    expect(stale.statusCode).toBe(412);
    const missing = await app.inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { label: 'one' } });
    expect(missing.statusCode).toBe(428);
    const unauthorized = await app.inject({ method: 'POST', url, headers: { ...jobHeaders, 'x-ce-session': 'wrong' }, payload: { label: 'one' } });
    expect(unauthorized.statusCode).toBe(403);
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${first.json().jobId}`, headers });
    expect(cancelled.statusCode).toBe(200); expect(cancelled.json().status).toBe('succeeded');
  });
  it('cancels by jobId without If-Match and closes only after stopping the active worker', async () => {
    const { app, controlled, headers, workspace } = await setup();
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/test-jobs`, headers: { ...headers, 'if-match': '"empty"', 'idempotency-key': randomUUID() }, payload: { label: 'one' } }); await nextTurn();
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${accepted.json().jobId}`, headers });
    expect(cancelled.statusCode).toBe(202); expect(controlled.workers[0]!.terminated).toBe(true);
    const closed = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers: { ...headers, 'if-match': '"empty"' } });
    expect(closed.statusCode).toBe(204);
    expect((await app.inject({ url: `/api/v1/workspaces/${workspace.id}`, headers })).statusCode).toBe(404);
  });
  it('advertises the active workspace on reconnect and forgets it after close', async () => {
    const { app, headers, workspace } = await setup();
    expect((await app.inject({ url: '/api/v1/bootstrap', headers })).json().activeWorkspaceId).toBe(workspace.id);
    await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers: { ...headers, 'if-match': '"empty"' } });
    expect((await app.inject({ url: '/api/v1/bootstrap', headers })).json().activeWorkspaceId).toBeUndefined();
  });
  it('closing with an active worker waits for termination before deleting its files', async () => {
    const { app, controlled, headers, workspace } = await setup();
    await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/test-jobs`, headers: { ...headers, 'if-match': '"empty"', 'idempotency-key': randomUUID() }, payload: { label: 'one' } }); await nextTurn();
    const file = await app.ce.files.write(workspace.id, Buffer.from('input'));
    let finish!: () => void; const termination = new Promise<void>((resolve) => { finish = resolve; });
    controlled.workers[0]!.terminate = async () => { await termination; controlled.workers[0]!.terminated = true; return 0; };
    const closing = app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers: { ...headers, 'if-match': '"empty"' } });
    await nextTurn(); await expect(access(file.path)).resolves.toBeUndefined();
    finish(); expect((await closing).statusCode).toBe(204);
    expect(controlled.workers[0]!.terminated).toBe(true); await expect(access(file.path)).rejects.toThrow();
  });
  it('coordinates simultaneous cancellation and close without duplicate termination or unhandled errors', async () => {
    const { app, controlled, headers, workspace } = await setup();
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/test-jobs`, headers: { ...headers, 'if-match': '"empty"', 'idempotency-key': randomUUID() }, payload: { label: 'one' } }); await nextTurn();
    let terminateCount = 0; let finish!: () => void; const termination = new Promise<void>((resolve) => { finish = resolve; });
    controlled.workers[0]!.terminate = async () => { terminateCount++; await termination; return 0; };
    const cancellation = app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${accepted.json().jobId}`, headers });
    const closing = app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers: { ...headers, 'if-match': '"empty"' } });
    await nextTurn(); finish();
    const replies = await Promise.all([cancellation, closing]);
    expect(replies.map((response) => response.statusCode)).toEqual([202, 204]); expect(terminateCount).toBe(1);
  });
});
