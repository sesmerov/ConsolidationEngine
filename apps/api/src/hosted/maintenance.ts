import { randomUUID } from 'node:crypto';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { PrivateObjectTransport } from './blob-object-store.js';
import type { HostedConfig } from './config.js';
import type { HostedDatabase, DatabaseTransaction } from './database.js';
import { HostedJobCoordinator } from './job-coordinator.js';
import { ObjectMaintenance, type MaintenanceGuard } from './object-maintenance.js';
import type { OperationalLogger } from './operational-log.js';
import type { HostedOutbox } from './outbox.js';
import type { QuotaLedger } from './quota-ledger.js';
import { isProjectionReferenced } from './query-repository.js';
import { SessionService } from './session-service.js';

interface CleanupTask { id: string; session_id: string | null; workspace_id: string | null; object_ref: Record<string, unknown>;
  deadline: Date; state: string; [key: string]: unknown }
interface Lease { holder: string; fence: string; expiresAt: Date }
export interface MaintenanceResult { readonly state: 'completed' | 'busy'; readonly expiredSessions: number; readonly reconciledJobs: number;
  readonly dispatched: number; readonly removedObjects: number; readonly deferredObjects: number; readonly completedTasks: number }
export interface MaintenanceDependencies {
  readonly quotas: QuotaLedger; readonly transport: PrivateObjectTransport;
  readonly coordinator?: Pick<HostedJobCoordinator, 'reconcileInternal'>; readonly outbox?: Pick<HostedOutbox, 'dispatch'>;
  readonly now?: () => number; readonly log?: OperationalLogger; readonly batchSize?: number;
}

