import type { Rational, SourceLocator } from './common.js';
import type { SourceFile } from './report.js';
import type { FactReadDTO, MetadataReadDTO, RuleResultDTO, ValidationSummary } from './validation.js';
import { validationRunSchema, validationValueSchema } from './validation.js';
import type { ProposalAfterDTO } from './recalculation.js';
import { presentationSchema, rationalSchema, sourceLocatorSchema, uuidSchema } from './common.schemas.js';
import { recalculationPolicySchema } from './profiles.js';
import { coordinateSchema, sourceFileSchema } from './report.js';
import { bindingSchema, directionChoiceSchema, factReadSchema, metadataReadsSchema, proposalSchema } from './recalculation.js';
import { diagnosticSchema } from './catalog.js';

export interface ApplicationRequestDTO { readonly baseVersionId: string; readonly previewId: string; readonly selectedIds: readonly string[]; readonly closureHash: string }
/** A functional receipt exists only after one atomic publication, never while a candidate is being accepted. */
export interface ApplyReceiptDTO {
  readonly id: string; readonly previewId: string; readonly acceptedIds: readonly string[]; readonly closureHash: string;
  readonly baseVersionId: string; readonly newVersionId: string; readonly beforeValidationRunId: string; readonly validationRunId: string; readonly appliedAt: string;
}
interface ApplyChangeBase {
  readonly changed: boolean;
  readonly receiptId: string; readonly proposalId: string; readonly directionId: string; readonly instanceId: string; readonly variantIds: readonly string[];
  readonly code: string; readonly targetKey: string; readonly before: FactReadDTO; readonly readKeys: readonly string[]; readonly predecessorIds: readonly string[];
  readonly metadataReads: readonly MetadataReadDTO[]; readonly sources: readonly SourceLocator[];
}
export type ApplyChangeDTO = ApplyChangeBase & (
  | { readonly after: Extract<ProposalAfterDTO, { readonly decimals: string }>; readonly exactNominal: Rational; readonly derivedInterval: { readonly lo: Rational; readonly hi: Rational }; readonly policyId: string }
  | { readonly after: Extract<ProposalAfterDTO, { readonly normalizedValue: boolean }>; readonly exactNominal?: never; readonly derivedInterval?: never; readonly policyId?: never }
);
/** Stored separately from the two validation bundles to retain shared immutable data. */
export interface ApplicationBundle { readonly receipt: ApplyReceiptDTO; readonly changes: readonly ApplyChangeDTO[] }
export interface ApplicationDetailDTO { readonly receipt: ApplyReceiptDTO; readonly changeCount: number; readonly beforeSummary: ValidationSummary; readonly afterSummary: ValidationSummary }
export interface ComparisonRowDTO { readonly key: string; readonly before?: RuleResultDTO; readonly after?: RuleResultDTO }
export interface ComparisonPageDTO {
  readonly items: readonly ComparisonRowDTO[]; readonly total: number; readonly nextCursor: string | null;
  readonly receipt: ApplyReceiptDTO; readonly beforeSummary: ValidationSummary; readonly afterSummary: ValidationSummary; readonly sourceFiles?: readonly SourceFile[];
}
const text = { type: 'string' } as const, hash = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const, count = { type: 'integer', minimum: 0 } as const;
const texts = { type: 'array', items: text, uniqueItems: true } as const, hashes = { type: 'array', items: hash, uniqueItems: true } as const;
const uuids = { type: 'array', items: uuidSchema, uniqueItems: true } as const, accepted = { ...uuids, minItems: 1, maxItems: 1_000_000 } as const;
const diagnostics = { type: 'array', items: diagnosticSchema } as const;
export const applicationRequestSchema = { type: 'object', additionalProperties: false, required: ['baseVersionId', 'previewId', 'selectedIds', 'closureHash'], properties: {
  baseVersionId: uuidSchema, previewId: uuidSchema, selectedIds: accepted, closureHash: hash,
} } as const;
export const applyReceiptSchema = { type: 'object', additionalProperties: false, required: ['id', 'previewId', 'acceptedIds', 'closureHash', 'baseVersionId', 'newVersionId', 'beforeValidationRunId', 'validationRunId', 'appliedAt'], properties: {
  id: uuidSchema, previewId: uuidSchema, acceptedIds: accepted, closureHash: hash, baseVersionId: uuidSchema, newVersionId: uuidSchema,
  beforeValidationRunId: uuidSchema, validationRunId: uuidSchema, appliedAt: { type: 'string', format: 'date-time' },
} } as const;
export const applyChangeSchema = { type: 'object', additionalProperties: false,
  required: ['changed', 'receiptId', 'proposalId', 'directionId', 'instanceId', 'variantIds', 'code', 'targetKey', 'before', 'after', 'readKeys', 'predecessorIds', 'metadataReads', 'sources'], properties: {
    changed: { type: 'boolean' },
    receiptId: uuidSchema, proposalId: uuidSchema, directionId: hash, instanceId: hash, variantIds: hashes, code: text, targetKey: text,
    before: factReadSchema, after: proposalSchema.properties.after, exactNominal: rationalSchema, derivedInterval: proposalSchema.properties.derivedInterval, policyId: text,
    readKeys: texts, predecessorIds: uuids, metadataReads: metadataReadsSchema, sources: { type: 'array', items: sourceLocatorSchema },
  }, allOf: [{ if: { type: 'object', properties: { after: { type: 'object', properties: { normalizedValue: { type: 'boolean' } } } } },
    then: { not: { anyOf: [{ type: 'object', required: ['exactNominal'] }, { type: 'object', required: ['derivedInterval'] }, { type: 'object', required: ['policyId'] }] } }, else: { type: 'object', required: ['exactNominal', 'derivedInterval', 'policyId'] } }] } as const;
