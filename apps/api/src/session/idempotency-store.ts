import { createHash } from 'node:crypto';
import { UUID_PATTERN } from '@ce/contracts';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash } from './canonical-state.js';
import type { WorkspaceStore } from './workspace-store.js';
interface Entry { readonly bodyHash: string; readonly jobId: string }
export interface IdempotencyScope { readonly workspaceId: string; readonly operation: string; readonly key: string }
export class IdempotencyStore {
  constructor(private readonly store: WorkspaceStore) {}
  private recordKey(scope: IdempotencyScope): string {
    if (!UUID_PATTERN.test(scope.key)) throw new ApiError('INVALID_REQUEST');
    return 'idempotency:' + canonicalHash({ sessionId: this.store.sessionId, ...scope });
  }
  lookup(scope: IdempotencyScope, bodyHash: string): string | undefined {
    this.store.get(scope.workspaceId);
    const entry = this.store.getRecord<Entry>(this.recordKey(scope));
    if (entry && entry.bodyHash !== bodyHash) throw new ApiError('IDEMPOTENCY_CONFLICT');
    return entry?.jobId;
  }
  has(scope: IdempotencyScope): boolean { this.store.get(scope.workspaceId); return this.store.getRecord<Entry>(this.recordKey(scope)) !== undefined; }
  remember(scope: IdempotencyScope, bodyHash: string, jobId: string): void { this.store.putInternalRecord(this.recordKey(scope), { bodyHash, jobId }); }
  forget(scope: IdempotencyScope): void { this.store.deleteInternalRecord(this.recordKey(scope)); }
}
export function hashJsonBody(body: unknown): string { return canonicalHash(body); }
export function hashMultipartBody(files: readonly { field: string; bytes: Uint8Array; metadata: JsonValue }[], metadata: JsonValue): string {
  // Content hashes and canonical metadata define identity. No transport boundary or duplicate upload bytes are retained.
  const normalized = files.map((file) => ({ field: file.field, metadata: file.metadata, size: file.bytes.byteLength,
    sha256: createHash('sha256').update(file.bytes).digest('hex') }));
  normalized.sort((a, b) => canonicalHash(a).localeCompare(canonicalHash(b)));
  return canonicalHash({ files: normalized, metadata });
}
