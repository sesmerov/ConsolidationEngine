import { randomUUID } from 'node:crypto';
import { ApiError } from '../errors.js';
import type { HostedConfig } from './config.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';

export type QuotaResource = 'session-state-bytes' | 'session-file-bytes' | 'blob-bytes' | 'sql-bytes'
  | 'blob-advanced-operations' | 'blob-simple-operations' | 'blob-transfer-bytes' | 'qstash-deliveries' | 'jobs' | 'session-creations';
export interface QuotaOwner { readonly sessionId: string; readonly workspaceId?: string }
export interface ReservationRequest {
  readonly owner?: QuotaOwner; readonly operationId: string; readonly resource: QuotaResource; readonly units: number;
  readonly purpose: 'public' | 'maintenance'; readonly now: Date;
}
export interface QuotaReservation {
  readonly id: string; readonly resource: QuotaResource; readonly units: number; readonly consumedUnits: number;
  readonly state: 'reserved' | 'consumed' | 'uncertain' | 'released' | 'cleanup_pending';
}
interface ReservationRow {
  id: string; session_id: string | null; workspace_id: string | null; resource: QuotaResource; units: string; consumed_units: string;
  operation_id: string; scope: 'global' | 'session' | 'workspace' | 'maintenance'; state: QuotaReservation['state'];
  [column: string]: unknown;
}
interface Budget { readonly limit: number; readonly since?: Date; readonly purpose?: 'public' | 'maintenance'; readonly sessionId?: string }
const lifetimeResources = new Set<QuotaResource>(['session-state-bytes','session-file-bytes','blob-bytes','sql-bytes']);
const resources: readonly QuotaResource[] = ['session-state-bytes','session-file-bytes','blob-bytes','sql-bytes','blob-advanced-operations',
  'blob-simple-operations','blob-transfer-bytes','qstash-deliveries','jobs','session-creations'];

/** Admission/accounting authority only. Callers authorize the owner and hold session/workspace locks first.
 * reserve/consume are short SQL operations; commit before contacting a provider. Every attempted provider call consumes its reservation.
 */
