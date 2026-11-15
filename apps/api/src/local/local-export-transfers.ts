import { createHash } from 'node:crypto';
import { open, lstat } from 'node:fs/promises';
import { EXPORT_MAX_BYTES, TRANSFER_PART_MAX_BYTES, isCompleteTransferManifest } from '@ce/contracts';
import type { ExportManifestDTO, JsonValue, TransferPartDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { ExportTransferService } from '../hosted/export-artifacts.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import type { SessionFiles } from '../storage/session-files.js';
import type { JobManager } from '../jobs/job-manager.js';
import { exportKey, type ExportArtifact } from '../workers/export.worker.js';

/** Same public manifest/part contract using local retained files; legacy whole-ZIP download remains available locally. */
export class LocalExportTransfers implements ExportTransferService {
  constructor(readonly store: WorkspaceStore, readonly files: SessionFiles, readonly jobs: JobManager) {}
  async manifest(owner: WorkspaceOwner, artifactId: string): Promise<ExportManifestDTO> {
    const artifact = this.artifact(owner, artifactId); await this.jobs.settle(artifact.jobId); this.artifact(owner, artifactId);
    const cacheKey = `export-manifest:${owner.workspaceId}:${artifactId}`, previous = this.store.getRecord<ExportManifestDTO>(cacheKey); if (previous) return previous;
    const location = await this.files.filePath(owner.workspaceId, artifact.fileId), info = await lstat(location);
    if (!info.isFile() || info.isSymbolicLink() || info.size !== artifact.size || info.size < 1 || info.size > EXPORT_MAX_BYTES) throw new ApiError('EXPORT_NOT_AVAILABLE');
    const reader = await open(location, 'r'), hash = createHash('sha256'), parts: TransferPartDTO[] = [];
    try { for (let offset = 0; offset < artifact.size; offset += TRANSFER_PART_MAX_BYTES) {
      const bytes = Buffer.alloc(Math.min(TRANSFER_PART_MAX_BYTES, artifact.size - offset)); let filled = 0;
      while (filled < bytes.length) { const read = await reader.read(bytes, filled, bytes.length - filled, offset + filled); if (!read.bytesRead) throw new ApiError('EXPORT_NOT_AVAILABLE'); filled += read.bytesRead; }
      hash.update(bytes); parts.push({ index: parts.length, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    } } finally { await reader.close(); }
    if (hash.digest('hex') !== artifact.sha256) throw new ApiError('EXPORT_NOT_AVAILABLE'); this.artifact(owner, artifactId);
    const job = this.store.job(owner.workspaceId, artifact.jobId), manifest: ExportManifestDTO = { artifactId, intent: artifact.intent, filename: artifact.filename, byteLength: artifact.size, sha256: artifact.sha256, expiresAt: new Date(Date.parse(job.endedAt ?? job.startedAt!) + 3_600_000).toISOString(), parts };
    if (!isCompleteTransferManifest(manifest)) throw new ApiError('EXPORT_NOT_AVAILABLE'); this.store.putRecords([{ key: cacheKey, value: manifest as unknown as JsonValue }]); return manifest;
  }
  async part(owner: WorkspaceOwner, artifactId: string, index: number): Promise<Uint8Array> {
    const manifest = await this.manifest(owner, artifactId), expected = manifest.parts.find(part => part.index === index); if (!expected) throw new ApiError('RESOURCE_NOT_FOUND');
    const artifact = this.artifact(owner, artifactId), reader = await open(await this.files.filePath(owner.workspaceId, artifact.fileId), 'r'), bytes = Buffer.alloc(expected.size); let filled = 0;
    try { while (filled < bytes.length) { const read = await reader.read(bytes, filled, bytes.length - filled, index * TRANSFER_PART_MAX_BYTES + filled); if (!read.bytesRead) throw new ApiError('EXPORT_NOT_AVAILABLE'); filled += read.bytesRead; } } finally { await reader.close(); }
    this.artifact(owner, artifactId); if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) throw new ApiError('EXPORT_NOT_AVAILABLE'); return bytes;
  }
  private artifact(owner: WorkspaceOwner, id: string): ExportArtifact {
    if (owner.sessionId !== this.store.sessionId) throw new ApiError('RESOURCE_NOT_FOUND'); this.store.get(owner.workspaceId);
    const artifact = this.store.getRecord<ExportArtifact>(exportKey(owner.workspaceId, id)); if (!artifact || artifact.workspaceId !== owner.workspaceId) throw new ApiError('RESOURCE_NOT_FOUND'); return artifact;
  }
}
