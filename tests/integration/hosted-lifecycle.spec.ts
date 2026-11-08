import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostedMaintenance } from '../../apps/api/src/hosted/maintenance.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { ObjectMaintenance } from '../../apps/api/src/hosted/object-maintenance.js';
import { HostedOutbox } from '../../apps/api/src/hosted/outbox.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { SessionService } from '../../apps/api/src/hosted/session-service.js';
import { createOperationalLogger } from '../../apps/api/src/hosted/operational-log.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('hosted lifecycle without a browser', () => {
  let h: HostedHarness, quotas: QuotaLedger, sessions: SessionService, coordinator: HostedJobCoordinator;
  let maintenance: HostedMaintenance, objects: ObjectLedger;
  const logs: string[] = [];
  beforeEach(async () => {
    h = await createHostedHarness(); quotas = new QuotaLedger(h.databases[0], h.config);
    sessions = new SessionService(h.databases[0], h.config, quotas);
    coordinator = new HostedJobCoordinator(h.databases[0], { config: h.config, instanceId: 'lifecycle', now: h.clock.now });
    const outbox = new HostedOutbox(h.databases[0], quotas, h.queue, { config: h.config, now: h.clock.now });
    maintenance = new HostedMaintenance(h.databases[0], h.config, { coordinator, outbox, quotas, transport: h.objectTransport,
      now: h.clock.now, log: createOperationalLogger(line => logs.push(line)) });
    objects = new ObjectLedger(h.databases[0], h.objectTransport, quotas, () => h.clock.date()); logs.length = 0;
  });
  afterEach(async () => { h.barriers.releaseAll(); await h.close(); });
  const context = () => ({ operationId: randomUUID(), deadline: new Date(h.clock.now() + 60_000).toISOString() });

  it('expires sixty-minute sessions and cleans their bytes without requests, preserving a different owner', async () => {
    const first = await seedHostedWorkspace(h);
    await objects.putObject(first.owner, Buffer.from('private first'), context(), 'files');
    h.clock.advance(1_800_000); const second = await seedHostedWorkspace(h);
    const retained = await objects.putObject(second.owner, Buffer.from('private second'), context(), 'files'), resourceId = randomUUID();
    // A different visitor's retained file is real owner-qualified metadata, not an orphan with ref_count0.
    await h.databases[0].transaction(async tx => {
      const ids = [second.owner.sessionId, second.owner.workspaceId, resourceId];
      await tx.query("INSERT INTO object_resources(session_id,workspace_id,id,kind,state,byte_length,sha256) VALUES($1,$2,$3,'file','retained',$4,$5)", [...ids, retained.byteLength, retained.sha256]);
      await tx.query("INSERT INTO stored_files(session_id,workspace_id,id,role,name,mime,byte_length,sha256,part_count,state,retained_ref_count) VALUES($1,$2,$3,'report','retained.xlsx','application/octet-stream',$4,$5,1,'retained',1)", [...ids, retained.byteLength, retained.sha256]);
      await tx.query("INSERT INTO object_parts(session_id,workspace_id,resource_id,part_index,size,sha256,object_id,status) VALUES($1,$2,$3,0,$4,$5,$6,'stored')", [...ids, retained.byteLength, retained.sha256, retained.objectId]);
      await tx.query('UPDATE physical_objects SET ref_count=1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [second.owner.sessionId, second.owner.workspaceId, retained.objectId]);
      await tx.query('INSERT INTO snapshot_sources(session_id,workspace_id,version_id,source_file_id) VALUES($1,$2,$3,$4)', [second.owner.sessionId, second.owner.workspaceId, second.snapshot.versionId, resourceId]);
    });
    h.clock.advance(1_800_000); await maintenance.sweep();
    expect((await h.databases[0].query('SELECT state FROM demo_sessions WHERE id=$1', [first.owner.sessionId])).rows[0]!.state).not.toBe('active');
    h.clock.advance(120_001); await maintenance.sweep();
    expect((await h.databases[0].query('SELECT state,token_hash FROM demo_sessions WHERE id=$1', [first.owner.sessionId])).rows[0])
      .toMatchObject({ state: 'deleted', token_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(h.objectTransport.entries()).toHaveLength(1);
    expect(h.objectTransport.entries()[0]!.privateKey).toContain(second.owner.sessionId);
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM workspace_versions WHERE session_id=$1', [first.owner.sessionId])).rows[0]!.n).toBe(0);
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM workspace_versions WHERE session_id=$1', [second.owner.sessionId])).rows[0]!.n).toBe(1);
  });

  it('does not renew an active session while retrying its outbox and never dispatches an expired queue item', async () => {
    const seeded = await seedHostedWorkspace(h), job = await seeded.queuedJob();
    await h.databases[0].query(`INSERT INTO outbox_entries(session_id,workspace_id,id,job_id,dispatch_state,next_attempt_at)
      VALUES($1,$2,$3,$4,'uncertain',$5)`, [job.sessionId, job.workspaceId, randomUUID(), job.jobId, h.clock.date()]);
    const before = (await h.databases[0].query('SELECT last_meaningful_activity_at,expires_at FROM demo_sessions WHERE id=$1', [job.sessionId])).rows[0];
    await maintenance.sweep(); expect(h.queue.accepted).toHaveLength(1);
    expect((await h.databases[0].query('SELECT last_meaningful_activity_at,expires_at FROM demo_sessions WHERE id=$1', [job.sessionId])).rows[0]).toEqual(before);
    const expired = await seeded.queuedJob();
    await h.databases[0].query(`INSERT INTO outbox_entries(session_id,workspace_id,id,job_id,dispatch_state,next_attempt_at)
      VALUES($1,$2,$3,$4,'pending',$5)`, [expired.sessionId, expired.workspaceId, randomUUID(), expired.jobId, h.clock.date()]);
    h.clock.advance(600_000); await maintenance.sweep();
    expect(h.queue.accepted).toHaveLength(1);
    expect((await h.databases[0].query('SELECT status FROM jobs WHERE id=$1', [expired.jobId])).rows[0]!.status).toBe('timed_out');
  });

  it('times out abandoned work at sixty seconds but retains CPU authority and receipts until safe release at120s', async () => {
    const seeded = await seedHostedWorkspace(h), job = await seeded.queuedJob();
    expect((await coordinator.claim(job)).state).toBe('claimed');
    await h.databases[0].query(`INSERT INTO mutation_receipts(session_id,key_hash,method,path,request_fingerprint,expected_base,workspace_id,response_status,response,created_at)
      VALUES($1,$2,'POST','/workspaces',$2,'empty',$3,201,$4,$5)`, [job.sessionId, 'a'.repeat(64), job.workspaceId, { name: 'private receipt' }, h.clock.date()]);
    await sessions.revoke(job.sessionId, h.clock.date()); h.clock.advance(60_000); await maintenance.sweep();
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM cpu_permits WHERE job_id=$1 AND released_at IS NULL', [job.jobId])).rows[0]!.n).toBe(3);
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM mutation_receipts WHERE session_id=$1', [job.sessionId])).rows[0]!.n).toBe(1);
    h.clock.advance(60_001); await maintenance.sweep();
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM cpu_permits WHERE job_id=$1 AND released_at IS NULL', [job.jobId])).rows[0]!.n).toBe(0);
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM mutation_receipts WHERE session_id=$1', [job.sessionId])).rows[0]!.n).toBe(0);
  });

  it('keeps uncertain bytes charged after an uncertain provider response and retries before24h', async () => {
    const seeded = await seedHostedWorkspace(h);
    h.objectTransport.failNext('put', 'after');
    await expect(objects.putObject(seeded.owner, Buffer.from('uncertain private bytes'), context(), 'files')).rejects.toThrow();
    h.clock.advance(120_001); h.objectTransport.failNext('removeMany', 'after'); h.objectTransport.failNext('get', 'before'); await maintenance.sweep();
    const counts = () => h.databases[0].query("SELECT count(*)::int AS n FROM quota_reservations WHERE session_id=$1 AND resource IN ('blob-bytes','session-file-bytes') AND state<>'released'", [seeded.owner.sessionId]);
    expect((await counts()).rows[0]!.n).toBe(2);
    expect((await h.databases[0].query('SELECT status FROM physical_objects WHERE session_id=$1', [seeded.owner.sessionId])).rows[0]!.status).not.toBe('deleted');
    h.clock.advance(3_600_000); await maintenance.sweep();
    expect((await counts()).rows[0]!.n).toBe(0); expect(h.objectTransport.entries()).toHaveLength(0);
    expect((await h.databases[0].query("SELECT count(*)::int AS n FROM usage_ledger WHERE session_id=$1 AND resource='blob-advanced-operations' AND category='consumed'", [seeded.owner.sessionId])).rows[0]!.n).toBe(1);
  });

  it('uses one durable sweep lease across instances and releases no foreign objects', async () => {
    const seeded = await seedHostedWorkspace(h);
    h.objectTransport.failNext('put', 'after'); await expect(objects.putObject(seeded.owner, Buffer.from('owned'), context(), 'files')).rejects.toThrow();
    h.clock.advance(120_001); h.barriers.arm('transport.beforeRemoveMany');
    const running = maintenance.sweep(); await h.barriers.waitUntilReached('transport.beforeRemoveMany');
    const other = new HostedMaintenance(h.databases[1], h.config, { coordinator, quotas, transport: h.objectTransport, now: h.clock.now });
    expect((await other.sweep()).state).toBe('busy'); h.barriers.release('transport.beforeRemoveMany');
    expect((await running).state).toBe('completed'); expect(h.objectTransport.entries()).toHaveLength(0);
  });

  it('alerts by18h without private fields and recovers an abandoned running cleanup', async () => {
    const seeded = await seedHostedWorkspace(h), id = randomUUID();
    await h.databases[0].query(`INSERT INTO cleanup_tasks(id,session_id,workspace_id,object_ref,reason,not_before,deadline,state,updated_at)
      VALUES($1,$2,$3,$4,'test-recovery',$5,$6,'running',$5)`, [id, seeded.owner.sessionId, seeded.owner.workspaceId,
      { kind: 'physical-object', objectId: randomUUID() }, h.clock.date(), new Date(h.clock.now() + 86_400_000)]);
    h.clock.advance(18 * 3_600_000); await maintenance.sweep();
    expect(logs.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ event: 'cleanup_delayed', count: expect.any(Number) }));
    expect(logs.join(' ')).not.toContain(seeded.owner.sessionId);
    expect((await h.databases[0].query('SELECT state FROM cleanup_tasks WHERE id=$1', [id])).rows[0]!.state).toBe('completed');
  });

  it('preserves pending roots and shared descendants retained by another publication', async () => {
    const seeded = await seedHostedWorkspace(h), job = await seeded.queuedJob(), outcome = await coordinator.claim(job);
    if (outcome.state !== 'claimed') throw new Error('Expected real claim');
    const claim = outcome.claim, write = { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt };
    const child = await objects.putCanonical(seeded.owner, Buffer.from('shared child'), [], write);
    const retained = await objects.putCanonical(seeded.owner, Buffer.from('retained root'), [child], write);
    const orphan = await objects.putCanonical(seeded.owner, Buffer.from('orphan root'), [child], context());
    await h.databases[0].transaction(tx => objects.retain(tx, seeded.owner, [retained], { publicationId: randomUUID(), jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence }));
    // This test has no running child process; mark the synthetic claim terminal before confirming termination.
    await coordinator.fail(claim, []); await coordinator.confirmTerminated(claim);
    h.clock.advance(120_001);
    const gc = new ObjectMaintenance(h.databases[0], quotas, h.objectTransport, h.clock.date.bind(h.clock));
    expect(await gc.pruneResource(seeded.owner, orphan.resourceId, async () => undefined)).toBe(false);
    h.clock.advance(60_001); await maintenance.sweep();
    expect((await h.databases[0].query('SELECT id FROM canonical_blocks WHERE session_id=$1 ORDER BY id', [seeded.owner.sessionId])).rows.map(row => row.id).sort())
      .toEqual([retained.resourceId, child.resourceId].sort());
    expect(h.objectTransport.entries()).toHaveLength(2);
    expect(Buffer.from(await objects.getCanonical(seeded.owner, child))).toEqual(Buffer.from('shared child'));
  });

  it('rejects a stale sweep acknowledgement after another instance has acquired its lease', async () => {
    const seeded = await seedHostedWorkspace(h);
    await objects.putObject(seeded.owner, Buffer.from('fenced removal'), context(), 'files');
    h.clock.advance(120_001); h.barriers.arm('transport.afterRemoveMany');
    const first = maintenance.sweep(); await h.barriers.waitUntilReached('transport.afterRemoveMany');
    h.clock.advance(120_001);
    const other = new HostedMaintenance(h.databases[1], h.config, { quotas, transport: h.objectTransport, now: h.clock.now });
    h.barriers.arm('transport.beforeRemoveMany');
    const replacement = other.sweep(); await h.barriers.waitUntilReached('transport.beforeRemoveMany');
    h.barriers.release('transport.afterRemoveMany'); await first.catch(() => undefined);
    expect((await h.databases[0].query("SELECT status FROM physical_objects WHERE session_id=$1", [seeded.owner.sessionId])).rows[0]!.status).toBe('cleanup_pending');
    expect((await h.databases[0].query("SELECT holder_id FROM leases WHERE scope='maintenance' AND scope_key='demo'")).rows[0]!.holder_id).not.toBeNull();
    h.barriers.release('transport.beforeRemoveMany'); await replacement;
    expect((await h.databases[0].query("SELECT count(*)::int AS n FROM physical_objects WHERE status='deleted'")).rows[0]!.n).toBe(1);
    expect((await h.databases[0].query("SELECT fence FROM leases WHERE scope='maintenance' AND scope_key='demo'")).rows[0]!.fence).toBe('2');
    expect((await h.databases[0].query("SELECT count(*)::int AS n FROM quota_reservations WHERE session_id=$1 AND resource='blob-bytes' AND state<>'released'", [seeded.owner.sessionId])).rows[0]!.n).toBe(0);
  });

  it('resumes a committed metadata chunk after interruption without declaring the session deleted early', async () => {
    const seeded = await seedHostedWorkspace(h), indexId = randomUUID();
    await h.databases[0].transaction(async tx => {
      await tx.query("INSERT INTO projection_sets(session_id,workspace_id,resource_kind,resource_id,revision,row_count) VALUES($1,$2,'results',$3,1,2001)", [seeded.owner.sessionId, seeded.owner.workspaceId, indexId]);
      await tx.query(`INSERT INTO projection_rows(session_id,workspace_id,resource_kind,resource_id,row_key,sort_key,payload_ref,summary)
        SELECT $1,$2,'results',$3,n::text,n::text,'{}','{"description":"private"}' FROM generate_series(1,2001) n`, [seeded.owner.sessionId, seeded.owner.workspaceId, indexId]);
    });
    await sessions.revoke(seeded.owner.sessionId, h.clock.date()); h.clock.advance(120_001);
    const original = h.databases[0].transaction.bind(h.databases[0]); let interrupted = false;
    const spy = vi.spyOn(h.databases[0], 'transaction').mockImplementation(async work => {
      let deletedRows = false;
      const value = await original(tx => work({ query: async (sql, values) => {
        const result = await tx.query(sql, values); if (sql.startsWith('DELETE FROM projection_rows') && result.rowCount) deletedRows = true;
        return result;
      } }));
      if (deletedRows && !interrupted) { interrupted = true; throw new Error('CONTROLLED_AFTER_COMMIT_INTERRUPTION'); }
      return value;
    });
    try { await maintenance.sweep(); } finally { spy.mockRestore(); }
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM projection_rows')).rows[0]!.n).toBe(1001);
    expect((await h.databases[0].query('SELECT state FROM demo_sessions WHERE id=$1', [seeded.owner.sessionId])).rows[0]!.state).not.toBe('deleted');
    h.clock.advance(30_001); await maintenance.sweep();
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM projection_rows')).rows[0]!.n).toBe(0);
    expect((await h.databases[0].query('SELECT state FROM demo_sessions WHERE id=$1', [seeded.owner.sessionId])).rows[0]!.state).toBe('deleted');
  });

  it('expires an export manifest while retaining the report version it was generated from', async () => {
    const seeded = await seedHostedWorkspace(h), job = await seeded.queuedJob(), artifactId = randomUUID(), manifestId = randomUUID();
    const part = await objects.putObject(seeded.owner, Buffer.from('private export zip'), context(), 'files');
    await h.databases[0].transaction(async tx => {
      const ids = [seeded.owner.sessionId, seeded.owner.workspaceId];
      await tx.query("INSERT INTO object_resources(session_id,workspace_id,id,kind,state,byte_length,sha256,created_at) VALUES($1,$2,$3,'artifact','retained',$4,$5,$6)", [...ids, artifactId, part.byteLength, part.sha256, h.clock.date()]);
      await tx.query("INSERT INTO object_parts(session_id,workspace_id,resource_id,part_index,size,sha256,object_id,status) VALUES($1,$2,$3,0,$4,$5,$6,'stored')", [...ids, artifactId, part.byteLength, part.sha256, part.objectId]);
      await tx.query('UPDATE physical_objects SET ref_count=1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...ids, part.objectId]);
      await tx.query("INSERT INTO object_manifests(session_id,workspace_id,id,resource_id,codec_version,whole_size,whole_sha256,part_count,sealed_at,ref_count,state) VALUES($1,$2,$3,$4,1,$5,$6,1,$7,1,'retained')", [...ids, manifestId, artifactId, part.byteLength, part.sha256, h.clock.date()]);
      await tx.query("INSERT INTO export_artifacts(session_id,workspace_id,id,version_id,kind,job_id,manifest_id,status,expires_at) VALUES($1,$2,$3,$4,'report',$5,$6,'ready',$7)", [...ids, artifactId, seeded.snapshot.versionId, job.jobId, manifestId, new Date(h.clock.now() + 600_000)]);
    });
    h.clock.advance(600_001); await maintenance.sweep();
    expect(h.objectTransport.entries()).toHaveLength(1); // An in-flight read may live until the120-second safe boundary.
    h.clock.advance(120_001); await maintenance.sweep();
    expect(h.objectTransport.entries()).toHaveLength(0);
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM export_artifacts')).rows[0]!.n).toBe(0);
    expect((await h.databases[0].query('SELECT count(*)::int AS n FROM workspace_versions')).rows[0]!.n).toBe(1);
  });
});
