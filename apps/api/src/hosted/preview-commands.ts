import type { JsonObject, JsonValue, PreviewBundle, Snapshot } from '@ce/contracts';
import { compileDirectionConfiguration, createProposalSelection, simulate, WorkBudget } from '@ce/engine';
import { ApiError } from '../errors.js';
import { canonicalHash, directionConfigurationVersion } from '../session/canonical-state.js';
import type { HostedWorkerRequest } from '../workers/protocol.js';
import type { HostedCommandDependencies } from './worker-runtime.js';
import type { PublicationEnvelope } from './publication.js';
import { commandBody, commandId, commandWriteContext } from './domain-commands.js';
import { loadReviewProjection } from './review-commands.js';
import { stageSelectionViews } from './selection-commands.js';

const json = (value: unknown) => value as JsonObject;
export async function calculateHostedPreview(request: HostedWorkerRequest, cancelled: () => boolean, deps: HostedCommandDependencies, base: Snapshot, budget: WorkBudget): Promise<PublicationEnvelope> {
  const claim = request.claim, command = commandBody(request), projection = await loadReviewProjection(request, deps);
  const compilation = compileDirectionConfiguration(base, projection, { budget, requireResolved: true });
  const configVersion = directionConfigurationVersion(compilation.directions, compilation.decisionState), changed = configVersion !== base.content.configVersion;
  if (changed !== command['configChanged']) throw new ApiError('INTERNAL_ERROR');
  const effectiveVersionId = commandId(command, 'effectiveVersionId');
  if (changed === (effectiveVersionId === base.versionId)) throw new ApiError('INTERNAL_ERROR');
  const content = { ...base.content, directions: compilation.directions, directionDecisionState: compilation.decisionState, configVersion };
  const snapshot: Snapshot = changed ? { ...base, versionId: effectiveVersionId, parentVersionId: base.versionId, createdAt: new Date(deps.now()).toISOString(), content, contentHash: canonicalHash(content) } : base;
  const bundle = simulate(snapshot, { previewId: commandId(command, 'previewId'), budget }), selection = createProposalSelection(bundle, 'available', budget), context = commandWriteContext(request, cancelled);
  const bundleRef = await deps.codec.put(claim, bundle, context), maskRef = await deps.codec.put(claim, selection, context), roots = [bundleRef, maskRef];
  const previewId = bundle.preview.id, selectionId = commandId(command, 'selectionId');
  const staged = await stageSelectionViews(request, deps, snapshot, bundle, selection, selectionId, 1, budget, true);
  const { previewRows, ...selectionViews } = staged.views;
  const previewViews = { rows: previewRows! };
  roots.push(...staged.canonicalRoots);
  const indexes = staged.indexes;
  const stored = changed ? await deps.snapshots.writeSnapshot(claim, snapshot, 'configuration') : undefined;
  const { proposalIds: _proposalIds, graphSummary, diagnostics, ...previewMetadata } = bundle.preview;
  const previewSummary = { ...previewMetadata, graphSummary: { nodes: graphSummary.nodes, edges: graphSummary.edges, blocked: graphSummary.blocked,
    conflictCount: graphSummary.conflicts.length, cycleCount: graphSummary.cycles.length }, diagnosticCount: diagnostics.length };
  return { kind: 'recalculation-operation', resultRef: { type: 'preview', id: previewId }, canonicalRoots: [...roots, ...(stored?.canonicalRoots ?? [])], indexes: [...indexes, ...(stored?.indexes ?? [])],
    ...(stored ? { version: stored.version } : {}),
    preview: { id: previewId, versionId: snapshot.versionId, basisId: snapshot.validationBasisId!, sourceRunId: commandId(command, 'runId'), manifestRefs: { bundle: json(bundleRef), views: previewViews },
      counters: json(previewSummary), contentHash: canonicalHash(bundle), expiresAt: new Date(deps.now() + 60 * 60_000).toISOString() },
    selection: { id: selectionId, previewId, versionId: snapshot.versionId, basisId: snapshot.validationBasisId!, maskRef: { projection: json(maskRef), views: selectionViews },
      counters: { availableCount: selection.availableCount, selectedCount: selection.selectedCount, requiredCount: selection.requiredCount, complete: selection.complete, closureHash: selection.closureHash }, selectionHash: selection.closureHash },
    review: { id: commandId(command, 'reviewId'), expectedRevision: command['reviewRevision'] as number, state: 'committed',
      receipt: { reviewId: commandId(command, 'reviewId'), runId: commandId(command, 'runId'), baseVersionId: base.versionId, newVersionId: snapshot.versionId, configVersion, included: compilation.directions.length } } };
}
