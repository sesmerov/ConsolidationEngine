import type { TargetSide } from './recalculation.js';
import { uuidSchema, workspaceParamsSchema } from './common.schemas.js';

export type DirectionOrigin = 'automatic' | 'explicit' | 'previous';
export type DirectionDecisionState =
  | { readonly schemaVersion: 1; readonly mode: 'new' }
  | {
    readonly schemaVersion: 1; readonly mode: 'reviewed'; readonly source: 'review' | 'replace';
    readonly originDefault: DirectionOrigin;
    readonly originExceptions: readonly { readonly instanceId: string; readonly origin: DirectionOrigin }[];
    readonly unselectedDefault: 'pending' | 'omitted'; readonly unselectedExceptions: readonly string[];
  };

const states = ['preparing', 'ready', 'committing', 'committed', 'discarded', 'expired', 'obsolete', 'failed'] as const;
export const directionReviewDecisions = ['included', 'omitted', 'pending', 'conflicted', 'excluded', 'undetermined'] as const;
const classes = ['singleLeft', 'singleRight', 'both', 'none', 'undetermined'] as const;
export type DirectionReviewState = typeof states[number];
export type DirectionReviewDecision = typeof directionReviewDecisions[number];
export type DirectionReviewClass = typeof classes[number];
export type DirectionReviewCountsDTO = Readonly<Record<DirectionReviewDecision | 'totalRows', number>>;
export interface DirectionReviewReceiptDTO {
  readonly reviewId: string; readonly runId: string; readonly baseVersionId: string; readonly newVersionId: string;
  readonly configVersion: string; readonly included: number;
}
export interface DirectionReviewSummaryDTO {
  readonly id: string; readonly workspaceId: string; readonly baseVersionId: string; readonly runId: string;
  readonly state: DirectionReviewState; readonly revision: number; readonly jobId?: string;
  readonly readyAt?: string; readonly expiresAt?: string; readonly counts?: DirectionReviewCountsDTO;
  readonly conflictGroupCount?: number; readonly receipt?: DirectionReviewReceiptDTO;
}
export interface DirectionReviewRowDTO {
  readonly rowId: string; readonly code: string; readonly location: string; readonly contextLabel: string;
  readonly classification: DirectionReviewClass; readonly state: DirectionReviewDecision;
  readonly options: readonly { readonly side: TargetSide; readonly label: string }[];
  readonly reasons: readonly { readonly code: string; readonly message: string }[];
  readonly instanceId?: string; readonly selectedSide?: TargetSide; readonly origin?: 'automatic' | 'manual' | 'saved';
  readonly groupId?: string; readonly producerCount?: number;
}
export interface DirectionReviewPrepareDTO { readonly baseVersionId: string; readonly runId: string }
export interface DirectionReviewCommitDTO { readonly expectedRevision: number; readonly acceptPartial: boolean }
export type DirectionReviewOperationDTO =
  | { readonly op: 'set'; readonly instanceId: string; readonly choice: TargetSide | 'omit' | 'suggest' }
  | { readonly op: 'resolveGroup'; readonly groupId: string; readonly winnerInstanceId: string | null }
  | { readonly op: 'omitAll' };
export interface DirectionReviewPatchDTO {
  readonly expectedRevision: number; readonly mutationId: string; readonly operations: readonly DirectionReviewOperationDTO[];
}
export interface DirectionReviewActiveDTO { readonly active: DirectionReviewSummaryDTO | null; readonly latestCommit?: DirectionReviewReceiptDTO }
export interface DirectionReviewMutationResponseDTO { readonly summary: DirectionReviewSummaryDTO; readonly appliedRevision: number }
export interface DirectionReviewPageDTO {
  readonly reviewId: string; readonly revision: number; readonly items: readonly DirectionReviewRowDTO[];
  readonly total: number; readonly nextCursor: string | null;
}

const closed = (properties: Record<string, unknown>, required: readonly string[] = Object.keys(properties)) => ({
  type: 'object', additionalProperties: false, properties, required,
});
const digest = { type: 'string', pattern: '^[0-9a-f]{64}$' };
const revision = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const count = { type: 'integer', minimum: 0, maximum: 1_000_000 };
const side = { enum: ['left', 'right'] };
const label = { type: 'string', maxLength: 2048 };
const receipt = closed({ reviewId: uuidSchema, runId: uuidSchema, baseVersionId: uuidSchema, newVersionId: uuidSchema, configVersion: digest, included: count });
const counts = closed(Object.fromEntries(['totalRows', ...directionReviewDecisions].map(key => [key, count])));
export const directionReviewSummarySchema = closed({
  id: uuidSchema, workspaceId: uuidSchema, baseVersionId: uuidSchema, runId: uuidSchema, state: { enum: states },
  revision: { ...revision, minimum: 0 }, jobId: uuidSchema, readyAt: { type: 'string', format: 'date-time' }, expiresAt: { type: 'string', format: 'date-time' },
  counts, conflictGroupCount: count, receipt,
}, ['id', 'workspaceId', 'baseVersionId', 'runId', 'state', 'revision']);
const row = closed({
  rowId: digest, code: { type: 'string', maxLength: 32767 }, location: label, contextLabel: label,
  classification: { enum: classes }, state: { enum: directionReviewDecisions },
  options: { type: 'array', maxItems: 2, items: closed({ side, label }) },
  reasons: { type: 'array', maxItems: 8, items: closed({ code: { type: 'string', maxLength: 128 }, message: label }) },
  instanceId: digest, selectedSide: side, origin: { enum: ['automatic', 'manual', 'saved'] }, groupId: digest, producerCount: count,
}, ['rowId', 'code', 'location', 'contextLabel', 'classification', 'state', 'options', 'reasons']);

export const directionReviewCollectionParamsSchema = workspaceParamsSchema;
export const directionReviewParamsSchema = closed({ workspaceId: uuidSchema, reviewId: uuidSchema });
export const directionReviewPrepareSchema = closed({ baseVersionId: uuidSchema, runId: uuidSchema });
export const directionReviewCommitSchema = closed({ expectedRevision: revision, acceptPartial: { type: 'boolean' } });
export const directionReviewPatchSchema = closed({
  expectedRevision: revision, mutationId: uuidSchema, operations: {
    type: 'array', minItems: 1, maxItems: 200, items: {
      oneOf: [
        closed({ op: { const: 'set' }, instanceId: digest, choice: { enum: ['left', 'right', 'omit', 'suggest'] } }),
        closed({ op: { const: 'resolveGroup' }, groupId: digest, winnerInstanceId: { anyOf: [digest, { type: 'null' }] } }),
        closed({ op: { const: 'omitAll' } }),
      ]
    }
  },
});
export const directionReviewRowsQuerySchema = closed({
  limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' },
  cursor: { type: 'string', minLength: 1, maxLength: 8192 }, state: { enum: directionReviewDecisions }, groupId: digest,
}, []);
export const directionReviewPageSchema = closed({
  reviewId: uuidSchema, revision, items: { type: 'array', maxItems: 200, items: row }, total: count, nextCursor: { anyOf: [{ type: 'string', maxLength: 8192 }, { type: 'null' }] },
});
export const directionReviewActiveSchema = closed({
  active: { anyOf: [directionReviewSummarySchema, { type: 'null' }] }, latestCommit: receipt,
}, ['active']);
export const directionReviewMutationResponseSchema = closed({ summary: directionReviewSummarySchema, appliedRevision: revision });
