import { createHash, randomUUID } from 'node:crypto';
import { MAX_PRIVATE_OBJECT_PART_BYTES, type ObjectStore, type PrivateObjectReference } from '../../apps/api/src/ports/object-store.js';
import type { WorkspaceOwner } from '../../apps/api/src/ports/workspace-repository.js';
import { ControlledBarriers } from './controlled-queue.js';

interface Entry { readonly owner: WorkspaceOwner; readonly reference: PrivateObjectReference; bytes: Uint8Array }
type Operation = 'put' | 'get' | 'remove' | 'removeMany';
/** Provider boundary with real bytes/hash checks; SQL authorization and quota reservations remain in the caller. */
export class ControlledObjects implements ObjectStore {
  private readonly data = new Map<string, Entry>();
  private readonly failures = new Map<Operation, 'before' | 'after'>();
  readonly calls: { readonly operation: Operation; readonly owner: WorkspaceOwner; readonly objectId?: string; readonly bytes?: number }[] = [];
  constructor(readonly barriers = new ControlledBarriers()) {}
  failNext(operation: Operation, point: 'before' | 'after'): void { this.failures.set(operation, point); }
  entries(): readonly { readonly owner: WorkspaceOwner; readonly reference: PrivateObjectReference }[] {
    return [...this.data.values()].map(({ owner, reference }) => structuredClone({ owner, reference }));
  }
  async put(owner: WorkspaceOwner, bytes: Uint8Array): Promise<PrivateObjectReference> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_PRIVATE_OBJECT_PART_BYTES) throw new Error('OBJECT_PART_LIMIT');
    const failure = this.takeFailure('put');
    this.calls.push({ operation: 'put', owner: { ...owner }, bytes: bytes.byteLength });
    await this.barriers.reach('objects.beforePut'); if (failure === 'before') throw new Error('CONTROLLED_OBJECT_PUT_REJECTED');
    const reference = { objectId: randomUUID(), byteLength: bytes.byteLength, sha256: digest(bytes) };
    this.data.set(reference.objectId, { owner: { ...owner }, reference, bytes: Uint8Array.from(bytes) });
    await this.barriers.reach('objects.afterPut'); if (failure === 'after') throw new Error('CONTROLLED_OBJECT_PUT_ACK_LOST');
    return { ...reference };
  }
  async get(owner: WorkspaceOwner, reference: PrivateObjectReference): Promise<Uint8Array> {
    const failure = this.takeFailure('get');
    this.calls.push({ operation: 'get', owner: { ...owner }, objectId: reference.objectId });
    await this.barriers.reach('objects.beforeGet'); if (failure === 'before') throw new Error('CONTROLLED_OBJECT_GET_REJECTED');
    const entry = this.owned(owner, reference.objectId);
    if (entry.bytes.byteLength !== reference.byteLength || digest(entry.bytes) !== reference.sha256) throw new Error('OBJECT_INTEGRITY');
    await this.barriers.reach('objects.afterGet'); if (failure === 'after') throw new Error('CONTROLLED_OBJECT_GET_RESPONSE_LOST');
    return Uint8Array.from(entry.bytes);
  }
  async remove(owner: WorkspaceOwner, objectId: string): Promise<void> {
    const failure = this.takeFailure('remove');
    this.calls.push({ operation: 'remove', owner: { ...owner }, objectId });
    await this.barriers.reach('objects.beforeRemove'); if (failure === 'before') throw new Error('CONTROLLED_OBJECT_REMOVE_REJECTED');
    if (this.data.has(objectId)) { this.owned(owner, objectId); this.data.delete(objectId); }
    await this.barriers.reach('objects.afterRemove'); if (failure === 'after') throw new Error('CONTROLLED_OBJECT_REMOVE_ACK_LOST');
  }
  corrupt(owner: WorkspaceOwner, objectId: string, bytes: Uint8Array): void { this.owned(owner, objectId).bytes = Uint8Array.from(bytes); }
  clear(): void { this.data.clear(); this.failures.clear(); }
  private takeFailure(operation: Operation): 'before' | 'after' | undefined { const failure = this.failures.get(operation); this.failures.delete(operation); return failure; }
  private owned(owner: WorkspaceOwner, id: string): Entry {
    const entry = this.data.get(id);
    if (!entry || entry.owner.sessionId !== owner.sessionId || entry.owner.workspaceId !== owner.workspaceId) throw new Error('OBJECT_NOT_FOUND');
    return entry;
  }
}
function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex'); }

