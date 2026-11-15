import type { ApplicationBundle, ApplyChangeDTO, CompactApplyReceiptDTO, JsonObject, JsonValue, RuleResultDTO, Snapshot } from '@ce/contracts';
import { applyCandidate, resultOrderKey, selectedProposalIds, WorkBudget } from '@ce/engine';
import { ApiError } from '../errors.js';
import { publicApplicationChange } from '../presentation/public-changes.js';
import { createPublicResultProjector, type BoundPublicValue } from '../presentation/public-results.js';
import { resultChanged } from '../presentation/result-change.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { HostedWorkerRequest } from '../workers/protocol.js';
import { commandBody, commandId, commandWriteContext, persistValidation } from './domain-commands.js';
import { loadHostedSelection } from './selection-commands.js';
import type { HostedCommandDependencies } from './worker-runtime.js';
import type { PublicationEnvelope, PublicationHandlers } from './publication.js';
import type { ProjectionInputRow } from './projection-store.js';

const json = (value: unknown) => value as JsonObject;
export async function applyHostedSelection(request: HostedWorkerRequest, cancelled: () => boolean, deps: HostedCommandDependencies, base: Snapshot, budget: WorkBudget): Promise<PublicationEnvelope> {
  const claim = request.claim, command = commandBody(request), loaded = await loadHostedSelection(request, deps), selectionId = loaded.selection.id as string;
  if (!loaded.projection.complete || loaded.projection.requiredCount || loaded.projection.closureHash !== command['closureHash']) throw new ApiError('SELECTION_NOT_CLOSED');
  const acceptedIds = selectedProposalIds(loaded.bundle, loaded.projection, budget), applicationId = commandId(command, 'applicationId');
  const newVersionId = commandId(command, 'newVersionId'), newValidationBasisId = commandId(command, 'newValidationBasisId');
  const candidate = applyCandidate(base, loaded.bundle, { receiptId: applicationId, newVersionId, newValidationBasisId,
    beforeRunId: commandId(command, 'beforeRunId'), runId: commandId(command, 'runId'), startedAt: claim.startedAt,
    selectedIds: acceptedIds, closureHash: loaded.projection.closureHash, budget, cancelled, now: deps.now });
  const patches = new Map(candidate.factPatches.map(fact => [fact.factKey, fact])), existing = new Set(base.content.facts.map(fact => fact.factKey));
  const facts = patches.size ? [...base.content.facts.map(fact => patches.get(fact.factKey) ?? fact), ...candidate.factPatches.filter(fact => !existing.has(fact.factKey))] : base.content.facts;
  const content = patches.size ? { ...base.content, facts, reportVersion: canonicalHash(facts) } : base.content;
  const appliedAt = new Date(deps.now()).toISOString(), snapshot: Snapshot = { ...base, versionId: newVersionId, validationBasisId: newValidationBasisId,
    parentVersionId: base.versionId, createdAt: appliedAt, content, contentHash: canonicalHash(content) };
  const selected = new Set(acceptedIds), changes: ApplyChangeDTO[] = [];
  for (const proposal of loaded.bundle.proposals) {
    budget.check(); if (!selected.has(proposal.id)) continue;
    if (!proposal.before || !proposal.after) throw new ApiError('PREVIEW_NOT_APPLICABLE');
    const evidence = { changed: patches.has(proposal.targetKey), receiptId: applicationId, proposalId: proposal.id, directionId: proposal.directionId,
      instanceId: proposal.instanceId, variantIds: proposal.variantIds, code: proposal.code, targetKey: proposal.targetKey,
      before: proposal.before, readKeys: proposal.readKeys, predecessorIds: proposal.predecessorIds, metadataReads: proposal.metadataReads, sources: proposal.sources };
    const after = proposal.after;
    if (typeof after.normalizedValue === 'boolean') changes.push({ ...evidence, after: { normalizedValue: after.normalizedValue, originalText: after.normalizedValue ? 'true' : 'false' } });
    else {
      if (!('decimals' in after) || !proposal.exactNominal || !proposal.derivedInterval) throw new ApiError('INTERNAL_ERROR');
      changes.push({ ...evidence, after: { ...after, originalText: evidence.changed ? after.originalText : proposal.before.originalText ?? after.originalText },
        exactNominal: proposal.exactNominal, derivedInterval: proposal.derivedInterval, policyId: loaded.bundle.preview.policyId });
    }
  }
  const receipt: ApplicationBundle['receipt'] = { id: applicationId, previewId: loaded.preview.id, acceptedIds,
    selectionRef: { id: selectionId, revision: Number(loaded.selection.revision) }, closureHash: loaded.projection.closureHash, baseVersionId: base.versionId,
    newVersionId, beforeValidationRunId: candidate.beforeValidation.run.id, validationRunId: candidate.validation.run.id, appliedAt };
  const { acceptedIds: _acceptedIds, ...compact } = receipt, compactReceipt: CompactApplyReceiptDTO = { ...compact, acceptedCount: acceptedIds.length };
  const bundleRef = await deps.codec.put(claim, { receipt, changes }, commandWriteContext(request, cancelled));
  const stored = await deps.snapshots.writeSnapshot(claim, snapshot, 'application');
  const before = await persistValidation(request, cancelled, deps, base, candidate.beforeValidation, budget);
  const after = await persistValidation(request, cancelled, deps, snapshot, candidate.validation, budget);
  const comparisons = new Map<string, { key: string; before?: RuleResultDTO; after?: RuleResultDTO }>();
  for (const result of candidate.beforeValidation.results) { budget.check(); const key = resultOrderKey(result); comparisons.set(key, { key, before: result }); }
  for (const result of candidate.validation.results) { budget.check(); const key = resultOrderKey(result); comparisons.set(key, { ...comparisons.get(key), key, after: result }); }
  let boundValue: BoundPublicValue = async value => value;
  const left = createPublicResultProjector(base, { budget, bound: value => boundValue(value) }), right = createPublicResultProjector(snapshot, { budget, bound: value => boundValue(value) });
  const comparison = await deps.indexes.stage(claim, { resource: { type: 'application', id: applicationId, view: 'comparison' }, kind: 'results', revision: 1,
    rows: [...comparisons.values()].map(row => ({ key: row.key, sortKey: row.key, status: resultChanged(row.before, row.after, budget) ? 'changed' : 'unchanged', value: row as unknown as JsonValue })),
    project: async (row, bound) => { boundValue = bound; const value = row.value as unknown as { key: string; before?: RuleResultDTO; after?: RuleResultDTO };
      return { key: value.key, ...(value.before ? { before: await left.row(value.before) } : {}), ...(value.after ? { after: await right.row(value.after) } : {}) } as unknown as JsonValue; } });
  function* changeRows(): Generator<ProjectionInputRow> {
    for (const change of changes) { budget.check(); if (change.changed) yield { key: change.proposalId, sortKey: change.proposalId, value: publicApplicationChange(snapshot, change) as unknown as JsonValue }; }
  }
  const changed = await deps.indexes.stage(claim, { resource: { type: 'application', id: applicationId, view: 'changes' }, kind: 'changes', revision: 1, rows: changeRows() });
  const summary = { receipt: compactReceipt, changeCount: changes.length, beforeSummary: candidate.beforeValidation.run.summary, afterSummary: candidate.validation.run.summary };
  return { kind: 'apply', resultRef: { type: 'application', id: applicationId }, version: stored.version, basis: stored.basis!, validations: [before.validation, after.validation],
    canonicalRoots: [bundleRef, ...stored.canonicalRoots, ...before.canonicalRoots, ...after.canonicalRoots, comparison.manifestRef, changed.manifestRef],
    indexes: [...stored.indexes, ...before.indexes, ...after.indexes, ...[comparison, changed].map(index => ({ kind: index.ref.kind, id: index.ref.indexId, revision: 1, basisId: newValidationBasisId }))],
    domain: { applicationId, selectionId, previewId: loaded.preview.id, expectedRevision: Number(loaded.selection.revision), closureHash: loaded.projection.closureHash,
      changesRef: { bundle: json(bundleRef) }, detailRef: { summary: json(summary), views: { comparison: json(comparison.ref), changes: json(changed.ref) } } } };
}

