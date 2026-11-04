import { randomUUID } from 'node:crypto';
import { RECALCULATION_POLICY_ID } from '@ce/contracts';
import type { ApplicationBundle, ApplicationRequestDTO, ApplyChangeDTO, ApplyReceiptDTO, JsonValue, PreviewBundle, ProposalDTO, ReportedFact, RuleResultDTO, Snapshot, ValidationBundle } from '@ce/contracts';
import { sameReportedValue } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import { ApiError } from '../errors.js';
import type { JobAcceptance } from '../jobs/job-manager.js';
import { canonicalHash, canonicalStringify, immutable } from '../session/canonical-state.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { validationKey } from '../validation/validation-service.js';
import { getPreview, markPreviewApplied, previewKey, selectPreview } from './preview-store.js';
import { assertDirectionsAllowed } from './directions-service.js';
export const applicationKey = (workspaceId: string, receiptId: string) => 'application:' + workspaceId + ':' + receiptId;
export function getApplication(store: WorkspaceStore, workspaceId: string, receiptId: string): ApplicationBundle {
  store.get(workspaceId); const bundle = store.getRecord<ApplicationBundle>(applicationKey(workspaceId, receiptId)); if (!bundle) throw new ApiError('RESOURCE_NOT_FOUND'); return bundle;
}
function assertValidation(bundle: ValidationBundle, runId: string, versionId: string, snapshot: Snapshot): void {
  const run = bundle?.run, rows = bundle?.results;
  if (!run || !Array.isArray(rows) || run.id !== runId || run.versionId !== versionId || run.profileId !== snapshot.content.profileId || run.status !== 'completed' || run.summary?.complete !== true
    || run.summary.rows !== snapshot.content.catalog.records.length || run.summary.variants !== snapshot.content.catalog.variants.length || !Array.isArray(run.resultIds) || run.resultIds.length !== rows.length
    || new Set(run.resultIds).size !== rows.length || rows.some((row, index) => row.id !== run.resultIds[index] || row.runId !== runId || row.versionId !== versionId || row.profileId !== snapshot.content.profileId)) throw new ApiError('INTERNAL_ERROR');
  const counts = { pass: 0, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 };
  for (const row of rows as readonly RuleResultDTO[]) { if (!Object.hasOwn(counts, row.status)) throw new ApiError('INTERNAL_ERROR'); counts[row.status]++; }
  if (canonicalStringify(counts) !== canonicalStringify(run.summary.byStatus) || run.summary.instances !== rows.filter(row => row.instanceId).length) throw new ApiError('INTERNAL_ERROR');
}
function existingValidation(store: WorkspaceStore, workspaceId: string, snapshot: Snapshot): ValidationBundle | undefined {
  return store.listRecords<ValidationBundle>('validation:' + workspaceId + ':').map(row => row.value).filter(bundle => {
    try { assertValidation(bundle, bundle.run.id, snapshot.versionId, snapshot); return true; } catch { return false; }
  }).sort((a, b) => b.run.startedAt.localeCompare(a.run.startedAt) || b.run.id.localeCompare(a.run.id))[0];
}
function selectedProposals(bundle: PreviewBundle, body: ApplicationRequestDTO): readonly ProposalDTO[] {
  if (body.baseVersionId !== bundle.preview.baseVersionId) throw new ApiError('STALE_VERSION');
  if (bundle.preview.state !== 'ready') throw new ApiError('PREVIEW_NOT_APPLICABLE');
  const selection = selectPreview(bundle, body.selectedIds);
  if (!body.selectedIds.length || new Set(body.selectedIds).size !== body.selectedIds.length) throw new ApiError('INVALID_REQUEST');
  if (!selection.complete || selection.closureHash !== body.closureHash) throw new ApiError('SELECTION_NOT_CLOSED');
  const selected = new Set(body.selectedIds), proposals = bundle.proposals.filter(row => selected.has(row.id));
  if (proposals.some(proposal => !proposal.before || !proposal.after) || new Set(proposals.map(row => row.targetKey)).size !== proposals.length) throw new ApiError('PREVIEW_NOT_APPLICABLE');
  return proposals;
}
export function prepareApplication(store: WorkspaceStore, workspaceId: string, body: ApplicationRequestDTO, limits?: Partial<WorkLimits>): JobAcceptance {
  store.assertAccepting(workspaceId); store.assertIdle(workspaceId); store.assertBase(workspaceId, body.baseVersionId);
  const snapshot = store.snapshot(workspaceId, body.baseVersionId), preview = getPreview(store, workspaceId, body.previewId), proposals = selectedProposals(preview, body);
  if (preview.preview.profileId !== snapshot.content.profileId || preview.preview.policyId !== RECALCULATION_POLICY_ID) throw new ApiError('PREVIEW_NOT_APPLICABLE');
  assertDirectionsAllowed(snapshot, limits);
  const before = existingValidation(store, workspaceId, snapshot);
  const intent = immutable({ receiptId: randomUUID(), newVersionId: randomUUID(), beforeRunId: before?.run.id ?? randomUUID(), runId: randomUUID(), startedAt: new Date().toISOString(),
    previewId: body.previewId, baseVersionId: body.baseVersionId, selectedIds: [...body.selectedIds].sort(), closureHash: body.closureHash });
  const assertPreview = () => {
    store.assertBase(workspaceId, intent.baseVersionId); const current = getPreview(store, workspaceId, intent.previewId);
    if (current !== preview || current.preview.state !== 'ready') throw new ApiError('PREVIEW_NOT_APPLICABLE');
    if (current.preview.profileId !== snapshot.content.profileId || current.preview.policyId !== RECALCULATION_POLICY_ID) throw new ApiError('PREVIEW_NOT_APPLICABLE');
    assertDirectionsAllowed(store.snapshot(workspaceId, intent.baseVersionId), limits);
  };
  return { retainedState: intent, input: { ...intent, preview: preview as unknown as JsonValue, ...(before ? { beforeValidation: before as unknown as JsonValue } : {}), ...(limits ? { limits: limits as unknown as JsonValue } : {}) },
    preparePublication: (_job, output) => {
      assertPreview(); const candidate = output.applicationCandidate;
      if (!candidate || output.snapshotContent || output.resultRef?.type !== 'application' || output.resultRef.id !== intent.receiptId || !Array.isArray(candidate.factPatches)) throw new ApiError('INTERNAL_ERROR');
      assertValidation(candidate.beforeValidation, intent.beforeRunId, intent.baseVersionId, snapshot); assertValidation(candidate.validation, intent.runId, intent.newVersionId, snapshot);
      const baseFacts = new Map(snapshot.content.facts.map(fact => [fact.factKey, fact])), coordinates = new Map(snapshot.content.coordinates.map(cell => [cell.factKey, cell]));
      const supplied = new Map(candidate.factPatches.map(fact => [fact.factKey, fact])); if (supplied.size !== candidate.factPatches.length) throw new ApiError('INTERNAL_ERROR');
      const patches = new Map<string, ReportedFact>(), changes: ApplyChangeDTO[] = [];
      for (const proposal of proposals) {
        const previous = baseFacts.get(proposal.targetKey), coordinate = coordinates.get(proposal.targetKey), after = proposal.after!;
        if (!coordinate) throw new ApiError('INTERNAL_ERROR');
        const changed = previous?.presence !== 'value' || !sameReportedValue(previous.normalizedValue, after.normalizedValue);
        const patch = supplied.get(proposal.targetKey);
        if (changed) {
          const expected: ReportedFact = { factKey: coordinate.factKey, contextId: coordinate.contextId, tableCode: coordinate.tableCode, sheetCode: coordinate.sheetCode, rowCode: coordinate.rowCode, columnCode: coordinate.columnCode,
            presence: 'value', normalizedValue: after.normalizedValue, originalText: after.originalText, sourceLocator: previous?.sourceLocator ?? coordinate.sourceLocator,
            derivation: { receiptId: intent.receiptId, previewId: intent.previewId, proposalId: proposal.id, baseVersionId: intent.baseVersionId } };
          if (!patch || canonicalStringify(patch) !== canonicalStringify(expected)) throw new ApiError('INTERNAL_ERROR'); patches.set(proposal.targetKey, expected);
        } else if (patch) throw new ApiError('INTERNAL_ERROR');
        const evidence = { changed, receiptId: intent.receiptId, proposalId: proposal.id, directionId: proposal.directionId, instanceId: proposal.instanceId, variantIds: proposal.variantIds,
          code: proposal.code, targetKey: proposal.targetKey, before: proposal.before!, readKeys: proposal.readKeys, predecessorIds: proposal.predecessorIds, metadataReads: proposal.metadataReads, sources: proposal.sources };
        if (typeof after.normalizedValue === 'boolean') {
          changes.push({ ...evidence, after: { normalizedValue: after.normalizedValue, originalText: after.normalizedValue ? 'true' : 'false' } });
        } else {
          if (!('decimals' in after) || !proposal.exactNominal || !proposal.derivedInterval) throw new ApiError('INTERNAL_ERROR');
          changes.push({ ...evidence, after: { ...after, originalText: changed ? after.originalText : previous!.originalText! }, exactNominal: proposal.exactNominal, derivedInterval: proposal.derivedInterval, policyId: preview.preview.policyId });
        }
      }
      if (patches.size !== supplied.size) throw new ApiError('INTERNAL_ERROR');
      // Restore ownership/sharing with the original main-thread snapshot after structuredClone transport.
      const facts = patches.size ? [...snapshot.content.facts.map(fact => patches.get(fact.factKey) ?? fact), ...[...patches.values()].filter(fact => !baseFacts.has(fact.factKey))] : snapshot.content.facts;
      const content = patches.size ? { ...snapshot.content, facts, reportVersion: canonicalHash(facts) } : snapshot.content;
      const receipt: ApplyReceiptDTO = { id: intent.receiptId, previewId: intent.previewId, acceptedIds: intent.selectedIds, closureHash: intent.closureHash,
        baseVersionId: intent.baseVersionId, newVersionId: intent.newVersionId, beforeValidationRunId: intent.beforeRunId, validationRunId: intent.runId, appliedAt: new Date().toISOString() };
      const applied = markPreviewApplied(preview, receipt.id, intent.selectedIds);
      const application: ApplicationBundle = { receipt, changes };
      return { assertCommit: assertPreview, output: { ...output, snapshotContent: content, snapshotVersionId: intent.newVersionId, records: [...(output.records ?? []),
        { key: validationKey(workspaceId, intent.beforeRunId), value: (before ?? candidate.beforeValidation) as unknown as JsonValue },
        { key: validationKey(workspaceId, intent.runId), value: candidate.validation as unknown as JsonValue },
        { key: previewKey(workspaceId, intent.previewId), value: applied as unknown as JsonValue },
        { key: applicationKey(workspaceId, receipt.id), value: application as unknown as JsonValue },
      ] } };
    },
  };
}
