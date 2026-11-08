import type { QueryResultRow } from 'pg';
import type { CompactValidationRunDTO, Diagnostic, DirectionReviewSummaryDTO, JobDTO, JsonObject, JsonValue,
  ProposalSelectionSummaryDTO, ResultRef, Snapshot, ValidationSummary } from '@ce/contracts';
import { UUID_PATTERN } from '@ce/contracts';
import type { WorkspaceMetadata, WorkspaceOwner, WorkspaceRepository, VersionMetadata } from '../ports/workspace-repository.js';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { HostedDatabase, DatabaseTransaction } from './database.js';
import { assertLiveSession } from './session-service.js';

export interface CanonicalResourceReference {
  readonly resourceId: string; readonly manifestId: string; readonly codecVersion: number; readonly sha256: string; readonly byteLength: number;
}
export interface WorkspaceRow extends QueryResultRow {
  session_id: string; id: string; name: string; current_version_id: string | null; current_basis_id: string | null;
  revision: string; status: 'empty' | 'ready' | 'closed';
}
export interface VersionRow extends QueryResultRow {
  session_id: string; workspace_id: string; id: string; parent_id: string | null; basis_id: string;
  content_manifest_ref: CanonicalResourceReference; directions_ref: JsonObject; content_hash: string; config_version: string | null;
  profile_id: string | null; catalog_version: string | null; report_version: string | null;
  summary: JsonObject; reason: 'import' | 'configuration' | 'application'; created_at: Date; revision: string;
}
export interface ValidationRow extends QueryResultRow {
  session_id: string; workspace_id: string; id: string; version_id: string; basis_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'; summary: ValidationSummary;
  result_index_ref: JsonObject | null; diagnostics_ref: JsonObject | null; profile_id: string | null;
  created_at: Date; started_at: Date | null; completed_at: Date | null;
}
export interface JobRow extends QueryResultRow {
  session_id: string; workspace_id: string; id: string; kind: JobDTO['kind'] | 'seal-upload'; input_refs: JsonObject;
  base_version_id: string | null; expected_revision: string | null; accepted_at: Date; queue_expires_at: Date;
  started_at: Date | null; deadline_at: Date | null; terminal_at: Date | null; cancel_requested_at: Date | null;
  status: JobDTO['status'] | 'dispatch_pending'; fence: string; attempt_id: string | null;
  result_refs: { resultRef?: ResultRef; newVersionId?: string } | null; diagnostics: { items?: readonly Diagnostic[] }; progress: Partial<JobDTO['progress']>;
}
export interface ReviewRow extends QueryResultRow {
  session_id: string; workspace_id: string; id: string; basis_id: string; source_run_id: string; base_version_id: string;
  revision: string; state: DirectionReviewSummaryDTO['state']; config_changed: boolean; dirty_count: number; base_config_version: string | null;
  preparation_job_id: string | null; pending_job_id: string | null; ready_at: Date | null; expires_at: Date;
  counts: DirectionReviewSummaryDTO['counts']; receipt: DirectionReviewSummaryDTO['receipt'] | null; choices_ref: JsonObject | null;
}
export interface SelectionRow extends QueryResultRow {
  session_id: string; workspace_id: string; id: string; preview_id: string; version_id: string; basis_id: string; revision: string;
  mask_ref: JsonObject; counters: JsonObject; selection_hash: string; state: ProposalSelectionSummaryDTO['state'] | 'expired';
  initialization_job_id: string | null; pending_job_id: string | null;
}
export function revisionNumber(value: string | number): number {
  const number = Number(value); if (!Number.isSafeInteger(number) || number < 0) throw new ApiError('INTERNAL_ERROR'); return number;
}
export const workspaceEtag = (row: WorkspaceRow) => `"${row.id}:${row.revision}:${row.current_version_id ?? 'empty'}"`;
/** Transaction callers authorize/lock the session first. Every resource lookup remains owner-qualified. */
export async function requireWorkspace(tx: DatabaseTransaction, owner: WorkspaceOwner, lock = false): Promise<WorkspaceRow> {
  const row = (await tx.query<WorkspaceRow>(`SELECT * FROM workspaces WHERE session_id=$1 AND id=$2 AND status<>'closed'${lock ? ' FOR UPDATE' : ''}`,
    [owner.sessionId, owner.workspaceId])).rows[0];
  if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
}
export async function requireVersion(tx: DatabaseTransaction, owner: WorkspaceOwner, versionId: string): Promise<VersionRow> {
  const row = (await tx.query<VersionRow>('SELECT * FROM workspace_versions WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND retained',
    [owner.sessionId, owner.workspaceId, versionId])).rows[0];
  if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
}
export async function requireJob(tx: DatabaseTransaction, owner: WorkspaceOwner, jobId: string, lock = false): Promise<JobRow> {
  const row = (await tx.query<JobRow>(`SELECT * FROM jobs WHERE session_id=$1 AND workspace_id=$2 AND id=$3${lock ? ' FOR UPDATE' : ''}`,
    [owner.sessionId, owner.workspaceId, jobId])).rows[0];
  if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
}
export function publicJob(row: JobRow): JobDTO {
  const status = row.status === 'dispatch_pending' ? 'queued' : row.status;
  return { jobId: row.id, workspaceId: row.workspace_id, kind: row.kind as JobDTO['kind'], status,
    ...(row.base_version_id ? { baseVersionId: row.base_version_id } : {}), ...(row.started_at ? { startedAt: row.started_at.toISOString() } : {}),
    ...(row.deadline_at ? { deadline: row.deadline_at.toISOString() } : {}), ...(row.terminal_at ? { endedAt: row.terminal_at.toISOString() } : {}),
    ...(status === 'succeeded' && row.result_refs?.resultRef ? { resultRef: row.result_refs.resultRef } : {}),
    ...(status === 'succeeded' && row.result_refs?.newVersionId ? { newVersionId: row.result_refs.newVersionId } : {}),
    progress: { completed: row.progress.completed ?? 0, total: row.progress.total ?? 0, complete: status === 'succeeded' },
    diagnostics: row.diagnostics.items ?? [], pollAfterMs: 5000 };
}
export function publicReview(row: ReviewRow): DirectionReviewSummaryDTO {
  return { id: row.id, workspaceId: row.workspace_id, validationBasisId: row.basis_id, baseVersionId: row.base_version_id,
    runId: row.source_run_id, revision: revisionNumber(row.revision), state: row.state,
    ...(row.pending_job_id || row.preparation_job_id ? { jobId: (row.pending_job_id ?? row.preparation_job_id)! } : {}),
    ...(row.ready_at ? { readyAt: row.ready_at.toISOString() } : {}), expiresAt: row.expires_at.toISOString(),
    ...(row.counts && 'totalRows' in row.counts ? { counts: row.counts } : {}), ...(row.receipt ? { receipt: row.receipt } : {}) };
}
const emptySummary = (): ValidationSummary => ({ complete: false, rows: 0, variants: 0, applicableVariants: 0, instances: 0,
  duplicateRows: 0, byStatus: { pass: 0, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 } });
