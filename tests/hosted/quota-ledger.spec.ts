import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { SessionService } from '../../apps/api/src/hosted/session-service.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';

describe('SQL quota reservations and provider accounting', () => {
  let harness: HostedHarness, one: QuotaLedger, two: QuotaLedger, owner: { sessionId: string; workspaceId: string };
  beforeEach(async () => {
    harness = await createHostedHarness();
    const config = { ...harness.config, limits: { ...harness.config.limits, maxJobsPerDay: 2, maxJobsPer30Days: 3 },
      quotas: { ...harness.config.quotas, blobBytes: 10 } };
    one = new QuotaLedger(harness.databases[0], config); two = new QuotaLedger(harness.databases[1], config);
    const sessions = new SessionService(harness.databases[0], config, one);
    const created = await sessions.create(randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'), harness.clock.date());
    owner = { sessionId: created.session.id, workspaceId: randomUUID() };
    await harness.databases[0].query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [owner.sessionId, owner.workspaceId, 'Quota']);
  });
  afterEach(async () => { await harness.close(); });
  it('adds unmaterialized SQL reservations to measured database bytes across independent pools', async () => {
    const measured = await one.measureSqlBytes(), MiB = 1024 * 1024;
    const eachReservation = MiB + Math.floor(Math.min(measured, MiB) / 4);
    const config = { ...harness.config, quotas: { ...harness.config.quotas, sqlBytes: measured + 2 * MiB } };
    const ledgers = harness.databases.map(db => new QuotaLedger(db, config));
    const results = await Promise.allSettled(harness.databases.map((db, index) => db.transaction(tx => ledgers[index]!.reserve(tx,
      { owner, operationId: randomUUID(), resource: 'sql-bytes', units: eachReservation, purpose: 'public', now: harness.clock.date() }))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const accepted = results.find(result => result.status === 'fulfilled');
    if (!accepted || accepted.status !== 'fulfilled') throw new Error('Missing SQL reservation');
    await harness.databases[0].transaction(tx => ledgers[0]!.markUncertain(tx, accepted.value.id));
    await expect(harness.databases[1].transaction(tx => ledgers[1]!.reserve(tx,
      { owner, operationId: randomUUID(), resource: 'sql-bytes', units: MiB, purpose: 'public', now: harness.clock.date() })))
      .rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
  });
  it('arbitrates competing reservations and retains uncertain bytes until verified reconciliation', async () => {
    const attempts = await Promise.allSettled([0, 1].map(index => harness.databases[index]!.transaction(tx => (index ? two : one).reserve(tx,
      { owner, operationId: randomUUID(), resource: 'blob-bytes', units: 7, purpose: 'public', now: harness.clock.date() }))));
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const accepted = attempts.find(result => result.status === 'fulfilled')!;
    if (accepted.status !== 'fulfilled') throw new Error('Missing reservation');
    await harness.databases[0].transaction(tx => one.markUncertain(tx, accepted.value.id));
    await expect(harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-bytes', units: 4,
      purpose: 'public', now: harness.clock.date() }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
    await harness.databases[0].transaction(tx => one.release(tx, { reservationId: accepted.value.id, confirmedAbsent: true, now: harness.clock.date() }));
    await harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-bytes', units: 10,
      purpose: 'public', now: harness.clock.date() }));
  });
  it('counts accepted jobs on UTC-day and rolling windows and never refunds consumed attempts', async () => {
    for (let i = 0; i < 2; i++) await harness.databases[0].transaction(async tx => {
      const reservation = await one.reserve(tx, { owner, operationId: randomUUID(), resource: 'jobs', units: 1, purpose: 'public', now: harness.clock.date() });
      await one.consume(tx, { reservationId: reservation.id, now: harness.clock.date() });
      await expect(one.release(tx, { reservationId: reservation.id, confirmedAbsent: true, now: harness.clock.date() })).rejects.toThrow(/consumed/i);
    });
    await expect(harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'jobs', units: 1,
      purpose: 'public', now: harness.clock.date() }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
    harness.clock.advance(24 * 60 * 60_000);
    await harness.databases[1].transaction(async tx => { const reservation = await two.reserve(tx, { owner, operationId: randomUUID(), resource: 'jobs', units: 1, purpose: 'public', now: harness.clock.date() }); await two.consume(tx, { reservationId: reservation.id, now: harness.clock.date() }); });
    await expect(harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'jobs', units: 1,
      purpose: 'public', now: harness.clock.date() }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
  });
  it('leaves maintenance capacity available after closing public admission', async () => {
    await harness.databases[0].transaction(async tx => {
      const reservation = await one.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-advanced-operations', units: 1400,
        purpose: 'public', now: harness.clock.date() }); await one.consume(tx, { reservationId: reservation.id, now: harness.clock.date() });
    });
    await expect(harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-advanced-operations', units: 1,
      purpose: 'public', now: harness.clock.date() }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
    await harness.databases[1].transaction(async tx => {
      const reservation = await two.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-advanced-operations', units: 200,
        purpose: 'maintenance', now: harness.clock.date() }); await two.consume(tx, { reservationId: reservation.id, now: harness.clock.date() });
    });
  });
  it('counts a job accepted exactly at UTC midnight and keeps state and file budgets separate', async () => {
    const midnight = new Date('2026-11-09T00:00:00.000Z');
    for (let index = 0; index < 2; index++) await harness.databases[0].transaction(async tx => {
      const reserved = await one.reserve(tx, { owner, operationId: randomUUID(), resource: 'jobs', units: 1, purpose: 'public', now: midnight });
      await one.consume(tx, { reservationId: reserved.id, now: midnight });
    });
    await expect(harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'jobs', units: 1,
      purpose: 'public', now: midnight }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
    for (const resource of ['session-state-bytes', 'session-file-bytes'] as const) {
      await harness.databases[0].transaction(tx => one.reserve(tx, { owner, operationId: randomUUID(), resource, units: 512 * 1024 * 1024, purpose: 'public', now: harness.clock.date() }));
      await expect(harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource, units: 1, purpose: 'public', now: harness.clock.date() }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
    }
  });
  it('accounts consumed bytes once, refuses premature release, and reconciles only confirmed deletion', async () => {
    const reservation = await harness.databases[0].transaction(tx => one.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-bytes', units: 10, purpose: 'public', now: harness.clock.date() }));
    await harness.databases[0].transaction(tx => one.consume(tx, { reservationId: reservation.id, units: 7, now: harness.clock.date() }));
    await harness.databases[1].transaction(tx => two.consume(tx, { reservationId: reservation.id, units: 7, now: harness.clock.date() }));
    await harness.databases[1].transaction(tx => two.markUncertain(tx, reservation.id));
    await harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-bytes', units: 3, purpose: 'public', now: harness.clock.date() }));
    await expect(harness.databases[0].transaction(tx => one.release(tx, { reservationId: reservation.id, confirmedAbsent: false as true, now: harness.clock.date() }))).rejects.toThrow(/confirmed/);
    await harness.databases[0].transaction(tx => one.release(tx, { reservationId: reservation.id, confirmedAbsent: true, now: harness.clock.date() }));
    await harness.databases[1].transaction(tx => two.release(tx, { reservationId: reservation.id, confirmedAbsent: true, now: harness.clock.date() }));
    await harness.databases[1].transaction(tx => two.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-bytes', units: 7, purpose: 'public', now: harness.clock.date() }));
  });
  it('splits byte reservations atomically without admitting extra capacity or changing owner/operation', async () => {
    const operationId = randomUUID(), parent = await harness.databases[0].transaction(tx => one.reserve(tx, { owner, operationId, resource: 'blob-bytes', units: 10, purpose: 'public', now: harness.clock.date() }));
    const outcomes = await Promise.allSettled(harness.databases.map((db, index) => db.transaction(tx => (index ? two : one).split(tx, { reservationId: parent.id, units: 6, now: harness.clock.date() }))));
    expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1); expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
    const remaining = await harness.databases[1].transaction(tx => two.split(tx, { reservationId: parent.id, units: 4, now: harness.clock.date() }));
    expect(remaining.units).toBe(4); const rows = (await harness.databases[0].query('SELECT session_id,workspace_id,operation_id,units,state FROM quota_reservations WHERE operation_id=$1 ORDER BY units', [operationId])).rows;
    expect(rows.map(row => Number(row.units))).toEqual([0,4,6]); expect(rows.every(row => row.session_id === owner.sessionId && row.workspace_id === owner.workspaceId && row.operation_id === operationId)).toBe(true);
    await expect(harness.databases[0].transaction(tx => one.reserve(tx, { owner, operationId: randomUUID(), resource: 'blob-bytes', units: 1, purpose: 'public', now: harness.clock.date() }))).rejects.toMatchObject({ code: 'PUBLIC_CAPACITY_EXCEEDED' });
  });
  it('never splits consumed, uncertain or provider-operation reservations', async () => {
    for (const [resource, state] of [['blob-bytes','consumed'],['blob-bytes','uncertain'],['blob-simple-operations','reserved']] as const) {
      const parent = await harness.databases[0].transaction(tx => one.reserve(tx, { owner, operationId: randomUUID(), resource, units: 2, purpose: 'public', now: harness.clock.date() }));
      if (state === 'consumed') await harness.databases[0].transaction(tx => one.consume(tx, { reservationId: parent.id, now: harness.clock.date() }));
      if (state === 'uncertain') await harness.databases[0].transaction(tx => one.markUncertain(tx, parent.id));
      await expect(harness.databases[1].transaction(tx => two.split(tx, { reservationId: parent.id, units: 1, now: harness.clock.date() }))).rejects.toThrow(/Only unused byte reservations/);
    }
  });
});
