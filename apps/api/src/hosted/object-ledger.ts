import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import { MAX_PRIVATE_OBJECT_PART_BYTES } from '../ports/object-store.js';
import type { ObjectStore, PrivateObjectReference } from '../ports/object-store.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { QuotaLedger } from './quota-ledger.js';
import type { QuotaResource } from './quota-ledger.js';
import { assertLiveSession } from './session-service.js';
import type { PrivateObjectTransport } from './blob-object-store.js';
import { CANONICAL_BLOCK_MAX_BYTES } from './canonical-codec.js';
import type { CanonicalBlockStore, CanonicalRef, CanonicalWriteContext } from './canonical-codec.js';

type Category = 'state' | 'files';
interface PhysicalRow { id: string; private_object_key: string; byte_length: number; sha256: string; status: string; reservation_id: string; ref_count: number; [key: string]: unknown }
interface CanonicalRow { id: string; manifest_id: string; hash: string; byte_length: string; state: string; [key: string]: unknown }
export interface RetentionContext { readonly publicationId: string; readonly jobId: string; readonly attemptId: string; readonly fence: string | number }
export interface ReservedObjectBytes { readonly sessionBytes: string; readonly blobBytes: string }
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const canonicalRef = (row: CanonicalRow): CanonicalRef => ({ resourceId: row.id, manifestId: row.manifest_id, codecVersion: 1, sha256: row.hash, byteLength: Number(row.byte_length) });
const physicalRef = (row: PhysicalRow): PrivateObjectReference => ({ objectId: row.id, byteLength: row.byte_length, sha256: row.sha256 });