/** Internal durable sweep. Every mutation is fenced; no session bearer or browser lifecycle is involved. */
export class HostedMaintenance {
  private readonly coordinator: Pick<HostedJobCoordinator, 'reconcileInternal'>;
  private readonly sessions: SessionService;
  private readonly objects: ObjectMaintenance;
  private readonly batch: number;
  constructor(readonly database: HostedDatabase, readonly config: HostedConfig, readonly dependencies: MaintenanceDependencies) {
    this.batch = dependencies.batchSize ?? 100;
    if (!Number.isInteger(this.batch) || this.batch < 1 || this.batch > 100) throw new TypeError('Maintenance batch must contain1–100 resources');
    this.coordinator = dependencies.coordinator ?? new HostedJobCoordinator(database, { config, instanceId: 'maintenance', ...(dependencies.now ? { now: dependencies.now } : {}) });
    this.sessions = new SessionService(database, config, dependencies.quotas);
    this.objects = new ObjectMaintenance(database, dependencies.quotas, dependencies.transport, () => this.now());
  }
  private now(): Date { return new Date((this.dependencies.now ?? Date.now)()); }
  private log(event: Parameters<OperationalLogger>[0], count: number): void { this.dependencies.log?.(event, { count }); }
  private async claim(): Promise<Lease | null> {
    return this.database.transaction(async tx => {
      const now = this.now(), holder = randomUUID();
      await tx.query("INSERT INTO leases(scope,scope_key) VALUES('maintenance','demo') ON CONFLICT DO NOTHING");
      const row = (await tx.query<{ holder_id: string | null; fence: string; safe_release_at: Date | null }>("SELECT holder_id,fence,safe_release_at FROM leases WHERE scope='maintenance' AND scope_key='demo' FOR UPDATE")).rows[0]!;
      if (row.holder_id && row.safe_release_at && row.safe_release_at > now) return null;
      const fence = (BigInt(row.fence) + 1n).toString(), expiresAt = new Date(now.getTime() + 120_000);
      await tx.query("UPDATE leases SET holder_id=$1,fence=$2,claimed_at=$3,safe_release_at=$4 WHERE scope='maintenance' AND scope_key='demo'", [holder, fence, now, expiresAt]);
      return { holder, fence, expiresAt };
    });
  }
  private guard(lease: Lease): MaintenanceGuard {
    return async tx => {
      const row = (await tx.query<{ holder_id: string; fence: string; safe_release_at: Date }>("SELECT holder_id,fence,safe_release_at FROM leases WHERE scope='maintenance' AND scope_key='demo' FOR UPDATE")).rows[0];
      if (!row || row.holder_id !== lease.holder || row.fence !== lease.fence || row.safe_release_at <= this.now()) throw new Error('Maintenance lease lost');
    };
  }
  async sweep(): Promise<MaintenanceResult> {
    const result = { state: 'completed' as const, expiredSessions: 0, reconciledJobs: 0, dispatched: 0, removedObjects: 0, deferredObjects: 0, completedTasks: 0 };
    const lease = await this.claim(); if (!lease) return { ...result, state: 'busy' };
    const guard = this.guard(lease), signal = AbortSignal.timeout(100_000);
    const active = () => !signal.aborted && this.now() < lease.expiresAt;
    try {
      const delayed = (await this.database.query<{ count: number }>("SELECT count(*)::int AS count FROM cleanup_tasks WHERE state<>'completed' AND deadline<=$1", [new Date(this.now().getTime() + (this.config.limits.cleanupDeadlineMs - this.config.quotas.cleanupAlertMs))])).rows[0]!.count;
      if (delayed) this.log('cleanup_delayed', delayed);
      const expired = await this.database.query<{ id: string; expires_at: Date; absolute_expires_at: Date }>(`SELECT id,expires_at,absolute_expires_at FROM demo_sessions
        WHERE state='active' AND (expires_at<=$1 OR absolute_expires_at<=$1) ORDER BY expires_at,id LIMIT $2`, [this.now(), this.batch]);
      for (const row of expired.rows) {
        if (!active()) break;
        await this.database.transaction(guard); await this.sessions.revoke(row.id, this.now()); result.expiredSessions++;
      }
      // Late detection never extends the24-hour deadline beyond actual expiration.
      await this.database.transaction(async tx => {
        await guard(tx);
        await tx.query(`UPDATE cleanup_tasks t SET deadline=least(t.deadline,least(s.expires_at,s.absolute_expires_at)+($1::bigint*interval '1 millisecond')),
          not_before=least(t.not_before,least(s.expires_at,s.absolute_expires_at)+($1::bigint*interval '1 millisecond'))
          FROM demo_sessions s WHERE t.session_id=s.id AND s.reason='expired' AND t.object_ref->>'kind'='session' AND t.state<>'completed'`, [this.config.limits.cleanupDeadlineMs]);
      });
      const jobs = await this.database.query<{ session_id: string; workspace_id: string; id: string }>(`SELECT j.session_id,j.workspace_id,j.id FROM jobs j JOIN demo_sessions s ON s.id=j.session_id
        WHERE j.status IN ('queued','dispatch_pending','running') AND (j.queue_expires_at<=$1 OR j.deadline_at<=$1 OR j.cancel_requested_at IS NOT NULL OR s.state<>'active')
        ORDER BY j.accepted_at,j.id LIMIT $2`, [this.now(), this.batch]);
      for (const row of jobs.rows) {
        if (!active()) break; await this.database.transaction(guard);
        await this.coordinator.reconcileInternal({ sessionId: row.session_id, workspaceId: row.workspace_id, jobId: row.id }); result.reconciledJobs++;
      }
      await this.database.transaction(async tx => {
        await guard(tx);
        await tx.query('UPDATE cpu_permits SET released_at=$1 WHERE released_at IS NULL AND safe_release_at<=$1', [this.now()]);
      });
      if (this.dependencies.outbox) {
        const pending = await this.database.query<{ session_id: string; workspace_id: string; job_id: string }>(`SELECT o.session_id,o.workspace_id,o.job_id FROM outbox_entries o
          JOIN jobs j ON j.session_id=o.session_id AND j.workspace_id=o.workspace_id AND j.id=o.job_id
          JOIN demo_sessions s ON s.id=o.session_id JOIN workspaces w ON w.session_id=o.session_id AND w.id=o.workspace_id
          WHERE o.dispatch_state IN ('pending','uncertain','dispatching') AND o.next_attempt_at<=$1 AND j.status IN ('queued','dispatch_pending')
          AND j.queue_expires_at>$1 AND j.cancel_requested_at IS NULL AND s.state='active' AND s.expires_at>$1 AND s.absolute_expires_at>$1 AND w.status<>'closed'
          ORDER BY o.next_attempt_at,o.id LIMIT $2`, [this.now(), Math.min(9, this.batch)]);
        for (const row of pending.rows) {
          if (!active()) break; await this.database.transaction(guard);
          try { if (await this.dependencies.outbox.dispatch({ sessionId: row.session_id, workspaceId: row.workspace_id, jobId: row.job_id }, { purpose: 'maintenance' })) result.dispatched++; }
          catch { /* Revocation can win between selection and the outbox's authority transaction. */ }
        }
      }
      await this.enqueueExpiredResources(guard);
      const tasks = await this.database.query<CleanupTask>(`SELECT * FROM cleanup_tasks WHERE state IN ('pending','retry','running') AND not_before<=$1
        AND (state<>'running' OR updated_at<=$2) ORDER BY deadline,id LIMIT $3`, [this.now(), new Date(this.now().getTime() - 120_000), this.batch]);
      for (const task of tasks.rows) {
        if (!active()) break;
        try {
          await this.database.transaction(async tx => { await guard(tx); await tx.query("UPDATE cleanup_tasks SET state='running',attempts=attempts+1,updated_at=$2 WHERE id=$1", [task.id, this.now()]); });
          const done = await this.cleanup(task, guard, active);
          await this.finishTask(task, done, guard); if (done) result.completedTasks++;
        } catch {
          await this.finishTask(task, false, guard);
        }
      }
      if (active()) {
        try { const objects = await this.objects.removeBatch(guard, signal, this.batch); result.removedObjects = objects.removed; result.deferredObjects = objects.deferred; }
        catch { result.deferredObjects = this.batch; this.log('cleanup_delayed', 1); }
      }
      // A session task finishes in the same sweep that confirms its last private object absent.
      for (const task of tasks.rows.filter(task => ['session', 'workspace'].includes(String(task.object_ref['kind'])))) {
        if (!active()) break; if (await this.completeClosedScope(task, guard)) { await this.finishTask(task, true, guard); result.completedTasks++; }
      }
      if (result.completedTasks || result.removedObjects) this.log('cleanup_completed', result.completedTasks + result.removedObjects);
      return result;
    } finally {
      await this.database.query("UPDATE leases SET holder_id=NULL WHERE scope='maintenance' AND scope_key='demo' AND holder_id=$1 AND fence=$2", [lease.holder, lease.fence]);
    }
  }

