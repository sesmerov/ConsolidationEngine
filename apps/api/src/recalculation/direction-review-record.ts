import type { DirectionReviewSummaryDTO, JsonValue } from '@ce/contracts';
import type { DirectionReviewProjection } from '@ce/engine';
import type { StateRecord } from '../workers/protocol.js';

interface MutationReceipt { readonly hash: string; readonly appliedRevision: number }
export interface ReviewRecord {
  readonly summary: DirectionReviewSummaryDTO;
  readonly projection?: DirectionReviewProjection;
  readonly mutations?: Readonly<Record<string, MutationReceipt>>;
}
export const reviewKey = (workspaceId: string, id: string) => `direction-review:${workspaceId}:${id}`;
export const activeReviewKey = (workspaceId: string) => `direction-review-active:${workspaceId}`;
export const latestDirectionCommitKey = (workspaceId: string) => `direction-review-receipt:${workspaceId}`;
export function reviewEntry(record: ReviewRecord): StateRecord {
  return { key: reviewKey(record.summary.workspaceId, record.summary.id), value: record as unknown as JsonValue };
}
export function releasedReview(record: ReviewRecord, state: 'obsolete' | 'expired' | 'discarded' | 'failed'): ReviewRecord {
  const { id, workspaceId, baseVersionId, runId, revision, jobId } = record.summary;
  return { summary: { id, workspaceId, baseVersionId, runId, revision, state, ...(jobId ? { jobId } : {}) } };
}
