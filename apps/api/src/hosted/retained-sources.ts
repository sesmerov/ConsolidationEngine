import { createHash } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { INPUT_BATCH_MAX_BYTES } from '@ce/contracts';
import type { SourceFile } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { ObjectLedger } from './object-ledger.js';
import { assertClaimAuthority, type HostedJobClaim } from './job-coordinator.js';
import type { CanonicalWriteContext } from './canonical-codec.js';
import { SessionFiles } from '../storage/session-files.js';
import type { StagedFile } from '../import/multipart-staging.js';
import type { TransferFileDescriptor } from '../storage/upload-batches.js';
import { assertLiveSession } from './session-service.js';
import { requireWorkspace, requireVersion } from './postgres-repository.js';

interface SourceRow extends QueryResultRow { id: string; batch_id: string; role: 'catalog'|'report'; name: string; byte_length: string; sha256: string; state: string; manifest_id: string; whole_size: string; whole_sha256: string; part_count: number; created_at: Date }
interface PartRow extends QueryResultRow { part_index: number; size: number; sha256: string; object_id: string }
export interface MaterializedSources { readonly files: readonly StagedFile[]; dispose(): Promise<void> }

/** The immutable originals belong to every referencing version. tmp is disposable worker scratch only. */
export class HostedRetainedSources {
  constructor(readonly database: HostedDatabase, readonly objects: ObjectLedger, readonly now: () => Date = () => new Date()) {}
  async promote(tx: DatabaseTransaction, claim: HostedJobClaim, versionId: string, sourceIds: readonly string[]): Promise<void> {
    await assertClaimAuthority(tx, claim, this.now()); await requireVersion(tx, claim, versionId);
    if (sourceIds.length < 2 || sourceIds.length > 21 || new Set(sourceIds).size !== sourceIds.length) throw new ApiError('TRANSFER_INCOMPLETE');
    for (const id of sourceIds) {
      const file = await this.source(tx, claim, id);
      const added = await tx.query('INSERT INTO snapshot_sources(session_id,workspace_id,version_id,source_file_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING source_file_id', [claim.sessionId, claim.workspaceId, versionId, id]);
      if (!added.rowCount) continue;
      await tx.query("UPDATE stored_files SET state='retained',retained_ref_count=retained_ref_count+1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, id]);
      await tx.query("UPDATE object_resources SET state='retained' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, id]);
      await tx.query("UPDATE object_manifests SET state='retained',ref_count=ref_count+1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, file.manifest_id]);
      await tx.query("UPDATE upload_batches SET state='retained' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, file.batch_id]);
    }
  }
  async forVersion(claim: HostedJobClaim, versionId: string, sources: readonly SourceFile[], cancelled: () => boolean = () => false): Promise<MaterializedSources> {
    const descriptors = await this.database.transaction(async tx => {
      await assertClaimAuthority(tx, claim, this.now()); await requireVersion(tx, claim, versionId); const result: TransferFileDescriptor[] = [];
      for (const expected of sources) {
        const link = (await tx.query('SELECT source_file_id FROM snapshot_sources WHERE session_id=$1 AND workspace_id=$2 AND version_id=$3 AND source_file_id=$4', [claim.sessionId, claim.workspaceId, versionId, expected.id])).rows[0];
        if (!link) throw new ApiError('EXPORT_NOT_AVAILABLE'); const file = await this.source(tx, claim, expected.id);
        if (file.sha256 !== expected.sha256 || Number(file.byte_length) !== expected.size || file.role !== expected.kind || file.state !== 'retained') throw new ApiError('EXPORT_NOT_AVAILABLE'); result.push(await this.descriptor(tx, claim, file));
      } return result;
    }); return this.materialize(claim, descriptors, cancelled);
  }
  async forBatch(claim: HostedJobClaim, batchId: string, cancelled: () => boolean = () => false): Promise<MaterializedSources> {
    const descriptors = await this.database.transaction(async tx => {
      await assertClaimAuthority(tx, claim, this.now());
      const batch = (await tx.query("SELECT id FROM upload_batches WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND state IN ('sealed','retained')", [claim.sessionId, claim.workspaceId, batchId])).rows[0]; if (!batch) throw new ApiError('TRANSFER_INCOMPLETE');
      const ids = (await tx.query<{ id: string }>('SELECT id FROM stored_files WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3 ORDER BY role,client_file_id', [claim.sessionId, claim.workspaceId, batchId])).rows;
      const result: TransferFileDescriptor[] = []; for (const { id } of ids) result.push(await this.descriptor(tx, claim, await this.source(tx, claim, id))); return result;
    }); return this.materialize(claim, descriptors, cancelled);
  }
  private async source(tx: DatabaseTransaction, owner: WorkspaceOwner, id: string): Promise<SourceRow> {
    const row = (await tx.query<SourceRow>(`SELECT f.*,r.created_at,m.id AS manifest_id,m.whole_size,m.whole_sha256 FROM stored_files f JOIN object_resources r USING(session_id,workspace_id,id)
      JOIN object_manifests m ON m.session_id=f.session_id AND m.workspace_id=f.workspace_id AND m.resource_id=f.id
      WHERE f.session_id=$1 AND f.workspace_id=$2 AND f.id=$3 AND f.state IN ('sealed','retained') AND m.state IN ('sealed','retained') FOR UPDATE OF f,m`, [owner.sessionId, owner.workspaceId, id])).rows[0];
    if (!row || Number(row.byte_length) !== Number(row.whole_size) || row.sha256 !== row.whole_sha256) throw new ApiError('EXPORT_NOT_AVAILABLE'); return row;
  }
  private async descriptor(tx: DatabaseTransaction, owner: WorkspaceOwner, row: SourceRow): Promise<TransferFileDescriptor> {
    const parts = (await tx.query<PartRow>("SELECT part_index,size,sha256,object_id FROM object_parts WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3 AND status='stored' ORDER BY part_index", [owner.sessionId, owner.workspaceId, row.id])).rows;
    if (parts.length !== row.part_count || parts.some((part, i) => part.part_index !== i) || parts.reduce((sum, part) => sum + part.size, 0) !== Number(row.byte_length)) throw new ApiError('EXPORT_NOT_AVAILABLE');
    return { source: { id: row.id, kind: row.role, displayName: row.name, size: Number(row.byte_length), sha256: row.sha256, importedAt: row.created_at.toISOString() }, parts: parts.map(part => ({ objectId: part.object_id, byteLength: part.size, sha256: part.sha256 })) };
  }
  private async materialize(claim: HostedJobClaim, descriptors: readonly TransferFileDescriptor[], cancelled: () => boolean): Promise<MaterializedSources> {
    const total = descriptors.reduce((sum, file) => sum + file.source.size, 0); if (!descriptors.length || descriptors.length > 21 || total > INPUT_BATCH_MAX_BYTES) throw new ApiError('EXPORT_LIMIT');
    const temporary = await SessionFiles.create(claim.sessionId, undefined, INPUT_BATCH_MAX_BYTES), files: StagedFile[] = [];
    const context: CanonicalWriteContext = { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt, cancelled };
    try {
      await temporary.createWorkspace(claim.workspaceId);
      for (const { source, parts } of descriptors) {
        const lease = temporary.reserve(claim.workspaceId, source.size), output = await temporary.openFile(claim.workspaceId, lease), hash = createHash('sha256'); let size = 0;
        try { for (const part of parts) { const bytes = await this.objects.getObject(claim, part, context); size += bytes.byteLength; if (size > source.size) throw new ApiError('EXPORT_NOT_AVAILABLE'); hash.update(bytes); await output.handle.writeFile(bytes); }
          await output.handle.close(); if (size !== source.size || hash.digest('hex') !== source.sha256) throw new ApiError('EXPORT_NOT_AVAILABLE'); await temporary.retain(lease, [output.id]); files.push({ ...source, path: output.path });
        } finally { await output.handle.close().catch(() => undefined); lease.release(); }
      }
      await this.database.transaction(tx => assertClaimAuthority(tx, claim, this.now())); return { files, dispose: () => temporary.close() };
    } catch (error) { await temporary.close(); throw error; }
  }
}
