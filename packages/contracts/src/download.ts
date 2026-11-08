import type { UUID } from './common.js';
import { uuidSchema } from './common.schemas.js';

export type ExportKind = 'report' | 'results';
export type ExportRequestDTO =
  | { readonly versionId: UUID; readonly kind: 'report' }
  | { readonly versionId: UUID; readonly kind: 'results'; readonly runId: UUID };

/** The workspace is part of an intent; a route-scoped export request must not override it. */
export type DownloadIntent = ExportRequestDTO & { readonly workspaceId: UUID };

export const downloadUiStates = ['idle', 'accepting', 'preparing', 'ready', 'transferring',
  'uncertain', 'failed', 'cancelled', 'expired'] as const;
export type DownloadUiState = typeof downloadUiStates[number];

function intentSchema(includeWorkspace: boolean) {
  const identity = { versionId: uuidSchema, ...(includeWorkspace ? { workspaceId: uuidSchema } : {}) };
  return { oneOf: [
    { type: 'object', additionalProperties: false, required: [...Object.keys(identity), 'kind'],
      properties: { ...identity, kind: { const: 'report' } } },
    { type: 'object', additionalProperties: false, required: [...Object.keys(identity), 'kind', 'runId'],
      properties: { ...identity, kind: { const: 'results' }, runId: uuidSchema } },
  ] } as const;
}

/** Structural only: the service must verify owner and run.versionId === versionId. */
export const downloadIntentSchema = intentSchema(true);
export const exportRequestSchema = intentSchema(false);
export const downloadUiStateSchema = { type: 'string', enum: downloadUiStates } as const;

/** Canonical identity input; its SHA-256 is independent from the private operation fingerprint. */
export function downloadIntentKey(intent: DownloadIntent): string {
  return JSON.stringify([intent.workspaceId, intent.versionId, intent.kind, intent.kind === 'results' ? intent.runId : null]);
}
export function sameDownloadIntent(a: DownloadIntent | null | undefined, b: DownloadIntent | null | undefined): boolean {
  return !!a && !!b && downloadIntentKey(a) === downloadIntentKey(b);
}
export interface ExportArtifactSummaryDTO {
  readonly id: UUID; readonly jobId: UUID; readonly intent: DownloadIntent; readonly intentFingerprint: string;
  readonly status: 'ready'; readonly size: number; readonly sha256: string;
  readonly filename: 'report.zip' | 'results.zip'; readonly mimeType: 'application/zip'; readonly expiresAt?: string;
}
const digestSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' } as const;
export const exportArtifactSummarySchema = { type: 'object', additionalProperties: false,
  required: ['id', 'jobId', 'intent', 'intentFingerprint', 'status', 'size', 'sha256', 'filename', 'mimeType'], properties: {
    id: uuidSchema, jobId: uuidSchema, intent: downloadIntentSchema, intentFingerprint: digestSchema,
    status: { const: 'ready' }, size: { type: 'integer', minimum: 0 }, sha256: digestSchema,
    filename: { enum: ['report.zip', 'results.zip'] }, mimeType: { const: 'application/zip' }, expiresAt: { type: 'string', format: 'date-time' },
  } } as const;
