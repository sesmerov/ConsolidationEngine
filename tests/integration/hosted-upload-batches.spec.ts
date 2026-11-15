import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedUploadBatches } from '../../apps/api/src/storage/upload-batches.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { TRANSFER_PART_MAX_BYTES, type UploadBatchCreateDTO } from '@ce/contracts';
import type { WorkspaceOwner } from '../../apps/api/src/ports/workspace-repository.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { sealUploadedBatch } from '../../apps/api/src/workers/seal-upload.worker.js';
import { HostedRetainedSources } from '../../apps/api/src/hosted/retained-sources.js';
import { readZipParts, zipBytes } from '../helpers/xlsx-fixtures.js';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
describe('reserved upload batches over independent PostgreSQL connections', () => {
  let harness: HostedHarness, owner: WorkspaceOwner, stores: [HostedUploadBatches, HostedUploadBatches], etag: string;
  const catalog = Buffer.from('catalog'), report = Buffer.alloc(TRANSFER_PART_MAX_BYTES + 19, 37);
  const declaration = (): UploadBatchCreateDTO => ({ baseVersionId: null, files: [{ clientFileId: 'catalog', role: 'catalog', name: 'reglas.xlsx', byteLength: catalog.length, sha256: sha(catalog) }, { clientFileId: 'report', role: 'report', name: 'informe.xlsx', byteLength: report.length, sha256: sha(report) }] });
  beforeEach(async () => {
    harness = await createHostedHarness(); const now = harness.clock.date(); owner = { sessionId: randomUUID(), workspaceId: randomUUID() }; const hash = sha(Buffer.from(owner.sessionId));
    await harness.databases[0].query(`INSERT INTO demo_sessions(id,token_hash,creation_nonce_hash,created_at,last_meaningful_activity_at,expires_at,absolute_expires_at) VALUES($1,$2,$2,$3,$3,$4,$5)`, [owner.sessionId, hash, now, new Date(+now + 3_600_000), new Date(+now + 86_400_000)]);
    await harness.databases[0].query('INSERT INTO workspaces(session_id,id,name) VALUES($1,$2,$3)', [owner.sessionId, owner.workspaceId, 'SYNTHETIC']); etag = `"${owner.workspaceId}:1:empty"`;
    stores = harness.databases.map(db => { const quotas = new QuotaLedger(db, harness.config), objects = new ObjectLedger(db, harness.objectTransport, quotas, () => harness.clock.date()); return new HostedUploadBatches(db, objects, quotas, () => harness.clock.date()); }) as [HostedUploadBatches, HostedUploadBatches];
  });
  afterEach(async () => { await harness?.close(); });
  it('reserves declarations before any bytes and returns bounded server identities from another instance', async () => {
    const batch = await stores[0].create(owner, declaration(), etag, randomUUID()); expect(batch.files).toHaveLength(2); expect(batch.partSize).toBe(TRANSFER_PART_MAX_BYTES); expect(batch.files[1]?.partCount).toBe(2); expect(batch.files.every(file => file.id !== file.clientFileId)).toBe(true);
    expect(await stores[1].get(owner, batch.id)).toEqual(batch); expect(harness.objectTransport.calls).toHaveLength(0);
    const reserved = (await harness.databases[0].query<{ total: string }>("SELECT sum(units)::text total FROM quota_reservations WHERE session_id=$1 AND resource='session-file-bytes' AND state='reserved'", [owner.sessionId])).rows[0]!; expect(Number(reserved.total)).toBe(catalog.length + report.length);
  });
  it('recovers a lost create acknowledgement before CAS without reserving twice or renewing idle time', async () => {
    const key = randomUUID(), first = await stores[0].create(owner, declaration(), etag, key), allocations = (await harness.databases[0].query('SELECT id FROM quota_reservations WHERE session_id=$1', [owner.sessionId])).rows.length;
    harness.clock.advance(40_000); await harness.databases[0].query('UPDATE workspaces SET revision=revision+1 WHERE session_id=$1 AND id=$2', [owner.sessionId, owner.workspaceId]);
    const replay = await stores[1].create(owner, declaration(), etag, key); expect(replay).toEqual(first);
    expect((await harness.databases[0].query('SELECT id FROM quota_reservations WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(allocations);
    const stored = (await harness.databases[0].query('SELECT response FROM mutation_receipts WHERE session_id=$1', [owner.sessionId])).rows[0]!; expect(stored.response).toEqual({ batchId: first.id });
    expect(+(await harness.databases[0].query('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1', [owner.sessionId])).rows[0]!.last_meaningful_activity_at).toBe(harness.clock.now() - 40_000);
    await expect(stores[1].create(owner, { ...declaration(), files: declaration().files.map(file => ({ ...file, name: 'other.xlsx' })) }, etag, key)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });
  it('registers real parts out of order, makes exact retries idempotent and rejects a conflicting hash', async () => {
    const batch = await stores[0].create(owner, declaration(), etag, randomUUID()), file = batch.files.find(file => file.role === 'report')!, last = report.subarray(TRANSFER_PART_MAX_BYTES);
    const receipt = await stores[0].putPart(owner, batch.id, file.id, 1, last, sha(last)); expect(await stores[1].putPart(owner, batch.id, file.id, 1, last, sha(last))).toEqual(receipt);
    expect(harness.objectTransport.calls.filter(call => call.operation === 'put')).toHaveLength(1); expect((await stores[1].get(owner, batch.id)).files.find(row => row.id === file.id)?.parts).toEqual([{ index: 1, size: last.length, sha256: sha(last) }]);
    const different = Buffer.alloc(last.length, 18); await expect(stores[1].putPart(owner, batch.id, file.id, 1, different, sha(different))).rejects.toMatchObject({ code: 'TRANSFER_PART_CONFLICT' });
    const first = report.subarray(0, TRANSFER_PART_MAX_BYTES); await stores[1].putPart(owner, batch.id, file.id, 0, first, sha(first)); expect((await stores[0].get(owner, batch.id)).state).toBe('receiving');
    expect((await harness.databases[0].query('SELECT id FROM object_manifests WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(0);
  });
  it('verifies actual hash/length and authorization before provider I/O', async () => {
    const batch = await stores[0].create(owner, declaration(), etag, randomUUID()), file = batch.files[0]!;
    await expect(stores[1].putPart(owner, batch.id, file.id, 0, catalog, 'a'.repeat(64))).rejects.toMatchObject({ code: 'TRANSFER_PART_CONFLICT' });
    await expect(stores[1].putPart(owner, batch.id, file.id, 1, catalog, sha(catalog))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(stores[1].putPart(owner, batch.id, file.id, 0, Buffer.alloc(TRANSFER_PART_MAX_BYTES + 1), 'a'.repeat(64))).rejects.toMatchObject({ code: 'UPLOAD_LIMIT' });
    await expect(stores[1].get({ ...owner, workspaceId: randomUUID() }, batch.id)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' }); expect(harness.objectTransport.calls).toHaveLength(0);
  });
  it('prevents registering a part when cancelled during provider I/O, and retains its cleanup identity', async () => {
    const batch = await stores[0].create(owner, declaration(), etag, randomUUID()), file = batch.files[0]!; harness.barriers.arm('transport.afterPut'); const upload = stores[0].putPart(owner, batch.id, file.id, 0, catalog, sha(catalog));
    await harness.barriers.waitUntilReached('transport.afterPut'); await stores[1].cancel(owner, batch.id); harness.barriers.release('transport.afterPut'); await expect(upload).rejects.toMatchObject({ code: 'TRANSFER_INCOMPLETE' });
    expect((await stores[1].get(owner, batch.id)).state).toBe('cleanup_pending'); expect((await harness.databases[0].query('SELECT resource_id FROM object_parts WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(0);
    expect((await harness.databases[0].query('SELECT id FROM physical_objects WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(1);
  });
  it('validates a single catalog, report counts, total/file maxima and base before any reservation', async () => {
    for (const body of [{ ...declaration(), files: declaration().files.slice(1) }, { ...declaration(), files: [...declaration().files, declaration().files[0]!] }, { ...declaration(), files: declaration().files.map(file => ({ ...file, byteLength: 10 * 1024 * 1024 + 1 })) }]) await expect(stores[0].create(owner, body, etag, randomUUID())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    await expect(stores[0].create(owner, declaration(), '"stale"', randomUUID())).rejects.toMatchObject({ code: 'STALE_VERSION' }); expect((await harness.databases[0].query('SELECT id FROM quota_reservations')).rows).toHaveLength(0);
  });
  it('does not attach an object claimed by cleanup between its write and part registration', async () => {
    const batch = await stores[0].create(owner, declaration(), etag, randomUUID()), file = batch.files[0]!, write = stores[0].objects.putObject.bind(stores[0].objects);
    stores[0].objects.putObject = async (...args) => {
      const object = await write(...args);
      await harness.databases[1].query("UPDATE physical_objects SET status='cleanup_pending' WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND ref_count=0", [owner.sessionId, owner.workspaceId, object.objectId]);
      return object;
    };
    await expect(stores[0].putPart(owner, batch.id, file.id, 0, catalog, sha(catalog))).rejects.toMatchObject({ code: 'TRANSFER_INCOMPLETE' });
    expect((await harness.databases[0].query('SELECT resource_id FROM object_parts WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(0);
    expect((await harness.databases[0].query('SELECT ref_count FROM physical_objects WHERE session_id=$1', [owner.sessionId])).rows[0]?.ref_count).toBe(0);
  });
  async function uploadAll(inputs: readonly { role: 'catalog'|'report'; bytes: Buffer }[], wrongWholeHash = false) {
    const batch = await stores[0].create(owner, { baseVersionId: null, files: inputs.map((input, i) => ({ clientFileId: 'file' + i, role: input.role, name: input.role + '.xlsx', byteLength: input.bytes.length, sha256: wrongWholeHash && i === 1 ? 'a'.repeat(64) : sha(input.bytes) })) }, etag, randomUUID());
    for (const [i, input] of inputs.entries()) { const file = batch.files.find(file => file.clientFileId === 'file' + i)!; for (let index = 0; index < file.partCount; index++) { const bytes = input.bytes.subarray(index * TRANSFER_PART_MAX_BYTES, (index + 1) * TRANSFER_PART_MAX_BYTES); await stores[index % 2]!.putPart(owner, batch.id, file.id, index, bytes, sha(bytes)); } } return batch;
  }
  async function sealClaim(batchId: string) {
    const jobId = randomUUID(), now = harness.clock.date(); await harness.databases[0].transaction(async tx => {
      await tx.query("INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,accepted_at,queue_expires_at,status) VALUES($1,$2,$3,'seal-upload',$4,$5,$6,'queued')", [owner.sessionId, owner.workspaceId, jobId, { batchId }, now, new Date(+now + 600_000)]);
      await stores[0].prepareSeal(tx, owner, batchId, jobId);
    }); const outcome = await new HostedJobCoordinator(harness.databases[1], { config: harness.config, now: harness.clock.now, instanceId: 'seal-instance' }).claim({ ...owner, jobId }); if (outcome.state !== 'claimed') throw new Error('Expected real fenced claim'); return outcome.claim;
  }
  it('seals a valid FINREP workbook above 4.5 MB only after every hash and preflight, with no partial manifest', async () => {
    const parts = await readZipParts('tests/fixtures/generated/demo-finrep-report.xlsx');
    const large = zipBytes(parts.map(part => part.name === '[Content_Types].xml' ? { ...part, compress: false, data: Buffer.concat([part.data, Buffer.alloc(5 * 1024 * 1024, 32)]) } : part));
    expect(large.byteLength).toBeGreaterThan(4.5 * 1024 * 1024);
    const batch = await uploadAll([{ role: 'catalog', bytes: await readFile('tests/fixtures/generated/demo-finrep-catalog.xlsx') }, { role: 'report', bytes: large }]), claim = await sealClaim(batch.id);
    const candidate = await sealUploadedBatch(stores[1], claim, batch.id); expect(candidate.files).toHaveLength(2); expect(JSON.stringify(candidate)).not.toMatch(/path|ce-session|private_object_key/);
    expect((await stores[0].get(owner, batch.id)).state).toBe('sealing'); expect((await harness.databases[0].query('SELECT id FROM object_manifests WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(0);
    await harness.databases[0].transaction(tx => stores[0].publishSealed(tx, claim, candidate)); expect((await stores[1].get(owner, batch.id)).state).toBe('sealed'); expect((await harness.databases[0].query('SELECT id FROM object_manifests WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(2);
  });
  it('does not expose a manifest for an incomplete batch or an incorrect whole-file hash', async () => {
    const incomplete = await stores[0].create(owner, declaration(), etag, randomUUID()); await expect(sealClaim(incomplete.id)).rejects.toMatchObject({ code: 'TRANSFER_INCOMPLETE' });
    const batch = await uploadAll([{ role: 'catalog', bytes: await readFile('tests/fixtures/generated/demo-finrep-catalog.xlsx') }, { role: 'report', bytes: await readFile('tests/fixtures/generated/demo-finrep-report.xlsx') }], true), claim = await sealClaim(batch.id);
    await expect(sealUploadedBatch(stores[1], claim, batch.id)).rejects.toMatchObject({ code: 'TRANSFER_INCOMPLETE' }); expect((await harness.databases[0].query('SELECT id FROM object_manifests WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(0);
  });
  it('retains immutable FINREP originals by version and reconstructs them on another instance without staging paths', async () => {
    const input = [{ role: 'catalog' as const, bytes: await readFile('tests/fixtures/generated/demo-finrep-catalog.xlsx') }, { role: 'report' as const, bytes: await readFile('tests/fixtures/generated/demo-finrep-report.xlsx') }];
    const batch = await uploadAll(input), seal = await sealClaim(batch.id), candidate = await sealUploadedBatch(stores[0], seal, batch.id);
    await harness.databases[0].transaction(async tx => { await stores[0].publishSealed(tx, seal, candidate); await tx.query("UPDATE jobs SET status='succeeded',terminal_at=$2 WHERE id=$1", [seal.jobId, harness.clock.date()]); });
    const coordinator = new HostedJobCoordinator(harness.databases[1], { config: harness.config, now: harness.clock.now, instanceId: 'source-instance' }); await coordinator.confirmTerminated(seal);
    const jobId = randomUUID(), now = harness.clock.date(); await harness.databases[0].query("INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,accepted_at,queue_expires_at,status) VALUES($1,$2,$3,'import','{}',$4,$5,'queued')", [owner.sessionId, owner.workspaceId, jobId, now, new Date(+now + 600_000)]);
    const accepted = await coordinator.claim({ ...owner, jobId }); if (accepted.state !== 'claimed') throw new Error('Expected import claim');
    const originals = new HostedRetainedSources(harness.databases[0], stores[0].objects, () => harness.clock.date()), versionId = randomUUID(), basisId = randomUUID();
    // Authority metadata fixture only; domain snapshot generation is verified by hosted-command suites.
    await harness.databases[0].transaction(async tx => {
      await tx.query("INSERT INTO validation_bases(session_id,workspace_id,id,catalog_ref,data_ref,contexts_ref,profile_ids,hashes) VALUES($1,$2,$3,'{}','{}','{}','[]','{}')", [owner.sessionId, owner.workspaceId, basisId]);
      await tx.query("INSERT INTO workspace_versions(session_id,workspace_id,id,basis_id,directions_ref,content_manifest_ref,content_hash,reason) VALUES($1,$2,$3,$4,'{}','{}',$5,'import')", [owner.sessionId, owner.workspaceId, versionId, basisId, 'a'.repeat(64)]);
      await originals.promote(tx, accepted.claim, versionId, batch.files.map(file => file.id)); await originals.promote(tx, accepted.claim, versionId, batch.files.map(file => file.id));
    });
    await stores[0].cancel(owner, batch.id); expect((await stores[1].get(owner, batch.id)).state).toBe('retained');
    expect((await harness.databases[0].query<{ retained_ref_count: number }>('SELECT retained_ref_count FROM stored_files WHERE batch_id=$1', [batch.id])).rows.map(row => row.retained_ref_count)).toEqual([1,1]);
    const otherInstance = new HostedRetainedSources(harness.databases[1], stores[1].objects, () => harness.clock.date());
    const expected = batch.files.map(file => ({ id: file.id, kind: file.role, displayName: file.name, size: file.byteLength, sha256: file.sha256, importedAt: now.toISOString() }));
    const materialized = await otherInstance.forVersion(accepted.claim, versionId, expected);
    try { for (const file of materialized.files) expect(sha(await readFile(file.path))).toBe(input.find(input => input.role === file.kind) && sha(input.find(input => input.role === file.kind)!.bytes)); } finally { await materialized.dispose(); }
    await expect(otherInstance.forVersion(accepted.claim, versionId, expected.map(file => ({ ...file, sha256: 'b'.repeat(64) })))).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE' });
  });
});
