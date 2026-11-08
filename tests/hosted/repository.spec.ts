import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresRepository } from '../../apps/api/src/hosted/postgres-repository.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('owner-qualified durable metadata repository', () => {
  let h: HostedHarness;
  beforeAll(async () => { h = await createHostedHarness(); });
  afterAll(async () => { await h?.close(); });

  it('reads identical committed metadata through two pools and never hydrates a public read', async () => {
    const seeded = await seedHostedWorkspace(h), hydrateSnapshot = vi.fn(async () => seeded.snapshot);
    const one = new PostgresRepository(h.databases[0], { now: h.clock.now, hydrateSnapshot });
    const two = new PostgresRepository(h.databases[1], { now: h.clock.now, hydrateSnapshot });
    expect(await one.workspace(seeded.owner)).toEqual(await two.workspace(seeded.owner));
    expect(await one.workspace(seeded.owner)).toMatchObject({ id: seeded.owner.workspaceId, currentVersionId: seeded.snapshot.versionId,
      validationBasisId: seeded.snapshot.validationBasisId, counts: { snapshots: 1, facts: 1 } });
    expect(await two.version(seeded.owner, seeded.snapshot.versionId)).toMatchObject({ versionId: seeded.snapshot.versionId, validationBasisId: seeded.snapshot.validationBasisId });
    expect(hydrateSnapshot).not.toHaveBeenCalled();
    expect(await one.loadSnapshot(seeded.owner, seeded.snapshot.versionId)).toEqual(seeded.snapshot);
    expect(hydrateSnapshot).toHaveBeenCalledExactlyOnceWith(seeded.owner, seeded.reference);
  });
  it('treats foreign and absent workspace/version/run IDs identically', async () => {
    const a = await seedHostedWorkspace(h), b = await seedHostedWorkspace(h), run = await a.validation();
    const repo = new PostgresRepository(h.databases[0], { now: h.clock.now });
    for (const operation of [() => repo.workspace({ ...b.owner, workspaceId: a.owner.workspaceId }),
      () => repo.workspace({ ...b.owner, workspaceId: randomUUID() }),
      () => repo.version(b.owner, a.snapshot.versionId), () => repo.version(b.owner, randomUUID()),
      () => repo.validation(b.owner, run.id), () => repo.validation(b.owner, randomUUID())]) {
      await expect(operation()).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND', statusCode: 404 });
    }
  });
  it('selects a complete validation of the current basis without returning unbounded result identities', async () => {
    const seeded = await seedHostedWorkspace(h), old = await seeded.validation(), newerIncomplete = await seeded.validation({ complete: false, offset: 1000 });
    const repo = new PostgresRepository(h.databases[1], { now: h.clock.now });
    const compatible = await repo.compatibleValidation(seeded.owner, seeded.snapshot.validationBasisId!);
    expect(compatible?.id).toBe(old.id); expect(compatible?.id).not.toBe(newerIncomplete.id);
    expect(compatible).not.toHaveProperty('resultIds'); expect(compatible).not.toHaveProperty('diagnostics');
    expect(await repo.compatibleValidation(seeded.owner, randomUUID())).toBeUndefined();
  });
  it('reauthorizes every query after another instance revokes or expires the session', async () => {
    const seeded = await seedHostedWorkspace(h), repo = new PostgresRepository(h.databases[0], { now: h.clock.now });
    await repo.workspace(seeded.owner);
    await h.databases[1].query("UPDATE demo_sessions SET state='revoked',revoked_at=$2 WHERE id=$1", [seeded.owner.sessionId, h.clock.date()]);
    await expect(repo.workspace(seeded.owner)).rejects.toMatchObject({ statusCode: 410 });
    const expired = await seedHostedWorkspace(h); h.clock.advance(3_600_001);
    await expect(repo.workspace(expired.owner)).rejects.toMatchObject({ statusCode: 410 });
  });
});
