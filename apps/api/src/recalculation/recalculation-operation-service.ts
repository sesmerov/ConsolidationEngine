import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { JsonValue, RecalculationOperationDTO, RecalculationReservationDTO } from '@ce/contracts';
import { projectDirectionConfiguration, createProposalSelection, verifyDirectionCompilation, WorkBudget } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import type { JobAcceptance } from '../jobs/job-manager.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { directionConfigurationVersion } from '../session/canonical-state.js';
import { ApiError } from '../errors.js';
import type { DirectionReviewService } from './direction-review-service.js';
import { activeReviewKey, latestDirectionCommitKey, reviewEntry } from './direction-review-record.js';
import { previewKey } from './preview-store.js';
import { proposalSelectionKey, selectionSummary } from './proposal-selection-record.js';

export class RecalculationOperationService {
  constructor(private readonly store: WorkspaceStore, private readonly reviews: DirectionReviewService, private readonly limits?: Partial<WorkLimits>) {}
  accept(workspaceId: string, body: RecalculationOperationDTO, jobId: string): JobAcceptance {
    const lease = this.reviews.operationLease(workspaceId, body, jobId), base = this.store.snapshot(workspaceId, body.baseVersionId);
    const compilation = projectDirectionConfiguration(lease.review.projection, { requireResolved: true });
    const configVersion = directionConfigurationVersion(compilation.directions, compilation.decisionState);
    const configChanged = configVersion !== base.content.configVersion;
    const effectiveVersionId = configChanged ? randomUUID() : base.versionId, previewId = randomUUID(), selectionId = randomUUID();
    const reservation: RecalculationReservationDTO = { kind: 'recalculation', inputVersionId: base.versionId, effectiveVersionId, reservedPreviewId: previewId };
    return { input: { projection: lease.review.projection as unknown as JsonValue, effectiveVersionId, configVersion, previewId,
      ...(this.limits ? { limits: this.limits as unknown as JsonValue } : {}) }, reservation,
      initialRecords: lease.initialRecords, assertStart: lease.assertStart, onTerminal: lease.onTerminal, finalize: lease.finalize,
      retainedState: { ...body, effectiveVersionId, configChanged, previewId, selectionId },
      preparePublication: (job, output) => {
        lease.assertCommit();
        const budget = new WorkBudget({ limits: { ...this.limits, milliseconds: Math.max(0, Math.min(this.limits?.milliseconds ?? 60_000, Date.parse(job.deadline!) - Date.now())) } });
        const candidate = output.directionCompilation, preview = output.recalculationPreview, selection = output.selectionProjection;
        if (!output.complete || !candidate || !preview || !selection
          || Object.keys(output).some(key => !['complete', 'directionCompilation', 'recalculationPreview', 'selectionProjection', 'resultRef'].includes(key))
          || output.resultRef?.type !== 'preview' || output.resultRef.id !== previewId
          || !verifyDirectionCompilation(lease.review.projection, candidate, { budget })
          || directionConfigurationVersion(candidate.directions, candidate.decisionState) !== configVersion
          || preview.preview.id !== previewId || preview.preview.baseVersionId !== effectiveVersionId || preview.preview.state !== 'ready'
          || preview.preview.profileId !== base.content.profileId || preview.proposals.length !== candidate.directions.length
          || !isDeepStrictEqual(preview.preview.proposalIds, preview.proposals.map(row => row.id))
          || !isDeepStrictEqual(createProposalSelection(preview, 'available', budget), selection)) throw new ApiError('INTERNAL_ERROR');
        const configuration = { ...base.content, directions: candidate.directions, directionDecisionState: candidate.decisionState, configVersion };
        const receipt = { reviewId: body.reviewId, runId: body.runId, baseVersionId: base.versionId, newVersionId: effectiveVersionId, configVersion, included: candidate.directions.length };
        const records = [
          reviewEntry({ summary: { ...lease.pending.summary, state: 'committed', receipt } }),
          { key: latestDirectionCommitKey(workspaceId), value: receipt },
          { key: activeReviewKey(workspaceId), value: null },
          { key: previewKey(workspaceId, previewId), value: preview as unknown as JsonValue },
          { key: proposalSelectionKey(workspaceId, previewId), value: { summary: selectionSummary({ id: selectionId, workspaceId, previewId,
            baseVersionId: effectiveVersionId, revision: 1, state: 'ready', initializationJobId: jobId }, selection), projection: selection } as unknown as JsonValue },
        ];
        return { assertCommit: lease.assertCommit, output: { complete: true, records, resultRef: { type: 'preview', id: previewId },
          ...(configChanged ? { snapshotVersionId: effectiveVersionId, snapshotContent: configuration } : {}) } };
      },
    };
  }
}
