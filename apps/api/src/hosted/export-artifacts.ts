import { createHash, randomUUID } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import type { QueryResultRow } from 'pg';
import { EXPORT_MAX_BYTES, EXPORT_MAX_PARTS, TRANSFER_PART_MAX_BYTES, downloadIntentKey, isCompleteTransferManifest, sameDownloadIntent } from '@ce/contracts';
import type { DownloadIntent, ExportArtifactSummaryDTO, ExportManifestDTO, TransferPartDTO } from '@ce/contracts';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { ApiError } from '../errors.js';
import { ObjectLedger } from './object-ledger.js';
import { QuotaLedger } from './quota-ledger.js';
import { assertClaimAuthority, type HostedJobClaim } from './job-coordinator.js';
import { assertLiveSession } from './session-service.js';
import { requireVersion, requireWorkspace } from './postgres-repository.js';

export const EXPORT_TEMPORARY_BYTES = 200 * 1024 * 1024;
interface ArtifactRow extends QueryResultRow { id: string; version_id: string; kind: 'report'|'results'; run_id: string|null; job_id: string; status: string; expires_at: Date; filename: string; manifest_id: string|null; byte_length: string; sha256: string }
interface PartsRow extends QueryResultRow { part_index: number; size: number; sha256: string; object_id: string }
interface ReservationRow extends QueryResultRow { session_bytes_id: string; blob_bytes_id: string; temporary_bytes_id: string }
export interface ExportArtifactCandidate { readonly artifactId: string; readonly manifestId: string; readonly byteLength: number; readonly sha256: string; readonly partCount: number; readonly intent: DownloadIntent }
export interface ExportTransferService { manifest(owner: WorkspaceOwner, artifactId: string): Promise<ExportManifestDTO>; part(owner: WorkspaceOwner, artifactId: string, index: number): Promise<Uint8Array> }
const intentFor = (owner: WorkspaceOwner, row: ArtifactRow): DownloadIntent => ({ workspaceId: owner.workspaceId, versionId: row.version_id, ...(row.kind === 'results' ? { kind: 'results', runId: row.run_id! } : { kind: 'report' }) });
const partDto = (part: PartsRow): TransferPartDTO => ({ index: part.part_index, size: part.size, sha256: part.sha256 });

