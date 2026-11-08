import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { JsonObject, OperationReceiptDTO, OperationReservationDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { HostedConfig } from './config.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import type { HostedOutbox } from './outbox.js';
import { requireJob, requireWorkspace, workspaceEtag, type JobRow } from './postgres-repository.js';
import { QuotaLedger } from './quota-ledger.js';
import { assertLiveSession, touchMeaningful } from './session-service.js';

/** Internal command after HTTP schema validation. inputRefs are server-owned references, never the raw upload/body. */
export interface JobAcceptanceRequest extends WorkspaceOwner {
  readonly key: string; readonly method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly path: string;
  readonly body: JsonObject; readonly expectedBase: string; readonly baseVersionId?: string;
  readonly kind: JobRow['kind']; readonly inputRefs: JsonObject; readonly expectedRevision?: number;
  readonly reservation?: OperationReservationDTO; readonly meaningful: boolean;
}
export interface AcceptedIdentity extends WorkspaceOwner { readonly jobId: string; readonly operationId: string; readonly now: Date }
/** Short SQL-only hook to validate/reserve domain IDs in the acceptance transaction; never persisted or sent to a worker. */
export interface ReservedDomain {
  readonly inputRefs?: JsonObject;
  readonly reservation?: OperationReservationDTO;
}
export type ReserveDomain = (tx: DatabaseTransaction, identity: AcceptedIdentity) => Promise<void | ReservedDomain>;
export type ReuseAcceptedJob = (tx: DatabaseTransaction, request: JobAcceptanceRequest) => Promise<string | undefined>;
interface ReceiptRow extends QueryResultRow {
  session_id: string; workspace_id: string; job_id: string; operation_id: string;
  method: string; path: string; request_fingerprint: string; expected_base: string;
  response_status: 202 | 503; reservation: OperationReservationDTO | null;
}
const keyHash = (key: string) => createHash('sha256').update(key).digest('hex');
function projection(row: ReceiptRow, job: JobRow): OperationReceiptDTO {
  return { operationId: row.operation_id, workspaceId: row.workspace_id, jobId: row.job_id,
    responseStatus: row.response_status, phase: job.status, ...(row.reservation ? { reservation: row.reservation } : {}),
    ...(job.status === 'succeeded' ? job.result_refs ?? {} : {}) };
}
export class HostedJobAcceptance {
  constructor(readonly database: HostedDatabase, readonly quotas: QuotaLedger, readonly outbox: HostedOutbox,
    readonly options: { config: HostedConfig; now?: () => number }) {}
  private now() { return new Date((this.options.now ?? Date.now)()); }
  async accept(request: JobAcceptanceRequest, reserveDomain?: ReserveDomain, reuse?: ReuseAcceptedJob): Promise<OperationReceiptDTO> {
    if (!request.key || request.key.length > 200 || !request.expectedBase) throw new ApiError('PRECONDITION_REQUIRED');
    if (Buffer.byteLength(JSON.stringify(request.inputRefs), 'utf8') > 32_768) throw new ApiError('SESSION_LIMIT');
    const fingerprint = canonicalHash(request.body), hash = keyHash(request.key);
    const identity = await this.database.transaction(async tx => {
      const now = this.now(); await assertLiveSession(tx, request.sessionId, now, { lock: true });
      const workspace = await requireWorkspace(tx, request, true);
      const previous = (await tx.query<ReceiptRow>('SELECT * FROM operation_receipts WHERE session_id=$1 AND key_hash=$2', [request.sessionId, hash])).rows[0];
      if (previous) {
        if (previous.workspace_id !== request.workspaceId || previous.method !== request.method || previous.path !== request.path
          || previous.request_fingerprint !== fingerprint || previous.expected_base !== request.expectedBase) throw new ApiError('IDEMPOTENCY_CONFLICT');
        return { ...request, jobId: previous.job_id };
      }
      if (workspaceEtag(workspace) !== request.expectedBase || (request.baseVersionId ?? null) !== workspace.current_version_id) throw new ApiError('STALE_VERSION');
      const reusable = await reuse?.(tx, request);
      if (reusable) {
        await requireJob(tx, request, reusable);
        const prior = (await tx.query<ReceiptRow>('SELECT * FROM operation_receipts WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3 ORDER BY created_at LIMIT 1',
          [request.sessionId, request.workspaceId, reusable])).rows[0];
        if (!prior) throw new ApiError('RESOURCE_NOT_FOUND');
        const quota = await this.quotas.reserve(tx, { owner: request, operationId: reusable, resource: 'sql-bytes', units: 16384, purpose: 'public', now });
        await tx.query(`INSERT INTO operation_receipts(session_id,workspace_id,key_hash,method,path,request_fingerprint,expected_base,response_status,job_id,operation_id,reservation,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [request.sessionId, request.workspaceId, hash, request.method, request.path, fingerprint,
          request.expectedBase, prior.response_status, reusable, prior.operation_id, prior.reservation, now]);
        await this.quotas.consume(tx, { reservationId: quota.id, now });
        return { ...request, jobId: reusable };
      }
      // The global queue bound is serialized independently of the owner locks.
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':queue-admission',0))");
      const queued = (await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM jobs WHERE status IN ('queued','dispatch_pending') AND queue_expires_at>$1", [now])).rows[0]!.count;
      if (queued >= this.options.config.limits.maxQueuedJobs) throw new ApiError('PUBLIC_CAPACITY_EXCEEDED', { resource: 'queue', retryAfterSeconds: 10 });
      const jobId = randomUUID(), accepted = { sessionId: request.sessionId, workspaceId: request.workspaceId, jobId, operationId: jobId, now };
      for (const [resource, units] of [['sql-bytes', 65_536], ['jobs', 1]] as const) {
        const reservation = await this.quotas.reserve(tx, { owner: request, operationId: jobId, resource, units, purpose: 'public', now });
        await this.quotas.consume(tx, { reservationId: reservation.id, now });
      }
      await tx.query(`INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,base_version_id,expected_revision,accepted_at,queue_expires_at,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'dispatch_pending')`, [request.sessionId, request.workspaceId, jobId, request.kind,
        { ...request.inputRefs, workspaceRevision: workspace.revision },
        request.baseVersionId ?? null, request.expectedRevision ?? null, now, new Date(now.getTime() + this.options.config.quotas.queueTtlMs)]);
      const domain = await reserveDomain?.(tx, accepted);
      if (domain?.inputRefs) {
        const refs = { ...domain.inputRefs, workspaceRevision: workspace.revision };
        if (Buffer.byteLength(JSON.stringify(refs), 'utf8') > 32_768) throw new ApiError('SESSION_LIMIT');
        await tx.query('UPDATE jobs SET input_refs=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [request.sessionId, request.workspaceId, jobId, refs]);
      }
      await tx.query(`INSERT INTO operation_receipts(session_id,workspace_id,key_hash,method,path,request_fingerprint,expected_base,response_status,job_id,operation_id,reservation,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,503,$8,$8,$9,$10)`, [request.sessionId, request.workspaceId, hash, request.method, request.path, fingerprint, request.expectedBase,
        jobId, domain?.reservation ?? request.reservation ?? null, now]);
      await tx.query(`INSERT INTO outbox_entries(session_id,workspace_id,id,job_id,dispatch_state,next_attempt_at,created_at)
        VALUES($1,$2,$3,$4,'pending',$5,$5)`, [request.sessionId, request.workspaceId, randomUUID(), jobId, now]);
      if (request.meaningful) await touchMeaningful(tx, request.sessionId, now);
      return accepted;
    });
    // Both success and uncertainty are durable before returning; no SQL transaction spans transport I/O.
    await this.outbox.dispatch(identity, { force: true, purpose: 'public' });
    return this.receiptByKey(request.sessionId, request.key);
  }
  async receiptByKey(sessionId: string, key: string): Promise<OperationReceiptDTO> { return this.receipt(sessionId, 'key_hash', keyHash(key)); }
  async receiptByOperation(sessionId: string, operationId: string): Promise<OperationReceiptDTO> { return this.receipt(sessionId, 'operation_id', operationId); }
  private async receipt(sessionId: string, column: 'key_hash' | 'operation_id', value: string): Promise<OperationReceiptDTO> {
    return this.database.transaction(async tx => {
      await assertLiveSession(tx, sessionId, this.now());
      const row = (await tx.query<ReceiptRow>(`SELECT * FROM operation_receipts WHERE session_id=$1 AND ${column}=$2 ORDER BY created_at LIMIT 1`, [sessionId, value])).rows[0];
      if (!row) throw new ApiError('RESOURCE_NOT_FOUND');
      const owner = { sessionId, workspaceId: row.workspace_id }; await requireWorkspace(tx, owner);
      return projection(row, await requireJob(tx, owner, row.job_id));
    });
  }
}
