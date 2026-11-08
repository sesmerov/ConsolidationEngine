import type { DirectionReviewCountsDTO, DirectionReviewSummaryDTO } from './direction-review.js';
import { directionReviewCountsSchema, directionReviewSummarySchema } from './direction-review.js';
import { uuidSchema } from './common.schemas.js';

export type RecalculationState = 'needs_validation' | 'no_candidates' | 'preparation_required' | 'pending' | 'ready';
export interface RecalculationStateDTO {
  readonly workspaceId: string; readonly currentVersionId: string; readonly validationBasisId: string;
  readonly compatibleRun?: { readonly id: string; readonly versionId: string; readonly validationBasisId: string; readonly endedAt?: string };
  readonly configuration: { readonly configVersion: string; readonly directionCount: number };
  readonly review?: DirectionReviewSummaryDTO;
  /** Unknown until the current immutable inputs have been classified by a preparation job. */
  readonly counts: DirectionReviewCountsDTO | null;
  readonly state: RecalculationState;
}
const closed = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
export const recalculationStateSchema = closed({
  workspaceId: uuidSchema, currentVersionId: uuidSchema, validationBasisId: uuidSchema,
  compatibleRun: closed({ id: uuidSchema, versionId: uuidSchema, validationBasisId: uuidSchema, endedAt: { type: 'string', format: 'date-time' } }, ['id', 'versionId', 'validationBasisId']),
  configuration: closed({ configVersion: { type: 'string' }, directionCount: { type: 'integer', minimum: 0 } }),
  review: directionReviewSummarySchema, counts: { anyOf: [directionReviewCountsSchema, { type: 'null' }] },
  state: { enum: ['needs_validation', 'no_candidates', 'preparation_required', 'pending', 'ready'] },
}, ['workspaceId', 'currentVersionId', 'validationBasisId', 'configuration', 'counts', 'state']);
