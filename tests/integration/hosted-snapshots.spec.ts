import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedSnapshotCodec } from '../../apps/api/src/hosted/snapshot-codec.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { HostedProjectionWriter } from '../../apps/api/src/hosted/projection-store.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('worker snapshot manifests preserve complete immutable inputs', () => {
  let h: HostedHarness;
  beforeEach(async () => { h = await createHostedHarness(); });
  afterEach(async () => { await h?.close(); });
  it('round-trips exact canonical content and shares immutable branches across configuration versions', async () => {
    const s = await seedHostedWorkspace(h), job = await s.queuedJob(), coordinator = new HostedJobCoordinator(h.databases[0], { config: h.config, instanceId: 'codec', now: h.clock.now });
    const result = await coordinator.claim(job); if (result.state !== 'claimed') throw new Error('Expected claim');
    const quotas = new QuotaLedger(h.databases[0], h.config), objects = new ObjectLedger(h.databases[0], h.objectTransport, quotas, () => h.clock.date());
    const writer = new HostedProjectionWriter(h.databases[0], quotas, objects, { now: h.clock.now });
    const codec = new HostedSnapshotCodec(h.databases[0], objects, writer);
    const first = { ...s.snapshot, versionId: randomUUID(), parentVersionId: s.snapshot.versionId };
    const saved = await codec.writeSnapshot(result.claim, first, 'configuration');
    expect(await codec.hydrateSnapshot(s.owner, saved.version.contentRef)).toEqual(first);
    const content = { ...first.content, configVersion: 'f'.repeat(64), directionDecisionState: { schemaVersion: 1 as const, mode: 'reviewed' as const,
      source: 'replace' as const, originDefault: 'explicit' as const, originExceptions: [], unselectedDefault: 'omitted' as const, unselectedExceptions: [] } };
    const second = { ...first, versionId: randomUUID(), content, contentHash: canonicalHash(content) };
    const again = await codec.writeSnapshot(result.claim, second, 'configuration');
    expect(await codec.hydrateSnapshot(s.owner, again.version.contentRef)).toEqual(second);
    expect(again.basis).toBeUndefined(); expect(saved.version.basisId).toBe(s.snapshot.validationBasisId);
    expect(again.version.summary).toMatchObject({ contextCount: second.content.contexts.length, directionCount: second.content.directions.length });
    expect(again.componentRefs.catalog).toEqual(saved.componentRefs.catalog); expect(again.componentRefs.data).toEqual(saved.componentRefs.data);
    expect(again.componentRefs.contexts).toEqual(saved.componentRefs.contexts); expect(again.componentRefs.configuration).not.toEqual(saved.componentRefs.configuration);
  });
});
