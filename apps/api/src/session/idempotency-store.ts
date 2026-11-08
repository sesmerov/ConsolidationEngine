import { createHash } from 'node:crypto';
import { UUID_PATTERN } from '@ce/contracts';
import type { JsonValue, OperationReceiptDTO, OperationReservationDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash } from './canonical-state.js';
import type { WorkspaceStore } from './workspace-store.js';
interface Entry {
  readonly workspaceId: string; readonly operation: string; readonly requestFingerprint: string;
  readonly jobId: string; readonly reservation?: OperationReservationDTO;
}
interface OperationIndex { readonly entryKey: string }
export interface IdempotencyScope {
  readonly workspaceId: string; readonly operation: string; readonly key: string;
  readonly method?: string; readonly path?: string; readonly expectedBase?: string;
}
export class IdempotencyStore {
  constructor(private readonly store: WorkspaceStore) {}
  private recordKey(key: string): string {
    if (!UUID_PATTERN.test(key)) throw new ApiError('INVALID_REQUEST');
    return 'idempotency:' + canonicalHash({ sessionId: this.store.sessionId, key });
  }
  private operationKey(operationId: string): string {
    if (!UUID_PATTERN.test(operationId)) throw new ApiError('INVALID_REQUEST');
    return 'operation-receipt:' + canonicalHash({ sessionId: this.store.sessionId, operationId });
  }
  private fingerprint(scope: IdempotencyScope, bodyHash: string): string {
    return canonicalHash({ sessionId: this.store.sessionId, workspaceId: scope.workspaceId, operation: scope.operation,
      method: scope.method ?? 'POST', path: scope.path ?? scope.operation, bodyHash, expectedBase: scope.expectedBase ?? null });
  }
  lookup(scope: IdempotencyScope, bodyHash: string): string | undefined {
    this.store.get(scope.workspaceId);
    const entry = this.store.getRecord<Entry>(this.recordKey(scope.key));
    if (entry && entry.requestFingerprint !== this.fingerprint(scope, bodyHash)) throw new ApiError('IDEMPOTENCY_CONFLICT');
    return entry?.jobId;
  }
  has(scope: IdempotencyScope): boolean {
    this.store.get(scope.workspaceId); const entry = this.store.getRecord<Entry>(this.recordKey(scope.key));
    return entry?.workspaceId === scope.workspaceId && entry.operation === scope.operation;
  }
  remember(scope: IdempotencyScope, bodyHash: string, jobId: string, reservation?: OperationReservationDTO): void {
    this.store.get(scope.workspaceId);
    const entryKey = this.recordKey(scope.key), operationKey = this.operationKey(jobId), prior = this.lookup(scope, bodyHash);
    if (prior) { if (prior !== jobId) throw new ApiError('IDEMPOTENCY_CONFLICT'); return; }
    const entry: Entry = { workspaceId: scope.workspaceId, operation: scope.operation,
      requestFingerprint: this.fingerprint(scope, bodyHash), jobId, ...(reservation ? { reservation } : {}) };
    const operation = this.store.getRecord<OperationIndex>(operationKey);
    this.store.putInternalRecords([{ key: entryKey, value: entry }, ...(!operation ? [{ key: operationKey, value: { entryKey } }] : [])]);
  }
  forget(scope: IdempotencyScope): void {
    this.store.get(scope.workspaceId); const entryKey = this.recordKey(scope.key), entry = this.store.getRecord<Entry>(entryKey);
    if (!entry || entry.workspaceId !== scope.workspaceId || entry.operation !== scope.operation) return;
    const operationKey = this.operationKey(entry.jobId), operation = this.store.getRecord<OperationIndex>(operationKey);
    this.store.putInternalRecords([], [entryKey, ...(operation?.entryKey === entryKey ? [operationKey] : [])]);
  }
  receiptByKey(key: string): OperationReceiptDTO {
    const entry = this.store.getRecord<Entry>(this.recordKey(key));
    if (!entry) throw new ApiError('RESOURCE_NOT_FOUND');
    return this.receipt(entry);
  }
  receiptByOperation(operationId: string): OperationReceiptDTO {
    const index = this.store.getRecord<OperationIndex>(this.operationKey(operationId));
    const entry = index ? this.store.getRecord<Entry>(index.entryKey) : undefined;
    if (!entry || entry.jobId !== operationId) throw new ApiError('RESOURCE_NOT_FOUND');
    return this.receipt(entry);
  }
  private receipt(entry: Entry): OperationReceiptDTO {
    const job = this.store.job(entry.workspaceId, entry.jobId);
    return { operationId: job.jobId, workspaceId: job.workspaceId, jobId: job.jobId, responseStatus: 202, phase: job.status,
      ...(entry.reservation ? { reservation: entry.reservation } : {}),
      ...(job.status === 'succeeded' && job.resultRef ? { resultRef: job.resultRef } : {}),
      ...(job.status === 'succeeded' && job.newVersionId ? { newVersionId: job.newVersionId } : {}) };
  }
}
export function hashJsonBody(body: unknown): string { return canonicalHash(body); }
export function hashMultipartBody(files: readonly { field: string; bytes: Uint8Array; metadata: JsonValue }[], metadata: JsonValue): string {
  // Content hashes and canonical metadata define identity. No transport boundary or duplicate upload bytes are retained.
  const normalized = files.map((file) => ({ field: file.field, metadata: file.metadata, size: file.bytes.byteLength,
    sha256: createHash('sha256').update(file.bytes).digest('hex') }));
  normalized.sort((a, b) => canonicalHash(a).localeCompare(canonicalHash(b)));
  return canonicalHash({ files: normalized, metadata });
}
