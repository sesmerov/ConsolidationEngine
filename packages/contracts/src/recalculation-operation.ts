import { uuidSchema } from './common.schemas.js';
import { directionConflictPageQuerySchema, directionReviewRowsQuerySchema } from './direction-review.js';
export interface RecalculationReviewPrepareDTO { readonly baseVersionId: string; readonly validationBasisId: string; readonly runId: string }
export interface RecalculationOperationDTO extends RecalculationReviewPrepareDTO { readonly reviewId: string; readonly expectedRevision: number }
export type RecalculationOperationRequestDTO = RecalculationOperationDTO;
export interface RecalculationOperationAcceptedDTO {
  readonly operationId: string; readonly jobId: string; readonly inputVersionId: string;
  readonly effectiveVersionId: string; readonly reservedPreviewId: string;
}
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const inputs = { baseVersionId: uuidSchema, validationBasisId: uuidSchema, runId: uuidSchema };
export const recalculationReviewPrepareSchema = closed(inputs);
export const recalculationOperationSchema = closed({ ...inputs, reviewId: uuidSchema, expectedRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } });
export const recalculationOperationAcceptedSchema = closed(Object.fromEntries(['operationId', 'jobId', 'inputVersionId', 'effectiveVersionId', 'reservedPreviewId'].map(key => [key, uuidSchema])));
const page = { limit: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$' }, scope: { enum: ['pending', 'resolved', 'all'] } };
export const recalculationReviewRowsQuerySchema = closed({ ...directionReviewRowsQuerySchema.properties, ...page }, []);
export const recalculationReviewGroupsQuerySchema = closed({ ...directionConflictPageQuerySchema.properties, ...page }, []);
export const recalculationReviewCandidatesQuerySchema = closed({ ...directionConflictPageQuerySchema.properties, limit: page.limit }, []);
