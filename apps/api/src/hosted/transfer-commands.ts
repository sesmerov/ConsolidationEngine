import type { QueryResultRow } from 'pg';
import { IMPORT_INSPECTION_TTL_MS, LANGUAGE_PROFILE_V2, UUID_PATTERN, validateProfileValues } from '@ce/contracts';
import type { DownloadIntent, ImportContextInputDTO, ImportInspectionCommitDTO, JsonObject, JsonValue, Snapshot, ValidationBundle } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { inspectWorkspace } from '../import/import-workspace.js';
import { canonicalHash } from '../session/canonical-state.js';
import { SessionFiles } from '../storage/session-files.js';
import { HostedUploadBatches, type SealedBatchCandidate } from '../storage/upload-batches.js';
import { sealUploadedBatch } from '../workers/seal-upload.worker.js';
import type { HostedWorkerRequest, InspectionCandidate, OperationContext } from '../workers/protocol.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import { prepareReportExportData, reportExportLimits, writeReportExport } from '../export/recalculated-report.js';
import { checkExportData, exportLimits, writeResultsExport, type ResultsExportData } from '../export/results-export.js';
import type { CanonicalCodec, CanonicalRef, CanonicalWriteContext } from './canonical-codec.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { assertClaimAuthority, type HostedJobClaim } from './job-coordinator.js';
import type { ObjectLedger } from './object-ledger.js';
import { requireWorkspace, type PostgresRepository } from './postgres-repository.js';
import type { HostedProjectionWriter } from './projection-store.js';
import type { PublicationEnvelope, PublicationHandlers, PublishedIndex } from './publication.js';
import type { QuotaLedger } from './quota-ledger.js';
import { assertLiveSession } from './session-service.js';
import { HostedSnapshotCodec } from './snapshot-codec.js';
import { HostedRetainedSources } from './retained-sources.js';
import { EXPORT_TEMPORARY_BYTES, HostedExportArtifacts, type ExportArtifactCandidate } from './export-artifacts.js';
import { readReportExportHistory } from './report-export-history.js';

