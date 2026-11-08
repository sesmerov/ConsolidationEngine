import type { UUID } from './common.js';
import { uuidSchema } from './common.schemas.js';
import { PUBLIC_JSON_MAX_BYTES, PUBLIC_PAGE_MAX_ITEMS } from './compact.js';
import { INPUT_FILE_MAX_BYTES, INPUT_BATCH_MAX_BYTES, INPUT_EXPANDED_MAX_BYTES,
  INPUT_MAX_REPORTS, TRANSFER_PART_MAX_BYTES, EXPORT_MAX_BYTES } from './transfers.js';

export const DEMO_SECRET_BYTES = 32;
/** A 32-byte unpadded base64url encoding has 43 characters and two unused zero bits at the end. */
export const sessionSecretSchema = { type: 'string', minLength: 43, maxLength: 43,
  pattern: '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$' } as const;
export interface CreateDemoSessionDTO { readonly creationNonce: string }
export const createDemoSessionSchema = { type: 'object', additionalProperties: false,
  required: ['creationNonce'], properties: { creationNonce: sessionSecretSchema } } as const;

export const demoSessionStates = ['active', 'revoked', 'expired', 'cleanup_pending', 'deleted'] as const;
export type DemoSessionState = typeof demoSessionStates[number];
/** Public metadata only. Token/nonce/hash and provider credentials never belong in a response. */
export interface DemoSessionDTO {
  readonly id: UUID;
  readonly state: DemoSessionState;
  readonly createdAt: string;
  readonly lastMeaningfulActivityAt: string;
  readonly expiresAt: string;
  readonly absoluteExpiresAt: string;
  readonly revokedAt?: string;
  readonly activeWorkspaceId?: UUID;
}
const timestamp = { type: 'string', format: 'date-time' } as const;
export const demoSessionSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'state', 'createdAt', 'lastMeaningfulActivityAt', 'expiresAt', 'absoluteExpiresAt'], properties: {
    id: uuidSchema, state: { enum: demoSessionStates }, createdAt: timestamp, lastMeaningfulActivityAt: timestamp,
    expiresAt: timestamp, absoluteExpiresAt: timestamp, revokedAt: timestamp, activeWorkspaceId: uuidSchema,
  } } as const;

export interface DemoPublicLimitsDTO {
  readonly maxFileBytes: number;
  readonly maxBatchBytes: number;
  readonly maxExpandedBytes: number;
  readonly maxReports: number;
  readonly maxExportBytes: number;
  readonly maxStateBytes: number;
  readonly maxStoredFileBytes: number;
  readonly maxSnapshots: number;
  readonly jsonBytes: number;
  readonly partBytes: number;
  readonly pageSize: number;
  readonly idleTimeoutMs: number;
  readonly absoluteTimeoutMs: number;
  readonly cleanupDeadlineMs: number;
  readonly maxActiveSessions: number;
  readonly maxCreationsPerDay: number;
  readonly maxQueuedJobs: number;
  readonly maxJobsPerDay: number;
  readonly maxJobsPer30Days: number;
}
/** Admission defaults, not proof of capacity or an instruction to auto-upgrade a provider. */
export const DEFAULT_DEMO_LIMITS = Object.freeze({
  maxFileBytes: INPUT_FILE_MAX_BYTES, maxBatchBytes: INPUT_BATCH_MAX_BYTES, maxExpandedBytes: INPUT_EXPANDED_MAX_BYTES,
  maxReports: INPUT_MAX_REPORTS, maxExportBytes: EXPORT_MAX_BYTES,
  maxStateBytes: 512 * 1024 * 1024, maxStoredFileBytes: 512 * 1024 * 1024, maxSnapshots: 20,
  jsonBytes: PUBLIC_JSON_MAX_BYTES, partBytes: TRANSFER_PART_MAX_BYTES, pageSize: PUBLIC_PAGE_MAX_ITEMS,
  idleTimeoutMs: 60 * 60_000, absoluteTimeoutMs: 24 * 60 * 60_000, cleanupDeadlineMs: 24 * 60 * 60_000,
  maxActiveSessions: 4, maxCreationsPerDay: 10, maxQueuedJobs: 8, maxJobsPerDay: 30, maxJobsPer30Days: 120,
} satisfies DemoPublicLimitsDTO);
const finitePositive = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } as const;
export const demoPublicLimitsSchema = { type: 'object', additionalProperties: false,
  required: Object.keys(DEFAULT_DEMO_LIMITS), properties: {
    ...Object.fromEntries(Object.keys(DEFAULT_DEMO_LIMITS).map(key => [key, finitePositive])),
    // Explicit session/admission configuration is allowed; these business/transport limits remain fixed.
    maxFileBytes: { const: INPUT_FILE_MAX_BYTES }, maxBatchBytes: { const: INPUT_BATCH_MAX_BYTES },
    maxExpandedBytes: { const: INPUT_EXPANDED_MAX_BYTES }, maxReports: { const: INPUT_MAX_REPORTS },
    maxExportBytes: { const: EXPORT_MAX_BYTES }, maxStateBytes: { const: 512 * 1024 * 1024 },
    maxStoredFileBytes: { const: 512 * 1024 * 1024 }, maxSnapshots: { const: 20 },
    jsonBytes: { const: PUBLIC_JSON_MAX_BYTES }, partBytes: { const: TRANSFER_PART_MAX_BYTES }, pageSize: { const: PUBLIC_PAGE_MAX_ITEMS },
  } } as const;

export interface HostedBootstrapDTO {
  readonly mode: 'hosted';
  readonly apiVersion: 'v1';
  readonly deploymentProfile?: string;
  readonly limits: DemoPublicLimitsDTO;
}
export const hostedBootstrapSchema = { type: 'object', additionalProperties: false,
  required: ['mode', 'apiVersion', 'limits'], properties: {
    mode: { const: 'hosted' }, apiVersion: { const: 'v1' },
    deploymentProfile: { type: 'string', minLength: 1, maxLength: 100 }, limits: demoPublicLimitsSchema,
  } } as const;
