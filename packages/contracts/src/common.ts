export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };
export type UUID = string;
export type CivilDate = string;
export interface Rational { readonly numerator: string; readonly denominator: string }
export type DataType = 'number' | 'boolean' | 'text' | 'date';
export interface TextValue { readonly kind: 'text'; readonly value: string }
export interface DateValue { readonly kind: 'date'; readonly value: CivilDate }
export type NormalizedValue = Rational | boolean | TextValue | DateValue;
/** Optional display text from trusted catalog/mapping data; never calculation authority. */
export interface PresentationDTO { readonly description?: string; readonly conceptLabel?: string }
/** Distinguishes an exact rational DTO from tagged text/date; never coerces a value. */
export function isRationalValue(value: unknown): value is Rational {
  return typeof value === 'object' && value !== null && !('kind' in value)
    && 'numerator' in value && typeof value.numerator === 'string'
    && 'denominator' in value && typeof value.denominator === 'string';
}
export interface SourceLocator {
  readonly fileId?: UUID; readonly sheet?: string; readonly row?: number;
  readonly column?: string; readonly ruleCode?: string;
}
export interface Diagnostic { readonly code: string; readonly message: string; readonly locator?: SourceLocator;
  readonly profileChoice?: { readonly reportIndex: number; readonly sha256: string; readonly candidates: readonly { readonly profileId: 'eba-corep-of-4.0-ca1-v1' | 'eba-finrep-4.0-f0101-v1'; readonly label: string; readonly tableCode: string }[] };
  readonly fileName?: string; readonly severity?: 'error' | 'warning' | 'info'; readonly line?: number; readonly column?: number; readonly start?: number; readonly end?: number }
export interface SnapshotContent {
  readonly catalogVersion: string; readonly reportVersion: string; readonly configVersion: string;
  readonly profileId: string; readonly contexts: readonly ReportContext[];
  readonly catalog: CatalogData; readonly coordinates: readonly Coordinate[];
  readonly facts: readonly ReportedFact[]; readonly directions: readonly DirectionDTO[];
  readonly directionDecisionState?: import('./direction-review.js').DirectionDecisionState;
  readonly sources: readonly SourceFile[];
  /** Absent for legacy ce-report-1. Trusted adapters bind visual reports to their actual source. */
  readonly reportSourceBindings?: readonly ReportSourceBinding[];
}
export interface Snapshot {
  readonly versionId: UUID; readonly parentVersionId?: UUID; readonly contentHash: string;
  readonly createdAt: string; readonly content: SnapshotContent;
}
export const JOB_KINDS = ['import','inspect-import','prepare-directions','commit-directions','validate','preview','select-proposals','apply','export'] as const;
export type JobKind = typeof JOB_KINDS[number];
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
import type { Coordinate, ReportedFact, ReportContext, ReportSourceBinding, SourceFile } from './report.js';
import type { DirectionDTO } from './recalculation.js';
export type { ReportContext, SourceFile } from './report.js';
