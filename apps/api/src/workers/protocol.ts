import type { Diagnostic, JobDTO, JsonValue, ResultRef, Snapshot, SnapshotContent } from '@ce/contracts';
import type { ApplicationCandidate } from '@ce/engine';
export interface StateRecord { readonly key: string; readonly value: JsonValue }
export interface WorkerOutput {
  readonly complete: boolean; readonly snapshotContent?: SnapshotContent;
  readonly records?: readonly StateRecord[]; readonly resultRef?: ResultRef;
  readonly diagnostics?: readonly Diagnostic[];
  readonly applicationCandidate?: ApplicationCandidate;
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
