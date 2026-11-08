import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@ce/contracts';
import { HostedPublication, type PublicationEnvelope } from '../../apps/api/src/hosted/publication.js';
import { HostedJobCoordinator, type HostedJobClaim } from '../../apps/api/src/hosted/job-coordinator.js';
import { HostedJobAcceptance } from '../../apps/api/src/hosted/job-acceptance.js';
import { HostedOutbox } from '../../apps/api/src/hosted/outbox.js';
import { PostgresRepository } from '../../apps/api/src/hosted/postgres-repository.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { CanonicalCodec } from '../../apps/api/src/hosted/canonical-codec.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('single fenced publication with real SQL and controlled private object transport', () => {
  let h: HostedHarness;
  beforeEach(async () => { h = await createHostedHarness(); });
  afterEach(async () => { await h?.close(); });
  async function scenario(changed = true) {
    const fixture = await seedHostedWorkspace(h), priorRun = await fixture.validation(), db = h.databases[0];
    const quotas = new QuotaLedger(db, h.config), objects = new ObjectLedger(db, h.objectTransport, quotas, () => h.clock.date());
    const publication = new HostedPublication(db, quotas, objects, { now: h.clock.now });
    const coordinator = new HostedJobCoordinator(db, { config: h.config, instanceId: 'publisher', now: h.clock.now });
    const acceptance = new HostedJobAcceptance(db, quotas, new HostedOutbox(db, quotas, h.queue, { config: h.config, now: h.clock.now }), { config: h.config, now: h.clock.now });
    const versionId = changed ? randomUUID() : fixture.snapshot.versionId, previewId = randomUUID(), selectionId = randomUUID(), reviewId = randomUUID();
    const baseVersionId = fixture.snapshot.versionId, basisId = fixture.snapshot.validationBasisId!;
    await db.query(`INSERT INTO direction_reviews(session_id,workspace_id,id,basis_id,source_run_id,base_version_id,state,config_changed,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,'ready',$7,$8)`, [fixture.owner.sessionId, fixture.owner.workspaceId, reviewId, basisId, priorRun.id, baseVersionId, changed, new Date(h.clock.now() + 900000)]);
    const workspace = await new PostgresRepository(db, { now: h.clock.now }).workspace(fixture.owner), key = randomUUID();
    const receipt = await acceptance.accept({ ...fixture.owner, key, method: 'POST', path: '/api/v1/recalculation-operations', body: { reviewId }, expectedBase: workspace.etag,
      baseVersionId, kind: 'recalculation-operation', meaningful: true,
      inputRefs: { publication: { versionId, previewId, selectionId, reviewId, resultId: previewId } },
      reservation: { kind: 'recalculation', inputVersionId: baseVersionId, effectiveVersionId: versionId, reservedPreviewId: previewId } }, async (tx, accepted) => {
      await tx.query(`UPDATE direction_reviews SET state='committing',pending_job_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3`, [fixture.owner.sessionId, fixture.owner.workspaceId, reviewId, accepted.jobId]);
      await tx.query(`INSERT INTO recalculation_operations(session_id,workspace_id,id,request_fingerprint,input_version_id,basis_id,run_id,review_id,review_revision,
        reserved_effective_version_id,config_changed,reserved_preview_id,reserved_selection_id,job_id,phase) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$3,'queued')`,
      [fixture.owner.sessionId, fixture.owner.workspaceId, accepted.jobId, 'a'.repeat(64), baseVersionId, basisId, priorRun.id, reviewId, versionId, changed, previewId, selectionId]);
    });
    const outcome = await coordinator.claim({ ...fixture.owner, jobId: receipt.jobId }); if (outcome.state !== 'claimed') throw new Error('Expected claim');
    const claim: HostedJobClaim = outcome.claim;
    // This is a publication-authority fixture, not an execution/conformance fixture; private canonical bytes are real and verified.
    const ref = await new CanonicalCodec(objects).put(fixture.owner, { syntheticPublication: true, amount: '12.00', unit: 'EUR' },
      { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt });
    const asJson = ref as unknown as JsonObject;
    const envelope: PublicationEnvelope = { kind: claim.kind, resultRef: { type: 'preview', id: previewId }, canonicalRoots: [ref], indexes: [],
      ...(changed ? { version: { id: versionId, basisId, parentId: baseVersionId, reason: 'configuration' as const, contentRef: ref, directionsRef: asJson,
        contentHash: ref.sha256, configVersion: 'b'.repeat(64), profileId: fixture.snapshot.content.profileId, catalogVersion: 'c', reportVersion: 'r', summary: {}, sourceFileIds: [] } } : {}),
      preview: { id: previewId, versionId, basisId, sourceRunId: priorRun.id, manifestRefs: asJson, counters: {}, contentHash: ref.sha256, expiresAt: new Date(h.clock.now() + 900000).toISOString() },
      selection: { id: selectionId, previewId, versionId, basisId, maskRef: asJson, counters: {}, selectionHash: 'c'.repeat(64) },
      review: { id: reviewId, expectedRevision: 1, state: 'committed', receipt: { previewId, versionId } } };
    return { ...fixture, publication, coordinator, acceptance, key, claim, envelope, ref, previewId, selectionId, versionId };
  }
  it.each([true, false])('publishes preview and initial selection together, preserving basis and version reuse (configuration changed=%s)', async changed => {
    const s = await scenario(changed), before = await s.acceptance.receiptByKey(s.owner.sessionId, s.key);
    expect(before.resultRef).toBeUndefined();
    expect(await s.publication.publish(s.claim, s.envelope)).toMatchObject({ status: 'succeeded', resultRef: { type: 'preview', id: s.previewId } });
    const db = h.databases[1], current = await new PostgresRepository(db, { now: h.clock.now }).workspace(s.owner);
    expect(current.currentVersionId).toBe(s.versionId); expect(current.validationBasisId).toBe(s.snapshot.validationBasisId);
    expect((await db.query('SELECT count(*)::int AS count FROM workspace_versions')).rows[0].count).toBe(changed ? 2 : 1);
    expect((await db.query('SELECT count(*)::int AS count FROM previews')).rows[0].count).toBe(1);
    expect((await db.query('SELECT count(*)::int AS count FROM proposal_selections')).rows[0].count).toBe(1);
    expect(await s.acceptance.receiptByKey(s.owner.sessionId, s.key)).toMatchObject({ phase: 'succeeded', resultRef: { id: s.previewId } });
    expect((await db.query('SELECT ref_count FROM canonical_blocks WHERE id=$1', [s.ref.resourceId])).rows[0].ref_count).toBe(1);
  });
  it('rolls back version, preview, retained objects and receipt when selection publication fails', async () => {
    const s = await scenario();
    await expect(s.publication.publish(s.claim, { ...s.envelope, selection: { ...s.envelope.selection!, selectionHash: 'invalid' } })).rejects.toThrow();
    const db = h.databases[1];
    expect((await db.query('SELECT count(*)::int AS count FROM workspace_versions')).rows[0].count).toBe(1);
    expect((await db.query('SELECT count(*)::int AS count FROM previews')).rows[0].count).toBe(0);
    expect((await db.query('SELECT ref_count FROM canonical_blocks WHERE id=$1', [s.ref.resourceId])).rows[0].ref_count).toBe(0);
    expect(await s.acceptance.receiptByKey(s.owner.sessionId, s.key)).toMatchObject({ phase: 'running' });
    await s.coordinator.fail(s.claim, [{ code: 'INTERNAL_ERROR', message: 'Synthetic publication fault.' }]);
    expect((await db.query('SELECT state FROM direction_reviews')).rows[0].state).toBe('ready');
  });
  it.each(['cancel', 'deadline', 'revision', 'revocation'] as const)('does not publish provisional output after %s', async trigger => {
    const s = await scenario(), db = h.databases[1];
    if (trigger === 'cancel') await s.coordinator.cancel(s.claim);
    if (trigger === 'deadline') h.clock.advance(60001);
    if (trigger === 'revision') await db.query('UPDATE workspaces SET revision=revision+1 WHERE session_id=$1 AND id=$2', [s.owner.sessionId, s.owner.workspaceId]);
    if (trigger === 'revocation') await db.query("UPDATE demo_sessions SET state='revoked' WHERE id=$1", [s.owner.sessionId]);
    await expect(s.publication.publish(s.claim, s.envelope)).rejects.toThrow();
    expect((await db.query('SELECT count(*)::int AS count FROM previews')).rows[0].count).toBe(0);
    expect((await db.query('SELECT ref_count FROM canonical_blocks WHERE id=$1', [s.ref.resourceId])).rows[0].ref_count).toBe(0);
  });
  it('rejects an unreserved functional result identity even if every other reference is valid', async () => {
    const s = await scenario();
    await expect(s.publication.publish(s.claim, { ...s.envelope, resultRef: { type: 'preview', id: randomUUID() } })).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect((await h.databases[1].query('SELECT count(*)::int AS count FROM previews')).rows[0].count).toBe(0);
  });
});
