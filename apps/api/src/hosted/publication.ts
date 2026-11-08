import type { Diagnostic, JobDTO, JsonObject, ResultRef, ValidationSummary } from '@ce/contracts';
import type { CanonicalRef } from './canonical-codec.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import type { ObjectLedger } from './object-ledger.js';
import { assertClaimAuthority, type HostedJobClaim } from './job-coordinator.js';
import { publicJob, requireJob, requireVersion, type JobRow } from './postgres-repository.js';
import { QuotaLedger } from './quota-ledger.js';
import { ApiError } from '../errors.js';

export interface PublishedVersion {
  readonly id: string; readonly basisId: string; readonly parentId?: string; readonly reason: 'import' | 'configuration' | 'application';
  readonly contentRef: CanonicalRef; readonly directionsRef: JsonObject; readonly contentHash: string; readonly configVersion: string;
  readonly profileId: string; readonly catalogVersion: string; readonly reportVersion: string; readonly summary: JsonObject;
  readonly sourceFileIds: readonly string[];
}
export interface PublishedBasis {
  readonly id: string; readonly catalogRef: JsonObject; readonly dataRef: JsonObject; readonly contextsRef: JsonObject;
  readonly profileIds: readonly string[]; readonly hashes: JsonObject;
}
export interface PublishedValidation {
  readonly id: string; readonly versionId: string; readonly basisId: string; readonly profileId: string;
  readonly summary: ValidationSummary; readonly resultIndexRef: JsonObject; readonly diagnosticsRef: JsonObject;
}
export interface PublishedPreview {
  readonly id: string; readonly versionId: string; readonly basisId: string; readonly sourceRunId: string;
  readonly manifestRefs: JsonObject; readonly counters: JsonObject; readonly contentHash: string; readonly expiresAt: string;
}
export interface PublishedSelection {
  readonly id: string; readonly previewId: string; readonly versionId: string; readonly basisId: string;
  readonly maskRef: JsonObject; readonly counters: JsonObject; readonly selectionHash: string;
}
export interface PublishedReview {
  readonly id: string; readonly expectedRevision: number; readonly state: 'ready' | 'committed';
  readonly choicesRef?: JsonObject; readonly counts?: JsonObject; readonly configChanged?: boolean; readonly dirtyCount?: number;
  readonly receipt?: JsonObject;
}
export interface PublishedIndex { readonly kind: string; readonly id: string; readonly revision: number; readonly basisId?: string }
/** Compact worker output, with no report, rule-result arrays, runtime closures or provider paths. */
export interface PublicationEnvelope {
  readonly kind: JobRow['kind']; readonly resultRef: ResultRef;
  readonly canonicalRoots: readonly CanonicalRef[]; readonly indexes: readonly PublishedIndex[];
  readonly version?: PublishedVersion; readonly basis?: PublishedBasis; readonly validations?: readonly PublishedValidation[];
  readonly preview?: PublishedPreview; readonly selection?: PublishedSelection; readonly review?: PublishedReview;
  /** Closed command-specific payload, published by the registered SQL-only domain handler. */
  readonly domain?: JsonObject; readonly diagnostics?: readonly Diagnostic[];
}
export interface PublicationContext { readonly claim: HostedJobClaim; readonly now: Date; readonly envelope: PublicationEnvelope }
export type DomainPublisher = (tx: DatabaseTransaction, context: PublicationContext) => Promise<void>;
export type PublicationHandlers = Partial<Record<JobRow['kind'], DomainPublisher>>;
export type RetainSources = (tx: DatabaseTransaction, claim: HostedJobClaim, versionId: string, sourceFileIds: readonly string[]) => Promise<void>;

