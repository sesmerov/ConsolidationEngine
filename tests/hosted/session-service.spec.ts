import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { SessionService, assertLiveSession, touchMeaningful } from '../../apps/api/src/hosted/session-service.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';

describe('durable independent demo sessions', () => {
  let harness: HostedHarness, one: SessionService, two: SessionService;
  beforeEach(async () => {
    harness = await createHostedHarness();
    one = new SessionService(harness.databases[0], harness.config, new QuotaLedger(harness.databases[0], harness.config));
    two = new SessionService(harness.databases[1], harness.config, new QuotaLedger(harness.databases[1], harness.config));
  });
  afterEach(async () => { await harness.close(); });
  it('recovers an accepted creation from a second instance without renewing or double charging', async () => {
    const token = secret(), nonce = secret();
    const first = await one.create(token, nonce, harness.clock.date());
    harness.clock.advance(1000);
    const replay = await two.create(token, nonce, harness.clock.date());
    expect(first.statusCode).toBe(201); expect(replay.statusCode).toBe(200); expect(replay.session).toEqual(first.session);
    const row = (await harness.databases[0].query('SELECT token_hash,creation_nonce_hash FROM demo_sessions WHERE id=$1', [first.session.id])).rows[0]!;
    expect(Object.values(row)).not.toContain(token); expect(Object.values(row)).not.toContain(nonce);
    expect((await harness.databases[1].query("SELECT sum(units)::int AS used FROM usage_ledger WHERE resource='session-creations' AND category='consumed'")).rows[0]).toEqual({ used: 1 });
    await expect(two.create(token, secret(), harness.clock.date())).rejects.toMatchObject({ code: 'SESSION_CREATION_CONFLICT' });
    await expect(two.create(secret(), nonce, harness.clock.date())).rejects.toMatchObject({ code: 'SESSION_CREATION_CONFLICT' });
  });
  it('serializes concurrent matching and crossed pairs and enforces active-session capacity', async () => {
    const token = secret(), nonce = secret();
    const results = await Promise.all([one.create(token, nonce, harness.clock.date()), two.create(token, nonce, harness.clock.date())]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 201]);
    expect(results[0]!.session.id).toBe(results[1]!.session.id);
    for (let i = 0; i < 3; i++) await one.create(secret(), secret(), harness.clock.date());
    await expect(two.create(secret(), secret(), harness.clock.date())).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
    expect((await harness.databases[0].query('SELECT count(*)::int AS count FROM demo_sessions')).rows[0]).toEqual({ count: 4 });
  });
  it('GET and receipt polling never extend inactivity; expiration persists before returning 410', async () => {
    const token = secret(), nonce = secret(), created = await one.create(token, nonce, harness.clock.date());
    harness.clock.advance(59 * 60_000);
    const session = await two.authorize(token, harness.clock.date());
    expect(session.lastMeaningfulActivityAt.toISOString()).toBe(created.session.lastMeaningfulActivityAt);
    harness.clock.advance(60_000);
    await expect(two.authorize(token, harness.clock.date())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect((await harness.databases[0].query('SELECT state FROM demo_sessions WHERE id=$1', [created.session.id])).rows[0]).toEqual({ state: 'expired' });
    expect((await harness.databases[0].query('SELECT count(*)::int AS count FROM cleanup_tasks WHERE session_id=$1', [created.session.id])).rows[0]).toEqual({ count: 1 });
    await expect(one.create(token, nonce, harness.clock.date())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
  it('touches only accepted meaningful work, throttles updates, and caps absolute lifetime', async () => {
    const created = await one.create(secret(), secret(), harness.clock.date());
    harness.clock.advance(30 * 60_000);
    await harness.databases[0].transaction(async tx => {
      await assertLiveSession(tx, created.session.id, harness.clock.date(), { lock: true });
      await touchMeaningful(tx, created.session.id, harness.clock.date());
    });
    const touched = await harness.databases[1].transaction(tx => assertLiveSession(tx, created.session.id, harness.clock.date()));
    expect(touched.expiresAt.getTime()).toBe(harness.clock.now() + 60 * 60_000);
    harness.clock.advance(1000);
    const throttled = await harness.databases[1].transaction(tx => touchMeaningful(tx, created.session.id, harness.clock.date()));
    expect(throttled.lastMeaningfulActivityAt).toEqual(touched.lastMeaningfulActivityAt);
    harness.clock.advance(60 * 60_000);
    await expect(harness.databases[1].transaction(tx => touchMeaningful(tx, created.session.id, harness.clock.date()))).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
  it('revokes immediately, cancels queued work and preserves cleanup independently of the browser', async () => {
    const token = secret(), created = await one.create(token, secret(), harness.clock.date());
    const workspace = randomUUID(), job = randomUUID();
    await harness.databases[0].query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [created.session.id, workspace, 'Demo']);
    await harness.databases[0].query(`INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,accepted_at,queue_expires_at,status) VALUES($1,$2,$3,'validate','{}',$4,$5,'queued')`,
      [created.session.id, workspace, job, harness.clock.date(), new Date(harness.clock.now() + 600_000)]);
    await two.revoke(created.session.id, harness.clock.date());
    await expect(one.authorize(token, harness.clock.date())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    expect((await harness.databases[0].query('SELECT status FROM jobs WHERE id=$1', [job])).rows[0]).toEqual({ status: 'cancelled' });
    await one.revoke(created.session.id, harness.clock.date());
    expect((await harness.databases[0].query('SELECT count(*)::int AS count FROM cleanup_tasks WHERE session_id=$1', [created.session.id])).rows[0]).toEqual({ count: 1 });
  });
  it('never renews past twenty-four hours, even with continuous meaningful work', async () => {
    const token = secret(), created = await one.create(token, secret(), harness.clock.date());
    for (let halfHours = 0; halfHours < 47; halfHours++) {
      harness.clock.advance(30 * 60_000);
      await harness.databases[0].transaction(tx => touchMeaningful(tx, created.session.id, harness.clock.date()));
    }
    const session = await two.authorize(token, harness.clock.date());
    expect(session.expiresAt.toISOString()).toBe(created.session.absoluteExpiresAt);
    harness.clock.advance(30 * 60_000);
    await expect(one.authorize(token, harness.clock.date())).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});
function secret(): string { return randomBytes(32).toString('base64url'); }
