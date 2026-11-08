import { createHash, randomUUID } from 'node:crypto';
import type { Snapshot } from '@ce/contracts';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import type { HostedHarness } from './hosted-harness.js';
import { uniqueTargetSnapshot, validate005 } from './iteration005-fixtures.js';

/** Real SQL metadata fixtures; manifest bytes are supplied explicitly by each worker/codec test. */
export async function seedHostedWorkspace(harness: HostedHarness) {
  const owner = { sessionId: randomUUID(), workspaceId: randomUUID() }, basisId = randomUUID(), versionId = randomUUID();
  const original = uniqueTargetSnapshot(), now = harness.clock.date();
  const content = { ...original.content, configVersion: canonicalHash({ directions: original.content.directions, directionDecisionState: original.content.directionDecisionState }) };
  const snapshot: Snapshot = { ...original, versionId, validationBasisId: basisId, createdAt: now.toISOString(), content, contentHash: canonicalHash(content) };
  const reference = { resourceId: randomUUID(), manifestId: randomUUID(), codecVersion: 1, sha256: snapshot.contentHash, byteLength: 1000 };
  const token = createHash('sha256').update(owner.sessionId).digest('hex');
  await harness.databases[0].transaction(async tx => {
    await tx.query(`INSERT INTO demo_sessions(id,token_hash,creation_nonce_hash,created_at,last_meaningful_activity_at,expires_at,absolute_expires_at)
      VALUES($1,$2,$2,$3,$3,$4,$5)`, [owner.sessionId, token, now, new Date(now.getTime() + 3_600_000), new Date(now.getTime() + 86_400_000)]);
    await tx.query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [owner.sessionId, owner.workspaceId, 'SYNTHETIC_SQL']);
    await tx.query(`INSERT INTO validation_bases(session_id,workspace_id,id,catalog_ref,data_ref,contexts_ref,profile_ids,hashes)
      VALUES($1,$2,$3,$4,$4,$4,$5,$6)`, [owner.sessionId, owner.workspaceId, basisId, reference, JSON.stringify([snapshot.content.profileId]), {}]);
    await tx.query(`INSERT INTO workspace_versions(session_id,workspace_id,id,basis_id,directions_ref,content_manifest_ref,content_hash,
      config_version,profile_id,catalog_version,report_version,summary,reason,created_at)
      VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10,$11,'import',$12)`, [owner.sessionId, owner.workspaceId, versionId, basisId, reference,
      snapshot.contentHash, content.configVersion, content.profileId, content.catalogVersion, content.reportVersion,
      { counts: { coordinates: content.coordinates.length, facts: content.facts.length, sources: content.sources.length } }, now]);
    await tx.query("UPDATE workspaces SET status='ready',current_version_id=$3,current_basis_id=$4 WHERE session_id=$1 AND id=$2",
      [owner.sessionId, owner.workspaceId, versionId, basisId]);
  });
  async function validation(options: { complete?: boolean; offset?: number } = {}) {
    const bundle = validate005(snapshot), started = new Date(now.getTime() + (options.offset ?? 0));
    const summary = { ...bundle.run.summary, complete: options.complete ?? true };
    await harness.databases[0].query(`INSERT INTO validation_runs(session_id,workspace_id,id,version_id,basis_id,status,summary,result_index_ref,
      created_at,started_at,completed_at,profile_id) VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8,$8,$8,$9)`,
    [owner.sessionId, owner.workspaceId, bundle.run.id, versionId, basisId, summary, reference, started, content.profileId]);
    return { ...bundle.run, summary };
  }
  async function queuedJob() {
    const id = randomUUID(), accepted = harness.clock.date();
    await harness.databases[0].query(`INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,base_version_id,accepted_at,queue_expires_at,status)
      VALUES($1,$2,$3,'validate',$4,$5,$6,$7,'queued')`, [owner.sessionId, owner.workspaceId, id,
      { schemaVersion: 1, versionId }, versionId, accepted, new Date(accepted.getTime() + 600_000)]);
    return { ...owner, jobId: id };
  }
  return { owner, snapshot, reference, validation, queuedJob };
}
