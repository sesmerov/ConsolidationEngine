import { randomUUID } from 'node:crypto';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { PrivateObjectTransport } from './blob-object-store.js';
import type { HostedDatabase, DatabaseTransaction } from './database.js';
import type { QuotaLedger } from './quota-ledger.js';

export type MaintenanceGuard = (tx: DatabaseTransaction) => Promise<void>;
interface PhysicalObject { session_id: string; workspace_id: string; id: string; private_object_key: string; byte_length: number; [key: string]: unknown }
const byteResources = ['session-state-bytes', 'session-file-bytes', 'blob-bytes', 'sql-bytes'];

/** Internal garbage collection: exact ledger keys, no visitor token and no bucket enumeration. */
export class ObjectMaintenance {
  constructor(readonly database: HostedDatabase, readonly quotas: QuotaLedger, readonly transport: PrivateObjectTransport,
    readonly now: () => Date = () => new Date()) {}

  async releaseUnlinkedBytes(tx: DatabaseTransaction, owner: WorkspaceOwner, limit = 1000): Promise<boolean> {
    const reservations = await tx.query<{ id: string }>(`SELECT q.id FROM quota_reservations q WHERE q.session_id=$1 AND q.workspace_id=$2
      AND q.resource=ANY($3::text[]) AND q.state<>'released'
      AND NOT EXISTS(SELECT 1 FROM physical_object_reservations p WHERE p.reservation_id=q.id)
      AND NOT EXISTS(SELECT 1 FROM physical_objects p WHERE p.reservation_id=q.id)
      ORDER BY q.id LIMIT $4 FOR UPDATE OF q`, [owner.sessionId, owner.workspaceId, byteResources, limit]);
    for (const row of reservations.rows) await this.quotas.release(tx, { reservationId: row.id, confirmedAbsent: true, now: this.now() });
    return reservations.rows.length < limit;
  }

  /** Call only after owner closure and all possible workers/requests have reached their safe boundary. */
  async detachWorkspace(tx: DatabaseTransaction, owner: WorkspaceOwner, limit = 1000): Promise<boolean> {
    const ids = [owner.sessionId, owner.workspaceId];
    for (const table of ['canonical_retention_links','canonical_claims','canonical_block_edges','snapshot_sources']) {
      const removed = await tx.query(`DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE session_id=$1 AND workspace_id=$2 LIMIT $3)`, [...ids, limit]);
      if (removed.rowCount) return false;
    }
    const removed = await tx.query(`WITH removed AS (DELETE FROM object_parts WHERE ctid IN
      (SELECT ctid FROM object_parts WHERE session_id=$1 AND workspace_id=$2 LIMIT $3) RETURNING object_id),
      counts AS (SELECT object_id,count(*)::integer AS n FROM removed GROUP BY object_id)
      UPDATE physical_objects p SET ref_count=p.ref_count-c.n,status='cleanup_pending'
      FROM counts c WHERE p.session_id=$1 AND p.workspace_id=$2 AND p.id=c.object_id`, [...ids, limit]);
    return !removed.rowCount;
  }

