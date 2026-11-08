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
