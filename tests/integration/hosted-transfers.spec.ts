import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { BlobObjectTransport } from '../../apps/api/src/hosted/blob-object-store.js';
import { CanonicalCodec } from '../../apps/api/src/hosted/canonical-codec.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import type { WorkspaceOwner } from '../../apps/api/src/ports/workspace-repository.js';

describe('private immutable storage, real PostgreSQL and controlled provider bytes', () => {
  let harness: HostedHarness, owner: WorkspaceOwner, one: ObjectLedger, two: ObjectLedger;
  beforeEach(async () => { harness = await createHostedHarness(); owner = await seedOwner(harness);
    one = new ObjectLedger(harness.databases[0], harness.objectTransport, new QuotaLedger(harness.databases[0], harness.config), () => harness.clock.date());
    two = new ObjectLedger(harness.databases[1], harness.objectTransport, new QuotaLedger(harness.databases[1], harness.config), () => harness.clock.date());
  });
  afterEach(async () => { await harness?.close(); });
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  function context() { return { operationId: randomUUID(), deadline: new Date(harness.clock.now() + 60_000).toISOString() }; }
  it('retains a 3 MiB real part across two pools, verifies hashes and rejects max+1 before provider I/O', async () => {
    const bytes = Buffer.alloc(3 * 1024 * 1024, 43), ref = await one.putObject(owner, bytes, context(), 'files');
    expect(ref.sha256).toBe(digest(bytes)); const downloaded = await two.getObject(owner, ref); expect(downloaded.byteLength).toBe(bytes.byteLength); expect(digest(downloaded)).toBe(digest(bytes));
    const calls = harness.objectTransport.calls.length; await expect(one.putObject(owner, Buffer.alloc(bytes.length + 1), context(), 'files')).rejects.toMatchObject({ code: 'UPLOAD_LIMIT' }); expect(harness.objectTransport.calls).toHaveLength(calls);
    expect(JSON.stringify(ref)).not.toMatch(/private_object_key|vercel|ce\/v1|token/);
  });
  it('authorizes before any provider read and rejects corruption', async () => {
    const ref = await one.putObject(owner, Buffer.from('private'), context(), 'files'), other = await seedOwner(harness), before = harness.objectTransport.calls.length;
    await expect(two.getObject(other, ref)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' }); expect(harness.objectTransport.calls).toHaveLength(before);
    harness.objectTransport.corrupt(harness.objectTransport.entries()[0]!.privateKey, Buffer.from('changed')); await expect(two.getObject(owner, ref)).rejects.toThrow(/integrity/i);
  });
  it('verifies authoritative SQL length and hash even when private Blob omits Content-Length', async () => {
    let bytes = Buffer.from('private');
    const sdk = { put: async () => ({}), del: async () => {}, get: async () => ({ statusCode: 200, blob: { size: 0 }, headers: new Headers(),
      stream: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }) }) };
    const transport = new BlobObjectTransport('synthetic-test-token', sdk as unknown as NonNullable<ConstructorParameters<typeof BlobObjectTransport>[1]>, () => {});
    const ledger = new ObjectLedger(harness.databases[0], transport, new QuotaLedger(harness.databases[0], harness.config), () => harness.clock.date());
    const ref = await ledger.putObject(owner, bytes, context(), 'files'); expect(await ledger.getObject(owner, ref)).toEqual(bytes);
    bytes = Buffer.from('privat'); await expect(ledger.getObject(owner, ref)).rejects.toThrow(/integrity/i);
    bytes = Buffer.from('changed'); await expect(ledger.getObject(owner, ref)).rejects.toThrow(/integrity/i);
  });
  it('keeps an acknowledged-lost write charged and reconciles its same private key before reuse', async () => {
    const bytes = Buffer.from('uncertain'), request = context(); harness.objectTransport.failNext('put', 'after'); await expect(one.putObject(owner, bytes, request, 'files')).rejects.toThrow();
    const rows = await harness.databases[0].query<{ id: string; status: string }>('SELECT id,status FROM physical_objects WHERE session_id=$1 AND workspace_id=$2', [owner.sessionId, owner.workspaceId]);
    expect(rows.rows).toHaveLength(1); expect(rows.rows[0]!.status).toBe('uncertain'); expect(harness.objectTransport.entries()).toHaveLength(1);
    const reservation = (await harness.databases[0].query("SELECT q.state FROM quota_reservations q JOIN physical_objects p ON p.reservation_id=q.id WHERE p.id=$1", [rows.rows[0]!.id])).rows[0]!; expect(reservation['state']).toBe('uncertain');
    await two.reconcileObject(owner, rows.rows[0]!.id, context()); const recovered = await two.putObject(owner, bytes, request, 'files'); expect(recovered.objectId).toBe(rows.rows[0]!.id); expect(harness.objectTransport.calls.filter(call => call.operation === 'put')).toHaveLength(1);
  });
  it('checks revocation after provider I/O and publishes no usable object', async () => {
    harness.barriers.arm('transport.afterPut'); const writing = one.putObject(owner, Buffer.from('revoked'), context(), 'files');
    await harness.barriers.waitUntilReached('transport.afterPut'); await harness.databases[1].query("UPDATE demo_sessions SET state='revoked',revoked_at=$2,reason='revoked' WHERE id=$1", [owner.sessionId, harness.clock.date()]); harness.barriers.release('transport.afterPut');
    await expect(writing).rejects.toMatchObject({ code: 'SESSION_EXPIRED' }); expect((await harness.databases[0].query('SELECT status FROM physical_objects WHERE session_id=$1', [owner.sessionId])).rows).toEqual([{ status: 'uncertain' }]);
  });
  it('does not return bytes when the session is revoked during the private read', async () => {
    const ref = await one.putObject(owner, Buffer.from('before-revocation'), context(), 'files'); harness.barriers.arm('transport.afterGet');
    const reading = two.getObject(owner, ref); await harness.barriers.waitUntilReached('transport.afterGet');
    await harness.databases[0].query("UPDATE demo_sessions SET state='revoked',revoked_at=$2,reason='revoked' WHERE id=$1", [owner.sessionId, harness.clock.date()]); harness.barriers.release('transport.afterGet');
    await expect(reading).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
  it('blocks elapsed work before any provider operation or quota reservation', async () => {
    const request = context(); harness.clock.advance(60_001); await expect(one.putObject(owner, Buffer.from('late'), request, 'files')).rejects.toMatchObject({ code: 'JOB_TIMED_OUT' });
    expect(harness.objectTransport.calls).toHaveLength(0); expect((await harness.databases[0].query('SELECT id FROM quota_reservations')).rows).toHaveLength(0);
  });
  it('deduplicates canonical content within the owner, preserves rational strings and retains shared blocks once per publication', async () => {
    const jobId = randomUUID(), attemptId = randomUUID(), now = harness.clock.date();
    await harness.databases[0].query(`INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,accepted_at,queue_expires_at,started_at,deadline_at,status,fence,attempt_id) VALUES($1,$2,$3,'export','{}',$4,$5,$4,$6,'running',1,$7)`, [owner.sessionId, owner.workspaceId, jobId, now, new Date(+now + 600_000), new Date(+now + 60_000), attemptId]);
    const ctx = { ...context(), operationId: jobId, jobId, attemptId, fence: 1 }, codec = new CanonicalCodec(one), value = { numerator: '123456789012345678901234567890', denominator: '7', absent: null, ordering: ['b','a'] };
    const ref = await codec.put(owner, value, ctx), count = harness.objectTransport.calls.filter(call => call.operation === 'put').length;
    expect(await new CanonicalCodec(two).put(owner, value, ctx)).toEqual(ref); expect(harness.objectTransport.calls.filter(call => call.operation === 'put')).toHaveLength(count); expect(await new CanonicalCodec(two).get(owner, ref)).toEqual(value);
    const publicationId = randomUUID(); await harness.databases[0].transaction(tx => one.retain(tx, owner, [ref, ref], { publicationId, jobId, attemptId, fence: 1 })); await harness.databases[1].transaction(tx => two.retain(tx, owner, [ref], { publicationId, jobId, attemptId, fence: 1 }));
    expect((await harness.databases[0].query('SELECT ref_count FROM canonical_blocks WHERE id=$1', [ref.resourceId])).rows[0]).toEqual({ ref_count: 1 });
  });
  it('keeps state and file budgets separate and refuses a non-reservable write before the provider', async () => {
    const limited = { ...harness.config, limits: { ...harness.config.limits, maxStateBytes: 8, maxStoredFileBytes: 32 } }, ledger = new ObjectLedger(harness.databases[0], harness.objectTransport, new QuotaLedger(harness.databases[0], limited), () => harness.clock.date());
    await expect(ledger.putObject(owner, Buffer.alloc(9), context(), 'state')).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' }); expect(harness.objectTransport.calls).toHaveLength(0);
    await ledger.putObject(owner, Buffer.alloc(9), context(), 'files'); expect(harness.objectTransport.entries()).toHaveLength(1);
  });
  it('retains shared descendants once per publication and fences an obsolete worker before storage', async () => {
    const jobId = randomUUID(), attemptId = randomUUID(), now = harness.clock.date();
    await harness.databases[0].query(`INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,accepted_at,queue_expires_at,started_at,deadline_at,status,fence,attempt_id) VALUES($1,$2,$3,'export','{}',$4,$5,$4,$6,'running',1,$7)`, [owner.sessionId, owner.workspaceId, jobId, now, new Date(+now + 600_000), new Date(+now + 60_000), attemptId]);
    const ctx = { ...context(), operationId: jobId, jobId, attemptId, fence: '1' }, codec = new CanonicalCodec(one), facts = Array.from({ length: 4000 }, (_, id) => ({ id, text: 'x'.repeat(100), numerator: '12345678901234567890', denominator: '7' }));
    const first = await codec.put(owner, { facts, revision: 'first' }, ctx), second = await codec.put(owner, { facts, revision: 'second' }, ctx), publicationId = randomUUID();
    await harness.databases[0].transaction(tx => one.retain(tx, owner, [first, second], { publicationId, jobId, attemptId, fence: '1' }));
    const counts = (await harness.databases[0].query<{ ref_count: number }>('SELECT ref_count FROM canonical_blocks WHERE session_id=$1', [owner.sessionId])).rows;
    expect(counts.length).toBeGreaterThan(3); expect(counts.every(row => row.ref_count === 1)).toBe(true);
    const nextAttempt = randomUUID(); await harness.databases[1].query('UPDATE jobs SET attempt_id=$2,fence=2 WHERE id=$1', [jobId, nextAttempt]); const calls = harness.objectTransport.calls.length;
    await expect(codec.put(owner, { extra: 'obsolete' }, ctx)).rejects.toMatchObject({ code: 'STALE_VERSION' }); expect(harness.objectTransport.calls).toHaveLength(calls);
    const successor = { ...ctx, attemptId: nextAttempt, fence: '2' }; expect(await new CanonicalCodec(two).put(owner, { facts, revision: 'first' }, successor)).toEqual(first);
    await harness.databases[1].transaction(tx => two.retain(tx, owner, [first], { publicationId: randomUUID(), jobId, attemptId: nextAttempt, fence: '2' }));
    expect((await harness.databases[0].query<{ ref_count: number }>('SELECT ref_count FROM canonical_blocks WHERE id=$1', [first.resourceId])).rows[0]?.ref_count).toBe(2);
  });
});
async function seedOwner(harness: HostedHarness): Promise<WorkspaceOwner> {
  const sessionId = randomUUID(), workspaceId = randomUUID(), now = harness.clock.date(), hash = createHash('sha256').update(sessionId).digest('hex');
  await harness.databases[0].query(`INSERT INTO demo_sessions(id,token_hash,creation_nonce_hash,created_at,last_meaningful_activity_at,expires_at,absolute_expires_at) VALUES($1,$2,$2,$3,$3,$4,$5)`, [sessionId, hash, now, new Date(+now + 3_600_000), new Date(+now + 86_400_000)]);
  await harness.databases[0].query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [sessionId, workspaceId, 'SYNTHETIC']); return { sessionId, workspaceId };
}