/** The last gate: all provisional references are durable before this single, short, fenced publication transaction. */
export class HostedPublication {
  constructor(readonly database: HostedDatabase, readonly quotas: QuotaLedger, readonly objects: Pick<ObjectLedger, 'retain'>,
    readonly options: { now?: () => number; handlers?: PublicationHandlers; retainSources?: RetainSources } = {}) {}
  private now() { return new Date((this.options.now ?? Date.now)()); }
  async publish(claim: HostedJobClaim, envelope: PublicationEnvelope): Promise<JobDTO> {
    if (Buffer.byteLength(JSON.stringify(envelope), 'utf8') > 262_144 || envelope.canonicalRoots.length > 32 || envelope.indexes.length > 16
      || (envelope.validations?.length ?? 0) > 2 || envelope.kind !== claim.kind) throw new ApiError('INTERNAL_ERROR');
    return this.database.transaction(async tx => {
      const { job, workspace } = await assertClaimAuthority(tx, claim, this.now()), now = this.now();
      const reservationValue = job.input_refs['publication'];
      if (!reservationValue || Array.isArray(reservationValue) || typeof reservationValue !== 'object') throw new ApiError('INTERNAL_ERROR');
      const reserved = reservationValue as JsonObject;
      const resultTypes: Partial<Record<JobRow['kind'], string>> = { validate: 'validation', preview: 'preview', 'recalculation-operation': 'preview',
        'prepare-directions': 'direction-review', 'commit-directions': 'direction-review', 'select-proposals': 'proposal-selection', apply: 'application',
        export: 'export', 'inspect-import': 'import-inspection', 'seal-upload': 'upload-batch' };
      if (resultTypes[envelope.kind] && envelope.resultRef.type !== resultTypes[envelope.kind]) throw new ApiError('INTERNAL_ERROR');
      if (envelope.version && !['import', 'commit-directions', 'recalculation-operation', 'apply'].includes(envelope.kind)
        || envelope.basis && !['import', 'apply'].includes(envelope.kind)
        || envelope.validations?.length && !['validate', 'apply'].includes(envelope.kind)
        || envelope.preview && !['preview', 'recalculation-operation'].includes(envelope.kind)
        || envelope.review && !['prepare-directions', 'commit-directions', 'recalculation-operation'].includes(envelope.kind)) throw new ApiError('INTERNAL_ERROR');
      const assertId = (name: string, id: string | undefined) => { if (id !== undefined && reserved[name] !== id) throw new ApiError('INTERNAL_ERROR', { reason: 'UNRESERVED_PUBLICATION' }); };
      assertId('resultId', envelope.resultRef.id);
      assertId('versionId', envelope.version?.id); assertId('basisId', envelope.basis?.id);
      assertId('previewId', envelope.preview?.id); assertId('selectionId', envelope.selection?.id); assertId('reviewId', envelope.review?.id);
      for (const run of envelope.validations ?? []) {
        if (!Array.isArray(reserved['runIds']) || !reserved['runIds'].includes(run.id) || !run.summary.complete) throw new ApiError('INTERNAL_ERROR');
      }
      if (envelope.preview && !envelope.selection || envelope.selection && !envelope.preview) throw new ApiError('INTERNAL_ERROR');
      if (envelope.version) {
        if ((envelope.version.parentId ?? null) !== workspace.current_version_id || envelope.version.sourceFileIds.length > 21
          || !envelope.canonicalRoots.some(ref => ref.resourceId === envelope.version!.contentRef.resourceId && ref.sha256 === envelope.version!.contentRef.sha256)) throw new ApiError('INTERNAL_ERROR');
        if (envelope.version.reason === 'configuration' && (envelope.basis || envelope.version.basisId !== workspace.current_basis_id)) throw new ApiError('INTERNAL_ERROR');
        if (envelope.version.reason !== 'configuration' && (!envelope.basis || envelope.version.basisId !== envelope.basis.id || envelope.basis.id === workspace.current_basis_id)) throw new ApiError('INTERNAL_ERROR');
      } else if (envelope.basis) throw new ApiError('INTERNAL_ERROR');
      if (envelope.domain && !this.options.handlers?.[envelope.kind]) throw new ApiError('INTERNAL_ERROR', { reason: 'MISSING_DOMAIN_PUBLISHER' });
      if (envelope.kind === 'recalculation-operation') {
        const operation = (await tx.query(`SELECT * FROM recalculation_operations WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3 FOR UPDATE`,
          [claim.sessionId, claim.workspaceId, claim.jobId])).rows[0];
        if (!operation || operation.config_changed !== Boolean(envelope.version) || operation.reserved_effective_version_id !== (envelope.version?.id ?? workspace.current_version_id)
          || operation.reserved_preview_id !== envelope.preview?.id || operation.reserved_selection_id !== envelope.selection?.id
          || operation.review_id !== envelope.review?.id || operation.review_revision !== String(envelope.review?.expectedRevision)) throw new ApiError('INTERNAL_ERROR');
      }
      const allocation = await this.quotas.reserve(tx, { owner: claim, operationId: claim.jobId, resource: 'sql-bytes', units: 262_144, purpose: 'public', now });
      for (const index of envelope.indexes) {
        const staged = (await tx.query(`SELECT complete,revision,job_id,attempt_id,fence,manifest_ref FROM projection_sets
          WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4 FOR UPDATE`, [claim.sessionId, claim.workspaceId, index.kind, index.id])).rows[0];
        if (!staged?.complete || staged.revision !== String(index.revision) || staged.job_id !== claim.jobId || staged.attempt_id !== claim.attemptId || staged.fence !== claim.fence) throw new ApiError('INTERNAL_ERROR', { reason: 'UNFINISHED_INDEX' });
        if (!envelope.canonicalRoots.some(ref => ref.resourceId === staged.manifest_ref?.resourceId && ref.sha256 === staged.manifest_ref.sha256)) throw new ApiError('INTERNAL_ERROR', { reason: 'UNRETAINED_INDEX' });
      }
      await this.objects.retain(tx, claim, envelope.canonicalRoots, { publicationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence });
      if (envelope.basis) { const basis = envelope.basis;
        await tx.query(`INSERT INTO validation_bases(session_id,workspace_id,id,catalog_ref,data_ref,contexts_ref,profile_ids,hashes,created_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [claim.sessionId, claim.workspaceId, basis.id, basis.catalogRef, basis.dataRef, basis.contextsRef, JSON.stringify(basis.profileIds), basis.hashes, now]);
      }
      for (const index of envelope.indexes) if (index.basisId) await tx.query(`UPDATE projection_sets SET basis_id=$5 WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4`,
        [claim.sessionId, claim.workspaceId, index.kind, index.id, index.basisId]);
      if (envelope.version) await this.version(tx, claim, envelope.version, now);
      for (const run of envelope.validations ?? []) {
        const version = await requireVersion(tx, claim, run.versionId); if (version.basis_id !== run.basisId) throw new ApiError('INCOMPATIBLE_VALIDATION_BASIS');
        await tx.query(`INSERT INTO validation_runs(session_id,workspace_id,id,version_id,basis_id,status,summary,result_index_ref,diagnostics_ref,created_at,started_at,completed_at,profile_id)
          VALUES($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,$10,$9,$11)`, [claim.sessionId, claim.workspaceId, run.id, run.versionId, run.basisId,
          run.summary, run.resultIndexRef, run.diagnosticsRef, now, new Date(claim.startedAt), run.profileId]);
      }
      if (envelope.preview && envelope.selection) await this.preview(tx, claim, envelope.preview, envelope.selection, now);
      if (envelope.review) { const review = envelope.review;
        const result = await tx.query(`UPDATE direction_reviews SET state=$5,revision=revision+1,pending_job_id=NULL,ready_at=$6,
          choices_ref=coalesce($7,choices_ref),counts=coalesce($8,counts),config_changed=coalesce($9,config_changed),dirty_count=coalesce($10,dirty_count),receipt=$11
          WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND revision=$4
            AND ((state='preparing' AND preparation_job_id=$12 AND $5='ready') OR (state='committing' AND pending_job_id=$12 AND $5='committed')) RETURNING id`,
        [claim.sessionId, claim.workspaceId, review.id, review.expectedRevision, review.state, now, review.choicesRef ?? null, review.counts ?? null,
          review.configChanged ?? null, review.dirtyCount ?? null, review.receipt ?? null, claim.jobId]);
        if (!result.rowCount) throw new ApiError('STALE_VERSION');
      }
      if (envelope.domain) await this.options.handlers![envelope.kind]!(tx, { claim, now, envelope });
      // Recheck time/cancellation after every SQL-only domain write, before publishing the authoritative pointer.
      await assertClaimAuthority(tx, claim, this.now());
      if (envelope.version) {
        await tx.query(`UPDATE workspaces SET current_version_id=$3,current_basis_id=$4,revision=revision+1,status='ready' WHERE session_id=$1 AND id=$2`,
          [claim.sessionId, claim.workspaceId, envelope.version.id, envelope.version.basisId]);
        await tx.query(`UPDATE direction_reviews SET state='obsolete' WHERE session_id=$1 AND workspace_id=$2 AND state='ready' AND base_version_id<>$3`, [claim.sessionId, claim.workspaceId, envelope.version.id]);
      }
      const resultRefs = { resultRef: envelope.resultRef, ...(envelope.version ? { newVersionId: envelope.version.id } : {}) };
      await tx.query(`UPDATE jobs SET status='succeeded',terminal_at=$4,result_refs=$5,diagnostics=$6,progress=jsonb_set(progress,'{complete}','true') WHERE session_id=$1 AND workspace_id=$2 AND id=$3`,
        [claim.sessionId, claim.workspaceId, claim.jobId, this.now(), resultRefs, { items: envelope.diagnostics ?? [] }]);
      await tx.query(`UPDATE operation_receipts SET response_status=202,result_refs=$4 WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3`, [claim.sessionId, claim.workspaceId, claim.jobId, resultRefs]);
      await tx.query(`UPDATE recalculation_operations SET phase='succeeded' WHERE session_id=$1 AND workspace_id=$2 AND job_id=$3`, [claim.sessionId, claim.workspaceId, claim.jobId]);
      await this.quotas.consume(tx, { reservationId: allocation.id, now: this.now() });
      return publicJob(await requireJob(tx, claim, claim.jobId));
    });
  }
  private async version(tx: DatabaseTransaction, claim: HostedJobClaim, version: PublishedVersion, now: Date) {
    if (version.reason !== 'import') {
      const parentFiles = (await tx.query<{ source_file_id: string }>('SELECT source_file_id FROM snapshot_sources WHERE session_id=$1 AND workspace_id=$2 AND version_id=$3 ORDER BY source_file_id',
        [claim.sessionId, claim.workspaceId, version.parentId])).rows.map(row => row.source_file_id);
      if (JSON.stringify(parentFiles) !== JSON.stringify([...new Set(version.sourceFileIds)].sort())) throw new ApiError('INTERNAL_ERROR', { reason: 'ORIGINAL_SOURCES_CHANGED' });
    }
    await tx.query(`INSERT INTO workspace_versions(session_id,workspace_id,id,parent_id,basis_id,directions_ref,content_manifest_ref,content_hash,config_version,
      profile_id,catalog_version,report_version,summary,reason,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [claim.sessionId, claim.workspaceId, version.id, version.parentId ?? null, version.basisId, version.directionsRef, version.contentRef, version.contentHash,
      version.configVersion, version.profileId, version.catalogVersion, version.reportVersion, version.summary, version.reason, now]);
    if (version.sourceFileIds.length) {
      if (!this.options.retainSources) throw new ApiError('INTERNAL_ERROR', { reason: 'MISSING_SOURCE_RETENTION' });
      await this.options.retainSources(tx, claim, version.id, version.sourceFileIds);
    }
  }
  private async preview(tx: DatabaseTransaction, claim: HostedJobClaim, preview: PublishedPreview, selection: PublishedSelection, now: Date) {
    if (selection.previewId !== preview.id || selection.versionId !== preview.versionId || selection.basisId !== preview.basisId) throw new ApiError('INTERNAL_ERROR');
    const version = await requireVersion(tx, claim, preview.versionId);
    const run = (await tx.query(`SELECT basis_id,status,summary FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND id=$3`, [claim.sessionId, claim.workspaceId, preview.sourceRunId])).rows[0];
    if (version.basis_id !== preview.basisId || run?.basis_id !== preview.basisId || run.status !== 'completed' || !run.summary.complete) throw new ApiError('INCOMPATIBLE_VALIDATION_BASIS');
    await tx.query(`INSERT INTO previews(session_id,workspace_id,id,version_id,basis_id,source_run_id,manifest_refs,counters,content_hash,state,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10,$11)`, [claim.sessionId, claim.workspaceId, preview.id, preview.versionId, preview.basisId, preview.sourceRunId,
      preview.manifestRefs, preview.counters, preview.contentHash, now, new Date(preview.expiresAt)]);
    await tx.query(`INSERT INTO proposal_selections(session_id,workspace_id,id,preview_id,version_id,basis_id,mask_ref,counters,selection_hash,state,created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',$10)`, [claim.sessionId, claim.workspaceId, selection.id, preview.id, preview.versionId, preview.basisId,
      selection.maskRef, selection.counters, selection.selectionHash, now]);
  }
}
