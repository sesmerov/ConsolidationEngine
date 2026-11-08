import type { QueryResultRow } from 'pg';
import { isTerminalJob } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { AcceptedJobReference, JobDispatcher } from '../ports/job-dispatcher.js';
import type { HostedConfig } from './config.js';
import type { HostedDatabase } from './database.js';
import { publicJob, requireJob, requireWorkspace } from './postgres-repository.js';
import { QuotaLedger } from './quota-ledger.js';
import { assertLiveSession } from './session-service.js';

interface OutboxRow extends QueryResultRow { dispatch_state: string; attempts: number; next_attempt_at: Date }
/** Durable transport uncertainty. A lease and attempt CAS prevent a late acknowledgement from overwriting a successor. */
export class HostedOutbox {
  constructor(readonly database: HostedDatabase, readonly quotas: QuotaLedger, readonly dispatcher: JobDispatcher,
    readonly options: { config: HostedConfig; now?: () => number }) {}
  private now() { return new Date((this.options.now ?? Date.now)()); }
  async dispatch(reference: AcceptedJobReference, options: { force?: boolean; purpose: 'public' | 'maintenance' }): Promise<boolean> {
    let attempt: number | undefined;
    try {
      attempt = await this.database.transaction(async tx => {
        const now = this.now(); await assertLiveSession(tx, reference.sessionId, now, { lock: true });
        await requireWorkspace(tx, reference, true); const job = await requireJob(tx, reference, reference.jobId, true);
        const identity = [reference.sessionId, reference.workspaceId, reference.jobId];
        const row = (await tx.query<OutboxRow>('SELECT * FROM outbox_entries WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3 FOR UPDATE', identity)).rows[0];
        if (!row) throw new ApiError('RESOURCE_NOT_FOUND');
        if (isTerminalJob(publicJob(job).status) || job.status === 'running' || row.dispatch_state === 'published') {
          await tx.query('UPDATE operation_receipts SET response_status=202 WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3', identity);
          return undefined;
        }
        if (job.cancel_requested_at || now >= job.queue_expires_at) return undefined;
        if (row.dispatch_state === 'dispatching' && now < row.next_attempt_at) return undefined;
        if (!options.force && now < row.next_attempt_at) return undefined;
        const attempt = row.attempts + 1;
        // One publication can produce the initial callback plus every configured retry. Charge the conservative maximum,
        // including uncertain ACKs; provider deduplication is not an accounting guarantee.
        for (const [resource, units] of [['sql-bytes', 8192], ['qstash-deliveries', this.options.config.quotas.maxDeliveryRetries + 1]] as const) {
          const quota = await this.quotas.reserve(tx, { owner: reference, operationId: reference.jobId, resource, units, purpose: options.purpose, now });
          await this.quotas.consume(tx, { reservationId: quota.id, now });
        }
        await tx.query(`UPDATE outbox_entries SET dispatch_state='dispatching',attempts=$4,next_attempt_at=$5,last_error=NULL
          WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3`, [...identity, attempt, new Date(now.getTime() + 30_000)]);
        return attempt;
      });
    } catch (error) {
      // A closed quota cannot trigger an unaccounted external call. The existing pending row remains retryable.
      if (error instanceof ApiError && error.code === 'PUBLIC_CAPACITY_EXCEEDED') return false;
      throw error;
    }
    if (attempt === undefined) return false;
    let acknowledged = false;
    try { await this.dispatcher.dispatch({ sessionId: reference.sessionId, workspaceId: reference.workspaceId, jobId: reference.jobId }); acknowledged = true; }
    catch { /* Provider acceptance may already have happened. Never invent a second job or refund the attempt. */ }
    await this.database.transaction(async tx => {
      const identity = [reference.sessionId, reference.workspaceId, reference.jobId], now = this.now();
      // Bookkeeping must remain possible after the visitor closes the session during network I/O.
      await tx.query('SELECT id FROM demo_sessions WHERE id=$1 FOR UPDATE', [reference.sessionId]);
      await tx.query('SELECT id FROM workspaces WHERE session_id=$1 AND id=$2 FOR UPDATE', [reference.sessionId, reference.workspaceId]);
      const job = await requireJob(tx, reference, reference.jobId, true);
      const changed = await tx.query(`UPDATE outbox_entries SET dispatch_state=$5,next_attempt_at=$6,last_error=$7
        WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3 AND attempts=$4 AND dispatch_state='dispatching' RETURNING id`,
      [...identity, attempt, acknowledged ? 'published' : 'uncertain', new Date(now.getTime() + Math.min(120_000, 1000 * 2 ** Math.min(attempt, 7))), acknowledged ? null : 'DISPATCH_ACK_UNCERTAIN']);
      if (!changed.rowCount) return;
      await tx.query('UPDATE operation_receipts SET response_status=$4 WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3', [...identity, acknowledged ? 202 : 503]);
      if (['queued', 'dispatch_pending'].includes(job.status)) {
        await tx.query('UPDATE jobs SET status=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [...identity, acknowledged ? 'queued' : 'dispatch_pending']);
        await tx.query('UPDATE recalculation_operations SET phase=$4 WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3', [...identity, acknowledged ? 'queued' : 'dispatch_pending']);
      }
    });
    return acknowledged;
  }
}