export const applicationBundleSchema = { type: 'object', additionalProperties: false, required: ['receipt', 'changes'], properties: { receipt: applyReceiptSchema, changes: { type: 'array', minItems: 1, items: applyChangeSchema } } } as const;
export const completedValidationSummarySchema = { type: 'object', additionalProperties: false, required: ['complete', 'rows', 'variants', 'applicableVariants', 'instances', 'duplicateRows', 'byStatus'], properties: {
  complete: { const: true }, rows: count, variants: count, applicableVariants: count, instances: count, duplicateRows: count,
  byStatus: { type: 'object', additionalProperties: false, required: ['pass', 'fail', 'not_applicable', 'not_evaluable', 'error'], properties: { pass: count, fail: count, not_applicable: count, not_evaluable: count, error: count } },
} } as const;
export const applicationDetailSchema = { type: 'object', additionalProperties: false, required: ['receipt', 'changeCount', 'beforeSummary', 'afterSummary'], properties: {
  receipt: applyReceiptSchema, changeCount: count, beforeSummary: completedValidationSummarySchema, afterSummary: completedValidationSummarySchema,
} } as const;
const eligibilitySchema = { type: 'object', additionalProperties: false, required: ['eligible', 'diagnostics'], properties: { eligible: { type: 'boolean' }, target: coordinateSchema, diagnostics } } as const;
export const ruleResultSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'runId', 'versionId', 'profileId', 'coverageOnly', 'code', 'variantIds', 'sourceRecordIds', 'tables', 'status', 'severity', 'severityOriginal', 'expression', 'values', 'readKeys', 'factReads', 'metadataReads', 'sources', 'diagnostics'], properties: {
    id: text, runId: uuidSchema, versionId: uuidSchema, profileId: text, instanceId: hash, coverageOnly: { type: 'boolean' }, binding: bindingSchema, contextId: text,
    code: text, variantIds: hashes, sourceRecordIds: texts, tables: texts, status: { enum: ['pass', 'fail', 'not_applicable', 'not_evaluable', 'error'] }, severity: { enum: ['error', 'warning', 'unknown'] }, severityOriginal: text,
    expression: text, precondition: text, preconditionResult: validationValueSchema, values: { type: 'object', additionalProperties: false, properties: { left: validationValueSchema, right: validationValueSchema, result: validationValueSchema } },
    readKeys: texts, factReads: { type: 'array', items: factReadSchema }, metadataReads: metadataReadsSchema, sources: { type: 'array', items: sourceLocatorSchema }, diagnostics,
    recalculation: { type: 'object', additionalProperties: false, required: ['left', 'right'], properties: { left: eligibilitySchema, right: eligibilitySchema, policy: recalculationPolicySchema } },
    presentation: presentationSchema,
  } } as const;
export const comparisonRowSchema = { type: 'object', additionalProperties: false, required: ['key'], properties: { key: text, before: ruleResultSchema, after: ruleResultSchema }, anyOf: [{ type: 'object', required: ['before'] }, { type: 'object', required: ['after'] }] } as const;
/** Closed response shape: internal snapshots and AST cannot pass through object spreading. */
export const validationResultsPageSchema = { type: 'object', additionalProperties: false,
  required: ['items', 'total', 'nextCursor', 'versionId', 'run'], properties: {
    items: { type: 'array', items: ruleResultSchema }, total: count, nextCursor: { type: ['string', 'null'] }, versionId: uuidSchema,
    run: validationRunSchema, sourceFiles: { type: 'array', items: sourceFileSchema },
    configuredDirections: { type: 'array', items: directionChoiceSchema },
  } } as const;
export const comparisonPageSchema = { type: 'object', additionalProperties: false, required: ['items', 'total', 'nextCursor', 'receipt', 'beforeSummary', 'afterSummary'], properties: {
  items: { type: 'array', items: comparisonRowSchema }, total: count, nextCursor: { type: ['string', 'null'] }, receipt: applyReceiptSchema,
  beforeSummary: completedValidationSummarySchema, afterSummary: completedValidationSummarySchema, sourceFiles: { type: 'array', items: sourceFileSchema },
} } as const;
export const changedOnlyQuerySchema = { type: 'string', enum: ['true', 'false'] } as const;