  /** Detach one unreferenced file/artifact/block, preserving snapshots, active claims and shared descendants. */
  async pruneResource(owner: WorkspaceOwner, resourceId: string, guard: MaintenanceGuard): Promise<boolean> {
    return this.database.transaction(async tx => {
      await guard(tx); const ids = [owner.sessionId, owner.workspaceId];
      await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [owner.sessionId]);
      await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', ids);
      if (await this.unsafeWorkers(tx, owner)) return false;
      const resource = (await tx.query<{ kind: string; created_at: Date }>('SELECT kind,created_at FROM object_resources WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [...ids, resourceId])).rows[0];
      if (!resource) return true;
      if (resource.created_at.getTime() > this.now().getTime() - 120_000) return false;
      if (resource.kind === 'artifact') {
        const artifact = (await tx.query<{ status: string; expires_at: Date }>('SELECT status,expires_at FROM export_artifacts WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [...ids, resourceId])).rows[0];
        if (artifact) {
          const expired = artifact.expires_at <= this.now();
          if (!expired && !['failed','cancelled','expired','cleanup_pending'].includes(artifact.status)) return false;
          if (expired && artifact.expires_at.getTime() + 120_000 > this.now().getTime()) return false;
          // An artifact owns exactly one published manifest reference; historical report versions own different resources.
          await tx.query("UPDATE object_manifests SET ref_count=0,state='cleanup_pending' WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3 AND ref_count=1", [...ids, resourceId]);
          await tx.query("UPDATE export_artifacts SET status='cleanup_pending' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [...ids, resourceId]);
        }
      }
      const retained = await tx.query(`SELECT 1 FROM object_manifests WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3 AND ref_count>0
        UNION ALL SELECT 1 FROM snapshot_sources WHERE session_id=$1 AND workspace_id=$2 AND source_file_id=$3
        UNION ALL SELECT 1 FROM canonical_blocks WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND ref_count>0
        UNION ALL SELECT 1 FROM canonical_retention_links WHERE session_id=$1 AND workspace_id=$2 AND block_id=$3
        UNION ALL SELECT 1 FROM canonical_block_edges WHERE session_id=$1 AND workspace_id=$2 AND child_id=$3
        UNION ALL SELECT 1 FROM canonical_claims WHERE session_id=$1 AND workspace_id=$2 AND block_id=$3 AND state='pending' AND expires_at>$4`, [...ids, resourceId, this.now()]);
      if (retained.rowCount) return false;
      const file = (await tx.query<{ retained_ref_count: number }>('SELECT retained_ref_count FROM stored_files WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...ids, resourceId])).rows[0];
      if (file?.retained_ref_count) return false;
      const reservations: string[] = [];
      const block = (await tx.query<{ reservation_id: string }>('SELECT reservation_id FROM canonical_blocks WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...ids, resourceId])).rows[0];
      if (block) reservations.push(block.reservation_id);
      const exported = (await tx.query<{ session_bytes_id: string; blob_bytes_id: string; temporary_bytes_id: string }>('SELECT * FROM export_reservations WHERE session_id=$1 AND workspace_id=$2 AND artifact_id=$3', [...ids, resourceId])).rows[0];
      if (exported) reservations.push(exported.session_bytes_id, exported.blob_bytes_id, exported.temporary_bytes_id);
      await tx.query('DELETE FROM export_reservations WHERE session_id=$1 AND workspace_id=$2 AND artifact_id=$3', [...ids, resourceId]);
      await tx.query('DELETE FROM export_artifacts WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...ids, resourceId]);
      const parts = await tx.query<{ session_bytes_id: string; blob_bytes_id: string }>('DELETE FROM upload_part_claims WHERE session_id=$1 AND workspace_id=$2 AND file_id=$3 RETURNING session_bytes_id,blob_bytes_id', [...ids, resourceId]);
      for (const part of parts.rows) reservations.push(part.session_bytes_id, part.blob_bytes_id);
      await tx.query('DELETE FROM canonical_claims WHERE session_id=$1 AND workspace_id=$2 AND block_id=$3', [...ids, resourceId]);
      await tx.query('DELETE FROM canonical_block_edges WHERE session_id=$1 AND workspace_id=$2 AND parent_id=$3', [...ids, resourceId]);
      await tx.query('DELETE FROM canonical_blocks WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...ids, resourceId]);
      await tx.query(`WITH removed AS (DELETE FROM object_parts WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3 RETURNING object_id),
        counts AS (SELECT object_id,count(*)::integer AS n FROM removed GROUP BY object_id)
        UPDATE physical_objects p SET ref_count=p.ref_count-c.n FROM counts c WHERE p.session_id=$1 AND p.workspace_id=$2 AND p.id=c.object_id`, [...ids, resourceId]);
      await tx.query('DELETE FROM object_manifests WHERE session_id=$1 AND workspace_id=$2 AND resource_id=$3', [...ids, resourceId]);
      await tx.query('DELETE FROM stored_files WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...ids, resourceId]);
      await tx.query('DELETE FROM object_resources WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...ids, resourceId]);
      for (const id of new Set(reservations)) {
        const physical = await tx.query('SELECT 1 FROM physical_object_reservations WHERE reservation_id=$1', [id]);
        if (!physical.rowCount) await this.quotas.release(tx, { reservationId: id, confirmedAbsent: true, now: this.now() });
      }
      return true;
    });
  }

  async unsafeWorkers(tx: DatabaseTransaction, owner: WorkspaceOwner): Promise<boolean> {
    return !!(await tx.query(`SELECT 1 FROM cpu_permits WHERE session_id=$1 AND workspace_id=$2 AND released_at IS NULL
      AND (safe_release_at IS NULL OR safe_release_at>$3) LIMIT 1`, [owner.sessionId, owner.workspaceId, this.now()])).rowCount;
  }

  async removeBatch(guard: MaintenanceGuard, signal: AbortSignal, limit = 100): Promise<{ removed: number; deferred: number }> {
    const candidates = (await this.database.query<PhysicalObject>(`SELECT p.* FROM physical_objects p WHERE p.status<>'deleted' AND p.ref_count=0
      AND p.updated_at<=$1 ORDER BY p.updated_at,p.id LIMIT $2`, [new Date(this.now().getTime() - 120_000), limit])).rows;
    if (!candidates.length) return { removed: 0, deferred: 0 };
    const rows = await this.database.transaction(async tx => {
      await guard(tx);
      const owners = [...new Set(candidates.map(row => `${row.session_id}/${row.workspace_id}`))].sort();
      for (const owner of owners) {
        const [sessionId, workspaceId] = owner.split('/');
        await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
        await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [sessionId, workspaceId]);
      }
      const result = await tx.query<PhysicalObject>(`SELECT p.* FROM physical_objects p
        JOIN jsonb_to_recordset($3::jsonb) AS selected(session_id uuid,workspace_id uuid,id uuid)
        ON selected.session_id=p.session_id AND selected.workspace_id=p.workspace_id AND selected.id=p.id
        WHERE p.status IN ('stored','uncertain','cleanup_pending','uploading','reserved') AND p.ref_count=0 AND p.updated_at<=$1
        AND NOT EXISTS(SELECT 1 FROM object_parts q WHERE q.session_id=p.session_id AND q.workspace_id=p.workspace_id AND q.object_id=p.id)
        AND NOT EXISTS(SELECT 1 FROM cpu_permits q WHERE q.session_id=p.session_id AND q.workspace_id=p.workspace_id AND q.released_at IS NULL AND (q.safe_release_at IS NULL OR q.safe_release_at>$2))
        ORDER BY p.updated_at,p.id FOR UPDATE OF p`, [new Date(this.now().getTime() - 120_000), this.now(), JSON.stringify(candidates.map(({ session_id, workspace_id, id }) => ({ session_id, workspace_id, id })))]);
      if (!result.rows.length) return [];
      // DEL currently has no monetary operation charge. Reserving one advanced operation per bounded request is conservative.
      // Provider rate limits still count every object in the request, not one object per batch.
      const reservation = await this.quotas.reserve(tx, { operationId: randomUUID(), resource: 'blob-advanced-operations', units: 1, purpose: 'maintenance', now: this.now() });
      await this.quotas.consume(tx, { reservationId: reservation.id, now: this.now() });
      for (const row of result.rows) await tx.query("UPDATE physical_objects SET status='cleanup_pending',updated_at=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [row.session_id, row.workspace_id, row.id, this.now()]);
      return result.rows;
    });
    if (!rows.length) return { removed: 0, deferred: 0 };
    const absent: PhysicalObject[] = [];
    try {
      await this.transport.removeMany(rows.map(row => row.private_object_key), signal);
      // Immutable server keys are never reused. A confirmed DEL acknowledgement establishes absence.
      absent.push(...rows);
    } catch {
      for (const row of rows) {
        if (signal.aborted) break;
        try {
          await this.database.transaction(async tx => {
            await guard(tx);
            for (const [resource, units] of [['blob-simple-operations', 1], ['blob-transfer-bytes', row.byte_length]] as const) {
              const reservation = await this.quotas.reserve(tx, { operationId: randomUUID(), resource, units, purpose: 'maintenance', now: this.now() });
              await this.quotas.consume(tx, { reservationId: reservation.id, now: this.now() });
            }
          });
          if (await this.transport.get(row.private_object_key, signal) === null) absent.push(row);
        } catch { /* Unknown absence is retained debt, never a refund or completed task. */ }
      }
    }
    await this.database.transaction(async tx => {
      await guard(tx);
      for (const owner of [...new Set(absent.map(row => `${row.session_id}/${row.workspace_id}`))].sort()) {
        const [sessionId, workspaceId] = owner.split('/');
        await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [sessionId]);
        await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [sessionId, workspaceId]);
      }
      for (const row of absent) {
        const identity = [row.session_id, row.workspace_id, row.id];
        const current = (await tx.query<{ status: string; ref_count: number }>('SELECT status,ref_count FROM physical_objects WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', identity)).rows[0];
        if (!current || current.status === 'deleted') continue;
        if (current.ref_count !== 0 || current.status !== 'cleanup_pending') throw new Error('Object authority changed during cleanup');
        const allocations = await tx.query<{ reservation_id: string }>('SELECT reservation_id FROM physical_object_reservations WHERE session_id=$1 AND workspace_id=$2 AND object_id=$3', identity);
        for (const allocation of allocations.rows) await this.quotas.release(tx, { reservationId: allocation.reservation_id, confirmedAbsent: true, now: this.now() });
        await tx.query("UPDATE physical_objects SET status='deleted',updated_at=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [...identity, this.now()]);
        await tx.query("UPDATE cleanup_tasks SET state='completed',last_error=NULL,updated_at=$4 WHERE session_id=$1 AND workspace_id=$2 AND object_ref->>'kind'='physical-object' AND object_ref->>'objectId'=$3", [...identity, this.now()]);
      }
    });
    return { removed: absent.length, deferred: rows.length - absent.length };
  }
}