export function publicValidation(row: ValidationRow): CompactValidationRunDTO {
  return { id: row.id, workspaceId: row.workspace_id, versionId: row.version_id, validationBasisId: row.basis_id,
    profileId: row.profile_id ?? '', status: row.status === 'completed' && row.summary.complete ? 'completed'
      : row.status === 'running' || row.status === 'pending' ? 'running' : 'incomplete',
    startedAt: (row.started_at ?? row.created_at).toISOString(), ...(row.completed_at ? { endedAt: row.completed_at.toISOString() } : {}),
    summary: { ...emptySummary(), ...row.summary }, diagnosticsCount: Number(row.diagnostics_ref?.['count'] ?? 0) };
}
export interface RepositoryOptions {
  readonly now?: () => number;
  /** Supplied only in an execution worker. Public routes use the metadata methods. */
  readonly hydrateSnapshot?: (owner: WorkspaceOwner, reference: CanonicalResourceReference) => Promise<Snapshot>;
}
export class PostgresRepository implements WorkspaceRepository {
  constructor(readonly database: HostedDatabase, private readonly options: RepositoryOptions = {}) {}
  private now(): Date { return new Date((this.options.now ?? Date.now)()); }
  private read<T>(owner: WorkspaceOwner, work: (tx: DatabaseTransaction, workspace: WorkspaceRow) => Promise<T>): Promise<T> {
    return this.database.transaction(async tx => { await assertLiveSession(tx, owner.sessionId, this.now());
      return work(tx, await requireWorkspace(tx, owner)); });
  }
  workspace(owner: WorkspaceOwner): Promise<WorkspaceMetadata> {
    return this.read(owner, async (tx, row) => {
      const version = row.current_version_id ? await requireVersion(tx, owner, row.current_version_id) : undefined;
      const active = (await tx.query<{ id: string }>("SELECT id FROM jobs WHERE session_id=$1 AND workspace_id=$2 AND status IN ('queued','dispatch_pending','running') ORDER BY accepted_at,id LIMIT 1", [owner.sessionId, owner.workspaceId])).rows[0];
      const snapshots = (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM workspace_versions WHERE session_id=$1 AND workspace_id=$2 AND retained', [owner.sessionId, owner.workspaceId])).rows[0]!.count;
      const bytes = (await tx.query<{ units: string }>("SELECT coalesce(sum(units),0)::text AS units FROM quota_reservations WHERE session_id=$1 AND resource='session-state-bytes' AND state<>'released'", [owner.sessionId])).rows[0]!.units;
      const counts = version?.summary['counts'] as Record<string, number> | undefined;
      return { id: row.id, name: row.name, state: row.status, etag: workspaceEtag(row),
        ...(row.current_version_id ? { currentVersionId: row.current_version_id } : {}), ...(row.current_basis_id ? { validationBasisId: row.current_basis_id } : {}),
        ...(active ? { activeJobId: active.id } : {}), counts: { snapshots, coordinates: counts?.['coordinates'] ?? 0, facts: counts?.['facts'] ?? 0, sources: counts?.['sources'] ?? 0 }, sessionBytes: revisionNumber(bytes) };
    });
  }
  version(owner: WorkspaceOwner, versionId: string): Promise<VersionMetadata> {
    return this.read(owner, async tx => { const row = await requireVersion(tx, owner, versionId); return {
      versionId: row.id, validationBasisId: row.basis_id, ...(row.parent_id ? { parentVersionId: row.parent_id } : {}), createdAt: row.created_at.toISOString(), contentHash: row.content_hash,
    }; });
  }
  job(owner: WorkspaceOwner, jobId: string): Promise<JobDTO> { return this.read(owner, async tx => publicJob(await requireJob(tx, owner, jobId))); }
  validation(owner: WorkspaceOwner, runId: string): Promise<CompactValidationRunDTO> {
    return this.read(owner, async tx => { const row = (await tx.query<ValidationRow>('SELECT * FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, runId])).rows[0];
      if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return publicValidation(row); });
  }
  compatibleValidation(owner: WorkspaceOwner, basisId: string, preferredRunId?: string): Promise<CompactValidationRunDTO | undefined> {
    return this.read(owner, async tx => { const row = (await tx.query<ValidationRow>(`SELECT * FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND basis_id=$3
      AND status='completed' AND summary->>'complete'='true' ORDER BY (id=$4) DESC NULLS LAST,created_at DESC,id DESC LIMIT 1`,
    [owner.sessionId, owner.workspaceId, basisId, preferredRunId ?? null])).rows[0]; return row && publicValidation(row); });
  }
  review(owner: WorkspaceOwner, reviewId: string): Promise<DirectionReviewSummaryDTO> {
    return this.read(owner, async tx => { const row = (await tx.query<ReviewRow>('SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [owner.sessionId, owner.workspaceId, reviewId])).rows[0];
      if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return publicReview(row); });
  }
  /** Only references cross this legacy internal port; no arbitrary table/key or heavy session row exists. */
  record(owner: WorkspaceOwner, key: string): Promise<JsonValue | undefined> {
    const [kind, id, extra] = key.split(':');
    if (extra || !id || !UUID_PATTERN.test(id)) throw new ApiError('INVALID_REQUEST');
    const tables = { validation: ['validation_runs', 'result_index_ref'], review: ['direction_reviews', 'choices_ref'],
      preview: ['previews', 'manifest_refs'], selection: ['proposal_selections', 'mask_ref'] } as const;
    const target = tables[kind as keyof typeof tables]; if (!target) throw new ApiError('INVALID_REQUEST');
    return this.read(owner, async tx => (await tx.query<{ reference: JsonValue }>(`SELECT ${target[1]} AS reference FROM ${target[0]} WHERE session_id=$1 AND workspace_id=$2 AND id=$3`,
      [owner.sessionId, owner.workspaceId, id])).rows[0]?.reference);
  }
  async loadSnapshot(owner: WorkspaceOwner, versionId: string): Promise<Snapshot> {
    if (!this.options.hydrateSnapshot) throw new ApiError('INTERNAL_ERROR');
    const version = await this.read(owner, tx => requireVersion(tx, owner, versionId));
    const snapshot = await this.options.hydrateSnapshot(owner, version.content_manifest_ref);
    if (snapshot.versionId !== version.id || snapshot.validationBasisId !== version.basis_id || snapshot.contentHash !== version.content_hash
      || canonicalHash(snapshot.content) !== version.content_hash) throw new ApiError('INTERNAL_ERROR');
    // Network hydration happens outside the short transaction; a revocation during I/O cannot authorize execution.
    await this.read(owner, tx => requireVersion(tx, owner, versionId));
    return snapshot;
  }
}
