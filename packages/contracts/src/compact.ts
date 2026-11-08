import type { UUID } from './common.js';
import { uuidSchema } from './common.schemas.js';
import type { ValidationSummary } from './validation.js';
import { validationSummarySchema } from './validation.js';

export const PUBLIC_JSON_MAX_BYTES = 1024 * 1024;
export const PUBLIC_PAGE_MAX_ITEMS = 50;
export const SHA256_HEX_SCHEMA = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const safeCount = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;

/** Opaque authorized reference, never a provider URL, storage key or truncated substitute. */
export interface LargeValueDescriptorDTO {
  readonly valueRef: UUID;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: 'text/plain' | 'text/plain; charset=utf-8' | 'application/json' | 'application/octet-stream';
}
export const largeValueDescriptorSchema = { type: 'object', additionalProperties: false,
  required: ['valueRef', 'byteLength', 'sha256', 'mediaType'], properties: {
    valueRef: uuidSchema, byteLength: safeCount, sha256: SHA256_HEX_SCHEMA,
    mediaType: { enum: ['text/plain', 'text/plain; charset=utf-8', 'application/json', 'application/octet-stream'] },
  } } as const;

/** Endpoint-specific schemas must also close their item payloads and authorize this scope. */
export interface CompactPageDTO<Item> {
  readonly workspaceId: UUID;
  readonly versionId: UUID;
  readonly validationBasisId?: UUID;
  readonly revision?: number;
  readonly items: readonly Item[];
  readonly total: number;
  readonly nextCursor: string | null;
}
export function compactPageSchema(itemSchema: object) {
  return { type: 'object', additionalProperties: false,
    required: ['workspaceId', 'versionId', 'items', 'total', 'nextCursor'], properties: {
      workspaceId: uuidSchema, versionId: uuidSchema, validationBasisId: uuidSchema,
      revision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
      items: { type: 'array', maxItems: PUBLIC_PAGE_MAX_ITEMS, items: itemSchema }, total: safeCount,
      nextCursor: { anyOf: [{ type: 'null' }, { type: 'string', minLength: 1, maxLength: 8192 }] },
    } } as const;
}

/** No resultIds or complete diagnostics: details are read through authorized paginated queries. */
export interface CompactValidationRunDTO {
  readonly id: UUID;
  readonly workspaceId: UUID;
  readonly versionId: UUID;
  readonly validationBasisId: UUID;
  readonly profileId: string;
  readonly status: 'running' | 'completed' | 'incomplete';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly summary: ValidationSummary;
  readonly diagnosticsCount: number;
}
export const compactValidationRunSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'workspaceId', 'versionId', 'validationBasisId', 'profileId', 'status', 'startedAt', 'summary', 'diagnosticsCount'],
  properties: {
    id: uuidSchema, workspaceId: uuidSchema, versionId: uuidSchema, validationBasisId: uuidSchema,
    profileId: { type: 'string', minLength: 1, maxLength: 200 }, status: { enum: ['running', 'completed', 'incomplete'] },
    startedAt: { type: 'string', format: 'date-time' }, endedAt: { type: 'string', format: 'date-time' },
    summary: validationSummarySchema, diagnosticsCount: safeCount,
  } } as const;

/** Size only; validate the closed DTO schema before calling this helper. Works in Node and Angular. */
export function publicJsonByteLength(value: unknown): number {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError('The public payload must be JSON serializable.');
  return new TextEncoder().encode(serialized).byteLength;
}

/** Page length and maxLength are not a byte budget: UTF-8 and JSON escaping count too. */
export function assertPublicJsonBudget(value: unknown): void {
  if (publicJsonByteLength(value) > PUBLIC_JSON_MAX_BYTES) throw new RangeError('Public JSON exceeds the 1 MiB byte budget.');
}
