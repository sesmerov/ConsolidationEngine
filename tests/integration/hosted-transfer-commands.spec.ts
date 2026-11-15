import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject, JobKind } from '@ce/contracts';
import { TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
import { HostedUploadBatches } from '../../apps/api/src/storage/upload-batches.js';
import { CanonicalCodec } from '../../apps/api/src/hosted/canonical-codec.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { HostedJobCoordinator, type HostedJobClaim } from '../../apps/api/src/hosted/job-coordinator.js';
import { HostedProjectionWriter } from '../../apps/api/src/hosted/projection-store.js';
import { HostedSnapshotCodec } from '../../apps/api/src/hosted/snapshot-codec.js';
import { PostgresRepository } from '../../apps/api/src/hosted/postgres-repository.js';
import { HostedPublication } from '../../apps/api/src/hosted/publication.js';
import { HostedRetainedSources } from '../../apps/api/src/hosted/retained-sources.js';
import { HostedExportArtifacts } from '../../apps/api/src/hosted/export-artifacts.js';
import { executeTransferCommand, prepareImportCommit, transferPublicationHandlers, type TransferCommandDependencies } from '../../apps/api/src/hosted/transfer-commands.js';
import type { DatabaseTransaction } from '../../apps/api/src/hosted/database.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import type { WorkspaceOwner } from '../../apps/api/src/ports/workspace-repository.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
describe('hosted transfer domain commands publish only durable references', () => {
  let h: HostedHarness, owner: WorkspaceOwner, deps: TransferCommandDependencies, uploads: HostedUploadBatches, coordinator: HostedJobCoordinator, publication: HostedPublication;
  beforeEach(async () => {
    h = await createHostedHarness(); const now = h.clock.date(); owner = { sessionId: randomUUID(), workspaceId: randomUUID() };
    await h.databases[0].query('INSERT INTO demo_sessions(id,token_hash,creation_nonce_hash,created_at,last_meaningful_activity_at,expires_at,absolute_expires_at) VALUES($1,$2,$2,$3,$3,$4,$5)', [owner.sessionId, sha(Buffer.from(owner.sessionId)), now, new Date(+now + 3_600_000), new Date(+now + 86_400_000)]);
    await h.databases[0].query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [owner.sessionId, owner.workspaceId, 'SYNTHETIC']);
    const db = h.databases[0], quotas = new QuotaLedger(db, h.config), objects = new ObjectLedger(db, h.objectTransport, quotas, () => h.clock.date()), indexes = new HostedProjectionWriter(db, quotas, objects, { now: h.clock.now }), snapshots = new HostedSnapshotCodec(db, objects, indexes);
    const repository = new PostgresRepository(db, { now: h.clock.now, hydrateSnapshot: (owner, ref) => snapshots.hydrateSnapshot(owner, { ...ref, codecVersion: 1 }) });
    deps = { db, quotas, objects, indexes, codec: new CanonicalCodec(objects), repository, now: h.clock.now };
    uploads = new HostedUploadBatches(db, objects, quotas, () => h.clock.date());
    coordinator = new HostedJobCoordinator(db, { config: h.config, now: h.clock.now, instanceId: 'transfer-domain' });
    const sources = new HostedRetainedSources(db, objects, () => h.clock.date());
    publication = new HostedPublication(db, quotas, objects, { now: h.clock.now, handlers: transferPublicationHandlers(deps), retainSources: (tx, claim, versionId, ids) => sources.promote(tx, claim, versionId, ids) });
  });
  afterEach(async () => { await h?.close(); });
  async function claim(kind: JobKind, input: JsonObject, reserve?: (tx: DatabaseTransaction, jobId: string) => Promise<void>): Promise<HostedJobClaim> {
    const jobId = randomUUID(), now = h.clock.date(), base = (await deps.repository.workspace(owner)).currentVersionId;
    await deps.db.transaction(async tx => {
      await tx.query("INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,base_version_id,accepted_at,queue_expires_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'queued')", [owner.sessionId, owner.workspaceId, jobId, kind, input, base ?? null, now, new Date(+now + 600_000)]);
      await reserve?.(tx, jobId);
    });
    const result = await coordinator.claim({ ...owner, jobId }); if (result.state !== 'claimed') throw new Error('Expected fenced claim'); return result.claim;
  }
  async function run(job: HostedJobClaim) {
    const envelope = await executeTransferCommand({ claim: job, schema: h.schema, cancellation: new SharedArrayBuffer(4) }, () => false, deps);
    expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(262_144); expect(JSON.stringify(envelope)).not.toMatch(/private_object_key|ce-session-|"facts":\[|"coordinates":\[/);
    const result = await publication.publish(job, envelope); await coordinator.confirmTerminated(job); return result;
  }
  async function inspectedFinrep() {
    const inputs = await Promise.all(['catalog','report'].map(async role => ({ role: role as 'catalog'|'report', bytes: await readFile(`tests/fixtures/generated/demo-finrep-${role}.xlsx`) })));
    const batch = await uploads.create(owner, { baseVersionId: null, files: inputs.map(file => ({ clientFileId: file.role, role: file.role, name: file.role + '.xlsx', byteLength: file.bytes.length, sha256: sha(file.bytes) })) }, `"${owner.workspaceId}:1:empty"`, randomUUID());
    for (const input of inputs) { const file = batch.files.find(file => file.role === input.role)!; for (let index = 0; index < file.partCount; index++) { const bytes = input.bytes.subarray(index * TRANSFER_PART_MAX_BYTES, (index + 1) * TRANSFER_PART_MAX_BYTES); await uploads.putPart(owner, batch.id, file.id, index, bytes, sha(bytes)); } }
    await run(await claim('seal-upload', { uploadBatchId: batch.id, publication: { resultId: batch.id } }, (tx, jobId) => uploads.prepareSeal(tx, owner, batch.id, jobId)));
    const inspectionId = randomUUID(); await run(await claim('inspect-import', { uploadBatchId: batch.id, context: { source: 'workbook' }, publication: { resultId: inspectionId } }));
    const inspection = (await deps.db.query('SELECT * FROM import_inspections WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, inspectionId])).rows[0]!;
    return { batch, inspectionId, inspection };
  }
  it('seals, inspects, imports and exports FINREP F 01.01 through real SQL and private parts', async () => {
    const { batch, inspectionId, inspection } = await inspectedFinrep();
    expect(inspection.summary.profiles[0].profileId).toBe('eba-finrep-4.0-f0101-v1'); expect(inspection.summary.reports).toBeUndefined();
    expect(inspection.detail_ref.views).toHaveProperty('reports');
    const versionId = randomUUID(), basisId = randomUUID();
    const body = { inspectionHash: inspection.inspection_hash, acceptedExcludedSheets: true };
    await run(await claim('import', { inspectionId, ...body, publication: { resultId: versionId, versionId, basisId } }, (tx, jobId) => prepareImportCommit(tx, owner, inspectionId, body, jobId, h.clock.date())));
    const snapshot = await deps.repository.loadSnapshot(owner, versionId); expect(snapshot.content.reportSourceBindings?.[0]?.profileId).toBe('eba-finrep-4.0-f0101-v1'); expect(snapshot.content.coordinates.some(row => row.tableCode === 'F_01.01')).toBe(true); expect(snapshot.content.facts.length).toBeGreaterThan(0);
    const summary = (await deps.db.query('SELECT summary FROM workspace_versions WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, versionId])).rows[0]!.summary;
    expect(summary.exportSummary.reports).toHaveLength(1); expect(summary.exportSummary.reports[0]).toMatchObject({ profileId: 'eba-finrep-4.0-f0101-v1', contextCount: 1, selectedSheets: ['1.1'] }); expect(summary.views.exportSummary).toHaveProperty('indexId');
    expect((await deps.db.query('SELECT source_file_id FROM snapshot_sources WHERE session_id=$1 AND workspace_id=$2 AND version_id=$3', [owner.sessionId, owner.workspaceId, versionId])).rows).toHaveLength(batch.files.length);
    const artifactId = randomUUID(), intent = { workspaceId: owner.workspaceId, versionId, kind: 'report' as const }, artifacts = new HostedExportArtifacts(deps.db, deps.objects, deps.quotas, () => h.clock.date());
    await run(await claim('export', { intent, artifactId, publication: { resultId: artifactId } }, (tx, jobId) => artifacts.reserve(tx, owner, { artifactId, jobId, intent })));
    const manifest = await artifacts.manifest(owner, artifactId), parts: Uint8Array[] = []; for (const part of manifest.parts) parts.push(await artifacts.part(owner, artifactId, part.index));
    expect(sha(Buffer.concat(parts))).toBe(manifest.sha256); expect(manifest.intent).toEqual(intent); expect(manifest.byteLength).toBeGreaterThan(10_000);
  }, 60_000);
  it('rejects a changed inspection hash and expired inspection before commit admission', async () => {
    const { inspectionId, inspection } = await inspectedFinrep(), jobId = randomUUID();
    await expect(deps.db.transaction(tx => prepareImportCommit(tx, owner, inspectionId, { inspectionHash: 'a'.repeat(64), acceptedExcludedSheets: true }, jobId, h.clock.date()))).rejects.toMatchObject({ code: 'IMPORT_INSPECTION_NOT_APPLICABLE' });
    h.clock.advance(900_001);
    await expect(deps.db.transaction(tx => prepareImportCommit(tx, owner, inspectionId, { inspectionHash: inspection.inspection_hash, acceptedExcludedSheets: true }, jobId, h.clock.date()))).rejects.toMatchObject({ code: 'IMPORT_INSPECTION_EXPIRED' });
    expect((await deps.repository.workspace(owner)).currentVersionId).toBeUndefined();
  }, 60_000);
  it('retains the accepted commit lease across inspection expiry while its job remains fenced and live', async () => {
    const { inspectionId, inspection } = await inspectedFinrep(); h.clock.advance(899_999);
    const versionId = randomUUID(), basisId = randomUUID(), body = { inspectionHash: inspection.inspection_hash, acceptedExcludedSheets: true };
    const accepted = await claim('import', { inspectionId, ...body, publication: { resultId: versionId, versionId, basisId } }, (tx, jobId) => prepareImportCommit(tx, owner, inspectionId, body, jobId, h.clock.date()));
    h.clock.advance(2); const result = await run(accepted); expect(result.newVersionId).toBe(versionId); expect((await deps.repository.workspace(owner)).currentVersionId).toBe(versionId);
  }, 60_000);
});
