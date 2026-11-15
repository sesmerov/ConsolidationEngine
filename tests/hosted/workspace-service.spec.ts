import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { SessionService } from '../../apps/api/src/hosted/session-service.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { HostedWorkspaceService } from '../../apps/api/src/hosted/workspace-service.js';
import { PostgresRepository, workspaceEtag } from '../../apps/api/src/hosted/postgres-repository.js';

let harness: HostedHarness, sessionId: string, services: HostedWorkspaceService[];
beforeEach(async () => {
  harness = await createHostedHarness();
  const sessions = new SessionService(harness.databases[0], harness.config, new QuotaLedger(harness.databases[0], harness.config));
  sessionId = (await sessions.create(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'), harness.clock.date())).session.id;
  services = harness.databases.map(db => new HostedWorkspaceService(db, new QuotaLedger(db, harness.config), () => harness.clock.date()));
});
afterEach(async () => { await harness?.close(); });
it('recovers a lost creation response across pools without a second workspace, activity renewal or capacity charge', async () => {
  const key = randomUUID(), first = await services[0]!.create(sessionId, 'SYNTHETIC', key);
  harness.clock.advance(60_000);
  const second = await services[1]!.create(sessionId, 'SYNTHETIC', key);
  expect(second.id).toBe(first.id);
  expect((await harness.databases[0].query('SELECT id FROM workspaces WHERE session_id=$1', [sessionId])).rowCount).toBe(1);
  expect((await harness.databases[0].query('SELECT last_meaningful_activity_at=created_at AS unchanged FROM demo_sessions WHERE id=$1', [sessionId])).rows[0]!.unchanged).toBe(true);
  await expect(services[0]!.create(sessionId, 'DIFFERENT', key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  await expect(services[0]!.create(sessionId, 'NEW', randomUUID())).rejects.toMatchObject({ code: 'ACTIVE_WORKSPACE_EXISTS' });
});
it('serializes distinct concurrent creates and rejects quota exhaustion atomically', async () => {
  const replies = await Promise.allSettled(services.map(service => service.create(sessionId, 'SYNTHETIC', randomUUID())));
  expect(replies.filter(reply => reply.status === 'fulfilled')).toHaveLength(1);
  expect(replies.filter(reply => reply.status === 'rejected')).toHaveLength(1);
  const restrictive = { ...harness.config, quotas: { ...harness.config.quotas, sqlBytes: 1 } };
  const another = new SessionService(harness.databases[0], harness.config, new QuotaLedger(harness.databases[0], harness.config));
  const otherId = (await another.create(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'), harness.clock.date())).session.id;
  await expect(new HostedWorkspaceService(harness.databases[1], new QuotaLedger(harness.databases[1], restrictive), () => harness.clock.date()).create(otherId, 'SYNTHETIC', randomUUID())).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
  expect((await harness.databases[0].query('SELECT id FROM workspaces WHERE session_id=$1', [otherId])).rowCount).toBe(0);
});
it('closes with CAS, recovers the original receipt and leaves durable cleanup without resurrecting a closed workspace', async () => {
  const workspace = await services[0]!.create(sessionId, 'SYNTHETIC', randomUUID()), owner = { sessionId, workspaceId: workspace.id };
  const key = randomUUID(), etag = workspaceEtag(workspace);
  await expect(services[1]!.close(owner, '"wrong"', key)).rejects.toMatchObject({ code: 'STALE_VERSION' });
  await expect(services[1]!.close({ ...owner, sessionId: randomUUID() }, etag, key)).rejects.toMatchObject({ code: 'SESSION_UNAUTHENTICATED' });
  await services[0]!.close(owner, etag, key); await services[1]!.close(owner, etag, key);
  expect((await harness.databases[0].query('SELECT state FROM cleanup_tasks WHERE session_id=$1', [sessionId])).rows).toEqual([{ state: 'pending' }]);
  await expect(new PostgresRepository(harness.databases[0], { now: harness.clock.now }).workspace(owner)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  await expect(services[0]!.close(owner, '"changed"', key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  const next = await services[1]!.create(sessionId, 'NEXT SYNTHETIC', randomUUID()); expect(next.id).not.toBe(workspace.id);
});
