import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue, LargeValueDescriptorDTO } from '@ce/contracts';
import { HostedProjectionWriter } from '../../apps/api/src/hosted/projection-store.js';
import { HostedQueryRepository } from '../../apps/api/src/hosted/query-repository.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { CanonicalCodec } from '../../apps/api/src/hosted/canonical-codec.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('bounded indexed pages and complete large values on real SQL', () => {
  let h: HostedHarness;
  beforeEach(async () => { h = await createHostedHarness(); });
  afterEach(async () => { await h?.close(); });
  async function scenario(values: readonly JsonValue[]) {
    const fixture = await seedHostedWorkspace(h), run = await fixture.validation(), job = await fixture.queuedJob();
    const coordinator = new HostedJobCoordinator(h.databases[0], { config: h.config, instanceId: 'indexer', now: h.clock.now });
    const claimed = await coordinator.claim(job); if (claimed.state !== 'claimed') throw new Error('Missing claim');
    const quotas = new QuotaLedger(h.databases[0], h.config), objects = new ObjectLedger(h.databases[0], h.objectTransport, quotas, () => h.clock.date());
    const codec = new CanonicalCodec(objects), writer = new HostedProjectionWriter(h.databases[0], quotas, objects, { now: h.clock.now });
    const resource = { type: 'run' as const, id: run.id, view: 'rows' };
    const staged = await writer.stage(claimed.claim, { resource, kind: 'results', basisId: fixture.snapshot.validationBasisId!, revision: 1,
      rows: values.map((value, n) => ({ key: String(n), sortKey: String(n).padStart(8, '0'), code: n % 2 ? 'OTHER' : 'MATCH', status: n % 3 ? 'fail' : 'pass', value })) });
    // Explicit fixture publication of this index pointer. Atomic writer publication itself has its own SQL suite.
    await h.databases[0].query('UPDATE validation_runs SET result_index_ref=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3',
      [fixture.owner.sessionId, fixture.owner.workspaceId, run.id, { views: { rows: staged.ref } }]);
    const query = new HostedQueryRepository(h.databases[1], codec, { signingKey: h.config.cursorSigningKey, now: h.clock.now });
    return { ...fixture, resource, staged, query };
  }
  it('reads a second page across instances with an owner/resource/filter/revision-bound cursor', async () => {
    const s = await scenario(Array.from({ length: 111 }, (_, id) => ({ id, label: `Fila ${id}` })));
    const first = await s.query.page(s.owner, s.resource, { limit: 50, filter: { code: 'MATCH' } });
    expect(first.items).toHaveLength(50); expect(first.total).toBe(56); expect(first.nextCursor).not.toBeNull();
    const second = await s.query.page(s.owner, s.resource, { limit: 50, filter: { code: 'MATCH' }, cursor: first.nextCursor! });
    expect(second.items).toHaveLength(6); expect(second.items[0]).toMatchObject({ id: 100 }); expect(second.nextCursor).toBeNull();
    await expect(s.query.page(s.owner, s.resource, { cursor: first.nextCursor!, filter: { code: 'OTHER' } })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(s.query.page(s.owner, s.resource, { cursor: first.nextCursor!.slice(0, -1) + '!' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(s.query.page(s.owner, s.resource, { limit: 51 })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('limits actual UTF-8 JSON bytes, preserving every row through a continuation cursor', async () => {
    const s = await scenario(Array.from({ length: 51 }, (_, id) => ({ id, text: 'á'.repeat(40000) })));
    const seen: number[] = []; let cursor: string | undefined;
    do {
      const page = await s.query.page(s.owner, s.resource, { limit: 50, ...(cursor ? { cursor } : {}) });
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(1024 * 1024);
      expect(page.items.length).toBeLessThanOrEqual(50); expect(page.items.length).toBeGreaterThan(0);
      seen.push(...page.items.map(item => (item as { id: number }).id)); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(Array.from({ length: 51 }, (_, id) => id));
  });
  it('returns an opaque descriptor and reconstructs a complete oversized value with authorized verified parts', async () => {
    const text = 'Ω'.repeat(550000), s = await scenario([{ id: 1, text }]);
    const page = await s.query.page(s.owner, s.resource, {}), descriptor = page.items[0] as unknown as LargeValueDescriptorDTO;
    expect(descriptor).toMatchObject({ mediaType: 'application/json' }); expect(descriptor.byteLength).toBeGreaterThan(1024 * 1024);
    const parts: Buffer[] = [];
    for (let index = 0; index < Math.ceil(descriptor.byteLength / (128 * 1024)); index++) parts.push(Buffer.from((await s.query.valuePart(s.owner, descriptor.valueRef, index)).bytes));
    expect(JSON.parse(Buffer.concat(parts).toString('utf8'))).toEqual({ id: 1, text });
    const foreign = await seedHostedWorkspace(h);
    await expect(s.query.valuePart(foreign.owner, descriptor.valueRef, 0)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await h.databases[0].query('UPDATE validation_runs SET result_index_ref=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3',
      [s.owner.sessionId, s.owner.workspaceId, s.resource.id, { views: { rows: { ...s.staged.ref, indexId: randomUUID() } } }]);
    await expect(s.query.valuePart(s.owner, descriptor.valueRef, 0)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('never treats a staged incomplete index or foreign resource as readable authority', async () => {
    const s = await scenario([{ id: 1 }]), foreign = await seedHostedWorkspace(h);
    await expect(s.query.page(foreign.owner, s.resource, {})).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await h.databases[0].query('UPDATE projection_sets SET complete=false WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3', [s.owner.sessionId, s.owner.workspaceId, s.staged.ref.indexId]);
    await expect(s.query.page(s.owner, s.resource, {})).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
  });
  it('keeps retained incomplete results and discarded historical previews readable without making them calculation authority', async () => {
    const s = await scenario([{ id: 1, status: 'not_evaluable' }]), db = h.databases[0];
    await db.query("UPDATE validation_runs SET status='failed',summary=jsonb_set(summary,'{complete}','false') WHERE session_id=$1 AND workspace_id=$2 AND id=$3",
      [s.owner.sessionId, s.owner.workspaceId, s.resource.id]);
    expect((await s.query.page(s.owner, s.resource, {})).items).toEqual([{ id: 1, status: 'not_evaluable' }]);
    const previewId = randomUUID(), historical = { type: 'preview' as const, id: previewId, view: 'rows' };
    await db.query(`INSERT INTO previews(session_id,workspace_id,id,version_id,basis_id,source_run_id,manifest_refs,content_hash,state,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'discarded',$9)`, [s.owner.sessionId, s.owner.workspaceId, previewId, s.snapshot.versionId,
      s.snapshot.validationBasisId, s.resource.id, { views: { rows: s.staged.ref } }, 'a'.repeat(64), new Date(h.clock.now() + 600000)]);
    await db.query('UPDATE projection_sets SET owner_ref=$4 WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3', [s.owner.sessionId, s.owner.workspaceId, s.staged.ref.indexId, historical]);
    expect((await s.query.page(s.owner, historical, {})).items).toEqual([{ id: 1, status: 'not_evaluable' }]);
  });
});
