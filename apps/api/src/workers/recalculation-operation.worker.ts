import type { JsonValue, Snapshot } from '@ce/contracts';
import { compileDirectionConfiguration, createProposalSelection, simulate } from '@ce/engine';
import { ApiError } from '../errors.js';
import { runDirectionWork } from './direction-review-worker.js';
import { canonicalHash, directionConfigurationVersion } from '../session/canonical-state.js';
import type { OperationContext, RecalculationOperationInput, WorkerOutput } from './protocol.js';

export function execute(input: JsonValue, context: OperationContext): WorkerOutput {
  if (!context.snapshot) throw new ApiError('INVALID_REQUEST');
  const base = context.snapshot, request = input as unknown as RecalculationOperationInput;
  return runDirectionWork(context, request.limits, budget => {
    const compilation = compileDirectionConfiguration(base, request.projection, { budget, requireResolved: true });
    if (directionConfigurationVersion(compilation.directions, compilation.decisionState) !== request.configVersion) throw new ApiError('INVALID_DIRECTION');
    const content = { ...base.content, directions: compilation.directions, directionDecisionState: compilation.decisionState, configVersion: request.configVersion };
    const snapshot: Snapshot = { ...base, versionId: request.effectiveVersionId, content, contentHash: canonicalHash(content),
      ...(request.effectiveVersionId !== base.versionId ? { parentVersionId: base.versionId } : {}) };
    const preview = simulate(snapshot, { previewId: request.previewId, budget, progress: context.progress });
    const selectionProjection = createProposalSelection(preview, 'available', budget);
    return { complete: true, directionCompilation: compilation, recalculationPreview: preview, selectionProjection,
      resultRef: { type: 'preview', id: request.previewId } };
  });
}
