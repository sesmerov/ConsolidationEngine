import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { UUID_PATTERN } from '@ce/contracts';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { JobManager } from '../jobs/job-manager.js';
import type { JobDispatcher } from '../ports/job-dispatcher.js';
import { MAX_PRIVATE_OBJECT_PART_BYTES } from '../ports/object-store.js';
import type { ObjectStore, PrivateObjectReference } from '../ports/object-store.js';
import type { WorkspaceMetadata, WorkspaceOwner, WorkspaceRepository } from '../ports/workspace-repository.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import type { SessionFiles } from '../storage/session-files.js';

function authorize(store: WorkspaceStore, owner: WorkspaceOwner): void {
  if (owner.sessionId !== store.sessionId) throw new ApiError('RESOURCE_NOT_FOUND');
  store.get(owner.workspaceId);
}
export class LocalWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly store: WorkspaceStore) {}
  async workspace(owner: WorkspaceOwner): Promise<WorkspaceMetadata> {
    authorize(this.store, owner);
    const { contexts: _contexts, versionIds: _versions, ...metadata } = this.store.get(owner.workspaceId);
    return Object.freeze({ ...metadata, etag: this.store.etag(owner.workspaceId) });
  }
  async version(owner: WorkspaceOwner, versionId: string) {
    authorize(this.store, owner);
    const { content: _content, ...metadata } = this.store.snapshot(owner.workspaceId, versionId);
    return Object.freeze(metadata);
  }
  async job(owner: WorkspaceOwner, jobId: string) { authorize(this.store, owner); return this.store.job(owner.workspaceId, jobId); }
  async record(owner: WorkspaceOwner, key: string) { authorize(this.store, owner); return this.store.getRecord<JsonValue>(key); }
  async loadSnapshot(owner: WorkspaceOwner, versionId: string) { authorize(this.store, owner); return this.store.snapshot(owner.workspaceId, versionId); }
}
export class LocalObjectStore implements ObjectStore {
  constructor(private readonly store: WorkspaceStore, private readonly files: SessionFiles) {}
  async put(owner: WorkspaceOwner, bytes: Uint8Array): Promise<PrivateObjectReference> {
    authorize(this.store, owner); this.store.assertAccepting(owner.workspaceId);
    if (bytes.byteLength > MAX_PRIVATE_OBJECT_PART_BYTES) throw new ApiError('UPLOAD_LIMIT');
    const written = await this.files.write(owner.workspaceId, bytes);
    authorize(this.store, owner); this.store.assertAccepting(owner.workspaceId);
    return Object.freeze({ objectId: written.id, byteLength: written.size, sha256: written.sha256 });
  }
  async get(owner: WorkspaceOwner, reference: PrivateObjectReference): Promise<Uint8Array> {
    authorize(this.store, owner);
    if (!UUID_PATTERN.test(reference.objectId) || !Number.isSafeInteger(reference.byteLength) || reference.byteLength < 0 || reference.byteLength > MAX_PRIVATE_OBJECT_PART_BYTES || !/^[a-f0-9]{64}$/.test(reference.sha256)) throw new ApiError('RESOURCE_NOT_FOUND');
    try {
      const location = await this.files.filePath(owner.workspaceId, reference.objectId);
      const info = await stat(location); if (!info.isFile() || info.size !== reference.byteLength) throw new ApiError('RESOURCE_NOT_FOUND');
      const chunks: Buffer[] = []; let size = 0; const hash = createHash('sha256');
      for await (const part of createReadStream(location, { highWaterMark: 64 * 1024 })) {
        size += part.length; if (size > reference.byteLength) throw new ApiError('RESOURCE_NOT_FOUND');
        hash.update(part); chunks.push(part);
      }
      if (size !== reference.byteLength || hash.digest('hex') !== reference.sha256) throw new ApiError('RESOURCE_NOT_FOUND');
      authorize(this.store, owner);
      return Buffer.concat(chunks, size);
    } catch { throw new ApiError('RESOURCE_NOT_FOUND'); }
  }
  async remove(owner: WorkspaceOwner, objectId: string): Promise<void> { authorize(this.store, owner); await this.files.removeFiles(owner.workspaceId, [objectId]); }
}
export interface LocalAdapters {
  readonly repository: WorkspaceRepository;
  readonly objects: ObjectStore;
  readonly dispatcher: JobDispatcher;
}
export function createLocalAdapters(store: WorkspaceStore, files: SessionFiles, jobs: JobManager): LocalAdapters {
  return Object.freeze({ repository: new LocalWorkspaceRepository(store), objects: new LocalObjectStore(store, files), dispatcher: jobs.dispatcher });
}