/** Output is reserved at admission, staged privately by the worker, then published with its job in one authority transaction. */
export class HostedExportArtifacts implements ExportTransferService {
  constructor(readonly database: HostedDatabase, readonly objects: ObjectLedger, readonly quotas: QuotaLedger, readonly now: () => Date = () => new Date()) {}
  async reserve(tx: DatabaseTransaction, owner: WorkspaceOwner, request: { artifactId: string; jobId: string; intent: DownloadIntent }): Promise<void> {
    await this.authorize(tx, owner); await requireVersion(tx, owner, request.intent.versionId);
    if (request.intent.workspaceId !== owner.workspaceId) throw new ApiError('RESOURCE_NOT_FOUND');
    if (request.intent.kind === 'results') {
      const run = (await tx.query('SELECT version_id,status FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, request.intent.runId])).rows[0];
      if (!run) throw new ApiError('RESOURCE_NOT_FOUND'); if (run.version_id !== request.intent.versionId) throw new ApiError('STALE_VERSION'); if (['pending','running'].includes(run.status)) throw new ApiError('WORKSPACE_BUSY');
    }
    const reserve = (resource: 'session-file-bytes'|'blob-bytes'|'sql-bytes', units: number) => this.quotas.reserve(tx, { owner, operationId: request.jobId, resource, units, purpose: 'public', now: this.now() });
    const output = await reserve('session-file-bytes', EXPORT_MAX_BYTES), blob = await reserve('blob-bytes', EXPORT_MAX_BYTES), temporary = await reserve('session-file-bytes', EXPORT_TEMPORARY_BYTES), sql = await reserve('sql-bytes', 65_536);
    await tx.query("INSERT INTO object_resources(session_id,workspace_id,id,kind,state,byte_length,sha256,created_at) VALUES($1,$2,$3,'artifact','reserved',$4,$5,$6)", [owner.sessionId, owner.workspaceId, request.artifactId, EXPORT_MAX_BYTES, '0'.repeat(64), this.now()]);
    const hashes = (await tx.query<{ id: string; sha256: string }>('SELECT f.id,f.sha256 FROM snapshot_sources s JOIN stored_files f ON f.session_id=s.session_id AND f.workspace_id=s.workspace_id AND f.id=s.source_file_id WHERE s.session_id=$1 AND s.workspace_id=$2 AND s.version_id=$3 ORDER BY f.id', [owner.sessionId, owner.workspaceId, request.intent.versionId])).rows;
    await tx.query("INSERT INTO export_artifacts(session_id,workspace_id,id,version_id,kind,run_id,job_id,status,expires_at,source_hashes,filename) VALUES($1,$2,$3,$4,$5,$6,$7,'preparing',$8,$9,$10)", [owner.sessionId, owner.workspaceId, request.artifactId, request.intent.versionId, request.intent.kind, request.intent.kind === 'results' ? request.intent.runId : null, request.jobId, new Date(+this.now() + 3_600_000), Object.fromEntries(hashes.map(row => [row.id, row.sha256])), request.intent.kind + '.zip']);
    await tx.query('INSERT INTO export_reservations(session_id,workspace_id,artifact_id,session_bytes_id,blob_bytes_id,temporary_bytes_id) VALUES($1,$2,$3,$4,$5,$6)', [owner.sessionId, owner.workspaceId, request.artifactId, output.id, blob.id, temporary.id]);
    await this.quotas.consume(tx, { reservationId: sql.id, now: this.now() });
  }
  async stageFile(claim: HostedJobClaim, artifactId: string, location: string): Promise<ExportArtifactCandidate> {
    const info = await lstat(location); if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > EXPORT_MAX_BYTES) throw new ApiError('EXPORT_LIMIT');
    const start = await this.database.transaction(async tx => { await assertClaimAuthority(tx, claim, this.now()); const artifact = await this.artifact(tx, claim, artifactId);
      if (artifact.status !== 'preparing' || artifact.job_id !== claim.jobId || claim.kind !== 'export') throw new ApiError('EXPORT_NOT_AVAILABLE'); return artifact; });
    const file = await open(location, 'r'), hash = createHash('sha256'); let total = 0, index = 0;
    try {
      while (total < info.size) {
        const expected = Math.min(TRANSFER_PART_MAX_BYTES, info.size - total), bytes = Buffer.alloc(expected); let filled = 0;
        while (filled < expected) { const read = await file.read(bytes, filled, expected - filled, total + filled); if (!read.bytesRead) throw new ApiError('EXPORT_NOT_AVAILABLE'); filled += read.bytesRead; }
        const partHash = createHash('sha256').update(bytes).digest('hex'), allocation = await this.database.transaction(async tx => {
          await assertClaimAuthority(tx, claim, this.now()); const artifact = await this.artifact(tx, claim, artifactId); if (artifact.status !== 'preparing' || artifact.job_id !== claim.jobId) throw new ApiError('EXPORT_NOT_AVAILABLE');
          const reservations = await this.reservations(tx, claim, artifactId), state = await this.quotas.split(tx, { reservationId: reservations.session_bytes_id, units: bytes.length, now: this.now() }), blob = await this.quotas.split(tx, { reservationId: reservations.blob_bytes_id, units: bytes.length, now: this.now() });
          return { sessionBytes: state.id, blobBytes: blob.id };
        });
        const object = await this.objects.putObject(claim, bytes, { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt }, 'files', allocation);
        await this.database.transaction(async tx => { await assertClaimAuthority(tx, claim, this.now());
          const physical = (await tx.query('SELECT status,sha256,byte_length FROM physical_objects WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [claim.sessionId, claim.workspaceId, object.objectId])).rows[0];
          if (!physical || physical.status !== 'stored' || physical.sha256 !== partHash || Number(physical.byte_length) !== bytes.byteLength) throw new ApiError('EXPORT_NOT_AVAILABLE');
          await tx.query("INSERT INTO object_parts(session_id,workspace_id,resource_id,part_index,size,sha256,object_id,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'stored',$8)", [claim.sessionId, claim.workspaceId, artifactId, index, bytes.length, partHash, object.objectId, this.now()]);
          await tx.query('UPDATE physical_objects SET ref_count=ref_count+1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, object.objectId]);
        }); hash.update(bytes); total += bytes.length; index++;
      }
      const final = await file.stat(); if (final.size !== info.size || total !== info.size || index > EXPORT_MAX_PARTS) throw new ApiError('EXPORT_LIMIT');
    } finally { await file.close(); }
    const candidate: ExportArtifactCandidate = { artifactId, manifestId: randomUUID(), byteLength: total, sha256: hash.digest('hex'), partCount: index, intent: intentFor(claim, start) };
    await this.database.transaction(async tx => { await assertClaimAuthority(tx, claim, this.now());
      await tx.query("UPDATE object_resources SET byte_length=$4,sha256=$5,state='sealing' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, artifactId, total, candidate.sha256]);
      await tx.query("INSERT INTO object_manifests(session_id,workspace_id,id,resource_id,codec_version,whole_size,whole_sha256,part_count,state) VALUES($1,$2,$3,$4,1,$5,$6,$7,'sealing')", [claim.sessionId, claim.workspaceId, candidate.manifestId, artifactId, total, candidate.sha256, index]);
    }); return candidate;
  }
  async publish(tx: DatabaseTransaction, claim: HostedJobClaim, candidate: ExportArtifactCandidate): Promise<void> {
    await assertClaimAuthority(tx, claim, this.now()); const artifact = await this.artifact(tx, claim, candidate.artifactId);
    if (artifact.status !== 'preparing' || artifact.job_id !== claim.jobId || claim.kind !== 'export' || !sameDownloadIntent(intentFor(claim, artifact), candidate.intent) || Number(artifact.byte_length) !== candidate.byteLength || artifact.sha256 !== candidate.sha256) throw new ApiError('EXPORT_NOT_AVAILABLE');
    const manifest = (await tx.query('SELECT id,whole_size,whole_sha256,part_count,state FROM object_manifests WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND resource_id=$4 FOR UPDATE', [claim.sessionId, claim.workspaceId, candidate.manifestId, candidate.artifactId])).rows[0], parts = await this.parts(tx, claim, candidate.artifactId);
    if (!manifest || manifest.state !== 'sealing' || Number(manifest.whole_size) !== candidate.byteLength || manifest.whole_sha256 !== candidate.sha256 || manifest.part_count !== candidate.partCount || parts.length !== candidate.partCount || !isCompleteTransferManifest({ byteLength: candidate.byteLength, parts: parts.map(partDto) })) throw new ApiError('TRANSFER_INCOMPLETE');
    await tx.query("UPDATE object_manifests SET state='retained',sealed_at=$4,ref_count=1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, candidate.manifestId, this.now()]);
    await tx.query("UPDATE object_resources SET state='retained' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, candidate.artifactId]);
    await tx.query("UPDATE export_artifacts SET status='ready',manifest_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, candidate.artifactId, candidate.manifestId]);
    const reservations = await this.reservations(tx, claim, candidate.artifactId);
    for (const reservationId of [reservations.session_bytes_id, reservations.blob_bytes_id, reservations.temporary_bytes_id]) await this.quotas.release(tx, { reservationId, confirmedAbsent: true, now: this.now() });
  }
  async manifest(owner: WorkspaceOwner, artifactId: string): Promise<ExportManifestDTO> {
    return this.database.transaction(async tx => { await this.authorize(tx, owner); const artifact = await this.available(tx, owner, artifactId), parts = await this.parts(tx, owner, artifactId);
      const manifest: ExportManifestDTO = { artifactId, intent: intentFor(owner, artifact), filename: artifact.filename, byteLength: Number(artifact.byte_length), sha256: artifact.sha256, expiresAt: artifact.expires_at.toISOString(), parts: parts.map(partDto) };
      if (!isCompleteTransferManifest(manifest)) throw new ApiError('EXPORT_NOT_AVAILABLE'); return manifest;
    });
  }
  async summary(owner: WorkspaceOwner, artifactId: string): Promise<ExportArtifactSummaryDTO> {
    const manifest = await this.manifest(owner, artifactId); return this.database.transaction(async tx => { await this.authorize(tx, owner); const row = await this.available(tx, owner, artifactId);
      return { id: artifactId, jobId: row.job_id, intent: manifest.intent, intentFingerprint: createHash('sha256').update(downloadIntentKey(manifest.intent)).digest('hex'), status: 'ready', size: manifest.byteLength, sha256: manifest.sha256, filename: row.filename as 'report.zip'|'results.zip', mimeType: 'application/zip' };
    });
  }
  async part(owner: WorkspaceOwner, artifactId: string, index: number): Promise<Uint8Array> {
    if (!Number.isInteger(index) || index < 0 || index >= EXPORT_MAX_PARTS) throw new ApiError('RESOURCE_NOT_FOUND');
    const part = await this.database.transaction(async tx => { await this.authorize(tx, owner); await this.available(tx, owner, artifactId); const row = (await this.parts(tx, owner, artifactId)).find(row => row.part_index === index); if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row; });
    const bytes = await this.objects.getObject(owner, { objectId: part.object_id, byteLength: part.size, sha256: part.sha256 });
    await this.database.transaction(async tx => { await this.authorize(tx, owner); await this.available(tx, owner, artifactId); }); return bytes;
  }
  private async artifact(tx: DatabaseTransaction, owner: WorkspaceOwner, artifactId: string): Promise<ArtifactRow> {
    const row = (await tx.query<ArtifactRow>('SELECT a.*,r.byte_length,r.sha256 FROM export_artifacts a JOIN object_resources r USING(session_id,workspace_id,id) WHERE a.session_id=$1 AND a.workspace_id=$2 AND a.id=$3 FOR UPDATE OF a,r', [owner.sessionId, owner.workspaceId, artifactId])).rows[0]; if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
  }
  private async available(tx: DatabaseTransaction, owner: WorkspaceOwner, artifactId: string): Promise<ArtifactRow> { const row = await this.artifact(tx, owner, artifactId); if (+row.expires_at <= +this.now() || row.status === 'expired') throw new ApiError('ARTIFACT_EXPIRED'); if (row.status !== 'ready' || !row.manifest_id) throw new ApiError('EXPORT_NOT_AVAILABLE'); return row; }
  private async parts(tx: DatabaseTransaction, owner: WorkspaceOwner, artifactId: string): Promise<PartsRow[]> {
    return (await tx.query<PartsRow>("SELECT p.part_index,p.size,p.sha256,p.object_id FROM object_parts p JOIN physical_objects o ON o.session_id=p.session_id AND o.workspace_id=p.workspace_id AND o.id=p.object_id WHERE p.session_id=$1 AND p.workspace_id=$2 AND p.resource_id=$3 AND p.status='stored' AND o.status='stored' ORDER BY p.part_index", [owner.sessionId, owner.workspaceId, artifactId])).rows;
  }
  private async reservations(tx: DatabaseTransaction, owner: WorkspaceOwner, artifactId: string): Promise<ReservationRow> { const row = (await tx.query<ReservationRow>('SELECT * FROM export_reservations WHERE session_id=$1 AND workspace_id=$2 AND artifact_id=$3 FOR UPDATE', [owner.sessionId, owner.workspaceId, artifactId])).rows[0]; if (!row) throw new ApiError('EXPORT_NOT_AVAILABLE'); return row; }
  private async authorize(tx: DatabaseTransaction, owner: WorkspaceOwner): Promise<void> { await assertLiveSession(tx, owner.sessionId, this.now(), { lock: true }); await requireWorkspace(tx, owner, true); }
}
