import type { UUID } from './common.js';
import { uuidSchema } from './common.schemas.js';
import { SHA256_HEX_SCHEMA } from './compact.js';
import type { DownloadIntent } from './download.js';
import { downloadIntentSchema } from './download.js';

export const TRANSFER_PART_MAX_BYTES = 3 * 1024 * 1024;
export const INPUT_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const INPUT_BATCH_MAX_BYTES = 50 * 1024 * 1024;
export const INPUT_EXPANDED_MAX_BYTES = 100 * 1024 * 1024;
export const INPUT_MAX_REPORTS = 20;
export const EXPORT_MAX_BYTES = 100 * 1024 * 1024;
export const EXPORT_MAX_PARTS = Math.ceil(EXPORT_MAX_BYTES / TRANSFER_PART_MAX_BYTES);
export const INPUT_FILE_MAX_PARTS = Math.ceil(INPUT_FILE_MAX_BYTES / TRANSFER_PART_MAX_BYTES);
const positiveBytes = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
const displayName = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[^\\\\/\\u0000-\\u001f\\u007f]+$' } as const;
const nullableBase = { anyOf: [uuidSchema, { type: 'null' }] } as const;
export const uploadBatchStates = ['reserved', 'receiving', 'sealing', 'sealed', 'retained', 'cleanup_pending', 'deleted'] as const;
export type UploadBatchState = typeof uploadBatchStates[number];

export interface UploadFileDeclarationDTO {
  readonly clientFileId: string;
  readonly role: 'catalog' | 'report';
  readonly name: string;
  readonly byteLength: number;
  readonly sha256: string;
}
export interface UploadBatchCreateDTO {
  /** Null explicitly identifies an empty workspace; If-Match remains required by the route guard. */
  readonly baseVersionId: UUID | null;
  readonly files: readonly UploadFileDeclarationDTO[];
}
const fileDeclarationProperties = {
  clientFileId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]*$' },
  role: { enum: ['catalog', 'report'] }, name: displayName,
  byteLength: { ...positiveBytes, maximum: INPUT_FILE_MAX_BYTES }, sha256: SHA256_HEX_SCHEMA,
} as const;
export const uploadFileDeclarationSchema = { type: 'object', additionalProperties: false,
  required: Object.keys(fileDeclarationProperties), properties: fileDeclarationProperties } as const;
export const uploadBatchCreateSchema = { type: 'object', additionalProperties: false,
  required: ['baseVersionId', 'files'], properties: {
    baseVersionId: nullableBase,
    files: { type: 'array', minItems: 2, maxItems: INPUT_MAX_REPORTS + 1, items: uploadFileDeclarationSchema },
  } } as const;

/** Receipt metadata only; binary bytes travel in the authenticated request/response body. */
export interface TransferPartDTO { readonly index: number; readonly size: number; readonly sha256: string }
const partProperties = {
  index: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
  size: { ...positiveBytes, maximum: TRANSFER_PART_MAX_BYTES }, sha256: SHA256_HEX_SCHEMA,
} as const;
export const transferPartSchema = { type: 'object', additionalProperties: false,
  required: ['index', 'size', 'sha256'], properties: partProperties } as const;

export interface UploadedFileDTO extends UploadFileDeclarationDTO {
  readonly id: UUID;
  readonly partCount: number;
  /** Only successfully registered parts are returned; missing parts remain resumable. */
  readonly parts: readonly TransferPartDTO[];
}
export interface UploadBatchDTO {
  readonly id: UUID;
  readonly workspaceId: UUID;
  readonly baseVersionId: UUID | null;
  readonly state: UploadBatchState;
  readonly partSize: typeof TRANSFER_PART_MAX_BYTES;
  readonly expiresAt: string;
  readonly files: readonly UploadedFileDTO[];
}
export const uploadedFileSchema = { type: 'object', additionalProperties: false,
  required: [...Object.keys(fileDeclarationProperties), 'id', 'partCount', 'parts'], properties: {
    ...fileDeclarationProperties, id: uuidSchema,
    partCount: { type: 'integer', minimum: 1, maximum: INPUT_FILE_MAX_PARTS },
    parts: { type: 'array', maxItems: INPUT_FILE_MAX_PARTS, items: { ...transferPartSchema,
      properties: { ...partProperties, index: { ...partProperties.index, maximum: INPUT_FILE_MAX_PARTS - 1 } } } },
  } } as const;
export const uploadBatchSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'workspaceId', 'baseVersionId', 'state', 'partSize', 'expiresAt', 'files'], properties: {
    id: uuidSchema, workspaceId: uuidSchema, baseVersionId: nullableBase, state: { enum: uploadBatchStates },
    partSize: { const: TRANSFER_PART_MAX_BYTES }, expiresAt: { type: 'string', format: 'date-time' },
    files: { type: 'array', minItems: 2, maxItems: INPUT_MAX_REPORTS + 1, items: uploadedFileSchema },
  } } as const;

export interface ExportManifestDTO {
  readonly artifactId: UUID;
  readonly intent: DownloadIntent;
  readonly filename: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly expiresAt: string;
  readonly parts: readonly TransferPartDTO[];
}
export const exportManifestSchema = { type: 'object', additionalProperties: false,
  required: ['artifactId', 'intent', 'filename', 'byteLength', 'sha256', 'expiresAt', 'parts'], properties: {
    artifactId: uuidSchema, intent: downloadIntentSchema, filename: displayName,
    byteLength: { ...positiveBytes, maximum: EXPORT_MAX_BYTES }, sha256: SHA256_HEX_SCHEMA,
    expiresAt: { type: 'string', format: 'date-time' },
    parts: { type: 'array', minItems: 1, maxItems: EXPORT_MAX_PARTS, items: { ...transferPartSchema,
      properties: { ...partProperties, index: { ...partProperties.index, maximum: EXPORT_MAX_PARTS - 1 } } } },
  } } as const;

export type UploadBatchDeclarationIssue = 'CATALOG_COUNT' | 'REPORT_COUNT' | 'DUPLICATE_CLIENT_FILE_ID' | 'BATCH_SIZE_EXCEEDED';
/** Cross-field constraints after schema validation, before reserving or accepting any bytes. */
export function uploadBatchDeclarationIssues(batch: UploadBatchCreateDTO): readonly UploadBatchDeclarationIssue[] {
  const issues: UploadBatchDeclarationIssue[] = [];
  if (batch.files.filter(file => file.role === 'catalog').length !== 1) issues.push('CATALOG_COUNT');
  const reports = batch.files.filter(file => file.role === 'report').length;
  if (reports < 1 || reports > INPUT_MAX_REPORTS) issues.push('REPORT_COUNT');
  if (new Set(batch.files.map(file => file.clientFileId)).size !== batch.files.length) issues.push('DUPLICATE_CLIENT_FILE_ID');
  if (batch.files.reduce((total, file) => total + file.byteLength, 0) > INPUT_BATCH_MAX_BYTES) issues.push('BATCH_SIZE_EXCEEDED');
  return issues;
}

/** Declared shape only: callers must authorize and verify each part and the whole-byte SHA-256. */
export function isCompleteTransferManifest(manifest: Pick<ExportManifestDTO, 'byteLength' | 'parts'>): boolean {
  const { byteLength, parts } = manifest;
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > EXPORT_MAX_BYTES
    || parts.length !== Math.ceil(byteLength / TRANSFER_PART_MAX_BYTES)) return false;
  return parts.every((part, index) => part.index === index
    && part.size === Math.min(TRANSFER_PART_MAX_BYTES, byteLength - index * TRANSFER_PART_MAX_BYTES));
}
