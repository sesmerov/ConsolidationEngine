import { createHash, randomUUID } from 'node:crypto';
import type { QueryResultRow } from 'pg';
import type { JsonObject } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { requireVersion, requireWorkspace, revisionNumber, workspaceEtag, type WorkspaceRow } from './postgres-repository.js';
import { QuotaLedger } from './quota-ledger.js';
import { assertLiveSession, touchMeaningful } from './session-service.js';

interface MutationIdentity { readonly method: 'POST' | 'DELETE'; readonly path: string; readonly fingerprint: string; readonly expectedBase: string }
interface MutationRow extends QueryResultRow { method: string; path: string; request_fingerprint: string; expected_base: string; workspace_id: string }
function keyHash(key: string): string {
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(key)) throw new ApiError('INVALID_REQUEST', { reason: 'IDEMPOTENCY_KEY_REQUIRED' });
  return createHash('sha256').update(key).digest('hex');
}
/** Manual workspace mutations use short owner-locked SQL transactions, independently of CPU job receipts. */
export class HostedWorkspaceService {
  constructor(readonly database: HostedDatabase, readonly quotas: QuotaLedger, readonly now: () => Date = () => new Date()) {}
  async metadata(owner: WorkspaceOwner) {
    return this.database.transaction(async tx => {
      await assertLiveSession(tx, owner.sessionId, this.now(), { lock: true });
      const row = await requireWorkspace(tx, owner, true);
      const version = row.current_version_id ? await requireVersion(tx, owner, row.current_version_id) : undefined;
      const versions = (await tx.query<{ id: string }>('SELECT id FROM workspace_versions WHERE session_id=$1 AND workspace_id=$2 AND retained ORDER BY created_at,id LIMIT 20', [owner.sessionId, owner.workspaceId])).rows;
      const active = (await tx.query<{ id: string }>("SELECT id FROM jobs WHERE session_id=$1 AND workspace_id=$2 AND status IN ('queued','dispatch_pending','running') ORDER BY accepted_at,id LIMIT 1", [owner.sessionId, owner.workspaceId])).rows[0];
      const bytes = (await tx.query<{ units: string }>("SELECT coalesce(sum(units),0)::text AS units FROM quota_reservations WHERE session_id=$1 AND resource='session-state-bytes' AND state<>'released'", [owner.sessionId])).rows[0]!.units;
      const counts = version?.summary['counts'] as Record<string, number> | undefined;
      return { etag: workspaceEtag(row), body: { id: row.id, name: row.name, state: row.status,
        ...(row.current_version_id ? { currentVersionId: row.current_version_id } : {}), ...(row.current_basis_id ? { validationBasisId: row.current_basis_id } : {}),
        ...(active ? { activeJobId: active.id } : {}), versionIds: versions.map(item => item.id), contextCount: Number(version?.summary['contextCount'] ?? 0),
        counts: { snapshots: versions.length, coordinates: counts?.['coordinates'] ?? 0, facts: counts?.['facts'] ?? 0, sources: counts?.['sources'] ?? 0 }, sessionBytes: revisionNumber(bytes) } };
    });
  }
  async create(sessionId: string, inputName: string, key: string): Promise<WorkspaceRow> {
    const name = inputName.trim(); if (!name || name.length > 200) throw new ApiError('INVALID_REQUEST');
    const hash = keyHash(key), identity: MutationIdentity = { method: 'POST', path: '/api/v1/workspaces', fingerprint: canonicalHash({ name: inputName }), expectedBase: '' };
    return this.database.transaction(async tx => {
      const now = this.now(); await assertLiveSession(tx, sessionId, now, { lock: true });
      const prior = await this.receipt(tx, sessionId, hash, identity);
      if (prior) return requireWorkspace(tx, { sessionId, workspaceId: prior.workspace_id });
      if ((await tx.query("SELECT id FROM workspaces WHERE session_id=$1 AND status<>'closed'", [sessionId])).rowCount) throw new ApiError('ACTIVE_WORKSPACE_EXISTS');
      const id = randomUUID(), owner = { sessionId, workspaceId: id };
      await tx.query('INSERT INTO workspaces(session_id,id,name,created_at) VALUES($1,$2,$3,$4)', [sessionId, id, name, now]);
      const reservation = await this.quotas.reserve(tx, { owner, operationId: id, resource: 'sql-bytes', units: 32 * 1024, purpose: 'public', now });
      await this.quotas.consume(tx, { reservationId: reservation.id, now });
      await this.saveReceipt(tx, owner, hash, identity, 201, { id }, now);
      await touchMeaningful(tx, sessionId, now);
      return requireWorkspace(tx, owner);
    });
  }
  async close(owner: WorkspaceOwner, expectedBase: string, key: string): Promise<void> {
    if (!expectedBase) throw new ApiError('PRECONDITION_REQUIRED');
    const hash = keyHash(key), identity: MutationIdentity = { method: 'DELETE', path: '/api/v1/workspaces/' + owner.workspaceId, fingerprint: canonicalHash({}), expectedBase };
    await this.database.transaction(async tx => {
      const now = this.now(); await assertLiveSession(tx, owner.sessionId, now, { lock: true });
      if (await this.receipt(tx, owner.sessionId, hash, identity)) return;
      const workspace = await requireWorkspace(tx, owner, true);
      if (workspaceEtag(workspace) !== expectedBase) throw new ApiError('STALE_VERSION');
      const identityValues = [owner.sessionId, owner.workspaceId, now];
      await tx.query("UPDATE workspaces SET status='closed',revision=revision+1 WHERE session_id=$1 AND id=$2", identityValues.slice(0, 2));
      await tx.query(`UPDATE jobs SET cancel_requested_at=coalesce(cancel_requested_at,$3),status='cancelled',terminal_at=$3
        WHERE session_id=$1 AND workspace_id=$2 AND status IN ('queued','dispatch_pending','running')`, identityValues);
      await tx.query("UPDATE outbox_entries SET dispatch_state='cancelled' WHERE session_id=$1 AND workspace_id=$2 AND dispatch_state IN ('pending','dispatching','uncertain')", identityValues.slice(0, 2));
      await tx.query(`INSERT INTO cleanup_tasks(id,session_id,object_ref,reason,not_before,deadline,state,updated_at)
        VALUES($1,$2,$3,'workspace-closed',$4,$5,'pending',$4)`, [randomUUID(), owner.sessionId,
        { kind: 'workspace', ...owner }, now, new Date(now.getTime() + this.quotas.config.limits.cleanupDeadlineMs)]);
      // Creation's metadata reserve covers close/cancellation/cleanup; revocation does not depend on public admission.
      await this.saveReceipt(tx, owner, hash, identity, 204, {}, now);
    });
  }
  private async receipt(tx: DatabaseTransaction, sessionId: string, hash: string, identity: MutationIdentity): Promise<MutationRow | undefined> {
    const row = (await tx.query<MutationRow>('SELECT * FROM mutation_receipts WHERE session_id=$1 AND key_hash=$2', [sessionId, hash])).rows[0];
    if (row && (row.method !== identity.method || row.path !== identity.path || row.request_fingerprint !== identity.fingerprint || row.expected_base !== identity.expectedBase)) throw new ApiError('IDEMPOTENCY_CONFLICT');
    return row;
  }
  private async saveReceipt(tx: DatabaseTransaction, owner: WorkspaceOwner, hash: string, identity: MutationIdentity, status: 201 | 204, response: JsonObject, now: Date): Promise<void> {
    await tx.query(`INSERT INTO mutation_receipts(session_id,key_hash,method,path,request_fingerprint,expected_base,workspace_id,response_status,response,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [owner.sessionId, hash, identity.method, identity.path, identity.fingerprint, identity.expectedBase, owner.workspaceId, status, response, now]);
  }
}