/** SQL-only handlers run inside HostedPublication after all immutable objects and indexes are durable. */
export function regulatoryPublicationHandlers(): PublicationHandlers {
  return {
    'select-proposals': async (tx, { claim, envelope, now }) => {
      const payload = envelope.domain!, command = claim.inputRefs['command'] as JsonObject;
      if (payload['selectionId'] !== command['selectionId'] || payload['previewId'] !== command['previewId'] || payload['expectedRevision'] !== command['expectedRevision']) throw new ApiError('INTERNAL_ERROR');
      const result = await tx.query(`UPDATE proposal_selections s SET state='ready',pending_job_id=NULL,revision=revision+1,mask_ref=$6,counters=$7,selection_hash=$8
        WHERE s.session_id=$1 AND s.workspace_id=$2 AND s.id=$3 AND s.revision=$4 AND s.pending_job_id=$5 AND s.state='updating'
          AND s.version_id=$9 AND EXISTS(SELECT 1 FROM previews p WHERE p.session_id=s.session_id AND p.workspace_id=s.workspace_id AND p.id=s.preview_id AND p.state='ready' AND p.expires_at>$10) RETURNING s.id`,
      [claim.sessionId, claim.workspaceId, payload['selectionId'], payload['expectedRevision'], claim.jobId, payload['maskRef'], payload['counters'], payload['selectionHash'], claim.baseVersionId, now]);
      if (result.rowCount !== 1) throw new ApiError('STALE_PROPOSAL_SELECTION');
    },
    apply: async (tx, { claim, envelope, now }) => {
      const payload = envelope.domain!, command = claim.inputRefs['command'] as JsonObject, receipt = (payload['detailRef'] as JsonObject)?.['summary'] as JsonObject;
      const compact = receipt?.['receipt'] as JsonObject;
      if (!envelope.version) throw new ApiError('INTERNAL_ERROR');
      if (payload['applicationId'] !== command['applicationId'] || payload['selectionId'] !== command['selectionId'] || payload['previewId'] !== command['previewId']
        || payload['expectedRevision'] !== command['expectedRevision'] || payload['closureHash'] !== command['closureHash'] || envelope.version?.id !== command['newVersionId']
        || compact?.['id'] !== payload['applicationId'] || compact['newVersionId'] !== envelope.version.id || compact['beforeValidationRunId'] !== command['beforeRunId'] || compact['validationRunId'] !== command['runId']) throw new ApiError('INTERNAL_ERROR');
      const selection = await tx.query(`UPDATE proposal_selections SET state='applied',pending_job_id=NULL WHERE session_id=$1 AND workspace_id=$2 AND id=$3
        AND revision=$4 AND state='applying' AND pending_job_id=$5 AND selection_hash=$6 AND version_id=$7 AND preview_id=$8 RETURNING id,counters`,
      [claim.sessionId, claim.workspaceId, payload['selectionId'], payload['expectedRevision'], claim.jobId, payload['closureHash'], claim.baseVersionId, payload['previewId']]);
      if (selection.rowCount !== 1 || selection.rows[0]!.counters.selectedCount !== compact['acceptedCount']) throw new ApiError('STALE_PROPOSAL_SELECTION');
      const preview = await tx.query(`UPDATE previews SET state='applied' WHERE session_id=$1 AND workspace_id=$2 AND id=$3 AND version_id=$4 AND state='ready' AND expires_at>$5 RETURNING id`,
      [claim.sessionId, claim.workspaceId, payload['previewId'], claim.baseVersionId, now]);
      if (preview.rowCount !== 1) throw new ApiError('PREVIEW_NOT_APPLICABLE');
      await tx.query(`INSERT INTO application_receipts(session_id,workspace_id,id,job_id,base_version_id,new_version_id,preview_id,before_run_id,after_run_id,selection_id,selection_revision,
        closure_hash,accepted_count,changes_ref,detail_ref,applied_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [claim.sessionId, claim.workspaceId, payload['applicationId'], claim.jobId, claim.baseVersionId, envelope.version.id, payload['previewId'], command['beforeRunId'], command['runId'],
        payload['selectionId'], payload['expectedRevision'], payload['closureHash'], compact['acceptedCount'], payload['changesRef'], payload['detailRef'], now]);
    },
  };
}
