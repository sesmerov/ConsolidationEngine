import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedJobAcceptance, type JobAcceptanceRequest } from '../../apps/api/src/hosted/job-acceptance.js';
import { HostedOutbox } from '../../apps/api/src/hosted/outbox.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { PostgresRepository } from '../../apps/api/src/hosted/postgres-repository.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('durable acceptance and recoverable outbox on real PostgreSQL', () => {
  let h: HostedHarness;
  beforeEach(async () => { h = await createHostedHarness(); });
  afterEach(async () => { await h?.close(); });
  function services() { return h.databases.map(db => {
    const quotas = new QuotaLedger(db, h.config), outbox = new HostedOutbox(db, quotas, h.queue, { config: h.config, now: h.clock.now });
    return new HostedJobAcceptance(db, quotas, outbox, { config: h.config, now: h.clock.now });
  }); }
  async function request(): Promise<JobAcceptanceRequest> {
    const fixture = await seedHostedWorkspace(h), metadata = await new PostgresRepository(h.databases[0], { now: h.clock.now }).workspace(fixture.owner);
    return { ...fixture.owner, key: randomUUID(), method: 'POST', path: `/api/v1/workspaces/${fixture.owner.workspaceId}/validations`,
      body: { baseVersionId: fixture.snapshot.versionId }, expectedBase: metadata.etag, baseVersionId: fixture.snapshot.versionId,
      kind: 'validate', meaningful: true, inputRefs: { schemaVersion: 1, versionId: fixture.snapshot.versionId } };
  }
  it('recovers an acknowledgement lost after provider acceptance from another instance without a new job', async () => {
    const command = await request(), [a, b] = services(); h.queue.failNextDispatch('after');
    const first = await a!.accept(command);
    expect(first.responseStatus).toBe(503); expect(first.phase).toBe('dispatch_pending'); expect(first.resultRef).toBeUndefined();
    expect(await b!.receiptByKey(command.sessionId, command.key)).toEqual(first);
    const second = await b!.accept(command);
    expect(second).toMatchObject({ operationId: first.operationId, jobId: first.jobId, responseStatus: 202, phase: 'queued' });
    expect(h.queue.messages).toHaveLength(2);
    expect(new Set(h.queue.messages.map(message => message.reference.jobId)).size).toBe(1);
    expect((await h.databases[0].query('SELECT count(*)::int AS count FROM jobs')).rows[0].count).toBe(1);
    expect((await h.databases[0].query("SELECT sum(units)::int AS count FROM usage_ledger WHERE resource='jobs'")).rows[0].count).toBe(1);
    expect((await h.databases[0].query("SELECT sum(units)::int AS count FROM usage_ledger WHERE resource='qstash-deliveries'")).rows[0].count).toBe(8);
  });
  it('recovers the receipt before stale-base rejection, without renewing session activity or charging another job', async () => {
    const command = await request(), [a, b] = services(), first = await a!.accept(command);
    const before = (await h.databases[0].query('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1', [command.sessionId])).rows[0];
    h.clock.advance(40_000);
    await h.databases[0].query('UPDATE workspaces SET revision=revision+1 WHERE session_id=$1 AND id=$2', [command.sessionId, command.workspaceId]);
    expect(await b!.accept(command)).toEqual(first);
    expect((await h.databases[1].query('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1', [command.sessionId])).rows[0]).toEqual(before);
    await expect(b!.accept({ ...command, key: randomUUID() })).rejects.toMatchObject({ code: 'STALE_VERSION' });
    await expect(b!.accept({ ...command, body: { another: true } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(h.queue.messages).toHaveLength(1);
  });
  it('serializes duplicate acceptance and never holds a SQL transaction across provider I/O', async () => {
    const command = await request(), [a, b] = services(); h.barriers.arm('queue.beforeDispatch');
    const firstPending = a!.accept(command); await h.barriers.waitUntilReached('queue.beforeDispatch');
    const second = await b!.accept(command); expect(second.responseStatus).toBe(503);
    expect((await h.databases[1].query('SELECT count(*)::int AS count FROM jobs')).rows[0].count).toBe(1);
    h.barriers.release('queue.beforeDispatch'); const first = await firstPending;
    expect(first.jobId).toBe(second.jobId); expect(first.responseStatus).toBe(202); expect(h.queue.messages).toHaveLength(1);
  });
  it('authorizes the live owner even for receipt replay and hides foreign operation IDs', async () => {
    const command = await request(), other = await request(), [a, b] = services(), first = await a!.accept(command);
    await expect(b!.receiptByOperation(other.sessionId, first.operationId)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await h.databases[0].query("UPDATE demo_sessions SET state='revoked' WHERE id=$1", [command.sessionId]);
    await expect(b!.accept(command)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect(b!.receiptByKey(command.sessionId, command.key)).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
  it('rolls back receipt, reserved domain rows and quota together when admission fails', async () => {
    const command = await request(), [a] = services();
    await expect(a!.accept(command, async tx => {
      await tx.query('UPDATE workspaces SET revision=revision+1 WHERE session_id=$1 AND id=$2', [command.sessionId, command.workspaceId]);
      throw new Error('DOMAIN_RESERVATION_FAILED');
    })).rejects.toThrow('DOMAIN_RESERVATION_FAILED');
    expect((await h.databases[0].query('SELECT count(*)::int AS count FROM jobs')).rows[0].count).toBe(0);
    expect((await h.databases[0].query('SELECT count(*)::int AS count FROM operation_receipts')).rows[0].count).toBe(0);
    expect((await h.databases[0].query('SELECT count(*)::int AS count FROM quota_reservations')).rows[0].count).toBe(0);
    expect((await new PostgresRepository(h.databases[0], { now: h.clock.now }).workspace(command)).etag).toBe(command.expectedBase);
  });
  it('reuses a preparing or ready authority across fresh keys without a second job or renewal', async () => {
    const command = await request(), [a, b] = services(), first = await a!.accept({ ...command, meaningful: false });
    const before = (await h.databases[0].query('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1', [command.sessionId])).rows[0];
    h.clock.advance(40000);
    for (let n = 0; n < 10; n++) {
      const receipt = await (n % 2 ? a! : b!).accept({ ...command, key: randomUUID() }, undefined, async () => first.jobId);
      expect(receipt.jobId).toBe(first.jobId);
    }
    expect((await h.databases[0].query('SELECT count(*)::int AS count FROM jobs')).rows[0].count).toBe(1);
    expect((await h.databases[0].query("SELECT sum(units)::int AS count FROM usage_ledger WHERE resource='jobs'")).rows[0].count).toBe(1);
    expect((await h.databases[1].query('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1', [command.sessionId])).rows[0]).toEqual(before);
    expect(h.queue.messages).toHaveLength(1);
  });
  it('derives reserved IDs inside the locked admission transaction and cannot override the server workspace revision', async () => {
    const command = await request(), [a, b] = services(), previewId = randomUUID();
    const reservation = { kind: 'recalculation' as const, inputVersionId: command.baseVersionId!, effectiveVersionId: command.baseVersionId!, reservedPreviewId: previewId };
    const first = await a!.accept(command, async () => ({ inputRefs: { workspaceRevision: 'forged', publication: { resultId: previewId } }, reservation }));
    expect(first.reservation).toEqual(reservation);
    const job = (await h.databases[0].query('SELECT input_refs FROM jobs WHERE session_id=$1 AND id=$2', [command.sessionId, first.jobId])).rows[0]!;
    expect(job.input_refs).toMatchObject({ workspaceRevision: '1', publication: { resultId: previewId } });
    expect(await b!.accept(command, async () => { throw new Error('must not execute on replay'); })).toEqual(first);
  });
});
