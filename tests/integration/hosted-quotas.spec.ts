import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedMaintenance } from '../../apps/api/src/hosted/maintenance.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('maintenance quota reserve', () => {
  let h: HostedHarness;
  beforeEach(async () => { h = await createHostedHarness(); });
  afterEach(async () => { await h.close(); });
  it('cleans recorded objects after public simple-operation admission is exhausted', async () => {
    const seeded = await seedHostedWorkspace(h), quotas = new QuotaLedger(h.databases[0], h.config);
    const objects = new ObjectLedger(h.databases[0], h.objectTransport, quotas, () => h.clock.date());
    h.objectTransport.failNext('put', 'after');
    await expect(objects.putObject(seeded.owner, Buffer.from('maintenance-reserved'), { operationId: randomUUID(), deadline: new Date(h.clock.now() + 60_000).toISOString() }, 'files')).rejects.toThrow();
    const budget = h.config.quotas.blobSimpleOperations - h.config.quotas.blobMaintenanceSimpleOperations;
    await h.databases[0].transaction(async tx => {
      const reservation = await quotas.reserve(tx, { owner: seeded.owner, operationId: randomUUID(), resource: 'blob-simple-operations', units: budget, purpose: 'public', now: h.clock.date() });
      await quotas.consume(tx, { reservationId: reservation.id, now: h.clock.date() });
    });
    await expect(h.databases[0].transaction(tx => quotas.reserve(tx, { owner: seeded.owner, operationId: randomUUID(), resource: 'blob-simple-operations', units: 1, purpose: 'public', now: h.clock.date() }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
    h.clock.advance(120_001);
    await new HostedMaintenance(h.databases[0], h.config, { quotas, transport: h.objectTransport, now: h.clock.now }).sweep();
    expect(h.objectTransport.entries()).toHaveLength(0);
    expect((await h.databases[0].query("SELECT sum(units)::int AS units FROM usage_ledger WHERE resource='blob-simple-operations' AND category='maintenance'")).rows[0]!.units).toBeNull();
    expect((await h.databases[0].query("SELECT sum(units)::int AS units FROM usage_ledger WHERE resource='blob-advanced-operations' AND category='maintenance'")).rows[0]!.units).toBe(1);
    expect((await h.databases[0].query("SELECT sum(units)::int AS units FROM usage_ledger WHERE resource='blob-simple-operations' AND category='consumed'")).rows[0]!.units).toBe(budget);
  });

  it('removes1400 recorded objects within14 hourly sweeps using14 maintenance calls and no GET after definitive ACK', async () => {
    const seeded = await seedHostedWorkspace(h), quotas = new QuotaLedger(h.databases[0], h.config);
    const bytes = Buffer.from('x'), hash = createHash('sha256').update(bytes).digest('hex'), operationId = randomUUID();
    const rows = Array.from({ length: 1400 }, () => {
      const id = randomUUID(); return { id, fileReservation: randomUUID(), blobReservation: randomUUID(), key: `ce/v1/${seeded.owner.sessionId}/${seeded.owner.workspaceId}/${id}` };
    });
    // Real SQL fixture for already admitted objects. Provider bytes are controlled; cleanup and quota transitions are real.
    await h.databases[0].transaction(async tx => {
      for (const [resource, units] of [
        ['blob-advanced-operations', h.config.quotas.blobAdvancedOperations - h.config.quotas.blobMaintenanceAdvancedOperations],
        ['blob-simple-operations', h.config.quotas.blobSimpleOperations - h.config.quotas.blobMaintenanceSimpleOperations],
      ] as const) {
        const quota = await quotas.reserve(tx, { owner: seeded.owner, operationId, resource, units, purpose: 'public', now: h.clock.date() });
        await quotas.consume(tx, { reservationId: quota.id, now: h.clock.date() });
      }
      const allocations = rows.flatMap(row => [{ id: row.fileReservation, resource: 'session-file-bytes' }, { id: row.blobReservation, resource: 'blob-bytes' }]);
      await tx.query(`INSERT INTO quota_reservations(id,session_id,workspace_id,scope,resource,units,operation_id,expires_at,state,created_at)
        SELECT a.id,$1,$2,'workspace',a.resource,1,$3,$4,'reserved',$5 FROM jsonb_to_recordset($6::jsonb) a(id uuid,resource text)`,
      [seeded.owner.sessionId, seeded.owner.workspaceId, operationId, new Date(h.clock.now() + 600_000), h.clock.date(), JSON.stringify(allocations)]);
      await tx.query(`INSERT INTO physical_objects(session_id,workspace_id,id,private_object_key,byte_length,sha256,status,reservation_id,created_at,updated_at)
        SELECT $1,$2,a.id,a.key,1,$3,'cleanup_pending',a."fileReservation",$4,$4 FROM jsonb_to_recordset($5::jsonb) a(id uuid,key text,"fileReservation" uuid)`,
      [seeded.owner.sessionId, seeded.owner.workspaceId, hash, new Date(h.clock.now() - 120_001), JSON.stringify(rows)]);
      await tx.query(`INSERT INTO physical_object_reservations(session_id,workspace_id,object_id,reservation_id)
        SELECT $1,$2,a.id,unnest(ARRAY[a."fileReservation",a."blobReservation"]) FROM jsonb_to_recordset($3::jsonb) a(id uuid,"fileReservation" uuid,"blobReservation" uuid)`,
      [seeded.owner.sessionId, seeded.owner.workspaceId, JSON.stringify(rows)]);
    });
    await Promise.all(rows.map(row => h.objectTransport.put(row.key, bytes)));
    const maintenance = new HostedMaintenance(h.databases[0], h.config, { quotas, transport: h.objectTransport, now: h.clock.now });
    const start = h.clock.now();
    for (let sweep = 0; sweep < 14; sweep++) { const result = await maintenance.sweep(); expect(result.removedObjects).toBe(100); if (sweep < 13) h.clock.advance(3_600_000); }
    expect(h.clock.now() - start).toBeLessThan(86_400_000); expect(h.objectTransport.entries()).toHaveLength(0);
    expect(h.objectTransport.calls.filter(call => call.operation === 'removeMany')).toHaveLength(14);
    expect(h.objectTransport.calls.filter(call => call.operation === 'get')).toHaveLength(0);
    const usage = (await h.databases[0].query("SELECT resource,sum(units)::int AS units FROM usage_ledger WHERE category='maintenance' GROUP BY resource")).rows;
    expect(usage).toEqual([{ resource: 'blob-advanced-operations', units: 14 }]);
    expect((await h.databases[0].query("SELECT count(*)::int AS n FROM physical_objects WHERE status='deleted'")).rows[0]!.n).toBe(1400);
  }, 120_000);

  it('keeps byte accounting balanced when consumption is older than30 days but release is recent', async () => {
    const seeded = await seedHostedWorkspace(h), quotas = new QuotaLedger(h.databases[0], h.config);
    const old = new Date(h.clock.now() - 31 * 86_400_000);
    await h.databases[0].transaction(async tx => {
      const held = await quotas.reserve(tx, { owner: seeded.owner, operationId: randomUUID(), resource: 'blob-bytes', units: 100, purpose: 'public', now: old });
      await quotas.consume(tx, { reservationId: held.id, now: old });
      await quotas.release(tx, { reservationId: held.id, confirmedAbsent: true, now: h.clock.date() });
    });
    await new HostedMaintenance(h.databases[0], h.config, { quotas, transport: h.objectTransport, now: h.clock.now }).sweep();
    await expect(h.databases[0].transaction(tx => quotas.reserve(tx, { owner: seeded.owner, operationId: randomUUID(), resource: 'blob-bytes', units: 1, purpose: 'public', now: h.clock.date() }))).resolves.toMatchObject({ state: 'reserved' });
    expect((await h.databases[0].query("SELECT sum(CASE WHEN category='released' THEN -units ELSE units END)::int AS n FROM usage_ledger WHERE resource='blob-bytes'")).rows[0]!.n).toBe(0);
  });
});