  private async finishTask(task: CleanupTask, done: boolean, guard: MaintenanceGuard): Promise<void> {
    await this.database.transaction(async tx => {
      await guard(tx); await tx.query(`UPDATE cleanup_tasks SET state=$2,last_error=$3,updated_at=$4,
        not_before=CASE WHEN $2='completed' THEN not_before ELSE least(deadline,$5) END WHERE id=$1`,
      [task.id, done ? 'completed' : 'retry', done ? null : 'CLEANUP_PENDING', this.now(), new Date(this.now().getTime() + 30_000)]);
    });
  }
  private async enqueueExpiredResources(guard: MaintenanceGuard): Promise<void> {
    await this.database.transaction(async tx => {
      await guard(tx);
      for (const [table, id, condition, kind] of [
        ['upload_batches', 'id', "state IN ('reserved','receiving','sealing','sealed','cleanup_pending') AND expires_at<=$1", 'upload-batch'],
        ['export_artifacts', 'id', "status IN ('ready','failed','cancelled','expired','cleanup_pending','preparing') AND (expires_at<=$1 OR status IN ('failed','cancelled','expired','cleanup_pending') OR status='preparing' AND EXISTS(SELECT 1 FROM jobs j WHERE j.session_id=r.session_id AND j.workspace_id=r.workspace_id AND j.id=r.job_id AND j.status IN ('failed','cancelled','timed_out')))", 'resource'],
      ] as const) {
        const rows = await tx.query<{ session_id: string; workspace_id: string; id: string; expires_at: Date }>(`SELECT session_id,workspace_id,${id} AS id,expires_at FROM ${table} r WHERE ${condition}
          AND NOT EXISTS(SELECT 1 FROM cleanup_tasks t WHERE t.session_id=r.session_id AND t.workspace_id=r.workspace_id AND coalesce(t.object_ref->>'id',t.object_ref->>'batchId')=r.id::text AND t.state<>'completed') LIMIT $2`, [this.now(), this.batch]);
        for (const row of rows.rows) await tx.query(`INSERT INTO cleanup_tasks(id,session_id,workspace_id,object_ref,reason,not_before,deadline,state,updated_at)
          VALUES($1,$2,$3,$4,'expired-resource',$5,$6,'pending',$7)`, [randomUUID(), row.session_id, row.workspace_id,
          { kind, id: row.id, ...(kind === 'upload-batch' ? { batchId: row.id } : {}) },
          new Date(Math.min(this.now().getTime(), row.expires_at.getTime() + this.config.limits.cleanupDeadlineMs)),
          new Date(Math.min(this.now().getTime(), row.expires_at.getTime()) + this.config.limits.cleanupDeadlineMs), this.now()]);
      }
      const blocks = await tx.query<{ session_id: string; workspace_id: string; id: string }>(`SELECT b.session_id,b.workspace_id,b.id FROM canonical_blocks b
        JOIN object_resources r ON r.session_id=b.session_id AND r.workspace_id=b.workspace_id AND r.id=b.id
        WHERE b.ref_count=0 AND r.created_at<=$1
        AND NOT EXISTS(SELECT 1 FROM canonical_retention_links l WHERE l.session_id=b.session_id AND l.workspace_id=b.workspace_id AND l.block_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM canonical_block_edges e WHERE e.session_id=b.session_id AND e.workspace_id=b.workspace_id AND e.child_id=b.id)
        AND NOT EXISTS(SELECT 1 FROM canonical_claims c WHERE c.session_id=b.session_id AND c.workspace_id=b.workspace_id AND c.block_id=b.id AND c.state='pending' AND c.expires_at>$2)
        AND NOT EXISTS(SELECT 1 FROM cleanup_tasks t WHERE t.session_id=b.session_id AND t.workspace_id=b.workspace_id AND t.object_ref->>'id'=b.id::text AND t.state<>'completed')
        ORDER BY r.created_at,b.id LIMIT $3`, [new Date(this.now().getTime() - 120_000), this.now(), this.batch]);
      for (const block of blocks.rows) await tx.query(`INSERT INTO cleanup_tasks(id,session_id,workspace_id,object_ref,reason,not_before,deadline,state,updated_at)
        VALUES($1,$2,$3,$4,'orphan-block',$5,$6,'pending',$5)`, [randomUUID(), block.session_id, block.workspace_id,
        { kind: 'resource', id: block.id }, this.now(), new Date(this.now().getTime() + this.config.limits.cleanupDeadlineMs)]);
      // Monthly provider counters age out; retained/uncertain bytes remain accounted until confirmed absence.
      await tx.query(`DELETE FROM usage_ledger WHERE reservation_id IN (SELECT q.id FROM quota_reservations q
        WHERE q.state IN ('released','consumed') AND (q.resource NOT IN ('session-state-bytes','session-file-bytes','blob-bytes','sql-bytes') OR q.state='released')
        AND EXISTS(SELECT 1 FROM usage_ledger u WHERE u.reservation_id=q.id)
        AND NOT EXISTS(SELECT 1 FROM usage_ledger u WHERE u.reservation_id=q.id AND u.recorded_at>=$1)
        ORDER BY q.created_at,q.id LIMIT 1000)`,
      [new Date(this.now().getTime() - 30 * 86_400_000)]);
    });
  }
  private async cleanup(task: CleanupTask, guard: MaintenanceGuard, active: () => boolean): Promise<boolean> {
    const kind = task.object_ref['kind'];
    if (kind === 'session' || kind === 'workspace') {
      if (!task.session_id) return false;
      const scopes = await this.database.query<{ id: string }>('SELECT id FROM workspaces WHERE session_id=$1 AND ($2::uuid IS NULL OR id=$2) ORDER BY id', [task.session_id, kind === 'workspace' ? task.workspace_id : null]);
      const safeAfter = task.deadline.getTime() - this.config.limits.cleanupDeadlineMs + 120_000;
      if (this.now().getTime() < safeAfter) return false;
      for (const scope of scopes.rows) if (!await this.purgeWorkspace({ sessionId: task.session_id, workspaceId: scope.id }, kind === 'session', guard, active)) return false;
      return this.completeClosedScope(task, guard);
    }
    if (!task.session_id || !task.workspace_id) return false;
    const owner = { sessionId: task.session_id, workspaceId: task.workspace_id };
    if (kind === 'physical-object') {
      const row = (await this.database.query<{ status: string; ref_count: number }>('SELECT status,ref_count FROM physical_objects WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, task.object_ref['objectId']])).rows[0];
      return !row || row.status === 'deleted' || row.ref_count > 0;
    }
    if (kind === 'resource') return this.objects.pruneResource(owner, String(task.object_ref['id']), guard);
    if (kind === 'upload-batch') {
      const batchId = task.object_ref['batchId'] ?? task.object_ref['id'];
      const batch = await this.database.transaction(async tx => {
        await guard(tx); await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [owner.sessionId]);
        await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [owner.sessionId, owner.workspaceId]);
        const row = (await tx.query<{ state: string; expires_at: Date }>('SELECT state,expires_at FROM upload_batches WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [owner.sessionId, owner.workspaceId, batchId])).rows[0];
        if (!row || row.state === 'retained' || row.state === 'deleted') return 'done';
        if (await this.objects.unsafeWorkers(tx, owner)) return 'blocked';
        if (row.state !== 'cleanup_pending' && row.expires_at.getTime() + 120_000 > this.now().getTime()) return 'blocked';
        await tx.query("UPDATE upload_batches SET state='cleanup_pending' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, batchId]);
        return 'clean';
      });
      if (batch === 'done') return true;
      if (batch === 'blocked') return false;
      const files = await this.database.query<{ id: string }>('SELECT id FROM stored_files WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3 ORDER BY id', [owner.sessionId, owner.workspaceId, batchId]);
      for (const file of files.rows) if (!await this.objects.pruneResource(owner, file.id, guard)) return false;
      return this.database.transaction(async tx => {
        await guard(tx); await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [owner.sessionId]);
        await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [owner.sessionId, owner.workspaceId]);
        const parents = (await tx.query<{ session_bytes_id: string; blob_bytes_id: string }>('SELECT session_bytes_id,blob_bytes_id FROM upload_batch_reservations WHERE session_id=$1 AND workspace_id=$2 AND batch_id=$3 FOR UPDATE', [owner.sessionId, owner.workspaceId, batchId])).rows[0];
        if (parents) for (const id of [parents.session_bytes_id, parents.blob_bytes_id]) await this.dependencies.quotas.release(tx, { reservationId: id, confirmedAbsent: true, now: this.now() });
        await tx.query("UPDATE upload_batches SET state='deleted' WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, batchId]); return true;
      });
    }
    if (kind === 'projection-index') return this.cleanupIndex(owner, task.object_ref, guard);
    return false;
  }
  private async purgeWorkspace(owner: WorkspaceOwner, sessionClosed: boolean, guard: MaintenanceGuard, active: () => boolean): Promise<boolean> {
    // Each chunk commits separately. A killed callback resumes from existing rows and never rolls back all prior cleanup.
    // No statement deletes more than1000 rows; CPU/time and a250-chunk ceiling bound one invocation.
    for (let chunk = 0; chunk < 250 && active(); chunk++) {
      const outcome = await this.database.transaction(async tx => {
      await guard(tx);
      const session = (await tx.query<{ state: string }>('SELECT state FROM demo_sessions WHERE id=$1 FOR UPDATE', [owner.sessionId])).rows[0];
      const workspace = (await tx.query<{ status: string }>('SELECT status FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [owner.sessionId, owner.workspaceId])).rows[0];
      if (!workspace || !session) return 'done';
      if (sessionClosed ? session.state === 'active' : workspace.status !== 'closed') return 'blocked';
      if (await this.objects.unsafeWorkers(tx, owner)) return 'blocked';
      const ids = [owner.sessionId, owner.workspaceId];
      await tx.query("UPDATE workspaces SET status='closed',name='Sesión cerrada',current_version_id=NULL,current_basis_id=NULL WHERE session_id=$1 AND id=$2", ids);
      await tx.query('UPDATE cpu_permits SET session_id=NULL,workspace_id=NULL,job_id=NULL,attempt_id=NULL,claimed_at=NULL,safe_release_at=NULL WHERE session_id=$1 AND workspace_id=$2 AND released_at IS NOT NULL', ids);
      if (!await this.objects.detachWorkspace(tx, owner)) return 'more';
      for (const table of ['projection_value_parts','projection_values','projection_rows','projection_sets','application_receipts',
        'proposal_selection_mutations','proposal_selections','direction_review_mutations','recalculation_operations','previews','direction_reviews',
        'import_inspections','operation_receipts','outbox_entries','mutation_receipts','export_reservations','export_artifacts','snapshot_manifests',
        'upload_part_claims','stored_files','canonical_blocks','object_manifests','object_resources','upload_batch_reservations','upload_batches',
        'validation_runs','jobs','workspace_versions','validation_bases']) {
        const leaves = table === 'workspace_versions' ? 'AND NOT EXISTS(SELECT 1 FROM workspace_versions child WHERE child.session_id=parent.session_id AND child.workspace_id=parent.workspace_id AND child.parent_id=parent.id)' : '';
        const removed = await tx.query(`DELETE FROM ${table} WHERE ctid IN (SELECT parent.ctid FROM ${table} parent WHERE session_id=$1 AND workspace_id=$2 ${leaves} LIMIT 1000)`, ids);
        if (removed.rowCount) return 'more';
      }
      return await this.objects.releaseUnlinkedBytes(tx, owner) ? 'done' : 'more';
      });
      if (outcome === 'done') return true;
      if (outcome === 'blocked') return false;
    }
    return false;
  }
  private async completeClosedScope(task: CleanupTask, guard: MaintenanceGuard): Promise<boolean> {
    if (!task.session_id) return false;
    return this.database.transaction(async tx => {
      await guard(tx); const session = (await tx.query<{ state: string }>('SELECT state FROM demo_sessions WHERE id=$1 FOR UPDATE', [task.session_id])).rows[0];
      if (!session || session.state === 'active' && task.object_ref['kind'] === 'session') return false;
      const scope = task.object_ref['kind'] === 'workspace' ? task.workspace_id : null;
      const remaining = await tx.query(`SELECT 1 FROM workspaces WHERE session_id=$1 AND ($2::uuid IS NULL OR id=$2) AND status<>'closed'
        UNION ALL SELECT 1 FROM jobs WHERE session_id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)
        UNION ALL SELECT 1 FROM physical_objects WHERE session_id=$1 AND ($2::uuid IS NULL OR workspace_id=$2) AND status<>'deleted'
        UNION ALL SELECT 1 FROM object_resources WHERE session_id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)
        UNION ALL SELECT 1 FROM projection_sets WHERE session_id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)
        UNION ALL SELECT 1 FROM quota_reservations WHERE session_id=$1 AND workspace_id IS NOT NULL AND ($2::uuid IS NULL OR workspace_id=$2)
          AND resource IN ('session-state-bytes','session-file-bytes','blob-bytes','sql-bytes') AND state<>'released'
        UNION ALL SELECT 1 FROM workspace_versions WHERE session_id=$1 AND ($2::uuid IS NULL OR workspace_id=$2)`, [task.session_id, scope]);
      if (remaining.rowCount) return false;
      if (task.object_ref['kind'] === 'session') {
        await tx.query('DELETE FROM mutation_receipts WHERE session_id=$1', [task.session_id]);
        await tx.query("UPDATE demo_sessions SET state='deleted',quota_usage='{}' WHERE id=$1 AND state<>'active'", [task.session_id]);
      }
      return true;
    });
  }
  private async cleanupIndex(owner: WorkspaceOwner, ref: Record<string, unknown>, guard: MaintenanceGuard): Promise<boolean> {
    return this.database.transaction(async tx => {
      await guard(tx); await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [owner.sessionId]);
      await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [owner.sessionId, owner.workspaceId]);
      if (await this.objects.unsafeWorkers(tx, owner)) return false;
      const kind = String(ref['resourceKind']), indexId = String(ref['resourceId']);
      const row = (await tx.query<{ job_id: string; attempt_id: string }>('SELECT job_id,attempt_id FROM projection_sets WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4 FOR UPDATE', [owner.sessionId, owner.workspaceId, kind, indexId])).rows[0];
      if (!row) return true;
      if (row.job_id !== ref['jobId'] || row.attempt_id !== ref['attemptId']) return false;
      if (await isProjectionReferenced(tx, owner, { kind: kind as Parameters<typeof isProjectionReferenced>[2]['kind'], indexId })) return false;
      const job = (await tx.query<{ status: string }>('SELECT status FROM jobs WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, row.job_id])).rows[0];
      if (!job || !['succeeded','failed','cancelled','timed_out'].includes(job.status)) return false;
      await tx.query(`DELETE FROM projection_value_parts WHERE session_id=$1 AND workspace_id=$2 AND value_id IN
        (SELECT id FROM projection_values WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4)`, [owner.sessionId, owner.workspaceId, kind, indexId]);
      for (const table of ['projection_values','projection_rows','projection_sets']) await tx.query(`DELETE FROM ${table} WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4`, [owner.sessionId, owner.workspaceId, kind, indexId]);
      return true;
    });
  }
}
