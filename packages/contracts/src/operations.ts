import type { JobStatus, ResultRef, UUID } from './common.js';
import { uuidSchema } from './common.schemas.js';

/** Reserved identities are not evidence that a version or preview has been published. */
export interface RecalculationReservationDTO {
  readonly kind: 'recalculation';
  readonly inputVersionId: UUID;
  readonly effectiveVersionId: UUID;
  readonly reservedPreviewId: UUID;
}
export type OperationReservationDTO = RecalculationReservationDTO;
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
export const operationReservationSchema = {
  type: 'object', additionalProperties: false,
  required: ['kind', 'inputVersionId', 'effectiveVersionId', 'reservedPreviewId'],
  properties: { kind: { const: 'recalculation' }, inputVersionId: uuidSchema, effectiveVersionId: uuidSchema, reservedPreviewId: uuidSchema },
} as const;
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
  allOf: [{ if: { properties: { phase: { const: 'succeeded' } }, required: ['phase'] },
    then: {}, else: { not: { anyOf: [{ required: ['resultRef'] }, { required: ['newVersionId'] }] } } }],
} as const;
