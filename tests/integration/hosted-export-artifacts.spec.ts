import { randomUUID, createHash } from 'node:crypto';
import { open, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedExportArtifacts } from '../../apps/api/src/hosted/export-artifacts.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { HostedJobCoordinator, type HostedJobClaim } from '../../apps/api/src/hosted/job-coordinator.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';
import { zipBytes } from '../helpers/xlsx-fixtures.js';
import { EXPORT_MAX_BYTES, isCompleteTransferManifest } from '@ce/contracts';

describe('authenticated export manifests and parts over durable SQL', () => {
  let harness: HostedHarness, seeded: Awaited<ReturnType<typeof seedHostedWorkspace>>, services: HostedExportArtifacts[], directory: string;
  beforeEach(async () => { harness = await createHostedHarness(); seeded = await seedHostedWorkspace(harness); directory = await mkdtemp(path.join(os.tmpdir(), 'ce-export-test-'));
    services = harness.databases.map(db => { const quota = new QuotaLedger(db, harness.config); return new HostedExportArtifacts(db, new ObjectLedger(db, harness.objectTransport, quota, () => harness.clock.date()), quota, () => harness.clock.date()); });
  });
  afterEach(async () => { if (directory && path.basename(directory).startsWith('ce-export-test-')) await rm(directory, { recursive: true, force: true }); await harness?.close(); });
  async function reserve(): Promise<{ artifactId: string; claim: HostedJobClaim }> {
    const artifactId = randomUUID(), jobId = randomUUID(), now = harness.clock.date(), { owner, snapshot } = seeded;
    await harness.databases[0].transaction(async tx => {
      await tx.query("INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,base_version_id,accepted_at,queue_expires_at,status) VALUES($1,$2,$3,'export',$4,$5,$6,$7,'queued')", [owner.sessionId, owner.workspaceId, jobId, { publication: { resultId: artifactId } }, snapshot.versionId, now, new Date(+now + 600_000)]);
      await services[0]!.reserve(tx, owner, { artifactId, jobId, intent: { workspaceId: owner.workspaceId, versionId: snapshot.versionId, kind: 'report' } });
    }); const result = await new HostedJobCoordinator(harness.databases[0], { config: harness.config, now: harness.clock.now, instanceId: 'artifact-instance' }).claim({ ...owner, jobId }); if (result.state !== 'claimed') throw new Error('Expected export claim'); return { artifactId, claim: result.claim };
  }
  it('publishes only a complete immutable ZIP manifest and serves verified parts from another pool without regenerating', async () => {
    const { artifactId, claim } = await reserve(), bytes = zipBytes([{ name: 'synthetic.txt', data: Buffer.alloc(5 * 1024 * 1024, 63) }]), location = path.join(directory, 'result.zip'); await writeFile(location, bytes);
    await expect(services[1]!.manifest(seeded.owner, artifactId)).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE' });
    const candidate = await services[0]!.stageFile(claim, artifactId, location); await expect(services[1]!.manifest(seeded.owner, artifactId)).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE' });
    await harness.databases[0].transaction(tx => services[0]!.publish(tx, claim, candidate)); const manifest = await services[1]!.manifest(seeded.owner, artifactId);
    expect(isCompleteTransferManifest(manifest)).toBe(true); expect(manifest.parts).toHaveLength(2); expect(manifest.byteLength).toBe(bytes.length); expect(manifest.sha256).toBe(createHash('sha256').update(bytes).digest('hex')); expect(JSON.stringify(manifest)).not.toMatch(/private|vercel|ce\/v1|path/);
    const puts = harness.objectTransport.calls.filter(call => call.operation === 'put').length, actual: Uint8Array[] = [];
    for (const part of manifest.parts) actual.push(await services[1]!.part(seeded.owner, artifactId, part.index)); expect(Buffer.concat(actual).equals(bytes)).toBe(true); await services[0]!.part(seeded.owner, artifactId, 0); expect(harness.objectTransport.calls.filter(call => call.operation === 'put')).toHaveLength(puts);
  });
  it('rejects a real max+1 file before reading or writing provider objects', async () => {
    const { artifactId, claim } = await reserve(), location = path.join(directory, 'oversized.zip'), file = await open(location, 'wx'); await file.truncate(EXPORT_MAX_BYTES + 1); await file.close();
    await expect(services[0]!.stageFile(claim, artifactId, location)).rejects.toMatchObject({ code: 'EXPORT_LIMIT' }); expect(harness.objectTransport.calls).toHaveLength(0);
  });
  it('rejects foreign owners and expired artifacts before a private read', async () => {
    const { artifactId, claim } = await reserve(), location = path.join(directory, 'small.zip'); await writeFile(location, zipBytes([{ name: 'x.txt', data: Buffer.from('synthetic') }]));
    const candidate = await services[0]!.stageFile(claim, artifactId, location); await harness.databases[0].transaction(tx => services[0]!.publish(tx, claim, candidate)); const calls = harness.objectTransport.calls.length;
    const other = await seedHostedWorkspace(harness); await expect(services[1]!.part(other.owner, artifactId, 0)).rejects.toMatchObject({ code: 'RESOURCE_NOT_FOUND' });
    await harness.databases[0].query('UPDATE export_artifacts SET expires_at=$2 WHERE id=$1', [artifactId, new Date(harness.clock.now() - 1)]); await expect(services[1]!.part(seeded.owner, artifactId, 0)).rejects.toMatchObject({ code: 'ARTIFACT_EXPIRED' }); expect(harness.objectTransport.calls).toHaveLength(calls);
  });
});