/** Deterministic provider adapter: the durable ledger allocates the private key before network I/O.
 * Structural interface: put(key,bytes,signal?)=>void; get(key,signal?)=>bytes|null; remove(key,signal?)=>void.
 * This adapter does not authorize keys. HostedObjectStore must resolve an owner-qualified ledger row first.
 */
export class ControlledObjectTransport {
  private readonly data = new Map<string, Uint8Array>();
  private readonly failures = new Map<Operation, 'before' | 'after'>();
  readonly calls: { readonly operation: Operation; readonly privateKey: string; readonly bytes?: number }[] = [];
  constructor(readonly barriers = new ControlledBarriers()) {}
  failNext(operation: Operation, point: 'before' | 'after'): void { this.failures.set(operation, point); }
  entries(): readonly { readonly privateKey: string; readonly byteLength: number; readonly sha256: string }[] {
    return [...this.data.entries()].map(([privateKey, bytes]) => ({ privateKey, byteLength: bytes.byteLength, sha256: digest(bytes) }));
  }
  async put(privateKey: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_PRIVATE_OBJECT_PART_BYTES) throw new Error('OBJECT_PART_LIMIT');
    const failure = await this.before('put', privateKey, signal, bytes.byteLength);
    const previous = this.data.get(privateKey);
    if (previous && digest(previous) !== digest(bytes)) throw new Error('OBJECT_KEY_CONTENT_CONFLICT');
    this.data.set(privateKey, Uint8Array.from(bytes));
    await this.after('put', failure, signal);
  }
  async get(privateKey: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    const failure = await this.before('get', privateKey, signal);
    const bytes = this.data.get(privateKey);
    await this.after('get', failure, signal);
    return bytes ? Uint8Array.from(bytes) : null;
  }
  async remove(privateKey: string, signal?: AbortSignal): Promise<void> {
    const failure = await this.before('remove', privateKey, signal);
    this.data.delete(privateKey); await this.after('remove', failure, signal);
  }
  async removeMany(privateKeys: readonly string[], signal?: AbortSignal): Promise<void> {
    if (!privateKeys.length || privateKeys.length > 100 || new Set(privateKeys).size !== privateKeys.length || privateKeys.some(key => !key || key.length > 1000)) throw new Error('INVALID_PRIVATE_OBJECT_BATCH');
    const failure = await this.before('removeMany', privateKeys[0]!, signal);
    for (const key of privateKeys) this.data.delete(key); await this.after('removeMany', failure, signal);
  }
  corrupt(privateKey: string, bytes: Uint8Array): void {
    if (!this.data.has(privateKey)) throw new Error('OBJECT_NOT_FOUND'); this.data.set(privateKey, Uint8Array.from(bytes));
  }
  clear(): void { this.data.clear(); this.failures.clear(); }
  private async before(operation: Operation, privateKey: string, signal?: AbortSignal, bytes?: number): Promise<'before' | 'after' | undefined> {
    signal?.throwIfAborted();
    if (!privateKey || privateKey.length > 1000) throw new Error('INVALID_PRIVATE_OBJECT_KEY');
    const failure = this.failures.get(operation); this.failures.delete(operation);
    this.calls.push({ operation, privateKey, ...(bytes === undefined ? {} : { bytes }) });
    await this.barriers.reach(`transport.before${operation[0]!.toUpperCase()}${operation.slice(1)}`);
    signal?.throwIfAborted(); if (failure === 'before') throw new Error(`CONTROLLED_${operation.toUpperCase()}_REJECTED`);
    return failure;
  }
  private async after(operation: Operation, failure: 'before' | 'after' | undefined, signal?: AbortSignal): Promise<void> {
    await this.barriers.reach(`transport.after${operation[0]!.toUpperCase()}${operation.slice(1)}`);
    signal?.throwIfAborted(); if (failure === 'after') throw new Error(`CONTROLLED_${operation.toUpperCase()}_ACK_LOST`);
  }
}
