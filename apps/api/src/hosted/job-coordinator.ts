import { randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { Diagnostic, JobDTO, JsonObject } from '@ce/contracts';
import { isTerminalJob } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { AcceptedJobReference } from '../ports/job-dispatcher.js';
import type { HostedConfig } from './config.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { assertLiveSession } from './session-service.js';
import { publicJob, requireJob, requireWorkspace, type JobRow } from './postgres-repository.js';

export interface HostedJobClaim extends AcceptedJobReference {
  readonly instanceId: string; readonly attemptId: string; readonly fence: string;
  readonly kind: JobRow['kind']; readonly inputRefs: JsonObject; readonly baseVersionId?: string;
  readonly startedAt: string; readonly deadlineAt: string;
}
export type ClaimOutcome = { readonly state: 'claimed'; readonly claim: HostedJobClaim }
  | { readonly state: 'busy'; readonly retryAfterMs: number } | { readonly state: 'terminal'; readonly job: JobDTO };
interface PermitRow extends QueryResultRow {
  scope: string; scope_key: string; session_id: string | null; workspace_id: string | null; job_id: string | null;
  attempt_id: string | null; fence: string; safe_release_at: Date | null; released_at: Date | null;
}
export class LostJobAuthorityError extends Error {
  constructor(readonly reason: 'stale_fence' | 'terminal' | 'cancelled' | 'deadline' | 'base_changed') { super(reason); }
}
const scopes = (claim: { workspaceId: string; instanceId: string }) => [
  ['global', 'demo'], ['workspace', claim.workspaceId], ['instance', claim.instanceId],
] as const;

/** Call inside the final short transaction; no object/network I/O is allowed after these locks. */
export async function assertClaimAuthority(tx: DatabaseTransaction, claim: HostedJobClaim, now: Date) {
  await assertLiveSession(tx, claim.sessionId, now, { lock: true });
  const workspace = await requireWorkspace(tx, claim, true), job = await requireJob(tx, claim, claim.jobId, true);
  if (job.fence !== claim.fence || job.attempt_id !== claim.attemptId) throw new LostJobAuthorityError('stale_fence');
  if (job.status !== 'running') throw new LostJobAuthorityError('terminal');
  if (job.cancel_requested_at) throw new LostJobAuthorityError('cancelled');
  if (!job.deadline_at || now >= job.deadline_at) throw new LostJobAuthorityError('deadline');
  if (job.base_version_id !== workspace.current_version_id) throw new LostJobAuthorityError('base_changed');
  if (job.input_refs['workspaceRevision'] !== undefined && String(job.input_refs['workspaceRevision']) !== workspace.revision) throw new LostJobAuthorityError('base_changed');
  for (const [scope, key] of scopes(claim)) {
    const permit = (await tx.query<PermitRow>('SELECT * FROM cpu_permits WHERE scope=$1 AND scope_key=$2 FOR UPDATE', [scope, key])).rows[0];
    if (!permit || permit.session_id !== claim.sessionId || permit.workspace_id !== claim.workspaceId || permit.job_id !== claim.jobId
      || permit.attempt_id !== claim.attemptId || permit.fence !== claim.fence || permit.released_at) throw new LostJobAuthorityError('stale_fence');
  }
  return { workspace, job };
}

export class HostedJobCoordinator {
  constructor(readonly database: HostedDatabase, private readonly options: { readonly config: HostedConfig; readonly instanceId: string; readonly now?: () => number }) {
    if (!options.instanceId || options.instanceId.length > 200) throw new TypeError('Invalid server instance identity');
  }
  private now(): Date { return new Date((this.options.now ?? Date.now)()); }
  async claim(reference: AcceptedJobReference): Promise<ClaimOutcome> {
    return this.database.transaction(async tx => {
      const now = this.now();
      await assertLiveSession(tx, reference.sessionId, now, { lock: true });
      const workspace = await requireWorkspace(tx, reference, true);
      let job = await requireJob(tx, reference, reference.jobId, true);
      job = await this.expireLocked(tx, job, now);
      if (isTerminalJob(publicJob(job).status)) return { state: 'terminal', job: publicJob(job) };
      // An attempt which has started is never executed again, even after a delivery/instance is lost.
      if (job.started_at || job.status === 'running') return { state: 'busy', retryAfterMs: 5000 };
      if (job.cancel_requested_at) return { state: 'terminal', job: publicJob(await this.terminal(tx, job, 'cancelled', [{ code: 'CANCELLED', message: 'Trabajo cancelado.' }], now)) };
      if (job.base_version_id !== workspace.current_version_id || (job.input_refs['workspaceRevision'] !== undefined && String(job.input_refs['workspaceRevision']) !== workspace.revision)) return { state: 'terminal', job: publicJob(await this.terminal(tx, job, 'failed', [{ code: 'STALE_VERSION', message: 'La versión cambió antes de ejecutar el trabajo.' }], now)) };
      const permitRows: PermitRow[] = [];
      for (const [scope, key] of scopes({ ...reference, instanceId: this.options.instanceId })) {
        await tx.query('INSERT INTO cpu_permits(scope,scope_key) VALUES($1,$2) ON CONFLICT DO NOTHING', [scope, key]);
        const permit = (await tx.query<PermitRow>('SELECT * FROM cpu_permits WHERE scope=$1 AND scope_key=$2 FOR UPDATE', [scope, key])).rows[0]!;
        if (permit.job_id && !permit.released_at && (!permit.safe_release_at || now < permit.safe_release_at)) return { state: 'busy', retryAfterMs: 5000 };
        permitRows.push(permit);
      }
      const attemptId = randomUUID(), fence = (BigInt(permitRows[0]!.fence) + 1n).toString();
      const deadline = new Date(now.getTime() + this.options.config.quotas.jobDeadlineMs);
      for (const permit of permitRows) await tx.query(`UPDATE cpu_permits SET session_id=$3,workspace_id=$4,job_id=$5,attempt_id=$6,fence=$7,
        claimed_at=$8,safe_release_at=$9,released_at=NULL WHERE scope=$1 AND scope_key=$2`,
      [permit.scope, permit.scope_key, reference.sessionId, reference.workspaceId, reference.jobId, attemptId, fence, now, new Date(now.getTime() + this.options.config.quotas.safeLeaseMs)]);
      await tx.query(`UPDATE jobs SET status='running',started_at=$4,deadline_at=$5,attempt_id=$6,fence=$7
        WHERE session_id=$1 AND workspace_id=$2 AND id=$3`, [reference.sessionId, reference.workspaceId, reference.jobId, now, deadline, attemptId, fence]);
      await tx.query("UPDATE recalculation_operations SET phase='running' WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3", [reference.sessionId, reference.workspaceId, reference.jobId]);
      return { state: 'claimed', claim: { ...reference, instanceId: this.options.instanceId, attemptId, fence, kind: job.kind, inputRefs: job.input_refs,
        ...(job.base_version_id ? { baseVersionId: job.base_version_id } : {}), startedAt: now.toISOString(), deadlineAt: deadline.toISOString() } };
    });
  }
  async get(reference: AcceptedJobReference): Promise<JobDTO> {
    return this.database.transaction(async tx => {
      const now = this.now(); await assertLiveSession(tx, reference.sessionId, now, { lock: true });
      await requireWorkspace(tx, reference, true);
      return publicJob(await this.expireLocked(tx, await requireJob(tx, reference, reference.jobId, true), now));
    });
  }
  /** Signed internal callbacks/maintenance only: reconcile terminal authority after session closure without a visitor token. */
  async reconcileInternal(reference: AcceptedJobReference): Promise<JobDTO> {
    return this.database.transaction(async tx => {
      const now = this.now(), session = (await tx.query('SELECT state,expires_at,absolute_expires_at FROM demo_sessions WHERE id=$1 FOR UPDATE', [reference.sessionId])).rows[0];
      if (!session) throw new ApiError('RESOURCE_NOT_FOUND');
      await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [reference.sessionId, reference.workspaceId]);
      let job = await this.expireLocked(tx, await requireJob(tx, reference, reference.jobId, true), now);
      if (!isTerminalJob(publicJob(job).status) && (session.state !== 'active' || now >= session.expires_at || now >= session.absolute_expires_at || job.cancel_requested_at)) {
        job = await this.terminal(tx, job, 'cancelled', [{ code: 'CANCELLED', message: 'Trabajo cancelado.' }], now);
      }
      return publicJob(job);
    });
  }
  async cancel(reference: AcceptedJobReference): Promise<JobDTO> {
    return this.database.transaction(async tx => {
      const now = this.now(); await assertLiveSession(tx, reference.sessionId, now, { lock: true });
      await requireWorkspace(tx, reference, true);
      const job = await this.expireLocked(tx, await requireJob(tx, reference, reference.jobId, true), now);
      if (isTerminalJob(publicJob(job).status)) return publicJob(job);
      await tx.query('UPDATE jobs SET cancel_requested_at=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [reference.sessionId, reference.workspaceId, reference.jobId, now]);
      return publicJob(await this.terminal(tx, job, 'cancelled', [{ code: 'CANCELLED', message: 'Trabajo cancelado.' }], now));
    });
  }
  /** Internal execution heartbeat: a failed authority read also causes the caller to stop its worker. */
  async poll(claim: HostedJobClaim): Promise<{ cancelled: boolean; reason?: string }> {
    try { await this.database.transaction(tx => assertClaimAuthority(tx, claim, this.now())); return { cancelled: false }; }
    catch (error) {
      if (error instanceof LostJobAuthorityError) return { cancelled: true, reason: error.reason };
      if (error instanceof ApiError && ['SESSION_EXPIRED', 'SESSION_UNAUTHENTICATED', 'RESOURCE_NOT_FOUND'].includes(error.code)) return { cancelled: true, reason: error.code };
      throw error;
    }
  }
  /** Only a runner which has awaited exit/terminate invokes this; a stale fence cannot release its successor. */
  async confirmTerminated(claim: HostedJobClaim): Promise<void> {
    await this.database.transaction(async tx => {
      for (const [scope, key] of scopes(claim)) await tx.query(`UPDATE cpu_permits SET released_at=$7 WHERE scope=$1 AND scope_key=$2
        AND session_id=$3 AND workspace_id=$4 AND job_id=$5 AND attempt_id=$6 AND fence=$8 AND released_at IS NULL`,
      [scope, key, claim.sessionId, claim.workspaceId, claim.jobId, claim.attemptId, this.now(), claim.fence]);
    });
  }
  async fail(claim: HostedJobClaim, diagnostics: readonly Diagnostic[], status: 'failed' | 'cancelled' | 'timed_out' = 'failed'): Promise<JobDTO> {
    return this.database.transaction(async tx => {
      // Terminal bookkeeping remains possible after revocation, with the same lock order as publication.
      await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [claim.sessionId]);
      await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [claim.sessionId, claim.workspaceId]);
      const job = await requireJob(tx, claim, claim.jobId, true);
      if (job.fence !== claim.fence || job.attempt_id !== claim.attemptId || isTerminalJob(publicJob(job).status)) return publicJob(job);
      return publicJob(await this.terminal(tx, job, status, diagnostics, this.now()));
    });
  }
  private async expireLocked(tx: DatabaseTransaction, job: JobRow, now: Date): Promise<JobRow> {
    if (isTerminalJob(publicJob(job).status)) return job;
    if (job.started_at && job.deadline_at && now >= job.deadline_at) return this.terminal(tx, job, 'timed_out', [{ code: 'JOB_TIMEOUT', message: 'El trabajo superó el plazo de ejecución.' }], now);
    if (!job.started_at && now >= job.queue_expires_at) return this.terminal(tx, job, 'timed_out', [{ code: 'JOB_QUEUE_EXPIRED', message: 'El trabajo caducó antes de ejecutarse.' }], now);
    return job;
  }
  private async terminal(tx: DatabaseTransaction, job: JobRow, status: 'failed' | 'cancelled' | 'timed_out', diagnostics: readonly Diagnostic[], now: Date): Promise<JobRow> {
    const identity = [job.session_id, job.workspace_id, job.id];
    await tx.query(`UPDATE jobs SET status=$4,terminal_at=$5,result_refs=NULL,diagnostics=$6,progress=jsonb_set(progress,'{complete}','false')
      WHERE session_id=$1 AND workspace_id=$2 AND id=$3`, [...identity, status, now, { items: diagnostics }]);
    await tx.query('UPDATE recalculation_operations SET phase=$4 WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3', [...identity, status]);
    await tx.query("UPDATE outbox_entries SET dispatch_state='cancelled' WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3 AND dispatch_state<>'published'", identity);
    await tx.query(`UPDATE direction_reviews SET pending_job_id=NULL,state=CASE
      WHEN base_version_id IS DISTINCT FROM (SELECT current_version_id FROM workspaces WHERE session_id=$1 AND id=$2) THEN 'obsolete'
      WHEN expires_at<=$4 THEN 'expired' ELSE 'ready' END
      WHERE session_id=$1 AND workspace_id=$2 AND pending_job_id=$3 AND state='committing'`, [...identity, now]);
    await tx.query(`UPDATE direction_reviews SET pending_job_id=NULL,state='failed' WHERE session_id=$1 AND workspace_id=$2 AND preparation_job_id=$3 AND state='preparing'`, identity);
    await tx.query(`UPDATE proposal_selections SET pending_job_id=NULL,state=CASE WHEN revision=0 THEN 'failed' ELSE 'ready' END
      WHERE session_id=$1 AND workspace_id=$2 AND pending_job_id=$3 AND state IN ('preparing','updating','applying')`, identity);
    return { ...job, status, terminal_at: now, result_refs: null, diagnostics: { items: diagnostics }, progress: { ...job.progress, complete: false } };
  }
}
