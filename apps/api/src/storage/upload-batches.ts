import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import { INPUT_BATCH_MAX_BYTES, INPUT_FILE_MAX_BYTES, TRANSFER_PART_MAX_BYTES, UUID_PATTERN, safeDisplayName, uploadBatchDeclarationIssues } from '@ce/contracts';
import type { SourceFile, TransferPartDTO, UploadBatchCreateDTO, UploadBatchDTO, UploadBatchState, UploadedFileDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { DatabaseTransaction, HostedDatabase } from '../hosted/database.js';
import { ObjectLedger } from '../hosted/object-ledger.js';
import { QuotaLedger } from '../hosted/quota-ledger.js';
import { assertLiveSession, touchMeaningful } from '../hosted/session-service.js';
import { requireWorkspace, workspaceEtag } from '../hosted/postgres-repository.js';
import { assertClaimAuthority, type HostedJobClaim } from '../hosted/job-coordinator.js';
import type { PrivateObjectReference } from '../ports/object-store.js';
import { canonicalHash } from '../session/canonical-state.js';

interface BatchRow extends QueryResultRow { id: string; base_version_id: string | null; state: UploadBatchState; expires_at: Date; reservation_id: string; seal_job_id: string | null }
interface FileRow extends QueryResultRow { id: string; batch_id: string; client_file_id: string; role: 'catalog'|'report'; name: string; byte_length: string; sha256: string; part_count: number; state: UploadBatchState; created_at: Date }
interface PartRow extends QueryResultRow { part_index: number; size: number; sha256: string; object_id: string }
interface ClaimRow extends QueryResultRow { size: number; sha256: string; session_bytes_id: string; blob_bytes_id: string; state: string }
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const receipt = (part: Pick<PartRow, 'part_index'|'size'|'sha256'>): TransferPartDTO => ({ index: part.part_index, size: part.size, sha256: part.sha256 });
export interface TransferFileDescriptor { readonly source: SourceFile; readonly parts: readonly PrivateObjectReference[] }
export interface SealedBatchCandidate { readonly batchId: string; readonly files: readonly { readonly fileId: string; readonly manifestId: string; readonly byteLength: number; readonly sha256: string; readonly partCount: number; readonly expandedBytes: number }[] }

/** Shared wire protocol. Hosted state lives in SQL; local parity is provided independently of this adapter. */
export interface UploadBatchService {
  create(owner: WorkspaceOwner, declaration: UploadBatchCreateDTO, etag: string, key: string): Promise<UploadBatchDTO>;
  get(owner: WorkspaceOwner, batchId: string): Promise<UploadBatchDTO>;
  authorizePart(owner: WorkspaceOwner, batchId: string, fileId: string, index: number, declaredSize?: number): Promise<void>;
  putPart(owner: WorkspaceOwner, batchId: string, fileId: string, index: number, bytes: Uint8Array, expectedSha: string): Promise<TransferPartDTO>;
  cancel(owner: WorkspaceOwner, batchId: string): Promise<void>;
}
export class HostedUploadBatches implements UploadBatchService {
  constructor(readonly database: HostedDatabase, readonly objects: ObjectLedger, readonly quotas: QuotaLedger, readonly now: () => Date = () => new Date()) {}
  async create(owner: WorkspaceOwner, declaration: UploadBatchCreateDTO, etag: string, key: string): Promise<UploadBatchDTO> {
    validateDeclaration(declaration); if (!etag) throw new ApiError('PRECONDITION_REQUIRED');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key ?? '')) throw new ApiError('INVALID_REQUEST', { reason: 'IDEMPOTENCY_KEY_REQUIRED' });
    const keyHash = sha(Buffer.from(key)), fingerprint = canonicalHash(declaration), route = `/api/v1/workspaces/${owner.workspaceId}/upload-batches`;
    const batchId = await this.database.transaction(async tx => {
      const now = this.now(); await assertLiveSession(tx, owner.sessionId, now, { lock: true });
      const prior = (await tx.query('SELECT * FROM mutation_receipts WHERE session_id=$1 AND key_hash=$2', [owner.sessionId, keyHash])).rows[0];
      if (prior) {
        if (prior.method !== 'POST' || prior.path !== route || prior.expected_base !== etag || prior.request_fingerprint !== fingerprint || prior.workspace_id !== owner.workspaceId) throw new ApiError('IDEMPOTENCY_CONFLICT');
        return String(prior.response.batchId);
      }
      const workspace = await requireWorkspace(tx, owner, true);
      if (workspaceEtag(workspace) !== etag || workspace.current_version_id !== declaration.baseVersionId) throw new ApiError('STALE_VERSION');
      const id = randomUUID(), total = declaration.files.reduce((sum, file) => sum + file.byteLength, 0), reserve = (resource: 'session-file-bytes'|'blob-bytes'|'sql-bytes', units: number) => this.quotas.reserve(tx, { owner, operationId: id, resource, units, purpose: 'public', now });
      const state = await reserve('session-file-bytes', total), blob = await reserve('blob-bytes', total), metadata = await reserve('sql-bytes', 32 * 1024 * (declaration.files.length + 1));
      await tx.query("INSERT INTO upload_batches(session_id,workspace_id,id,base_version_id,declared_total_bytes,state,reservation_id,expires_at,created_at) VALUES($1,$2,$3,$4,$5,'reserved',$6,$7,$8)", [owner.sessionId, owner.workspaceId, id, declaration.baseVersionId, total, metadata.id, new Date(+now + 3_600_000), now]);
      await tx.query('INSERT INTO upload_batch_reservations(session_id,workspace_id,batch_id,session_bytes_id,blob_bytes_id) VALUES($1,$2,$3,$4,$5)', [owner.sessionId, owner.workspaceId, id, state.id, blob.id]);
      for (const file of declaration.files) {
        const fileId = randomUUID(); await tx.query("INSERT INTO object_resources(session_id,workspace_id,id,kind,state,byte_length,sha256,created_at) VALUES($1,$2,$3,'file','reserved',$4,$5,$6)", [owner.sessionId, owner.workspaceId, fileId, file.byteLength, file.sha256, now]);
        await tx.query("INSERT INTO stored_files(session_id,workspace_id,id,batch_id,client_file_id,role,name,mime,byte_length,sha256,part_count,state) VALUES($1,$2,$3,$4,$5,$6,$7,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',$8,$9,$10,'reserved')", [owner.sessionId, owner.workspaceId, fileId, id, file.clientFileId, file.role, safeDisplayName(file.name), file.byteLength, file.sha256, Math.ceil(file.byteLength / TRANSFER_PART_MAX_BYTES)]);
      }
      await tx.query("INSERT INTO mutation_receipts(session_id,key_hash,method,path,request_fingerprint,expected_base,workspace_id,response_status,response,created_at) VALUES($1,$2,'POST',$3,$4,$5,$6,201,$7,$8)", [owner.sessionId, keyHash, route, fingerprint, etag, owner.workspaceId, { batchId: id }, now]);
      await this.quotas.consume(tx, { reservationId: metadata.id, now }); await touchMeaningful(tx, owner.sessionId, now); return id;
    }); return this.get(owner, batchId);
  }
  async get(owner: WorkspaceOwner, batchId: string): Promise<UploadBatchDTO> {
    return this.database.transaction(async tx => { await this.authorize(tx, owner); const batch = await this.batch(tx, owner, batchId);
      const files = (await tx.query<FileRow>('SELECT * FROM stored_files WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3 ORDER BY role,client_file_id', [owner.sessionId, owner.workspaceId, batchId])).rows;
      const result: UploadedFileDTO[] = [];
      for (const file of files) { const parts = (await tx.query<PartRow>("SELECT part_index,size,sha256,object_id FROM object_parts WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3 AND status='stored' ORDER BY part_index", [owner.sessionId, owner.workspaceId, file.id])).rows;
        result.push({ id: file.id, clientFileId: file.client_file_id, role: file.role, name: file.name, byteLength: Number(file.byte_length), sha256: file.sha256, partCount: file.part_count, parts: parts.map(receipt) }); }
      return { id: batch.id, workspaceId: owner.workspaceId, baseVersionId: batch.base_version_id, state: batch.state, partSize: TRANSFER_PART_MAX_BYTES, expiresAt: batch.expires_at.toISOString(), files: result };
    });
  }
  async authorizePart(owner: WorkspaceOwner, batchId: string, fileId: string, index: number, declaredSize?: number): Promise<void> {
    await this.database.transaction(async tx => { await this.authorize(tx, owner); this.writable(await this.batch(tx, owner, batchId)); const file = await this.file(tx, owner, batchId, fileId); const size = partSize(file, index); if (declaredSize !== undefined && size !== declaredSize) throw new ApiError('TRANSFER_PART_CONFLICT'); });
  }
  async putPart(owner: WorkspaceOwner, batchId: string, fileId: string, index: number, bytes: Uint8Array, expectedSha: string): Promise<TransferPartDTO> {
    if (!bytes.byteLength || bytes.byteLength > TRANSFER_PART_MAX_BYTES) throw new ApiError('UPLOAD_LIMIT');
    if (!/^[a-f0-9]{64}$/.test(expectedSha) || sha(bytes) !== expectedSha) throw new ApiError('TRANSFER_PART_CONFLICT');
    const plan = await this.database.transaction(async tx => {
      await this.authorize(tx, owner); this.writable(await this.batch(tx, owner, batchId)); const file = await this.file(tx, owner, batchId, fileId);
      if (partSize(file, index) !== bytes.byteLength) throw new ApiError('TRANSFER_PART_CONFLICT');
      const recorded = (await tx.query<PartRow>("SELECT part_index,size,sha256,object_id FROM object_parts WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3 AND part_index=$4 AND status='stored'", [owner.sessionId, owner.workspaceId, fileId, index])).rows[0];
      if (recorded) { if (recorded.size !== bytes.byteLength || recorded.sha256 !== expectedSha) throw new ApiError('TRANSFER_PART_CONFLICT'); return { recorded }; }
      const previous = (await tx.query<ClaimRow>('SELECT * FROM upload_part_claims WHERE session_id=$1 AND workspace_id=$2 AND file_id=$3 AND part_index=$4 FOR UPDATE', [owner.sessionId, owner.workspaceId, fileId, index])).rows[0];
      if (previous) { if (previous.size !== bytes.byteLength || previous.sha256 !== expectedSha || previous.state !== 'pending') throw new ApiError('TRANSFER_PART_CONFLICT'); return { claim: previous }; }
      const budgets = (await tx.query<{ session_bytes_id: string; blob_bytes_id: string }>('SELECT session_bytes_id,blob_bytes_id FROM upload_batch_reservations WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3', [owner.sessionId, owner.workspaceId, batchId])).rows[0]!;
      const state = await this.quotas.split(tx, { reservationId: budgets.session_bytes_id, units: bytes.byteLength, now: this.now() }), blob = await this.quotas.split(tx, { reservationId: budgets.blob_bytes_id, units: bytes.byteLength, now: this.now() });
      await tx.query("INSERT INTO upload_part_claims(session_id,workspace_id,batch_id,file_id,part_index,size,sha256,session_bytes_id,blob_bytes_id,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')", [owner.sessionId, owner.workspaceId, batchId, fileId, index, bytes.byteLength, expectedSha, state.id, blob.id]);
      return { claim: { size: bytes.byteLength, sha256: expectedSha, session_bytes_id: state.id, blob_bytes_id: blob.id, state: 'pending' } as ClaimRow };
    });
    if ('recorded' in plan) return receipt(plan.recorded);
    const context = { operationId: batchId, deadline: new Date(+this.now() + 60_000).toISOString() };
    const object = await this.objects.putObject(owner, bytes, context, 'files', { sessionBytes: plan.claim.session_bytes_id, blobBytes: plan.claim.blob_bytes_id });
    try { return await this.database.transaction(async tx => {
      await this.authorize(tx, owner); this.writable(await this.batch(tx, owner, batchId)); await this.file(tx, owner, batchId, fileId);
      const physical = (await tx.query('SELECT status,sha256,byte_length FROM physical_objects WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [owner.sessionId, owner.workspaceId, object.objectId])).rows[0];
      if (!physical || physical.status !== 'stored' || physical.sha256 !== expectedSha || Number(physical.byte_length) !== bytes.byteLength) throw new ApiError('TRANSFER_INCOMPLETE');
      const inserted = await tx.query("INSERT INTO object_parts(session_id,workspace_id,resource_id,part_index,size,sha256,object_id,status,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,'stored',$8) ON CONFLICT DO NOTHING RETURNING part_index", [owner.sessionId, owner.workspaceId, fileId, index, bytes.byteLength, expectedSha, object.objectId, this.now()]);
      if (inserted.rowCount) await tx.query('UPDATE physical_objects SET ref_count=ref_count+1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, object.objectId]);
      await tx.query("UPDATE upload_part_claims SET state='recorded' WHERE session_id=$1 AND workspace_id=$2 AND file_id=$3 AND part_index=$4", [owner.sessionId, owner.workspaceId, fileId, index]);
      await tx.query("UPDATE upload_batches SET state='receiving' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, batchId]);
      await tx.query("UPDATE stored_files SET state='receiving' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, fileId]);
      await tx.query("UPDATE object_resources SET state='receiving' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, fileId]);
      return { index, size: bytes.byteLength, sha256: expectedSha };
    }); } catch (error) { await this.database.transaction(tx => this.enqueueCleanup(tx, owner, { kind: 'physical-object', objectId: object.objectId }, 'unregistered-upload-part')); throw error; }
  }
  async cancel(owner: WorkspaceOwner, batchId: string): Promise<void> {
    await this.database.transaction(async tx => {
      await this.authorize(tx, owner); const batch = await this.batch(tx, owner, batchId); if (batch.state === 'retained') return;
      await tx.query("UPDATE upload_batches SET state='cleanup_pending' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, batchId]);
      await tx.query("UPDATE stored_files SET state='cleanup_pending' WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3 AND retained_ref_count=0", [owner.sessionId, owner.workspaceId, batchId]);
      const budgets = (await tx.query<{ session_bytes_id: string; blob_bytes_id: string }>('SELECT session_bytes_id,blob_bytes_id FROM upload_batch_reservations WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3', [owner.sessionId, owner.workspaceId, batchId])).rows[0]!;
      for (const reservationId of [budgets.session_bytes_id, budgets.blob_bytes_id]) await this.quotas.release(tx, { reservationId, confirmedAbsent: true, now: this.now() });
      if (batch.seal_job_id) await tx.query("UPDATE jobs SET cancel_requested_at=coalesce(cancel_requested_at,$4) WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND status IN ('queued','dispatch_pending','running')", [owner.sessionId, owner.workspaceId, batch.seal_job_id, this.now()]);
      await this.enqueueCleanup(tx, owner, { kind: 'upload-batch', batchId }, 'cancelled-upload');
    });
  }
  /** SQL-only acceptance hook, called after the durable job identity is inserted. */
  async prepareSeal(tx: DatabaseTransaction, owner: WorkspaceOwner, batchId: string, jobId: string): Promise<void> {
    await this.authorize(tx, owner); this.writable(await this.batch(tx, owner, batchId)); await this.completeFiles(tx, owner, batchId);
    await tx.query("UPDATE upload_batches SET state='sealing',seal_job_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, batchId, jobId]);
    await tx.query("UPDATE stored_files SET state='sealing' WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3", [owner.sessionId, owner.workspaceId, batchId]);
  }
  async filesForSeal(claim: HostedJobClaim, batchId: string): Promise<readonly TransferFileDescriptor[]> {
    return this.database.transaction(async tx => { await assertClaimAuthority(tx, claim, this.now()); const batch = await this.batch(tx, claim, batchId);
      if (batch.state !== 'sealing' || batch.seal_job_id !== claim.jobId || claim.kind !== 'seal-upload') throw new ApiError('TRANSFER_INCOMPLETE');
      return this.completeFiles(tx, claim, batchId);
    });
  }
  /** Invoked in the same fenced transaction that publishes the job result; the candidate contains no file bytes or paths. */
  async publishSealed(tx: DatabaseTransaction, claim: HostedJobClaim, candidate: SealedBatchCandidate): Promise<void> {
    await assertClaimAuthority(tx, claim, this.now()); const batch = await this.batch(tx, claim, candidate.batchId);
    if (batch.state !== 'sealing' || batch.seal_job_id !== claim.jobId || claim.kind !== 'seal-upload') throw new ApiError('TRANSFER_INCOMPLETE');
    const files = await this.completeFiles(tx, claim, candidate.batchId);
    if (candidate.files.length !== files.length || new Set(candidate.files.map(file => file.fileId)).size !== files.length || candidate.files.reduce((sum, file) => sum + file.expandedBytes, 0) > 100 * 1024 * 1024) throw new ApiError('TRANSFER_INCOMPLETE');
    for (const file of files) {
      const verified = candidate.files.find(row => row.fileId === file.source.id);
      if (!verified || !UUID_PATTERN.test(verified.manifestId) || verified.sha256 !== file.source.sha256 || verified.byteLength !== file.source.size || verified.partCount !== file.parts.length || !Number.isSafeInteger(verified.expandedBytes) || verified.expandedBytes < 0) throw new ApiError('TRANSFER_INCOMPLETE');
      await tx.query("INSERT INTO object_manifests(session_id,workspace_id,id,resource_id,codec_version,whole_size,whole_sha256,part_count,sealed_at,state) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'sealed')", [claim.sessionId, claim.workspaceId, verified.manifestId, verified.fileId, verified.byteLength, verified.sha256, verified.partCount, this.now()]);
      await tx.query("UPDATE stored_files SET state='sealed' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, verified.fileId]);
      await tx.query("UPDATE object_resources SET state='sealed' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, verified.fileId]);
    }
    await tx.query("UPDATE upload_batches SET state='sealed' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, candidate.batchId]);
  }
  private async completeFiles(tx: DatabaseTransaction, owner: WorkspaceOwner, batchId: string): Promise<TransferFileDescriptor[]> {
    const files = (await tx.query<FileRow>('SELECT f.*,r.created_at FROM stored_files f JOIN object_resources r USING(session_id,workspace_id,id) WHERE f.session_id=$1 AND f.workspace_id=$2 AND f.batch_id=$3 ORDER BY f.role,f.client_file_id', [owner.sessionId, owner.workspaceId, batchId])).rows;
    const result: TransferFileDescriptor[] = [];
    for (const file of files) {
      const parts = (await tx.query<PartRow>("SELECT p.part_index,p.size,p.sha256,p.object_id FROM object_parts p JOIN physical_objects o ON o.session_id=p.session_id AND o.workspace_id=p.workspace_id AND o.id=p.object_id WHERE p.session_id=$1 AND p.workspace_id=$2 AND p.resource_id=$3 AND p.status='stored' AND o.status='stored' ORDER BY p.part_index", [owner.sessionId, owner.workspaceId, file.id])).rows;
      if (parts.length !== file.part_count || parts.some((part, index) => part.part_index !== index || part.size !== partSize(file, index))) throw new ApiError('TRANSFER_INCOMPLETE');
      result.push({ source: { id: file.id, kind: file.role, displayName: file.name, size: Number(file.byte_length), sha256: file.sha256, importedAt: file.created_at.toISOString() }, parts: parts.map(part => ({ objectId: part.object_id, byteLength: part.size, sha256: part.sha256 })) });
    }
    if (files.length < 2 || files.length > 21) throw new ApiError('TRANSFER_INCOMPLETE'); return result;
  }
  async authorize(tx: DatabaseTransaction, owner: WorkspaceOwner): Promise<void> { await assertLiveSession(tx, owner.sessionId, this.now(), { lock: true }); await requireWorkspace(tx, owner, true); }
  async batch(tx: DatabaseTransaction, owner: WorkspaceOwner, id: string): Promise<BatchRow> {
    if (!UUID_PATTERN.test(id)) throw new ApiError('RESOURCE_NOT_FOUND');
    const row = (await tx.query<BatchRow>('SELECT * FROM upload_batches WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [owner.sessionId, owner.workspaceId, id])).rows[0]; if (!row || row.state === 'deleted') throw new ApiError('RESOURCE_NOT_FOUND'); return row;
  }
  private async file(tx: DatabaseTransaction, owner: WorkspaceOwner, batchId: string, id: string): Promise<FileRow> {
    if (!UUID_PATTERN.test(id)) throw new ApiError('RESOURCE_NOT_FOUND');
    const row = (await tx.query<FileRow>('SELECT * FROM stored_files WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3 AND id=$4 FOR UPDATE', [owner.sessionId, owner.workspaceId, batchId, id])).rows[0]; if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
  }
  private writable(row: BatchRow): void { if (!['reserved','receiving'].includes(row.state) || +row.expires_at <= +this.now()) throw new ApiError('TRANSFER_INCOMPLETE'); }
  private async enqueueCleanup(tx: DatabaseTransaction, owner: WorkspaceOwner, reference: { kind: string; objectId?: string; batchId?: string }, reason: string): Promise<void> {
    const now = this.now(); await tx.query("INSERT INTO cleanup_tasks(id,session_id,workspace_id,object_ref,reason,not_before,deadline,state,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8)", [randomUUID(), owner.sessionId, owner.workspaceId, reference, reason, new Date(+now + 120_000), new Date(+now + 86_400_000), now]);
  }
}
function partSize(file: FileRow, index: number): number { if (!Number.isInteger(index) || index < 0 || index >= file.part_count) throw new ApiError('INVALID_REQUEST'); return Math.min(TRANSFER_PART_MAX_BYTES, Number(file.byte_length) - index * TRANSFER_PART_MAX_BYTES); }
export function validateDeclaration(value: UploadBatchCreateDTO): void {
  if (!value || !Object.hasOwn(value, 'baseVersionId') || value.baseVersionId !== null && !UUID_PATTERN.test(value.baseVersionId) || !Array.isArray(value.files) || value.files.length < 2 || value.files.length > 21 || uploadBatchDeclarationIssues(value).length) throw new ApiError('INVALID_REQUEST');
  for (const file of value.files) if (!file || !['catalog','report'].includes(file.role) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(file.clientFileId) || typeof file.name !== 'string' || !file.name || file.name.length > 200 || /[\\/\u0000-\u001f\u007f]/.test(file.name) || !file.name.toLowerCase().endsWith('.xlsx') || !Number.isSafeInteger(file.byteLength) || file.byteLength < 1 || file.byteLength > INPUT_FILE_MAX_BYTES || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new ApiError('INVALID_REQUEST');
  if (value.files.reduce((sum, file) => sum + file.byteLength, 0) > INPUT_BATCH_MAX_BYTES) throw new ApiError('INVALID_REQUEST');
}
