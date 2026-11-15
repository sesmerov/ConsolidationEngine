import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
import type { ImportContextInputDTO, JsonValue, TransferPartDTO, UploadBatchCreateDTO, UploadBatchDTO, UploadedFileDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { FileLease, SessionFiles } from '../storage/session-files.js';
import { validateDeclaration, type UploadBatchService } from '../storage/upload-batches.js';
import type { JobAcceptance } from '../jobs/job-manager.js';
import type { StagedFile, StagedUpload } from '../import/multipart-staging.js';
import type { LocalSealInput, LocalSealedFile } from '../workers/local-seal-upload.worker.js';

interface LocalBatch { readonly batch: UploadBatchDTO; readonly createdAt: string; readonly sealJobId?: string }
interface CreationReceipt { readonly fingerprint: string; readonly etag: string; readonly batchId: string }
const recordKey = (owner: WorkspaceOwner, batchId: string) => `upload-batch:${owner.workspaceId}:${batchId}`;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
/** Same bounded public protocol locally. Only local capacity leases/coordination live in process. */
export class LocalUploadBatches implements UploadBatchService {
  private readonly leases = new Map<string, FileLease>();
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(readonly store: WorkspaceStore, readonly files: SessionFiles, readonly now: () => number = Date.now) {}
  async create(owner: WorkspaceOwner, declaration: UploadBatchCreateDTO, etag: string, key: string): Promise<UploadBatchDTO> {
    validateDeclaration(declaration); if (!etag) throw new ApiError('PRECONDITION_REQUIRED');
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key ?? '')) throw new ApiError('INVALID_REQUEST');
    return this.lock(owner, async () => {
      this.authorize(owner); const fingerprint = canonicalHash(declaration), receiptKey = `upload-create:${owner.workspaceId}:${sha(Buffer.from(key))}`, prior = this.store.getRecord<CreationReceipt>(receiptKey);
      if (prior) { if (prior.fingerprint !== fingerprint || prior.etag !== etag) throw new ApiError('IDEMPOTENCY_CONFLICT'); return this.get(owner, prior.batchId); }
      if (this.store.etag(owner.workspaceId) !== etag || (this.store.current(owner.workspaceId)?.versionId ?? null) !== declaration.baseVersionId) throw new ApiError('STALE_VERSION');
      const lease = this.files.reserve(owner.workspaceId, declaration.files.reduce((sum, file) => sum + file.byteLength, 0)), allocated: string[] = [], files: UploadedFileDTO[] = [];
      try {
        for (const file of declaration.files) { const target = await this.files.openFile(owner.workspaceId, lease); allocated.push(target.id); await target.handle.close(); files.push({ ...file, id: target.id, partCount: Math.ceil(file.byteLength / TRANSFER_PART_MAX_BYTES), parts: [] }); }
        this.authorize(owner); if (this.store.etag(owner.workspaceId) !== etag) throw new ApiError('STALE_VERSION');
        const id = randomUUID(), batch: UploadBatchDTO = { id, workspaceId: owner.workspaceId, baseVersionId: declaration.baseVersionId, state: 'reserved', partSize: TRANSFER_PART_MAX_BYTES, expiresAt: new Date(this.now() + 3_600_000).toISOString(), files };
        this.store.putRecords([{ key: recordKey(owner, id), value: { batch, createdAt: new Date(this.now()).toISOString() } as unknown as JsonValue }, { key: receiptKey, value: { fingerprint, etag, batchId: id } }]); this.leases.set(id, lease); return batch;
      } catch (error) { await this.files.removeFiles(owner.workspaceId, allocated); lease.release(); throw error; }
    });
  }
  async get(owner: WorkspaceOwner, batchId: string): Promise<UploadBatchDTO> { return this.record(owner, batchId).batch; }
  async authorizePart(owner: WorkspaceOwner, batchId: string, fileId: string, index: number, declaredSize?: number): Promise<void> {
    const batch = this.record(owner, batchId).batch; this.writable(batch); const file = this.file(batch, fileId), size = this.partSize(file, index); if (declaredSize !== undefined && declaredSize !== size) throw new ApiError('TRANSFER_PART_CONFLICT');
  }
  async putPart(owner: WorkspaceOwner, batchId: string, fileId: string, index: number, bytes: Uint8Array, expectedSha: string): Promise<TransferPartDTO> {
    if (!bytes.byteLength || bytes.byteLength > TRANSFER_PART_MAX_BYTES) throw new ApiError('UPLOAD_LIMIT');
    if (!/^[a-f0-9]{64}$/.test(expectedSha) || sha(bytes) !== expectedSha) throw new ApiError('TRANSFER_PART_CONFLICT');
    return this.lock(owner, async () => {
      const record = this.record(owner, batchId); this.writable(record.batch); const file = this.file(record.batch, fileId); if (this.partSize(file, index) !== bytes.byteLength) throw new ApiError('TRANSFER_PART_CONFLICT');
      const prior = file.parts.find(part => part.index === index); if (prior) { if (prior.sha256 !== expectedSha || prior.size !== bytes.byteLength) throw new ApiError('TRANSFER_PART_CONFLICT'); return prior; }
      const location = await this.files.filePath(owner.workspaceId, file.id), handle = await open(location, 'r+');
      try { let offset = 0; while (offset < bytes.length) { const written = await handle.write(bytes, offset, bytes.length - offset, index * TRANSFER_PART_MAX_BYTES + offset); if (!written.bytesWritten) throw new ApiError('TRANSFER_INCOMPLETE'); offset += written.bytesWritten; } await handle.sync(); } finally { await handle.close(); }
      this.authorize(owner); const part = { index, size: bytes.byteLength, sha256: expectedSha };
      const batch: UploadBatchDTO = { ...record.batch, state: 'receiving', files: record.batch.files.map(row => row.id === file.id ? { ...row, parts: [...row.parts, part].sort((a, b) => a.index - b.index) } : row) };
      this.save(owner, { ...record, batch }); return part;
    });
  }
  async cancel(owner: WorkspaceOwner, batchId: string): Promise<void> {
    await this.lock(owner, async () => { const record = this.record(owner, batchId); if (record.batch.state === 'retained') return; this.save(owner, { ...record, batch: { ...record.batch, state: 'cleanup_pending' } });
      await this.files.removeFiles(owner.workspaceId, record.batch.files.map(file => file.id)); this.leases.get(batchId)?.release(); this.leases.delete(batchId);
    });
  }
  async prepareSeal(owner: WorkspaceOwner, batchId: string, jobId: string): Promise<JobAcceptance> {
    const record = this.record(owner, batchId); this.writable(record.batch); if (record.batch.files.some(file => file.parts.length !== file.partCount)) throw new ApiError('TRANSFER_INCOMPLETE');
    const sources = await this.staged(owner, record), input: LocalSealInput = { batchId, files: sources }, sealing: LocalBatch = { ...record, sealJobId: jobId, batch: { ...record.batch, state: 'sealing' } };
    return { includeSnapshot: false, input: input as unknown as JsonValue, initialRecords: [{ key: recordKey(owner, batchId), value: sealing as unknown as JsonValue }],
      assertStart: () => { if (this.record(owner, batchId) !== record) throw new ApiError('TRANSFER_INCOMPLETE'); this.writable(record.batch); },
      preparePublication: async (_job, output) => {
        const current = this.record(owner, batchId), verified = output.records?.[0]?.value as unknown as { files?: readonly LocalSealedFile[] };
        if (current.batch.state !== 'sealing' || current.sealJobId !== jobId || output.resultRef?.id !== batchId || !verified.files || verified.files.length !== sources.length || verified.files.some(file => !sources.some(source => source.id === file.id && source.sha256 === file.sha256 && source.size === file.size))) throw new ApiError('TRANSFER_INCOMPLETE');
        const lease = this.leases.get(batchId); if (!lease) throw new ApiError('TRANSFER_INCOMPLETE'); await this.files.retain(lease, sources.map(file => file.id)); this.leases.delete(batchId);
        return { output: { complete: true, resultRef: { type: 'upload-batch', id: batchId }, records: [{ key: recordKey(owner, batchId), value: { ...current, batch: { ...current.batch, state: 'sealed' } } as unknown as JsonValue }] }, assertCommit: () => { if (this.record(owner, batchId).batch.state !== 'sealing') throw new ApiError('TRANSFER_INCOMPLETE'); } };
      }, finalize: async () => { const current = this.store.getRecord<LocalBatch>(recordKey(owner, batchId)); if (current?.sealJobId === jobId && current.batch.state === 'sealing') await this.cancel(owner, batchId); },
    };
  }
  async stageForInspection(owner: WorkspaceOwner, batchId: string, context: ImportContextInputDTO): Promise<StagedUpload & { context: ImportContextInputDTO }> {
    return this.lock(owner, async () => {
      const record = this.record(owner, batchId); if (!['sealed','retained'].includes(record.batch.state) || Date.parse(record.batch.expiresAt) <= this.now()) throw new ApiError('TRANSFER_INCOMPLETE');
      const sources = await this.staged(owner, record); this.save(owner, { ...record, batch: { ...record.batch, state: 'retained' } });
      return { files: sources, context, bodyHash: canonicalHash({ uploadBatchId: batchId, context }), retain: async () => {}, cleanup: async () => {} };
    });
  }
  private async staged(owner: WorkspaceOwner, record: LocalBatch): Promise<StagedFile[]> { const files: StagedFile[] = []; for (const file of record.batch.files) files.push({ id: file.id, kind: file.role, displayName: file.name, size: file.byteLength, sha256: file.sha256, importedAt: record.createdAt, path: await this.files.filePath(owner.workspaceId, file.id) }); return files; }
  private file(batch: UploadBatchDTO, id: string): UploadedFileDTO { const file = batch.files.find(file => file.id === id); if (!file) throw new ApiError('RESOURCE_NOT_FOUND'); return file; }
  private partSize(file: UploadedFileDTO, index: number): number { if (!Number.isInteger(index) || index < 0 || index >= file.partCount) throw new ApiError('INVALID_REQUEST'); return Math.min(TRANSFER_PART_MAX_BYTES, file.byteLength - index * TRANSFER_PART_MAX_BYTES); }
  private writable(batch: UploadBatchDTO) { if (!['reserved','receiving'].includes(batch.state) || Date.parse(batch.expiresAt) <= this.now()) throw new ApiError('TRANSFER_INCOMPLETE'); }
  private record(owner: WorkspaceOwner, id: string): LocalBatch { this.authorize(owner); const record = this.store.getRecord<LocalBatch>(recordKey(owner, id)); if (!record) throw new ApiError('RESOURCE_NOT_FOUND'); return record; }
  private save(owner: WorkspaceOwner, record: LocalBatch) { this.store.putRecords([{ key: recordKey(owner, record.batch.id), value: record as unknown as JsonValue }]); }
  private authorize(owner: WorkspaceOwner) { if (owner.sessionId !== this.store.sessionId) throw new ApiError('RESOURCE_NOT_FOUND'); this.store.assertAccepting(owner.workspaceId); }
  private async lock<T>(owner: WorkspaceOwner, work: () => Promise<T>): Promise<T> { const previous = this.queues.get(owner.workspaceId), next = (previous ?? Promise.resolve()).catch(() => {}).then(work); this.queues.set(owner.workspaceId, next); try { return await next; } finally { if (this.queues.get(owner.workspaceId) === next) this.queues.delete(owner.workspaceId); } }
}
