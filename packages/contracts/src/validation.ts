import type { DataType, Diagnostic, NormalizedValue, PresentationDTO, Rational, SourceLocator, ValidationBasisId } from './common.js';
import type { RecalculationPolicyDTO } from './profiles.js';
import type { Coordinate, FactDerivation } from './report.js';
import type { SourceFile } from './report.js';
import type { Severity } from './catalog.js';
import type { DirectionChoiceDTO } from './recalculation.js';
import { dateValueSchema, rationalSchema, sourceLocatorSchema, textValueSchema, uuidSchema, validationBasisIdSchema } from './common.schemas.js';
import { coordinateSchema } from './report.js';
import { diagnosticSchema } from './catalog.js';
export type ValidationStatus = 'pass' | 'fail' | 'not_applicable' | 'not_evaluable' | 'error';
export interface ValidationBinding { readonly contextId?: string; readonly contextIds?: readonly string[]; readonly tableCode?: string; readonly sheetCode?: string; readonly rowCode?: string; readonly columnCode?: string }
export type ValidationValueDTO = (
  | { readonly kind: 'number'; readonly nominal: Rational; readonly interval: { readonly lo: Rational; readonly hi: Rational }; readonly unit: string }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'date'; readonly value: string }
  | { readonly kind: 'null'; readonly presence: 'explicit_null' | 'implicit_null' | 'derived_null'; readonly dataType: DataType; readonly unit?: string }
  | { readonly kind: 'unknown'; readonly presence: 'unknown' }
) & { readonly coordinate?: Coordinate; readonly sourceLocator?: SourceLocator };
export interface MetadataReadDTO { readonly contextId: string; readonly code: string; readonly presence: 'declared' | 'missing'; readonly value?: boolean; readonly sourceLocator?: SourceLocator }
/** Original snapshot input, before selection-specific default and interval options. */
export interface FactReadDTO {
  readonly factKey: string; readonly coordinate: Coordinate; readonly presence: 'value' | 'explicit_null' | 'implicit_null';
  readonly normalizedValue?: NormalizedValue; readonly originalText?: string; readonly sourceLocator: SourceLocator; readonly derivation?: FactDerivation;
}
export interface RuleResultDTO {
  readonly presentation?: PresentationDTO;
  readonly id: string; readonly runId: string; readonly versionId: string; readonly profileId: string;
  readonly instanceId?: string; readonly coverageOnly: boolean; readonly binding?: ValidationBinding; readonly contextId?: string;
  readonly code: string; readonly variantIds: readonly string[]; readonly sourceRecordIds: readonly string[]; readonly tables: readonly string[];
  readonly status: ValidationStatus; readonly severity: Severity; readonly severityOriginal: string;
  readonly expression: string; readonly precondition?: string; readonly preconditionResult?: ValidationValueDTO;
  readonly values: { readonly left?: ValidationValueDTO; readonly right?: ValidationValueDTO; readonly result?: ValidationValueDTO };
  readonly readKeys: readonly string[]; readonly factReads: readonly FactReadDTO[]; readonly metadataReads: readonly MetadataReadDTO[];
  readonly sources: readonly SourceLocator[]; readonly diagnostics: readonly Diagnostic[];
  readonly recalculation?: { readonly left: DirectionEligibilityDTO; readonly right: DirectionEligibilityDTO; readonly policy?: RecalculationPolicyDTO };
}
const trace = { coordinate: coordinateSchema, sourceLocator: sourceLocatorSchema } as const;
export const validationValueSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['kind', 'nominal', 'interval', 'unit'], properties: { ...trace, kind: { const: 'number' }, nominal: rationalSchema,
    interval: { type: 'object', additionalProperties: false, required: ['lo', 'hi'], properties: { lo: rationalSchema, hi: rationalSchema } }, unit: { type: 'string' } } },
  { type: 'object', additionalProperties: false, required: ['kind', 'value'], properties: { ...trace, kind: { const: 'boolean' }, value: { type: 'boolean' } } },
  { ...textValueSchema, properties: { ...textValueSchema.properties, ...trace } },
  { ...dateValueSchema, properties: { ...dateValueSchema.properties, ...trace } },
  { type: 'object', additionalProperties: false, required: ['kind', 'presence', 'dataType'], properties: { ...trace, kind: { const: 'null' }, presence: { enum: ['explicit_null', 'implicit_null', 'derived_null'] }, dataType: { enum: ['number', 'boolean', 'text', 'date'] }, unit: { type: 'string' } },
    allOf: [{ if: { type: 'object', properties: { dataType: { enum: ['text', 'date'] } } }, then: { type: 'object', properties: { unit: { const: '' } } } }] },
  { type: 'object', additionalProperties: false, required: ['kind', 'presence'], properties: { ...trace, kind: { const: 'unknown' }, presence: { const: 'unknown' } } },
] } as const;
/** Optional, request-scoped eligibility metadata; it never changes the validation result. */
export interface DirectionEligibilityDTO { readonly eligible: boolean; readonly target?: Coordinate; readonly diagnostics: readonly Diagnostic[] }
export interface ValidationSummary {
  readonly complete: boolean; readonly rows: number; readonly variants: number; readonly applicableVariants: number;
  readonly instances: number; readonly duplicateRows: number; readonly byStatus: Readonly<Record<ValidationStatus, number>>;
}
export interface ValidationRunDTO {
  readonly id: string; readonly versionId: string; readonly profileId: string; readonly status: 'running' | 'completed' | 'incomplete';
  /** Legacy runs without a basis remain compatible only with their exact version. */
  readonly validationBasisId?: ValidationBasisId;
  readonly startedAt: string; readonly endedAt?: string; readonly summary: ValidationSummary; readonly resultIds: readonly string[];
  readonly diagnostics: readonly Diagnostic[];
}
export interface ValidationBundle { readonly run: ValidationRunDTO; readonly results: readonly RuleResultDTO[] }
export interface ValidationResultsQueryDTO {
  readonly limit?: string; readonly cursor?: string; readonly status?: ValidationStatus;
  readonly code?: string; readonly table?: string; readonly includeConfiguredDirections?: 'true' | 'false';
}
export interface ValidationResultsPageDTO { readonly items: readonly RuleResultDTO[]; readonly total: number; readonly nextCursor: string | null; readonly versionId: string; readonly run: ValidationRunDTO; readonly sourceFiles?: readonly SourceFile[]; readonly configuredDirections?: readonly DirectionChoiceDTO[] }
const count = { type: 'integer', minimum: 0 } as const;
export const validationSummarySchema = { type: 'object', additionalProperties: false,
  required: ['complete', 'rows', 'variants', 'applicableVariants', 'instances', 'duplicateRows', 'byStatus'], properties: {
    complete: { type: 'boolean' }, rows: count, variants: count, applicableVariants: count, instances: count, duplicateRows: count,
    byStatus: { type: 'object', additionalProperties: false, required: ['pass', 'fail', 'not_applicable', 'not_evaluable', 'error'], properties: {
      pass: count, fail: count, not_applicable: count, not_evaluable: count, error: count,
    } },
  } } as const;
export const validationRunSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'versionId', 'profileId', 'status', 'startedAt', 'summary', 'resultIds', 'diagnostics'], properties: {
    id: uuidSchema, versionId: uuidSchema, validationBasisId: validationBasisIdSchema, profileId: { type: 'string' }, status: { enum: ['running', 'completed', 'incomplete'] },
    startedAt: { type: 'string', format: 'date-time' }, endedAt: { type: 'string', format: 'date-time' }, summary: validationSummarySchema,
    resultIds: { type: 'array', items: { type: 'string' } }, diagnostics: { type: 'array', items: diagnosticSchema },
  } } as const;