/** SQL owns permissions, byte reservations, provisional identities and publication references. Provider I/O never holds a transaction. */
export class ObjectLedger implements CanonicalBlockStore {
  constructor(readonly database: HostedDatabase, private readonly transport: PrivateObjectTransport, private readonly quotas: QuotaLedger, private readonly now: () => Date = () => new Date()) {}
  forOperation(context: CanonicalWriteContext, category: Category = 'files'): ObjectStore {
    return { put: (owner, bytes) => this.putObject(owner, bytes, context, category), get: (owner, ref) => this.getObject(owner, ref, context), remove: (owner, id) => this.markForCleanup(owner, id) };
  }
  async putObject(owner: WorkspaceOwner, bytes: Uint8Array, context: CanonicalWriteContext, category: Category, reserved?: ReservedObjectBytes): Promise<PrivateObjectReference> {
    if (!bytes.byteLength || bytes.byteLength > MAX_PRIVATE_OBJECT_PART_BYTES) throw new ApiError('UPLOAD_LIMIT');
    const hash = digest(bytes), resource: QuotaResource = category === 'state' ? 'session-state-bytes' : 'session-file-bytes';
    const plan = await this.database.transaction(async tx => {
      await this.authorize(tx, owner, context);
      let usableReservation = !!reserved;
      if (reserved) for (const [id, expected] of [[reserved.sessionBytes, resource], [reserved.blobBytes, 'blob-bytes']] as const) {
        const allocation = (await tx.query<{ resource: string; units: string; state: string }>('SELECT resource,units,state FROM quota_reservations WHERE id=$1 AND session_id=$2 AND workspace_id=$3 AND operation_id=$4 FOR UPDATE', [id, owner.sessionId, owner.workspaceId, context.operationId])).rows[0];
        if (!allocation || allocation.resource !== expected || Number(allocation.units) !== bytes.byteLength) throw new ApiError('TRANSFER_PART_CONFLICT');
        if (allocation.state === 'released') usableReservation = false;
      }
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':object:'||$1,0))", [owner.sessionId + ':' + owner.workspaceId + ':' + resource + ':' + hash]);
      const existing = (await tx.query<PhysicalRow>(`SELECT p.* FROM physical_objects p JOIN quota_reservations q ON q.id=p.reservation_id
        WHERE p.session_id=$1 AND p.workspace_id=$2 AND p.sha256=$3 AND p.byte_length=$4 AND q.resource=$5 AND p.status<>'deleted' ORDER BY p.created_at LIMIT 1 FOR UPDATE OF p`, [owner.sessionId, owner.workspaceId, hash, bytes.byteLength, resource])).rows[0];
      if (existing) {
        if (reserved && existing.status === 'stored') for (const id of [reserved.sessionBytes, reserved.blobBytes]) {
          const linked = (await tx.query('SELECT reservation_id FROM physical_object_reservations WHERE object_id=$1 AND reservation_id=$2', [existing.id, id])).rowCount;
          if (!linked) await this.quotas.release(tx, { reservationId: id, confirmedAbsent: true, now: this.now() });
        }
        return { existing };
      }
      const allocation = reserved && usableReservation ? [reserved.sessionBytes, reserved.blobBytes, ...await this.reserve(tx, owner, context.operationId, [['sql-bytes', 32 * 1024]])]
        : await this.reserve(tx, owner, context.operationId, [[resource, bytes.byteLength], ['blob-bytes', bytes.byteLength], ['sql-bytes', 32 * 1024]]);
      const put = await this.reserve(tx, owner, context.operationId, [['blob-advanced-operations', 1], ['blob-transfer-bytes', bytes.byteLength]]);
      const verify = await this.reserve(tx, owner, context.operationId, [['blob-simple-operations', 1], ['blob-transfer-bytes', bytes.byteLength]]);
      for (const id of put) await this.quotas.consume(tx, { reservationId: id, ...(context.attemptId ? { attemptId: context.attemptId } : {}), now: this.now() });
      const id = randomUUID(), privateKey = `ce/v1/${owner.sessionId}/${owner.workspaceId}/${id}`;
      await tx.query(`INSERT INTO physical_objects(session_id,workspace_id,id,private_object_key,byte_length,sha256,status,reservation_id,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,'uploading',$7,$8,$8)`, [owner.sessionId, owner.workspaceId, id, privateKey, bytes.byteLength, hash, allocation[0], this.now()]);
      for (const reservationId of allocation) await tx.query('INSERT INTO physical_object_reservations(session_id,workspace_id,object_id,reservation_id) VALUES($1,$2,$3,$4)', [owner.sessionId, owner.workspaceId, id, reservationId]);
      return { row: { id, private_object_key: privateKey, byte_length: bytes.byteLength, sha256: hash, status: 'uploading', reservation_id: allocation[0]!, ref_count: 0 } as PhysicalRow, allocation, verify };
    });
    if ('existing' in plan) {
      if (plan.existing.status === 'stored') return physicalRef(plan.existing);
      if (plan.existing.status === 'uncertain') { await this.reconcileObject(owner, plan.existing.id, context); return this.putObject(owner, bytes, context, category, reserved); }
      throw new ApiError('WORKSPACE_BUSY');
    }
    const { row, allocation, verify } = plan;
    try {
      await this.transport.put(row.private_object_key, bytes, this.signal(context));
      await this.database.transaction(async tx => { await this.authorize(tx, owner, context); for (const id of verify) await this.quotas.consume(tx, { reservationId: id, ...(context.attemptId ? { attemptId: context.attemptId } : {}), now: this.now() }); });
      const stored = await this.transport.get(row.private_object_key, this.signal(context)); this.integrity(stored, row);
      await this.database.transaction(async tx => { await this.authorize(tx, owner, context);
        await tx.query("UPDATE physical_objects SET status='stored',updated_at=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, row.id, this.now()]);
        for (const id of allocation) await this.quotas.consume(tx, { reservationId: id, now: this.now() });
      }); return physicalRef(row);
    } catch (error) {
      await this.database.transaction(async tx => {
        await tx.query("UPDATE physical_objects SET status='uncertain',updated_at=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, row.id, this.now()]);
        for (const id of allocation) await this.quotas.markUncertain(tx, id);
        for (const id of verify) { const state = (await tx.query<{ state: string }>('SELECT state FROM quota_reservations WHERE id=$1', [id])).rows[0]?.state; if (state === 'reserved') await this.quotas.release(tx, { reservationId: id, confirmedAbsent: true, now: this.now() }); }
        await this.cleanup(tx, owner, row.id, 'uncertain-object');
      }); throw error;
    }
  }
  async getObject(owner: WorkspaceOwner, reference: PrivateObjectReference, context = this.readContext()): Promise<Uint8Array> {
    const row = await this.database.transaction(async tx => { await this.authorize(tx, owner, context); const row = await this.physical(tx, owner, reference.objectId);
      if (row.status !== 'stored' || row.byte_length !== reference.byteLength || row.sha256 !== reference.sha256) throw new ApiError('RESOURCE_NOT_FOUND');
      await this.chargeRead(tx, owner, context, row.byte_length); return row;
    });
    const bytes = await this.transport.get(row.private_object_key, this.signal(context)); this.integrity(bytes, row);
    await this.database.transaction(tx => this.authorize(tx, owner, context)); return bytes!;
  }
  /** Reconciliation consults the exact recorded key. No list-all request or guessed new object is used. */
  async reconcileObject(owner: WorkspaceOwner, objectId: string, context = this.readContext()): Promise<PrivateObjectReference | null> {
    const row = await this.database.transaction(async tx => { await this.authorize(tx, owner, context); const row = await this.physical(tx, owner, objectId); await this.chargeRead(tx, owner, context, row.byte_length); return row; });
    const bytes = await this.transport.get(row.private_object_key, this.signal(context)); if (bytes) this.integrity(bytes, row);
    await this.database.transaction(async tx => { await this.authorize(tx, owner, context); const current = await this.physical(tx, owner, objectId);
      if (current.ref_count && !bytes) throw new Error('Referenced private object is missing.');
      const allocations = (await tx.query<{ reservation_id: string }>('SELECT reservation_id FROM physical_object_reservations WHERE session_id=$1 AND workspace_id=$2 AND object_id=$3', [owner.sessionId, owner.workspaceId, objectId])).rows;
      await tx.query('UPDATE physical_objects SET status=$4,updated_at=$5 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, objectId, bytes ? 'stored' : 'deleted', this.now()]);
      for (const allocation of allocations) { if (bytes) await this.quotas.consume(tx, { reservationId: allocation.reservation_id, now: this.now() }); else await this.quotas.release(tx, { reservationId: allocation.reservation_id, confirmedAbsent: true, now: this.now() }); }
    }); return bytes ? physicalRef(row) : null;
  }
  async putCanonical(owner: WorkspaceOwner, bytes: Uint8Array, dependencies: readonly CanonicalRef[], context: CanonicalWriteContext): Promise<CanonicalRef> {
    if (!bytes.byteLength || bytes.byteLength > CANONICAL_BLOCK_MAX_BYTES) throw new ApiError('UPLOAD_LIMIT'); const hash = digest(bytes);
    const previous = await this.database.transaction(async tx => { await this.authorize(tx, owner, context); const row = await this.findCanonical(tx, owner, hash); if (row) await this.claim(tx, owner, row.id, context); return row; });
    if (previous) return canonicalRef(previous);
    const object = await this.putObject(owner, bytes, context, 'state');
    return this.database.transaction(async tx => {
      await this.authorize(tx, owner, context); await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':canonical:'||$1,0))", [owner.sessionId + ':' + hash]);
      const existing = await this.findCanonical(tx, owner, hash); if (existing) { await this.claim(tx, owner, existing.id, context); return canonicalRef(existing); }
      const children = [...new Map(dependencies.map(ref => [ref.resourceId, ref])).values()]; for (const child of children) await this.canonical(tx, owner, child);
      const allocations = await this.reserve(tx, owner, context.operationId, [['sql-bytes', 32 * 1024 + children.length * 512]]), id = randomUUID(), manifestId = randomUUID();
      const physical = await this.physical(tx, owner, object.objectId); if (physical.status !== 'stored' || physical.sha256 !== hash || Number(physical.byte_length) !== bytes.byteLength) throw new Error('Unsealed canonical object.');
      await tx.query("INSERT INTO object_resources(session_id,workspace_id,id,kind,state,byte_length,sha256,created_at) VALUES($1,$2,$3,'block','sealed',$4,$5,$6)", [owner.sessionId, owner.workspaceId, id, bytes.byteLength, hash, this.now()]);
      await tx.query("INSERT INTO object_parts(session_id,workspace_id,resource_id,part_index,size,sha256,object_id,status,created_at) VALUES($1,$2,$3,0,$4,$5,$6,'stored',$7)", [owner.sessionId, owner.workspaceId, id, bytes.byteLength, hash, object.objectId, this.now()]);
      await tx.query("INSERT INTO object_manifests(session_id,workspace_id,id,resource_id,codec_version,whole_size,whole_sha256,part_count,sealed_at,state) VALUES($1,$2,$3,$4,1,$5,$6,1,$7,'sealed')", [owner.sessionId, owner.workspaceId, manifestId, id, bytes.byteLength, hash, this.now()]);
      await tx.query('INSERT INTO canonical_blocks(session_id,workspace_id,id,codec_version,hash,byte_length,manifest_id,reservation_id) VALUES($1,$2,$3,1,$4,$5,$6,$7)', [owner.sessionId, owner.workspaceId, id, hash, bytes.byteLength, manifestId, allocations[0]]);
      for (const child of children) await tx.query('INSERT INTO canonical_block_edges(session_id,workspace_id,parent_id,child_id) VALUES($1,$2,$3,$4)', [owner.sessionId, owner.workspaceId, id, child.resourceId]);
      await tx.query('UPDATE physical_objects SET ref_count=ref_count+1 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, object.objectId]);
      await this.claim(tx, owner, id, context); for (const reservationId of allocations) await this.quotas.consume(tx, { reservationId, now: this.now() });
      return { resourceId: id, manifestId, codecVersion: 1, sha256: hash, byteLength: bytes.byteLength };
    });
  }
  async getCanonical(owner: WorkspaceOwner, reference: CanonicalRef): Promise<Uint8Array> {
    const part = await this.database.transaction(async tx => { await this.authorize(tx, owner); await this.canonical(tx, owner, reference);
      return (await tx.query<{ object_id: string; size: number; sha256: string }>("SELECT object_id,size,sha256 FROM object_parts WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3 AND part_index=0 AND status='stored'", [owner.sessionId, owner.workspaceId, reference.resourceId])).rows[0];
    }); if (!part) throw new ApiError('RESOURCE_NOT_FOUND'); return this.getObject(owner, { objectId: part.object_id, byteLength: part.size, sha256: part.sha256 });
  }
  /** Called inside the coordinator's publication transaction. It performs no provider I/O. */
  async retain(tx: DatabaseTransaction, owner: WorkspaceOwner, roots: readonly CanonicalRef[], context: RetentionContext): Promise<void> {
    await this.authorize(tx, owner, { ...context, operationId: context.jobId, deadline: new Date(this.now().getTime() + 60_000).toISOString() });
    for (const root of roots) { await this.canonical(tx, owner, root);
      const claim = (await tx.query<{ job_id: string; attempt_id: string; fence: string }>("SELECT job_id,attempt_id,fence FROM canonical_claims WHERE session_id=$1 AND workspace_id=$2 AND operation_id=$3 AND block_id=$4 AND state IN ('pending','retained')", [owner.sessionId, owner.workspaceId, context.jobId, root.resourceId])).rows[0];
      if (!claim || claim.job_id !== context.jobId || claim.attempt_id !== context.attemptId || String(claim.fence) !== String(context.fence)) throw new ApiError('STALE_VERSION');
    }
    if (!roots.length) return;
    await tx.query(`WITH RECURSIVE reach(id) AS (
      SELECT unnest($3::uuid[]) UNION SELECT e.child_id FROM canonical_block_edges e JOIN reach r ON e.parent_id=r.id WHERE e.session_id=$1 AND e.workspace_id=$2
    ), added AS (
      INSERT INTO canonical_retention_links(session_id,workspace_id,publication_id,block_id,job_id,attempt_id,fence,created_at)
      SELECT $1,$2,$4,id,$5,$6,$7,$8 FROM reach ON CONFLICT DO NOTHING RETURNING block_id
    ), blocks AS (
      UPDATE canonical_blocks b SET ref_count=ref_count+1 FROM added a WHERE b.session_id=$1 AND b.workspace_id=$2 AND b.id=a.block_id RETURNING b.id
    ), resources AS (
      UPDATE object_resources r SET state='retained' FROM added a WHERE r.session_id=$1 AND r.workspace_id=$2 AND r.id=a.block_id RETURNING r.id
    ), manifests AS (
      UPDATE object_manifests m SET state='retained',ref_count=ref_count+1 FROM added a WHERE m.session_id=$1 AND m.workspace_id=$2 AND m.resource_id=a.block_id RETURNING m.id
    ) UPDATE canonical_claims c SET state='retained' FROM reach r WHERE c.session_id=$1 AND c.workspace_id=$2 AND c.operation_id=$5 AND c.block_id=r.id`,
    [owner.sessionId, owner.workspaceId, roots.map(ref => ref.resourceId), context.publicationId, context.jobId, context.attemptId, context.fence, this.now()]);
  }
  async markForCleanup(owner: WorkspaceOwner, objectId: string): Promise<void> {
    await this.database.transaction(async tx => { await this.authorize(tx, owner); const row = await this.physical(tx, owner, objectId); if (row.ref_count) throw new ApiError('WORKSPACE_BUSY'); await tx.query("UPDATE physical_objects SET status='cleanup_pending',updated_at=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, objectId, this.now()]); await this.cleanup(tx, owner, objectId, 'unreferenced-object'); });
  }
  private async claim(tx: DatabaseTransaction, owner: WorkspaceOwner, id: string, context: CanonicalWriteContext): Promise<void> {
    await tx.query(`INSERT INTO canonical_claims(session_id,workspace_id,operation_id,block_id,job_id,attempt_id,fence,expires_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')
      ON CONFLICT(session_id,workspace_id,operation_id,block_id) DO UPDATE SET expires_at=greatest(canonical_claims.expires_at,EXCLUDED.expires_at),job_id=EXCLUDED.job_id,attempt_id=EXCLUDED.attempt_id,fence=EXCLUDED.fence`, [owner.sessionId, owner.workspaceId, context.operationId, id, context.jobId ?? null, context.attemptId ?? null, context.fence ?? null, new Date(Date.parse(context.deadline) + 120_000)]);
  }
  private async authorize(tx: DatabaseTransaction, owner: WorkspaceOwner, context?: CanonicalWriteContext): Promise<void> {
    const now = this.now(); await assertLiveSession(tx, owner.sessionId, now, { lock: true });
    const workspace = (await tx.query("SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 AND status<>'closed' FOR UPDATE", [owner.sessionId, owner.workspaceId])).rows[0]; if (!workspace) throw new ApiError('RESOURCE_NOT_FOUND');
    if (context && (context.cancelled?.() || !Number.isFinite(Date.parse(context.deadline)) || Date.parse(context.deadline) <= now.getTime())) throw new ApiError('JOB_TIMED_OUT');
    if (context?.jobId) { const job = (await tx.query("SELECT id FROM jobs WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND attempt_id=$4 AND fence=$5 AND status='running' AND cancel_requested_at IS NULL AND deadline_at>$6 FOR UPDATE", [owner.sessionId, owner.workspaceId, context.jobId, context.attemptId, context.fence, now])).rows[0]; if (!job) throw new ApiError('STALE_VERSION'); }
  }
  private async physical(tx: DatabaseTransaction, owner: WorkspaceOwner, id: string): Promise<PhysicalRow> {
    const row = (await tx.query<PhysicalRow>('SELECT * FROM physical_objects WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [owner.sessionId, owner.workspaceId, id])).rows[0]; if (!row || row.status === 'deleted') throw new ApiError('RESOURCE_NOT_FOUND'); return row;
  }
  private async findCanonical(tx: DatabaseTransaction, owner: WorkspaceOwner, hash: string): Promise<CanonicalRow | undefined> {
    return (await tx.query<CanonicalRow>(`SELECT b.*,r.state FROM canonical_blocks b JOIN object_resources r USING(session_id,workspace_id,id) WHERE b.session_id=$1 AND b.workspace_id=$2 AND b.codec_version=1 AND b.hash=$3 AND r.state IN ('sealed','retained')`, [owner.sessionId, owner.workspaceId, hash])).rows[0];
  }
  private async canonical(tx: DatabaseTransaction, owner: WorkspaceOwner, ref: CanonicalRef): Promise<CanonicalRow> {
    const row = await this.findCanonical(tx, owner, ref.sha256); if (!row || row.id !== ref.resourceId || row.manifest_id !== ref.manifestId || Number(row.byte_length) !== ref.byteLength || ref.codecVersion !== 1) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
  }
  private async reserve(tx: DatabaseTransaction, owner: WorkspaceOwner, operationId: string, resources: readonly (readonly [QuotaResource, number])[]): Promise<string[]> {
    const ids: string[] = []; for (const [resource, units] of resources) ids.push((await this.quotas.reserve(tx, { owner, operationId, resource, units, purpose: 'public', now: this.now() })).id); return ids;
  }
  private async chargeRead(tx: DatabaseTransaction, owner: WorkspaceOwner, context: CanonicalWriteContext, bytes: number): Promise<void> {
    for (const reservationId of await this.reserve(tx, owner, context.operationId, [['blob-simple-operations', 1], ['blob-transfer-bytes', bytes]])) await this.quotas.consume(tx, { reservationId, now: this.now() });
  }
  private integrity(bytes: Uint8Array | null, row: PhysicalRow): asserts bytes is Uint8Array { if (!bytes || bytes.byteLength !== row.byte_length || digest(bytes) !== row.sha256) throw new Error('Private object integrity check failed.'); }
  private signal(context: CanonicalWriteContext): AbortSignal { return AbortSignal.timeout(Math.max(1, Math.min(60_000, Date.parse(context.deadline) - this.now().getTime()))); }
  private readContext(): CanonicalWriteContext { return { operationId: randomUUID(), deadline: new Date(this.now().getTime() + 60_000).toISOString() }; }
  private async cleanup(tx: DatabaseTransaction, owner: WorkspaceOwner, objectId: string, reason: string): Promise<void> {
    const now = this.now(); await tx.query(`INSERT INTO cleanup_tasks(id,session_id,workspace_id,object_ref,reason,not_before,deadline,state,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8)`, [randomUUID(), owner.sessionId, owner.workspaceId, { kind: 'physical-object', objectId }, reason, new Date(now.getTime() + 120_000), new Date(now.getTime() + 86_400_000), now]);
  }
}
