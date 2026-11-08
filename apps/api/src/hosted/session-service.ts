import { createHash, randomUUID } from 'node:crypto';
import type { DemoSessionDTO, DemoSessionState } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { HostedConfig } from './config.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { QuotaLedger } from './quota-ledger.js';

interface SessionRow {
  id: string; state: DemoSessionState; created_at: Date; last_meaningful_activity_at: Date; expires_at: Date; absolute_expires_at: Date;
  revoked_at: Date | null; token_hash: string; creation_nonce_hash: string; [column: string]: unknown;
}
export interface LiveSession {
  readonly id: string; readonly state: 'active'; readonly createdAt: Date; readonly lastMeaningfulActivityAt: Date;
  readonly expiresAt: Date; readonly absoluteExpiresAt: Date;
}
export interface AuthorizedSession extends Omit<LiveSession, 'state'> { readonly state: DemoSessionState; readonly revokedAt?: Date }
const sessionFields = 'id,state,created_at,last_meaningful_activity_at,expires_at,absolute_expires_at,revoked_at,token_hash,creation_nonce_hash';

/** Recheck the database for every command/claim/publication. This helper never touches activity or owns a transaction. */
export async function assertLiveSession(tx: DatabaseTransaction, sessionId: string, now: Date, options: { readonly lock?: true } = {}): Promise<LiveSession> {
  const row = (await tx.query<SessionRow>(`SELECT ${sessionFields} FROM demo_sessions WHERE id=$1${options.lock ? ' FOR UPDATE' : ''}`, [sessionId])).rows[0];
  if (!row) throw new ApiError('SESSION_UNAUTHENTICATED');
  if (!isLive(row, now)) throw new ApiError('SESSION_EXPIRED');
  return { ...authorized(row), state: 'active' };
}
/** Invoke only after accepting a new manual action. Replays, reads, automatic drafts/parts never call this. */
export async function touchMeaningful(tx: DatabaseTransaction, sessionId: string, now: Date): Promise<LiveSession> {
  const session = await assertLiveSession(tx, sessionId, now, { lock: true });
  if (now.getTime() - session.lastMeaningfulActivityAt.getTime() < 30_000) return session;
  // Preserve the configured inactivity period from the authoritative timestamps, capped by absolute expiry.
  const idleMs = session.expiresAt.getTime() - session.lastMeaningfulActivityAt.getTime();
  const expiresAt = new Date(Math.min(now.getTime() + idleMs, session.absoluteExpiresAt.getTime()));
  await tx.query('UPDATE demo_sessions SET last_meaningful_activity_at=$2,expires_at=$3 WHERE id=$1', [sessionId, now, expiresAt]);
  return { ...session, lastMeaningfulActivityAt: now, expiresAt };
}
export function sessionSecretHash(secret: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new ApiError('SESSION_UNAUTHENTICATED');
  const bytes = Buffer.from(secret, 'base64url');
  if (bytes.length !== 32 || bytes.toString('base64url') !== secret) throw new ApiError('SESSION_UNAUTHENTICATED');
  return createHash('sha256').update(bytes).digest('hex');
}
export class SessionService {
  constructor(readonly database: HostedDatabase, readonly config: HostedConfig, readonly quotas: QuotaLedger) {}
  async create(token: string, creationNonce: string, now: Date): Promise<{ readonly statusCode: 200 | 201; readonly session: DemoSessionDTO }> {
    const tokenHash = sessionSecretHash(token), nonceHash = sessionSecretHash(creationNonce);
    const result = await this.database.transaction(async tx => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema()||':session-creation',0))");
      const existing = (await tx.query<SessionRow>(`SELECT ${sessionFields} FROM demo_sessions WHERE token_hash=$1 OR creation_nonce_hash=$2 FOR UPDATE`, [tokenHash, nonceHash])).rows;
      if (existing.length) {
        if (existing.length !== 1 || existing[0]!.token_hash !== tokenHash || existing[0]!.creation_nonce_hash !== nonceHash) throw new ApiError('SESSION_CREATION_CONFLICT');
        const row = existing[0]!;
        if (!isLive(row, now)) { if (row.state === 'active') await this.closeRow(tx, row, now, 'expired'); return { expired: true } as const; }
        return { statusCode: 200 as const, session: await this.dto(tx, row) };
      }
      // Expired sessions do not occupy active capacity, regardless of whether a browser or scheduler visited them.
      const active = (await tx.query<{ count: number }>("SELECT count(*)::int AS count FROM demo_sessions WHERE state='active' AND expires_at>$1 AND absolute_expires_at>$1", [now])).rows[0]!.count;
      if (active >= this.config.limits.maxActiveSessions) throw new ApiError('PUBLIC_CAPACITY_EXCEEDED', { resource: 'active-sessions', retryAfterSeconds: 60 });
      const id = randomUUID(), expiresAt = new Date(now.getTime() + this.config.limits.idleTimeoutMs), absoluteExpiresAt = new Date(now.getTime() + this.config.limits.absoluteTimeoutMs);
      await tx.query(`INSERT INTO demo_sessions(id,token_hash,creation_nonce_hash,created_at,last_meaningful_activity_at,expires_at,absolute_expires_at)
        VALUES($1,$2,$3,$4,$4,$5,$6)`, [id, tokenHash, nonceHash, now, expiresAt, absoluteExpiresAt]);
      const reservation = await this.quotas.reserve(tx, { owner: { sessionId: id }, operationId: id, resource: 'session-creations', units: 1, purpose: 'public', now });
      await this.quotas.consume(tx, { reservationId: reservation.id, now });
      // Includes the future cancellation/cleanup metadata so revocation does not depend on public admission.
      const metadata = await this.quotas.reserve(tx, { owner: { sessionId: id }, operationId: id, resource: 'sql-bytes', units: 16 * 1024, purpose: 'public', now });
      await this.quotas.consume(tx, { reservationId: metadata.id, now });
      return { statusCode: 201 as const, session: { id, state: 'active' as const, createdAt: now.toISOString(), lastMeaningfulActivityAt: now.toISOString(), expiresAt: expiresAt.toISOString(), absoluteExpiresAt: absoluteExpiresAt.toISOString() } };
    });
    if ('expired' in result) throw new ApiError('SESSION_EXPIRED');
    return result;
  }
  async authorize(token: string, now: Date, options: { readonly allowClosed?: boolean } = {}): Promise<AuthorizedSession> {
    const hash = sessionSecretHash(token);
    const result = await this.database.transaction(async tx => {
      const row = (await tx.query<SessionRow>(`SELECT ${sessionFields} FROM demo_sessions WHERE token_hash=$1 FOR UPDATE`, [hash])).rows[0];
      if (!row) throw new ApiError('SESSION_UNAUTHENTICATED');
      if (!isLive(row, now)) {
        if (row.state === 'active') { await this.closeRow(tx, row, now, 'expired'); row.state = 'expired'; row.revoked_at = now; }
        return { session: authorized(row), expired: !options.allowClosed };
      }
      return { session: authorized(row), expired: false };
    });
    // Throw after commit so revocation/cancellation/cleanup cannot roll back with the HTTP error.
    if (result.expired) throw new ApiError('SESSION_EXPIRED');
    return result.session;
  }
  async metadata(sessionId: string, now: Date): Promise<DemoSessionDTO> {
    return this.database.transaction(async tx => {
      await assertLiveSession(tx, sessionId, now);
      const row = (await tx.query<SessionRow>(`SELECT ${sessionFields} FROM demo_sessions WHERE id=$1`, [sessionId])).rows[0]!;
      return this.dto(tx, row);
    });
  }
  async revoke(sessionId: string, now: Date): Promise<void> {
    await this.database.transaction(async tx => {
      const row = (await tx.query<SessionRow>(`SELECT ${sessionFields} FROM demo_sessions WHERE id=$1 FOR UPDATE`, [sessionId])).rows[0];
      if (!row) throw new ApiError('SESSION_UNAUTHENTICATED');
      if (row.state === 'active') await this.closeRow(tx, row, now, isLive(row, now) ? 'revoked' : 'expired');
    });
  }
  private async dto(tx: DatabaseTransaction, row: SessionRow): Promise<DemoSessionDTO> {
    const workspace = (await tx.query<{ id: string }>("SELECT id FROM workspaces WHERE session_id=$1 AND status<>'closed'", [row.id])).rows[0];
    return { id: row.id, state: row.state, createdAt: row.created_at.toISOString(), lastMeaningfulActivityAt: row.last_meaningful_activity_at.toISOString(),
      expiresAt: row.expires_at.toISOString(), absoluteExpiresAt: row.absolute_expires_at.toISOString(), ...(row.revoked_at ? { revokedAt: row.revoked_at.toISOString() } : {}),
      ...(workspace ? { activeWorkspaceId: workspace.id } : {}) };
  }
  private async closeRow(tx: DatabaseTransaction, row: SessionRow, now: Date, reason: 'revoked' | 'expired'): Promise<void> {
    await tx.query('UPDATE demo_sessions SET state=$2,revoked_at=$3,reason=$2 WHERE id=$1', [row.id, reason, now]);
    await tx.query(`UPDATE jobs SET cancel_requested_at=coalesce(cancel_requested_at,$2),
      status=CASE WHEN status IN ('queued','dispatch_pending') THEN 'cancelled' ELSE status END,
      terminal_at=CASE WHEN status IN ('queued','dispatch_pending') THEN $2 ELSE terminal_at END
      WHERE session_id=$1 AND status IN ('queued','dispatch_pending','running')`, [row.id, now]);
    await tx.query("UPDATE outbox_entries SET dispatch_state='cancelled' WHERE session_id=$1 AND dispatch_state IN ('pending','dispatching','uncertain')", [row.id]);
    await tx.query(`INSERT INTO cleanup_tasks(id,session_id,object_ref,reason,not_before,deadline,state,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,'pending',$5)`, [randomUUID(), row.id, { kind: 'session', sessionId: row.id }, reason, now,
      new Date(now.getTime() + this.config.limits.cleanupDeadlineMs)]);
  }
}
function isLive(row: SessionRow, now: Date): boolean { return row.state === 'active' && row.revoked_at === null && row.expires_at.getTime() > now.getTime() && row.absolute_expires_at.getTime() > now.getTime(); }
function authorized(row: SessionRow): AuthorizedSession { return { id: row.id, state: row.state, createdAt: row.created_at,
  lastMeaningfulActivityAt: row.last_meaningful_activity_at, expiresAt: row.expires_at, absoluteExpiresAt: row.absolute_expires_at,
  ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}) }; }
