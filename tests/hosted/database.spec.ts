import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HostedDatabase, validatedSchemaName } from '../../apps/api/src/hosted/database.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';

describe('PostgreSQL 17 authority foundation (real SQL)', () => {
  let harness: HostedHarness;
  beforeAll(async () => { harness = await createHostedHarness(); });
  afterAll(async () => { await harness?.close(); });

  it('migrates idempotently across independent pools and uses PostgreSQL 17', async () => {
    const [one, two] = harness.databases;
    await Promise.all([one.migrate(), two.migrate()]);
    expect(Number((await one.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0]!.server_version_num)).toBeGreaterThanOrEqual(170000);
    expect((await one.query('SELECT version FROM schema_migrations')).rows).toEqual([{ version: 1 }]);
    expect((await two.query('SELECT count(*)::int AS count FROM demo_sessions')).rows[0]).toEqual({ count: 0 });
    expect(one.poolMaximum).toBe(2);
    expect(two.poolMaximum).toBe(2);
  });
  it('rolls back on failure, releases the connection, and exposes committed data to the other pool', async () => {
    const id = randomUUID();
    await expect(harness.databases[0].transaction(async tx => {
      await insertSession(tx, id);
      throw new Error('deliberate transaction failure');
    })).rejects.toThrow('deliberate transaction failure');
    expect((await harness.databases[1].query('SELECT id FROM demo_sessions WHERE id=$1', [id])).rows).toEqual([]);
    await harness.databases[0].transaction(tx => insertSession(tx, id));
    expect((await harness.databases[1].query('SELECT id FROM demo_sessions WHERE id=$1', [id])).rows).toEqual([{ id }]);
  });
  it('enforces unique secret hashes, active-workspace uniqueness and cross-owner foreign keys', async () => {
    const [one] = harness.databases;
    const sessionA = randomUUID(), sessionB = randomUUID(), workspace = randomUUID(), basis = randomUUID();
    await one.transaction(async tx => { await insertSession(tx, sessionA); await insertSession(tx, sessionB); });
    await expect(one.query('UPDATE demo_sessions SET token_hash=(SELECT token_hash FROM demo_sessions WHERE id=$1) WHERE id=$2', [sessionA, sessionB])).rejects.toMatchObject({ code: '23505' });
    await expect(one.query('UPDATE demo_sessions SET creation_nonce_hash=(SELECT creation_nonce_hash FROM demo_sessions WHERE id=$1) WHERE id=$2', [sessionA, sessionB])).rejects.toMatchObject({ code: '23505' });
    await one.query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [sessionA, workspace, 'Demo']);
    await expect(one.query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [sessionA, randomUUID(), 'Other'])).rejects.toMatchObject({ code: '23505' });
    await expect(one.query('INSERT INTO validation_bases(session_id,workspace_id,id,catalog_ref,data_ref,contexts_ref,profile_ids,hashes) VALUES($1,$2,$3,$4,$4,$4,$5,$6)',
      [sessionB, workspace, basis, {}, '[]', {}])).rejects.toMatchObject({ code: '23503' });
  });
  it('makes CAS and the twenty-snapshot cap authoritative across both instances', async () => {
    const [one, two] = harness.databases;
    const session = randomUUID(), workspace = randomUUID(), basis = randomUUID();
    await one.transaction(async tx => {
      await insertSession(tx, session);
      await tx.query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [session, workspace, 'CAS']);
      await tx.query('INSERT INTO validation_bases(session_id,workspace_id,id,catalog_ref,data_ref,contexts_ref,profile_ids,hashes) VALUES($1,$2,$3,$4,$4,$4,$5,$6)', [session, workspace, basis, {}, '[]', {}]);
    });
    const outcomes = await Promise.all([one, two].map(db => db.query('UPDATE workspaces SET revision=revision+1 WHERE session_id=$1 AND id=$2 AND revision=1 RETURNING revision', [session, workspace])));
    expect(outcomes.map(result => result.rowCount).sort()).toEqual([0, 1]);
    for (let index = 0; index < 19; index++) await insertVersion(one, session, workspace, basis);
    const last = await Promise.allSettled([one, two].map(db => insertVersion(db, session, workspace, basis)));
    expect(last.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(last.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await one.query('SELECT count(*)::int AS count FROM workspace_versions WHERE session_id=$1 AND workspace_id=$2', [session, workspace])).rows[0]).toEqual({ count: 20 });
    await expect(one.query("UPDATE workspace_versions SET reason='arbitrary' WHERE session_id=$1", [session])).rejects.toMatchObject({ code: '23514' });
  });
  it('creates every modeled entity and bounded, separately indexed projection rows', async () => {
    const tables = (await harness.databases[0].query<{ tablename: string }>('SELECT tablename FROM pg_tables WHERE schemaname=$1', [harness.schema])).rows.map(row => row.tablename);
    expect(tables).toEqual(expect.arrayContaining(['demo_sessions','workspaces','validation_bases','workspace_versions',
      'validation_runs','direction_reviews','recalculation_operations','previews','proposal_selections','jobs','operation_receipts',
      'outbox_entries','cpu_permits','leases','quota_reservations','usage_ledger','cleanup_tasks','upload_batches','stored_files',
      'object_parts','object_manifests','canonical_blocks','snapshot_manifests','export_artifacts','projection_rows']));
  });
  it('validates schema names before issuing SQL and rejects unsafe TLS settings', () => {
    expect(() => validatedSchemaName('public; DROP SCHEMA public')).toThrow(/schema/i);
    expect(() => validatedSchemaName('public')).toThrow(/schema/i);
    expect(() => new HostedDatabase({ databaseUrl: 'postgres://a:b@example.org/db', schema: harness.schema, tls: 'loopback-test' })).toThrow(/loopback/i);
  });
  it('supports separate one-connection API and worker pools without increasing the per-instance maximum', async () => {
    const db = new HostedDatabase({ databaseUrl: harness.config.databaseUrl, schema: harness.schema, tls: harness.config.databaseTls, poolMaximum: 1 });
    try { expect(db.poolMaximum).toBe(1); expect((await db.query('SELECT 1 AS ready')).rows).toEqual([{ ready: 1 }]); }
    finally { await db.close(); }
  });
});

type Queryable = Pick<HostedDatabase, 'query'>;
async function insertSession(db: Queryable, id: string): Promise<void> {
  const hash = id.replaceAll('-', '').padEnd(64, 'a');
  await db.query(`INSERT INTO demo_sessions(id,token_hash,creation_nonce_hash,created_at,last_meaningful_activity_at,expires_at,absolute_expires_at)
    VALUES($1,$2,$2,now(),now(),now()+interval '1 hour',now()+interval '24 hours')`, [id, hash]);
}
async function insertVersion(db: Queryable, session: string, workspace: string, basis: string): Promise<void> {
  await db.query(`INSERT INTO workspace_versions(session_id,workspace_id,id,basis_id,directions_ref,content_manifest_ref,reason,content_hash)
    VALUES($1,$2,$3,$4,$5,$5,'import',$6)`, [session, workspace, randomUUID(), basis, {}, 'a'.repeat(64)]);
}