export class QuotaLedger {
  constructor(readonly database: HostedDatabase, readonly config: HostedConfig) {}
  async reserve(tx: DatabaseTransaction, request: ReservationRequest): Promise<QuotaReservation> {
    units(request.units); validDate(request.now);
    if (!resources.includes(request.resource) || !['public','maintenance'].includes(request.purpose)) throw new TypeError('Invalid quota resource or purpose');
    if ((request.resource === 'session-state-bytes' || request.resource === 'session-file-bytes') && !request.owner) throw new TypeError('Session quota requires an owner');
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':quota:'||$1,0))", [request.resource]);
    for (const budget of this.budgets(request)) {
      let used = await this.usage(tx, request.resource, budget);
      if (request.resource === 'sql-bytes') {
        // pg_total_relation_size includes materialized rows/indexes but not future writes already admitted by another pool.
        // Consumed bytes are already represented by measured storage or the ledger; add only the unconsumed reservation remainder.
        const pending = (await tx.query<{ units: string }>(`SELECT coalesce(sum(greatest(units-consumed_units,0)),0)::text AS units
          FROM quota_reservations WHERE resource='sql-bytes' AND state IN ('reserved','uncertain','cleanup_pending')`)).rows[0]!.units;
        used = Math.max(used, await this.measureSqlBytes(tx) + safeCount(pending));
      }
      if (used > budget.limit - request.units) throw new ApiError('PUBLIC_CAPACITY_EXCEEDED', { resource: request.resource,
        reason: request.purpose === 'maintenance' ? 'MAINTENANCE_CAPACITY' : 'PUBLIC_QUOTA', retryAfterSeconds: budget.since ? 60 : 300 });
    }
    const id = randomUUID(), scope = request.purpose === 'maintenance' ? 'maintenance' : request.owner ? (request.owner.workspaceId ? 'workspace' : 'session') : 'global';
    await tx.query(`INSERT INTO quota_reservations(id,session_id,workspace_id,scope,resource,units,operation_id,expires_at,state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9)`, [id, request.owner?.sessionId ?? null, request.owner?.workspaceId ?? null, scope,
      request.resource, request.units, request.operationId, new Date(request.now.getTime() + this.config.quotas.queueTtlMs + this.config.quotas.callbackDeadlineMs), request.now]);
    return { id, resource: request.resource, units: request.units, consumedUnits: 0, state: 'reserved' };
  }
  async consume(tx: DatabaseTransaction, request: { readonly reservationId: string; readonly units?: number; readonly attemptId?: string; readonly now: Date }): Promise<QuotaReservation> {
    validDate(request.now);
    const reservation = await this.row(tx, request.reservationId);
    const amount = request.units ?? Number(reservation.units); units(amount, true);
    if (amount > Number(reservation.units)) throw new TypeError('Consumption exceeds its reservation');
    if (!reservation.resource.endsWith('-bytes') && amount !== Number(reservation.units)) throw new TypeError('Operation/job attempts consume their entire reserved count');
    if (reservation.state === 'consumed') {
      if (Number(reservation.consumed_units) !== amount) throw new Error('Reservation already consumed with another amount');
      return projection(reservation);
    }
    if (!['reserved','uncertain'].includes(reservation.state)) throw new Error('Reservation is no longer consumable');
    await tx.query(`UPDATE quota_reservations SET state='consumed',consumed_units=$2 WHERE id=$1`, [reservation.id, amount]);
    await tx.query(`INSERT INTO usage_ledger(id,session_id,workspace_id,reservation_id,scope,resource,units,operation_id,attempt_id,recorded_at,category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [randomUUID(), reservation.session_id, reservation.workspace_id, reservation.id,
      reservation.scope, reservation.resource, amount, reservation.operation_id, request.attemptId ?? null, request.now, reservation.scope === 'maintenance' ? 'maintenance' : 'consumed']);
    return { ...projection(reservation), state: 'consumed', consumedUnits: amount };
  }
  async markUncertain(tx: DatabaseTransaction, reservationId: string): Promise<void> {
    const reservation = await this.row(tx, reservationId);
    if (reservation.state === 'reserved') await tx.query("UPDATE quota_reservations SET state='uncertain' WHERE id=$1", [reservationId]);
    else if (!['uncertain','consumed'].includes(reservation.state)) throw new Error('Reservation cannot become uncertain after release');
  }
  /** Assign already admitted bytes to a physical part. The transaction preserves the sum and owner; it does not admit more capacity. */
  async split(tx: DatabaseTransaction, request: { readonly reservationId: string; readonly units: number; readonly now: Date }): Promise<QuotaReservation> {
    units(request.units); validDate(request.now); const parent = await this.row(tx, request.reservationId);
    if (!lifetimeResources.has(parent.resource) || parent.state !== 'reserved' || Number(parent.consumed_units) !== 0) throw new Error('Only unused byte reservations can be split');
    if (request.units > Number(parent.units)) throw new Error('Split exceeds the reserved bytes');
    const id = randomUUID(), remaining = Number(parent.units) - request.units;
    await tx.query("UPDATE quota_reservations SET units=$2::bigint,state=CASE WHEN $2::bigint=0 THEN 'released' ELSE 'reserved' END WHERE id=$1", [parent.id, remaining]);
    await tx.query(`INSERT INTO quota_reservations(id,session_id,workspace_id,scope,resource,units,operation_id,expires_at,state,created_at)
      SELECT $2,session_id,workspace_id,scope,resource,$3,operation_id,expires_at,'reserved',$4 FROM quota_reservations WHERE id=$1`, [parent.id, id, request.units, request.now]);
    return { id, resource: parent.resource, units: request.units, consumedUnits: 0, state: 'reserved' };
  }
  /** Only confirmed absence/deletion permits refunding retained bytes. Consumed attempts/jobs are never refunded. */
  async release(tx: DatabaseTransaction, request: { readonly reservationId: string; readonly confirmedAbsent: true; readonly now: Date }): Promise<void> {
    if (request.confirmedAbsent !== true) throw new Error('Uncertain reservations require confirmed reconciliation'); validDate(request.now);
    const reservation = await this.row(tx, request.reservationId);
    if (reservation.state === 'released') return;
    if (Number(reservation.consumed_units) > 0 && !lifetimeResources.has(reservation.resource)) throw new Error('Consumed provider attempts and accepted jobs cannot be refunded');
    if (Number(reservation.consumed_units) > 0) await tx.query(`INSERT INTO usage_ledger(id,session_id,workspace_id,reservation_id,scope,resource,units,operation_id,recorded_at,category)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'released')`, [randomUUID(), reservation.session_id, reservation.workspace_id, reservation.id,
      reservation.scope, reservation.resource, reservation.consumed_units, reservation.operation_id, request.now]);
    await tx.query("UPDATE quota_reservations SET state='released' WHERE id=$1", [reservation.id]);
  }
  async measureSqlBytes(tx: DatabaseTransaction = this.database): Promise<number> {
    const result = await tx.query<{ bytes: string }>(`SELECT coalesce(sum(pg_total_relation_size(c.oid)),0)::text AS bytes
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relkind IN ('r','m')`);
    return safeCount(result.rows[0]!.bytes);
  }
  private async row(tx: DatabaseTransaction, id: string): Promise<ReservationRow> {
    // ID is an internal server reference. Public callers cannot use this method as authorization.
    const row = (await tx.query<ReservationRow>('SELECT * FROM quota_reservations WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!row) throw new Error('Quota reservation not found'); return row;
  }
  private budgets(request: ReservationRequest): readonly Budget[] {
    const { limits, quotas } = this.config, now = request.now;
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const month = new Date(now.getTime() - 30 * 24 * 60 * 60_000);
    const rolling = (limit: number, reserve: number) => [{ limit, since: month }, ...(request.purpose === 'public' ? [{ limit: limit - reserve, since: month, purpose: 'public' as const }] : [])];
    switch (request.resource) {
      case 'session-state-bytes': return [{ limit: limits.maxStateBytes, sessionId: request.owner!.sessionId }];
      case 'session-file-bytes': return [{ limit: limits.maxStoredFileBytes, sessionId: request.owner!.sessionId }];
      case 'blob-bytes': return [{ limit: quotas.blobBytes }];
      case 'sql-bytes': return [{ limit: quotas.sqlBytes }];
      case 'blob-advanced-operations': return rolling(quotas.blobAdvancedOperations, quotas.blobMaintenanceAdvancedOperations);
      case 'blob-simple-operations': return rolling(quotas.blobSimpleOperations, quotas.blobMaintenanceSimpleOperations);
      case 'blob-transfer-bytes': return rolling(quotas.blobTransferBytes, quotas.blobMaintenanceTransferBytes);
      case 'qstash-deliveries': return [{ limit: quotas.queuePublicDeliveriesPerDay + quotas.queueMaintenanceDeliveriesPerDay, since: day },
        { limit: request.purpose === 'maintenance' ? quotas.queueMaintenanceDeliveriesPerDay : quotas.queuePublicDeliveriesPerDay, since: day, purpose: request.purpose }];
      case 'jobs': return [{ limit: limits.maxJobsPerDay, since: day }, { limit: limits.maxJobsPer30Days, since: month }];
      case 'session-creations': return [{ limit: limits.maxCreationsPerDay, since: day }];
    }
  }
  private async usage(tx: DatabaseTransaction, resource: QuotaResource, budget: Budget): Promise<number> {
    // One statement sees reservations and ledger at one MVCC snapshot during consume/release transitions.
    const result = await tx.query<{ units: string }>(`SELECT coalesce(sum(units),0)::text AS units FROM (
      SELECT units FROM quota_reservations WHERE resource=$1 AND state IN ('reserved','uncertain','cleanup_pending')
        AND ($3::uuid IS NULL OR session_id=$3) AND ($4::text IS NULL OR (scope='maintenance')=($4='maintenance'))
      UNION ALL
      SELECT CASE WHEN category='released' THEN -units ELSE units END FROM usage_ledger WHERE resource=$1
        AND category IN ('consumed','maintenance','released') AND ($2::timestamptz IS NULL OR recorded_at>=$2)
        AND ($3::uuid IS NULL OR session_id=$3) AND ($4::text IS NULL OR (scope='maintenance')=($4='maintenance'))
      ) usage`, [resource, budget.since ?? null, budget.sessionId ?? null, budget.purpose ?? null]);
    return safeCount(result.rows[0]!.units);
  }
}
function projection(row: ReservationRow): QuotaReservation { return { id: row.id, resource: row.resource, units: Number(row.units), consumedUnits: Number(row.consumed_units), state: row.state }; }
function units(value: number, allowZero = false): void { if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) throw new TypeError('Quota units must be bounded nonnegative integers'); }
function safeCount(value: string): number { const number = Number(value); units(number, true); return number; }
function validDate(value: Date): void { if (!Number.isFinite(value.getTime())) throw new TypeError('Invalid quota time'); }
