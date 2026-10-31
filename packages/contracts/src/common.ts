export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type UUID = string;
export type CivilDate = string;
export interface Rational { readonly numerator: string; readonly denominator: string }
export interface SourceLocator {
  readonly fileId?: UUID; readonly sheet?: string; readonly row?: number;
  readonly column?: string; readonly ruleCode?: string;
}
export interface Diagnostic { readonly code: string; readonly message: string; readonly locator?: SourceLocator;
  readonly fileName?: string; readonly severity?: 'error' | 'warning' | 'info'; readonly line?: number; readonly column?: number; readonly start?: number; readonly end?: number }
export interface SnapshotContent {
  readonly catalogVersion: string; readonly reportVersion: string; readonly configVersion: string;
  readonly profileId: string; readonly contexts: readonly ReportContext[];
  readonly catalog: CatalogData; readonly coordinates: readonly Coordinate[];
  readonly facts: readonly ReportedFact[]; readonly directions: readonly DirectionDTO[];
  readonly sources: readonly SourceFile[];
}
export interface Snapshot {
  readonly versionId: UUID; readonly parentVersionId?: UUID; readonly contentHash: string;
  readonly createdAt: string; readonly content: SnapshotContent;
}
export type JobKind = 'import' | 'validate' | 'preview' | 'apply' | 'export';
export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';
export interface ResultRef { readonly type: string; readonly id: string }
export interface JobProgress { readonly completed: number; readonly total: number; readonly complete: boolean }
export interface JobDTO {
  readonly jobId: UUID; readonly workspaceId: UUID; readonly kind: JobKind; readonly status: JobStatus;
  readonly baseVersionId?: UUID; readonly startedAt?: string; readonly deadline?: string; readonly endedAt?: string;
  readonly progress: JobProgress; readonly resultRef?: ResultRef; readonly newVersionId?: UUID;
  readonly diagnostics: readonly Diagnostic[]; readonly pollAfterMs: number;
}
export interface WorkspaceDTO {
  readonly id: UUID; readonly name: string; readonly state: 'empty' | 'ready' | 'closed';
  readonly currentVersionId?: UUID; readonly versionIds: readonly UUID[]; readonly activeJobId?: UUID;
  readonly contexts: readonly ReportContext[];
  readonly counts: { readonly snapshots: number; readonly coordinates: number; readonly facts: number; readonly sources: number };
  readonly sessionBytes: number;
}
export interface BootstrapDTO { readonly sessionToken: string; readonly apiVersion: 'v1'; readonly sessionPersistence: 'ephemeral'; readonly activeWorkspaceId?: UUID }
export const SESSION_LIMIT_BYTES = 512 * 1024 * 1024;
export const MAX_SNAPSHOTS = 20;
export const JOB_DEADLINE_MS = 60_000;
export const TERMINAL_JOB_STATUSES: readonly JobStatus[] = ['succeeded', 'failed', 'cancelled', 'timed_out'];
export function isTerminalJob(status: JobStatus): boolean { return TERMINAL_JOB_STATUSES.includes(status); }
export function isCivilDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
/** This text is for display only; storage always uses server-generated identifiers. */
export function safeDisplayName(value: string): string {
  return (value.split(/[\\/]/).at(-1) ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200) || 'archivo.xlsx';
}
import type { CatalogData } from './catalog.js';
import type { Coordinate, ReportedFact, ReportContext, SourceFile } from './report.js';
import type { DirectionDTO } from './recalculation.js';
export type { ReportContext, SourceFile } from './report.js';