export interface TransferCommandDependencies {
  readonly db: HostedDatabase; readonly codec: CanonicalCodec; readonly objects: ObjectLedger; readonly quotas: QuotaLedger;
  readonly repository: PostgresRepository; readonly indexes: HostedProjectionWriter; readonly now?: () => number;
}
interface InspectionRow extends QueryResultRow {
  id: string; base_version_id: string|null; upload_batch_id: string; inspection_hash: string; state: string;
  candidate_ref: CanonicalRef|null; detail_ref: JsonObject; summary: JsonObject; commit_job_id: string|null; expires_at: Date;
}
const date = (deps: TransferCommandDependencies) => new Date((deps.now ?? Date.now)());
const asObject = (value: unknown): JsonObject => value as JsonObject;
function id(value: unknown): string { if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ApiError('INTERNAL_ERROR'); return value; }
function publicationId(claim: HostedJobClaim, name: string): string { return id((claim.inputRefs['publication'] as JsonObject | undefined)?.[name]); }
function writeContext(claim: HostedJobClaim, cancelled: () => boolean): CanonicalWriteContext { return { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt, cancelled }; }
function operation(claim: HostedJobClaim, cancelled: () => boolean): OperationContext {
  return { job: { jobId: claim.jobId, workspaceId: claim.workspaceId, kind: claim.kind, status: 'running', startedAt: claim.startedAt, deadline: claim.deadlineAt,
    ...(claim.baseVersionId ? { baseVersionId: claim.baseVersionId } : {}), progress: { completed: 0, total: 0, complete: false }, diagnostics: [], pollAfterMs: 5000 }, cancelled, progress: () => {} };
}
async function inspection(tx: DatabaseTransaction, owner: WorkspaceOwner, inspectionId: string): Promise<InspectionRow> {
  const row = (await tx.query<InspectionRow>('SELECT * FROM import_inspections WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE', [owner.sessionId, owner.workspaceId, inspectionId])).rows[0];
  if (!row) throw new ApiError('RESOURCE_NOT_FOUND'); return row;
}
function applicable(row: InspectionRow, body: ImportInspectionCommitDTO, now: Date, accepted = false): void {
  if (!accepted && +row.expires_at <= +now || row.state === 'expired') throw new ApiError('IMPORT_INSPECTION_EXPIRED');
  if (row.inspection_hash !== body.inspectionHash || !row.candidate_ref) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
  if (row.summary['requiresPartialCoverageAcceptance'] && !body.acceptedExcludedSheets) throw new ApiError('PARTIAL_COVERAGE_NOT_ACCEPTED');
}
/** Admission hook after job INSERT. No source hydration or provider request occurs in this transaction. */
export async function prepareImportCommit(tx: DatabaseTransaction, owner: WorkspaceOwner, inspectionId: string, body: ImportInspectionCommitDTO, jobId: string, now: Date): Promise<void> {
  await assertLiveSession(tx, owner.sessionId, now, { lock: true }); const workspace = await requireWorkspace(tx, owner, true), row = await inspection(tx, owner, inspectionId);
  applicable(row, body, now);
  if (row.state !== 'ready' || row.base_version_id !== workspace.current_version_id) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
  await tx.query("UPDATE import_inspections SET state='committing',commit_job_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [owner.sessionId, owner.workspaceId, inspectionId, jobId]);
}

/** Runs inside the bounded worker. The returned envelope contains durable references and summaries only. */
export async function executeTransferCommand(request: HostedWorkerRequest, cancelled: () => boolean, deps: TransferCommandDependencies): Promise<PublicationEnvelope> {
  const claim = request.claim, now = () => date(deps), uploads = new HostedUploadBatches(deps.db, deps.objects, deps.quotas, now);
  const originals = new HostedRetainedSources(deps.db, deps.objects, now), check = () => { if (cancelled() || +now() >= Date.parse(claim.deadlineAt)) throw new ApiError('JOB_TIMED_OUT'); };
  check(); await deps.db.transaction(tx => assertClaimAuthority(tx, claim, now()));
  if (claim.kind === 'seal-upload') {
    const batchId = id(claim.inputRefs['uploadBatchId']); if (publicationId(claim, 'resultId') !== batchId) throw new ApiError('INTERNAL_ERROR');
    const candidate = await sealUploadedBatch(uploads, claim, batchId, cancelled);
    return { kind: claim.kind, resultRef: { type: 'upload-batch', id: batchId }, canonicalRoots: [], indexes: [], domain: asObject(candidate) };
  }
  if (claim.kind === 'inspect-import') {
    const batchId = id(claim.inputRefs['uploadBatchId']), inspectionId = publicationId(claim, 'resultId'), declaration = claim.inputRefs['context'] as unknown as ImportContextInputDTO;
    if (!declaration || !['form','workbook'].includes(declaration.source)) throw new ApiError('INVALID_REQUEST');
    const staged = await originals.forBatch(claim, batchId, cancelled);
    try {
      const candidate = await inspectWorkspace(staged.files, operation(claim, cancelled), declaration); check();
      if (candidate.content.profileId !== LANGUAGE_PROFILE_V2 || candidate.profiles.length !== 1 || candidate.reports.length !== staged.files.filter(file => file.kind === 'report').length || candidate.content.directions.length || validateProfileValues(candidate.content).length) throw new ApiError('INTERNAL_ERROR');
      const inspectionHash = canonicalHash({ baseVersionId: claim.baseVersionId ?? null, inputs: staged.files.map(({ kind, sha256, size, displayName }) => ({ kind, sha256, size, displayName })), declaration,
        profiles: candidate.profiles, scope: candidate.reports, candidateHash: canonicalHash(candidate.content) });
      const ctx = writeContext(claim, cancelled), candidateRef = await deps.codec.put(claim, { candidate, declaration }, ctx), bundle = await deps.codec.put(claim, { profiles: candidate.profiles, reports: candidate.reports, context: candidate.context, diagnostics: candidate.diagnostics }, ctx);
      const roots: CanonicalRef[] = [candidateRef, bundle], indexes: PublishedIndex[] = [], views: Record<string, unknown> = {};
      for (const view of ['reports','context','diagnostics'] as const) {
        const rows = candidate[view], stagedIndex = await deps.indexes.stage(claim, { resource: { type: 'inspection', id: inspectionId, view }, kind: 'details', revision: 1,
          rows: rows.map((value, index) => ({ key: String(index).padStart(6, '0'), sortKey: String(index).padStart(6, '0'), value: value as unknown as JsonValue })) });
        roots.push(stagedIndex.manifestRef); views[view] = stagedIndex.ref; indexes.push({ kind: stagedIndex.ref.kind, id: stagedIndex.ref.indexId, revision: stagedIndex.ref.revision });
      }
      const createdAt = now().toISOString(), expiresAt = new Date(+now() + IMPORT_INSPECTION_TTL_MS).toISOString();
      const summary: JsonObject = { id: inspectionId, workspaceId: claim.workspaceId, ...(claim.baseVersionId ? { baseVersionId: claim.baseVersionId } : {}), state: 'ready', createdAt, expiresAt, inspectionHash,
        profiles: candidate.profiles as unknown as JsonValue, requiresPartialCoverageAcceptance: candidate.reports.some(report => report.excludedSheets.length > 0), reportCount: candidate.reports.length, contextCount: candidate.context.length, diagnosticsCount: candidate.diagnostics.length };
      return { kind: claim.kind, resultRef: { type: 'import-inspection', id: inspectionId }, canonicalRoots: roots, indexes,
        domain: { inspectionId, batchId, inspectionHash, candidateRef: asObject(candidateRef), detailRef: { bundle: asObject(bundle), views: asObject(views) }, summary, createdAt, expiresAt } };
    } finally { await staged.dispose(); }
  }
  if (claim.kind === 'import') {
    const inspectionId = id(claim.inputRefs['inspectionId']), body = { inspectionHash: String(claim.inputRefs['inspectionHash']), acceptedExcludedSheets: claim.inputRefs['acceptedExcludedSheets'] === true };
    const row = await deps.db.transaction(async tx => { await assertClaimAuthority(tx, claim, now()); const row = await inspection(tx, claim, inspectionId);
      if (row.state !== 'committing' || row.commit_job_id !== claim.jobId || row.base_version_id !== (claim.baseVersionId ?? null)) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE'); applicable(row, body, now(), true); return row; });
    const stored = await deps.codec.get(claim, row.candidate_ref!, { deadline: claim.deadlineAt, cancelled }) as unknown as { candidate: InspectionCandidate; declaration: ImportContextInputDTO };
    const staged = await originals.forBatch(claim, row.upload_batch_id, cancelled);
    try {
      check(); const candidate = stored.candidate;
      const hash = canonicalHash({ baseVersionId: claim.baseVersionId ?? null, inputs: staged.files.map(({ kind, sha256, size, displayName }) => ({ kind, sha256, size, displayName })), declaration: stored.declaration,
        profiles: candidate.profiles, scope: candidate.reports, candidateHash: canonicalHash(candidate.content) });
      if (hash !== row.inspection_hash || canonicalHash(candidate.content.sources.map(({ id, sha256, size }) => ({ id, sha256, size }))) !== canonicalHash(staged.files.map(({ id, sha256, size }) => ({ id, sha256, size })))) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
      const snapshot: Snapshot = { versionId: publicationId(claim, 'versionId'), validationBasisId: publicationId(claim, 'basisId'), ...(claim.baseVersionId ? { parentVersionId: claim.baseVersionId } : {}),
        createdAt: now().toISOString(), contentHash: canonicalHash(candidate.content), content: candidate.content };
      const saved = await new HostedSnapshotCodec(deps.db, deps.objects, deps.indexes).writeSnapshot(claim, snapshot, 'import'); check();
      return { kind: claim.kind, resultRef: { type: 'import', id: publicationId(claim, 'resultId') }, version: saved.version, ...(saved.basis ? { basis: saved.basis } : {}), canonicalRoots: saved.canonicalRoots, indexes: saved.indexes,
        domain: { inspectionId, inspectionHash: row.inspection_hash, acceptedExcludedSheets: body.acceptedExcludedSheets, versionId: snapshot.versionId } };
    } finally { await staged.dispose(); }
  }
  if (claim.kind === 'export') return exportCommand(claim, cancelled, deps);
  throw new ApiError('INVALID_REQUEST');
}

async function exportCommand(claim: HostedJobClaim, cancelled: () => boolean, deps: TransferCommandDependencies): Promise<PublicationEnvelope> {
  const now = () => date(deps), check = () => { if (cancelled() || +now() >= Date.parse(claim.deadlineAt)) throw new ApiError('JOB_TIMED_OUT'); };
  const artifactId = id(claim.inputRefs['artifactId']), intent = claim.inputRefs['intent'] as unknown as DownloadIntent;
  if (!intent || intent.workspaceId !== claim.workspaceId || !['report','results'].includes(intent.kind)) throw new ApiError('EXPORT_NOT_AVAILABLE');
  const snapshot = await deps.repository.loadSnapshot(claim, id(intent.versionId)), temporary = await SessionFiles.create(claim.sessionId, undefined, EXPORT_TEMPORARY_BYTES);
  let staged: Awaited<ReturnType<HostedRetainedSources['forVersion']>> | undefined;
  try {
    await temporary.createWorkspace(claim.workspaceId); const lease = temporary.reserve(claim.workspaceId, EXPORT_TEMPORARY_BYTES);
    const allocate = async () => { const file = await temporary.openFile(claim.workspaceId, lease); await file.handle.close(); return file.path; };
    const paths = { json: await allocate(), xlsx: await allocate(), zip: await allocate() };
    if (intent.kind === 'results') {
      const row = await deps.db.transaction(async tx => { await assertClaimAuthority(tx, claim, now()); return (await tx.query('SELECT version_id,status,result_index_ref FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, id(intent.runId)])).rows[0]; });
      if (!row || row.version_id !== snapshot.versionId || row.status !== 'completed' || !row.result_index_ref?.bundle) throw new ApiError('EXPORT_NOT_AVAILABLE');
      const bundle = await deps.codec.get(claim, row.result_index_ref.bundle, { deadline: claim.deadlineAt, cancelled }) as unknown as ValidationBundle;
      if (bundle.run.id !== intent.runId || bundle.run.versionId !== intent.versionId || !bundle.run.summary.complete) throw new ApiError('EXPORT_NOT_AVAILABLE');
      const content = snapshot.content, data: ResultsExportData = { ...bundle, versionId: snapshot.versionId, contentHash: snapshot.contentHash, profileId: content.profileId, contexts: content.contexts, sources: content.sources,
        catalog: { records: content.catalog.records, variants: content.catalog.variants, coverage: content.catalog.coverage }, synthetic: content.contexts.some(context => context.entityId === 'SYNTHETIC'), ...(content.reportSourceBindings ? { reportSourceBindings: content.reportSourceBindings } : {}) };
      const limits = exportLimits(); checkExportData(data, limits, check); await writeResultsExport(data, paths, limits, check, () => {});
    } else {
      const history = await readReportExportHistory(claim, snapshot, deps, cancelled);
      const data = prepareReportExportData(snapshot, history, reportExportLimits(), check);
      const finrepSources = new Set(snapshot.content.reportSourceBindings?.filter(binding => binding.profileId === 'eba-finrep-4.0-f0101-v1').map(binding => binding.sourceFileId));
      if (finrepSources.size) staged = await new HostedRetainedSources(deps.db, deps.objects, now).forVersion(claim, snapshot.versionId, snapshot.content.sources.filter(source => finrepSources.has(source.id)), cancelled);
      const reports: string[] = []; for (const _partition of data.partitions) reports.push(await allocate());
      await writeReportExport(data, { ...paths, reports }, reportExportLimits(), check, () => {}, staged?.files);
    }
    check(); const candidate = await new HostedExportArtifacts(deps.db, deps.objects, deps.quotas, now).stageFile(claim, artifactId, paths.zip);
    return { kind: 'export', resultRef: { type: 'export', id: artifactId }, canonicalRoots: [], indexes: [], domain: asObject(candidate) };
  } finally { await staged?.dispose(); await temporary.close(); }
}

export function transferPublicationHandlers(deps: TransferCommandDependencies): PublicationHandlers {
  const now = () => date(deps), uploads = new HostedUploadBatches(deps.db, deps.objects, deps.quotas, now), exports = new HostedExportArtifacts(deps.db, deps.objects, deps.quotas, now);
  return {
    'seal-upload': (tx, { claim, envelope }) => uploads.publishSealed(tx, claim, envelope.domain as unknown as SealedBatchCandidate),
    export: (tx, { claim, envelope }) => exports.publish(tx, claim, envelope.domain as unknown as ExportArtifactCandidate),
    'inspect-import': async (tx, { claim, envelope }) => {
      const domain = envelope.domain!;
      if ((await tx.query("SELECT id FROM import_inspections WHERE session_id=$1 AND workspace_id=$2 AND state IN ('ready','committing') AND expires_at>$3", [claim.sessionId, claim.workspaceId, now()])).rowCount) throw new ApiError('IMPORT_INSPECTION_EXISTS');
      if (domain['inspectionId'] !== envelope.resultRef.id || domain['batchId'] !== claim.inputRefs['uploadBatchId']) throw new ApiError('INTERNAL_ERROR');
      await tx.query("INSERT INTO import_inspections(session_id,workspace_id,id,base_version_id,upload_batch_id,job_id,inspection_hash,state,candidate_ref,detail_ref,summary,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'ready',$8,$9,$10,$11,$12)",
        [claim.sessionId, claim.workspaceId, domain['inspectionId'], claim.baseVersionId ?? null, domain['batchId'], claim.jobId, domain['inspectionHash'], domain['candidateRef'], domain['detailRef'], domain['summary'], domain['createdAt'], domain['expiresAt']]);
    },
    import: async (tx, { claim, envelope }) => {
      const domain = envelope.domain!, row = await inspection(tx, claim, id(domain['inspectionId']));
      if (row.state !== 'committing' || row.commit_job_id !== claim.jobId || row.base_version_id !== (claim.baseVersionId ?? null) || envelope.version?.id !== domain['versionId']) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
      applicable(row, { inspectionHash: String(domain['inspectionHash']), acceptedExcludedSheets: domain['acceptedExcludedSheets'] === true }, now(), true);
      await tx.query("UPDATE import_inspections SET state='committed',committed_version_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3", [claim.sessionId, claim.workspaceId, row.id, domain['versionId']]);
    },
  };
}
