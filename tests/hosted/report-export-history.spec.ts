import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SourceFile, Snapshot } from '@ce/contracts';
import { collectApplicationHistory } from '../../apps/api/src/export/change-log.js';
import { CanonicalCodec } from '../../apps/api/src/hosted/canonical-codec.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { readReportExportHistory } from '../../apps/api/src/hosted/report-export-history.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

let h: HostedHarness;
beforeEach(async () => { h = await createHostedHarness(); });
afterEach(async () => { await h.close(); });
async function scenario() {
  const fixture = await seedHostedWorkspace(h), db = h.databases[0], owner = fixture.owner, versions = [fixture.snapshot.versionId];
  async function sources(): Promise<SourceFile[]> {
    const rows: SourceFile[] = ['catalog','report'].map(kind => ({ id: randomUUID(), kind: kind as 'catalog'|'report', displayName: kind + '.xlsx', size: 1, expandedBytes: 1, sha256: 'a'.repeat(64), importedAt: h.clock.date().toISOString() }));
    for (const row of rows) {
      await db.query("INSERT INTO object_resources(session_id,workspace_id,id,kind,state,byte_length,sha256) VALUES($1,$2,$3,'file','retained',1,$4)", [owner.sessionId,owner.workspaceId,row.id,row.sha256]);
      await db.query("INSERT INTO stored_files(session_id,workspace_id,id,role,name,mime,byte_length,sha256,part_count,state,retained_ref_count) VALUES($1,$2,$3,$4,$5,'application/octet-stream',1,$6,1,'retained',1)", [owner.sessionId,owner.workspaceId,row.id,row.kind,row.displayName,row.sha256]);
    }
    return rows;
  }
  const originalSources = await sources();
  // Metadata-only retained-version fixture. Canonical snapshot payloads deliberately do not exist.
  for (let index = 1; index < 20; index++) {
    const previous = versions.at(-1)!, version = randomUUID();
    await db.query(`INSERT INTO workspace_versions(session_id,workspace_id,id,parent_id,basis_id,directions_ref,content_manifest_ref,content_hash,config_version,profile_id,catalog_version,report_version,summary,reason)
      SELECT session_id,workspace_id,$4,id,basis_id,directions_ref,content_manifest_ref,content_hash,config_version,profile_id,catalog_version,report_version,summary,'configuration'
      FROM workspace_versions WHERE session_id=$1 AND workspace_id=$2 AND id=$3`, [owner.sessionId,owner.workspaceId,previous,version]);
    versions.push(version);
  }
  for (const version of versions) for (const source of originalSources) await db.query('INSERT INTO snapshot_sources(session_id,workspace_id,version_id,source_file_id) VALUES($1,$2,$3,$4)', [owner.sessionId,owner.workspaceId,version,source.id]);
  const target: Snapshot = { ...fixture.snapshot, versionId: versions.at(-1)!, parentVersionId: versions.at(-2)!, content: { ...fixture.snapshot.content, sources: originalSources } };
  const coordinator = new HostedJobCoordinator(db, { config: h.config, instanceId: 'history', now: h.clock.now }), claimed = await coordinator.claim(await fixture.queuedJob());
  if (claimed.state !== 'claimed') throw new Error('Expected claim');
  let canonicalReads = 0;
  const codec = new CanonicalCodec({ async getCanonical() { canonicalReads++; throw new Error('Ancestor payload must never be hydrated'); }, async putCanonical() { throw new Error('Read only'); } });
  return { owner, db, target, versions, sources, claim: claimed.claim, deps: { db, codec, now: h.clock.now }, canonicalReads: () => canonicalReads };
}
it('traverses 20 retained versions using source identities without reading any ancestor payload', async () => {
  const s = await scenario(), history = await readReportExportHistory(s.claim, s.target, s.deps, () => false);
  for (const id of s.versions) { const version = history.snapshot(id); expect(Object.keys(version.content)).toEqual(['sources']); expect(version.content.sources[0]).toEqual(expect.objectContaining({ id: expect.any(String), kind: expect.any(String) })); expect(version.content.sources[0]).not.toHaveProperty('displayName'); }
  expect(s.canonicalReads()).toBe(0); expect(collectApplicationHistory(s.target, history, () => {})).toEqual({ receipts: [], changes: [] });
});
it('stops at a different import lineage and rejects missing retained history', async () => {
  const s = await scenario(), otherSources = await s.sources(), parent = s.versions.at(-2)!;
  await s.db.query('DELETE FROM snapshot_sources WHERE session_id=$1 AND workspace_id=$2 AND version_id=$3', [s.owner.sessionId,s.owner.workspaceId,parent]);
  for (const source of otherSources) await s.db.query('INSERT INTO snapshot_sources(session_id,workspace_id,version_id,source_file_id) VALUES($1,$2,$3,$4)', [s.owner.sessionId,s.owner.workspaceId,parent,source.id]);
  const history = await readReportExportHistory(s.claim, s.target, s.deps, () => false);
  expect(history.snapshot(parent).content.sources.map(row => row.id).sort()).toEqual(otherSources.map(row => row.id).sort());
  expect(() => history.snapshot(s.versions.at(-3)!)).toThrow(); expect(s.canonicalReads()).toBe(0);
  await s.db.query('UPDATE workspace_versions SET retained=false WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [s.owner.sessionId,s.owner.workspaceId,parent]);
  await expect(readReportExportHistory(s.claim, s.target, s.deps, () => false)).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE', details: { reason: 'INCOMPLETE_VERSION_HISTORY' } });
});
