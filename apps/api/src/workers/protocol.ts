import type { Diagnostic, ImportContextInputDTO, ImportInspectionContextDTO, ImportInspectionDTO, ImportInspectionProfileDTO, ImportInspectionReportDTO, JobDTO, JsonValue, ResultRef, Snapshot, SnapshotContent } from '@ce/contracts';
import type { StagedFile } from '../import/multipart-staging.js';
import type { ApplicationCandidate, DirectionReviewProjection, ReviewSeed, WorkLimits } from '@ce/engine';
import type { DirectionDecisionState, DirectionDTO } from '@ce/contracts';
export interface StateRecord { readonly key: string; readonly value: JsonValue }
export interface WorkerOutput {
  readonly complete: boolean; readonly snapshotContent?: SnapshotContent;
  readonly records?: readonly StateRecord[]; readonly resultRef?: ResultRef;
  readonly diagnostics?: readonly Diagnostic[];
  readonly applicationCandidate?: ApplicationCandidate;
  readonly inspectionCandidate?: InspectionCandidate;
  readonly verifiedInspectionHash?: string;
  readonly directionReviewProjection?: DirectionReviewProjection;
  readonly directionCompilation?: DirectionCompilation;
}
export interface DirectionCompilation { readonly directions: readonly DirectionDTO[]; readonly decisionState: DirectionDecisionState }
export interface PrepareDirectionsInput { readonly reviewId: string; readonly seeds: readonly ReviewSeed[]; readonly limits?: Partial<WorkLimits> }
export interface CommitDirectionsInput { readonly projection: DirectionReviewProjection; readonly limits?: Partial<WorkLimits> }
export interface InspectionCandidate {
  readonly content: SnapshotContent; readonly profiles: readonly ImportInspectionProfileDTO[];
  readonly context: readonly ImportInspectionContextDTO[]; readonly reports: readonly ImportInspectionReportDTO[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface InspectionRecord {
  readonly inspection: ImportInspectionDTO; readonly candidate?: SnapshotContent;
  readonly files?: readonly StagedFile[]; readonly declaration?: ImportContextInputDTO;
  /** Released business data is removed atomically; only file IDs needed by bounded cleanup survive temporarily. */
  readonly cleanupFileIds?: readonly string[];
}
export interface WorkerRequest {
  readonly job: JobDTO; readonly input: JsonValue; readonly snapshot?: Snapshot;
  readonly cancellation: SharedArrayBuffer; readonly moduleUrl?: string;
}
export type WorkerMessage =
  | { readonly type: 'progress'; readonly completed: number; readonly total: number }
  | { readonly type: 'result'; readonly output: WorkerOutput }
  | { readonly type: 'failure'; readonly diagnostic: Diagnostic };
export interface OperationContext {
  readonly job: JobDTO; readonly snapshot?: Snapshot;
  readonly cancelled: () => boolean; readonly progress: (completed: number, total: number) => void;
}
export interface WorkerOperation { execute(input: JsonValue, context: OperationContext): Promise<WorkerOutput> | WorkerOutput }
