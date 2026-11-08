import type { JobStatus, ResultRef, UUID } from './common.js';
import { uuidSchema } from './common.schemas.js';
import type { DownloadIntent } from './download.js';
import { downloadIntentSchema } from './download.js';

/** Reserved identities are not evidence that a version or preview has been published. */
export interface RecalculationReservationDTO {
  readonly kind: 'recalculation';
  readonly inputVersionId: UUID;
  readonly effectiveVersionId: UUID;
  readonly reservedPreviewId: UUID;
}
export interface ExportReservationDTO {
  readonly kind: 'export'; readonly intent: DownloadIntent; readonly intentFingerprint: string; readonly reservedExportId: UUID;
}
export type OperationReservationDTO = RecalculationReservationDTO | ExportReservationDTO;
/** A compact, owner-authorized receipt. It never contains request bodies or credentials. */
export interface OperationReceiptDTO {
  readonly operationId: UUID;
  readonly workspaceId: UUID;
  readonly jobId: UUID;
  readonly responseStatus: 202 | 503;
  readonly phase: JobStatus | 'dispatch_pending';
  readonly reservation?: OperationReservationDTO;
  /** These fields are present only after successful atomic publication. */
  readonly resultRef?: ResultRef;
  readonly newVersionId?: UUID;
}
export const operationReservationSchema = { oneOf: [{
  type: 'object', additionalProperties: false,
  required: ['kind', 'inputVersionId', 'effectiveVersionId', 'reservedPreviewId'],
  properties: { kind: { const: 'recalculation' }, inputVersionId: uuidSchema, effectiveVersionId: uuidSchema, reservedPreviewId: uuidSchema },
}, { type: 'object', additionalProperties: false, required: ['kind', 'intent', 'intentFingerprint', 'reservedExportId'],
  properties: { kind: { const: 'export' }, intent: downloadIntentSchema, intentFingerprint: { type: 'string', pattern: '^[a-f0-9]{64}$' }, reservedExportId: uuidSchema },
}] } as const;
export const operationReceiptSchema = {
  type: 'object', additionalProperties: false,
  required: ['operationId', 'workspaceId', 'jobId', 'responseStatus', 'phase'],
  properties: {
    operationId: uuidSchema, workspaceId: uuidSchema, jobId: uuidSchema,
    responseStatus: { enum: [202, 503] }, phase: { enum: ['dispatch_pending', 'queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out'] },
    reservation: operationReservationSchema,
    resultRef: { type: 'object', additionalProperties: false, required: ['type', 'id'], properties: {
      type: { type: 'string', minLength: 1, maxLength: 100 }, id: { type: 'string', minLength: 1, maxLength: 200 },
    } }, newVersionId: uuidSchema,
  },
  allOf: [{ if: { type: 'object', properties: { phase: { const: 'succeeded' } }, required: ['phase'] },
    then: {}, else: { not: { anyOf: [{ type: 'object', required: ['resultRef'] }, { type: 'object', required: ['newVersionId'] }] } } }],
} as const;
