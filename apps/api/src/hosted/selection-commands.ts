import type { JsonObject, JsonValue, PreviewBundle, ProposalExplanationSection, ProposalSelectionOperationDTO, Snapshot } from '@ce/contracts';
import { editProposalSelection, type ProposalSelectionProjection, WorkBudget } from '@ce/engine';
import { ApiError } from '../errors.js';
import { createPublicProposalProjector } from '../presentation/public-proposals.js';
import type { HostedWorkerRequest } from '../workers/protocol.js';
import type { HostedCommandDependencies } from './worker-runtime.js';
import type { PublicationEnvelope } from './publication.js';
import type { CanonicalRef } from './canonical-codec.js';
import type { ProjectionInputRow } from './projection-store.js';
import { commandBody, commandId, commandWriteContext } from './domain-commands.js';

const json = (value: unknown) => value as JsonObject;
export async function loadHostedSelection(request: HostedWorkerRequest, deps: HostedCommandDependencies) {
  const claim = request.claim, command = commandBody(request);
  const preview = (await deps.db.query('SELECT * FROM previews WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, commandId(command, 'previewId')])).rows[0];
  const selection = (await deps.db.query('SELECT * FROM proposal_selections WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, commandId(command, 'selectionId')])).rows[0];
  if (!preview || !selection || preview.version_id !== claim.baseVersionId || selection.version_id !== claim.baseVersionId || selection.preview_id !== preview.id
    || preview.state !== 'ready' || preview.expires_at <= new Date(deps.now()) || selection.pending_job_id !== claim.jobId
    || selection.revision !== String(command['expectedRevision']) || selection.state !== (claim.kind === 'apply' ? 'applying' : 'updating')) throw new ApiError('STALE_PROPOSAL_SELECTION');
  const bundle = await deps.codec.get(claim, preview.manifest_refs.bundle as CanonicalRef) as unknown as PreviewBundle;
  const projection = await deps.codec.get(claim, selection.mask_ref.projection as CanonicalRef) as unknown as ProposalSelectionProjection;
  if (bundle.preview.id !== preview.id || bundle.preview.baseVersionId !== claim.baseVersionId || projection.closureHash !== selection.selection_hash) throw new ApiError('INTERNAL_ERROR');
  return { bundle, projection, preview, selection };
}

/** All selection views carry one revision and are switched together by the publication transaction. */
export async function stageSelectionViews(request: HostedWorkerRequest, deps: HostedCommandDependencies, snapshot: Snapshot, bundle: PreviewBundle,
  projection: ProposalSelectionProjection, selectionId: string, revision: number, budget: WorkBudget, includePreview = false) {
  const projector = createPublicProposalProjector(snapshot, bundle, projection, budget), views: Record<string, JsonValue> = {};
  const canonicalRoots: CanonicalRef[] = [], indexes: PublicationEnvelope['indexes'][number][] = [];
  async function stage(view: string, rows: Iterable<ProjectionInputRow>, type: 'selection' | 'preview' = 'selection') {
    const stored = await deps.indexes.stage(request.claim, { resource: { type, id: type === 'selection' ? selectionId : bundle.preview.id, view },
      kind: view === 'rows' ? 'proposals' : 'details', basisId: snapshot.validationBasisId!, revision, rows });
    canonicalRoots.push(stored.manifestRef); indexes.push({ kind: stored.ref.kind, id: stored.ref.indexId, revision, basisId: snapshot.validationBasisId! });
    if (type === 'selection') views[view] = json(stored.ref); else views['previewRows'] = json(stored.ref);
  }
  function* rows(): Generator<ProjectionInputRow> {
    for (let n = 0; n < bundle.proposals.length; n++) { const row = projector.row(n); yield { key: row.id, sortKey: JSON.stringify([row.code, row.id]), code: row.code, status: row.state,
      selectors: { table: row.target.tableCode, contextId: row.target.contextId, selected: row.selected, required: row.required, predecessorCount: row.predecessorCount, requiredPredecessorCount: row.requiredPredecessorCount,
        ...(row.origin?.fileId ? { originFileId: row.origin.fileId } : {}) }, value: row as unknown as JsonValue }; }
  }
  function* dependencies(): Generator<ProjectionInputRow> {
    for (const proposal of bundle.proposals) for (const row of projector.dependencies(proposal)) yield { key: proposal.id + ':' + row.id, sortKey: JSON.stringify([proposal.id, row.code, row.id]), code: row.code, status: row.state,
      selectors: { resultId: proposal.id, required: row.required, selected: row.selected }, value: row as unknown as JsonValue };
  }
  function* explanations(): Generator<ProjectionInputRow> {
    for (let n = 0; n < bundle.proposals.length; n++) { const row = projector.explanation(n, selectionId, revision); yield { key: row.proposalId, sortKey: row.proposalId, value: row as unknown as JsonValue }; }
  }
  function* items(): Generator<ProjectionInputRow> {
    const sections: ProposalExplanationSection[] = ['operands', 'origins', 'diagnostics', 'descriptions'];
    for (const proposal of bundle.proposals) for (const section of sections) { let ordinal = 0; for (const row of projector.items(proposal, section)) yield {
      key: proposal.id + ':' + row.itemId, sortKey: JSON.stringify([proposal.id, section, String(ordinal++).padStart(12, '0')]),
      selectors: { resultId: proposal.id, section }, value: row as unknown as JsonValue }; }
  }
  if (includePreview) await stage('rows', rows(), 'preview');
  await stage('rows', rows()); await stage('dependencies', dependencies()); await stage('explanations', explanations()); await stage('items', items());
  return { views, canonicalRoots, indexes };
}
export async function editHostedSelection(request: HostedWorkerRequest, cancelled: () => boolean, deps: HostedCommandDependencies, snapshot: Snapshot, budget: WorkBudget): Promise<PublicationEnvelope> {
  const command = commandBody(request), loaded = await loadHostedSelection(request, deps);
  const projection = editProposalSelection(loaded.bundle, loaded.projection, command['operations'] as unknown as ProposalSelectionOperationDTO[], budget);
  const projectionRef = await deps.codec.put(request.claim, projection, commandWriteContext(request, cancelled));
  const staged = await stageSelectionViews(request, deps, snapshot, loaded.bundle, projection, loaded.selection.id, Number(loaded.selection.revision) + 1, budget);
  return { kind: 'select-proposals', resultRef: { type: 'proposal-selection', id: loaded.selection.id }, canonicalRoots: [projectionRef, ...staged.canonicalRoots], indexes: staged.indexes,
    domain: { selectionId: loaded.selection.id, previewId: loaded.preview.id, expectedRevision: Number(loaded.selection.revision),
      maskRef: { projection: json(projectionRef), views: staged.views }, counters: selectionCounters(projection), selectionHash: projection.closureHash } };
}
export function selectionCounters(projection: ProposalSelectionProjection): JsonObject {
  return { availableCount: projection.availableCount, selectedCount: projection.selectedCount, requiredCount: projection.requiredCount, complete: projection.complete, closureHash: projection.closureHash };
}
