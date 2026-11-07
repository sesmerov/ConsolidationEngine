import type { Diagnostic, PresentationDTO, Rational, SourceFile, SourceLocator } from './common.js';
import type { FactReadDTO, MetadataReadDTO, ValidationBinding, ValidationValueDTO } from './validation.js';
import { validationValueSchema } from './validation.js';
import { normalizedValueSchema, presentationSchema, rationalSchema, sourceLocatorSchema, uuidSchema } from './common.schemas.js';
import { coordinateSchema, factDerivationSchema, sourceFileSchema } from './report.js';
import { diagnosticSchema } from './catalog.js';

export const RECALCULATION_POLICY_ID = 'half-even-v1' as const;
export type TargetSide = 'left' | 'right';
/** Server-resolved identity. HTTP callers choose only instanceId and targetSide. */
export interface DirectionDTO {
  readonly id: string; readonly instanceId: string; readonly variantIds: readonly string[];
  readonly binding: ValidationBinding; readonly targetSide: TargetSide; readonly targetKey: string;
}
export interface DirectionChoiceDTO { readonly instanceId: string; readonly targetSide: TargetSide }
export interface DirectionsRequestDTO { readonly directions: readonly DirectionChoiceDTO[] }
export interface DirectionsResponseDTO { readonly versionId: string; readonly configVersion: string; readonly directions: readonly DirectionDTO[] }
export type PreviewState = 'ready' | 'applied' | 'discarded' | 'obsolete';
export type ProposalState = 'available' | 'blocked' | 'accepted' | 'applied' | 'discarded' | 'obsolete';
export interface ProducerConflictDTO { readonly targetKey: string; readonly producerIds: readonly string[] }
export interface GraphSummaryDTO {
  readonly nodes: number; readonly edges: number; readonly order: readonly string[];
  readonly conflicts: readonly ProducerConflictDTO[]; readonly cycles: readonly (readonly string[])[]; readonly blocked: number;
}
export interface PreviewDTO {
  readonly id: string; readonly baseVersionId: string; readonly profileId: string; readonly policyId: string;
  readonly createdAt: string;
  readonly appliedReceiptId?: string;
  readonly state: PreviewState; readonly proposalIds: readonly string[]; readonly graphSummary: GraphSummaryDTO;
  readonly diagnostics: readonly Diagnostic[];
}
export interface CompactPreviewDTO extends Omit<PreviewDTO, 'proposalIds' | 'graphSummary' | 'diagnostics'> {
  readonly graphSummary: { readonly nodes: number; readonly edges: number; readonly blocked: number; readonly conflictCount: number; readonly cycleCount: number };
  readonly diagnosticCount: number;
}
/** Consumers read this quantized value and its destination precision, never exactNominal. */
export type ProposalAfterDTO =
  | { readonly normalizedValue: Rational; readonly originalText: string; readonly decimals: string; readonly unit: string }
  | { readonly normalizedValue: boolean; readonly originalText: 'true' | 'false' };
export interface ProposalCalculationDTO {
  readonly expression: string; readonly precondition?: string;
  readonly sourceValue?: ValidationValueDTO; readonly preconditionValue?: ValidationValueDTO;
  readonly reads: readonly { readonly fact: FactReadDTO; readonly fromProposalId?: string }[];
}
export interface ProposalDTO {
  readonly presentation?: PresentationDTO;
  /** Retained simulation evidence. Only detail responses include it. */
  readonly calculation?: ProposalCalculationDTO;
  readonly id: string; readonly previewId: string; readonly directionId: string; readonly instanceId: string;
  readonly variantIds: readonly string[]; readonly binding: ValidationBinding; readonly code: string; readonly targetKey: string;
  readonly before?: FactReadDTO; readonly exactNominal?: Rational; readonly derivedInterval?: { readonly lo: Rational; readonly hi: Rational };
  readonly after?: ProposalAfterDTO; readonly readKeys: readonly string[]; readonly predecessorIds: readonly string[];
  readonly metadataReads: readonly MetadataReadDTO[]; readonly sources: readonly SourceLocator[];
  readonly state: ProposalState; readonly diagnostics: readonly Diagnostic[];
}
export interface PreviewBundle { readonly preview: PreviewDTO; readonly proposals: readonly ProposalDTO[] }
export interface ProposalsPageDTO {
  readonly items: readonly ProposalDTO[]; readonly nextCursor: string | null; readonly total: number; readonly versionId: string;
  readonly sourceFiles?: readonly SourceFile[];
}
export interface PreviewSelectionDTO {
  readonly selectedIds: readonly string[]; readonly requiredIds: readonly string[]; readonly closureHash: string;
  readonly complete: boolean; readonly state: PreviewState;
}
const text = { type: 'string' } as const;
const hash = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const hashes = { type: 'array', items: hash, uniqueItems: true } as const;
const uuids = { type: 'array', items: uuidSchema, uniqueItems: true } as const;
const texts = { type: 'array', items: text, uniqueItems: true } as const;
const count = { type: 'integer', minimum: 0 } as const;
export const bindingSchema = { type: 'object', additionalProperties: false, properties: {
  contextId: text, contextIds: texts, tableCode: text, sheetCode: text, rowCode: text, columnCode: text,
} } as const;
const diagnostics = { type: 'array', items: diagnosticSchema } as const;
export const metadataReadsSchema = { type: 'array', items: { type: 'object', additionalProperties: false, required: ['contextId', 'code', 'presence'], properties: {
  contextId: text, code: text, presence: { enum: ['declared', 'missing'] }, value: { type: 'boolean' }, sourceLocator: sourceLocatorSchema,
} } } as const;
export const factReadSchema = { type: 'object', additionalProperties: false, required: ['factKey', 'coordinate', 'presence', 'sourceLocator'], properties: {
  factKey: text, coordinate: coordinateSchema, presence: { enum: ['value', 'explicit_null', 'implicit_null'] },
  normalizedValue: normalizedValueSchema, originalText: text, sourceLocator: sourceLocatorSchema, derivation: factDerivationSchema,
}, allOf: [{ if: { type: 'object', properties: { presence: { const: 'value' } } }, then: { type: 'object', required: ['normalizedValue', 'originalText'] }, else: { not: { anyOf: [{ type: 'object', required: ['normalizedValue'] }, { type: 'object', required: ['originalText'] }] } } },
  { if: { type: 'object', required: ['derivation'] }, then: { type: 'object', properties: { presence: { const: 'value' } } } }] } as const;
export const directionChoiceSchema = { type: 'object', additionalProperties: false, required: ['instanceId', 'targetSide'], properties: {
  instanceId: hash, targetSide: { enum: ['left', 'right'] },
} } as const;
export const directionsRequestSchema = { type: 'object', additionalProperties: false, required: ['directions'], properties: {
  // Uniqueness and structural eligibility are semantic validation, reported as INVALID_DIRECTION.
  directions: { type: 'array', maxItems: 1_000_000, items: directionChoiceSchema },
} } as const;
export const directionSchema = { type: 'object', additionalProperties: false, required: ['id', 'instanceId', 'variantIds', 'binding', 'targetSide', 'targetKey'], properties: {
  id: hash, instanceId: hash, variantIds: hashes, binding: bindingSchema, targetSide: { enum: ['left', 'right'] }, targetKey: text,
} } as const;
const previewStates = { enum: ['ready', 'applied', 'discarded', 'obsolete'] } as const;
export const compactPreviewSchema = { type: 'object', additionalProperties: false, required: ['id', 'baseVersionId', 'profileId', 'policyId', 'createdAt', 'state', 'graphSummary', 'diagnosticCount'], properties: {
  id: uuidSchema, baseVersionId: uuidSchema, profileId: text, policyId: text, createdAt: { type: 'string', format: 'date-time' }, appliedReceiptId: uuidSchema, state: previewStates, diagnosticCount: count,
  graphSummary: { type: 'object', additionalProperties: false, required: ['nodes', 'edges', 'blocked', 'conflictCount', 'cycleCount'], properties: { nodes: count, edges: count, blocked: count, conflictCount: count, cycleCount: count } },
} } as const;
export const previewSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'baseVersionId', 'profileId', 'policyId', 'createdAt', 'state', 'proposalIds', 'graphSummary', 'diagnostics'], properties: {
    id: uuidSchema, baseVersionId: uuidSchema, profileId: text, policyId: text, createdAt: { type: 'string', format: 'date-time' }, appliedReceiptId: uuidSchema, state: previewStates, proposalIds: uuids, diagnostics,
    graphSummary: { type: 'object', additionalProperties: false, required: ['nodes', 'edges', 'order', 'conflicts', 'cycles', 'blocked'], properties: {
      nodes: count, edges: count, order: hashes, blocked: count, cycles: { type: 'array', items: hashes },
      conflicts: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['targetKey', 'producerIds'], properties: { targetKey: text, producerIds: hashes } } },
    } },
  }, allOf: [{ if: { type: 'object', properties: { state: { const: 'applied' } } }, then: { type: 'object', required: ['appliedReceiptId'] }, else: { not: { type: 'object', required: ['appliedReceiptId'] } } }] } as const;
export const proposalSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'previewId', 'directionId', 'instanceId', 'variantIds', 'binding', 'code', 'targetKey', 'readKeys', 'predecessorIds', 'metadataReads', 'sources', 'state', 'diagnostics'], properties: {
    id: uuidSchema, previewId: uuidSchema, directionId: hash, instanceId: hash, variantIds: hashes, binding: bindingSchema, code: text, targetKey: text,
    before: factReadSchema, exactNominal: rationalSchema,
    derivedInterval: { type: 'object', additionalProperties: false, required: ['lo', 'hi'], properties: { lo: rationalSchema, hi: rationalSchema } },
    after: { oneOf: [
      { type: 'object', additionalProperties: false, required: ['normalizedValue', 'originalText', 'decimals', 'unit'], properties: { normalizedValue: rationalSchema, originalText: text, decimals: { type: 'string', pattern: '^(?:INF|0|-?(?:[1-9]|1[0-8]))$' }, unit: text } },
      { type: 'object', additionalProperties: false, required: ['normalizedValue', 'originalText'], properties: { normalizedValue: { type: 'boolean' }, originalText: { enum: ['true', 'false'] } },
        allOf: [{ if: { type: 'object', properties: { normalizedValue: { const: true } } }, then: { type: 'object', properties: { originalText: { const: 'true' } } }, else: { type: 'object', properties: { originalText: { const: 'false' } } } }] },
    ] },
    readKeys: texts, predecessorIds: uuids, metadataReads: metadataReadsSchema, sources: { type: 'array', items: sourceLocatorSchema }, diagnostics,
    state: { enum: ['available', 'blocked', 'accepted', 'applied', 'discarded', 'obsolete'] },
    presentation: presentationSchema,
    calculation: { type: 'object', additionalProperties: false, required: ['expression', 'reads'], properties: {
      expression: text, precondition: text, sourceValue: validationValueSchema, preconditionValue: validationValueSchema,
      reads: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact'], properties: { fact: factReadSchema, fromProposalId: uuidSchema } } },
    } },
  }, allOf: [
    { if: { type: 'object', properties: { state: { enum: ['available', 'accepted', 'applied'] } } }, then: { type: 'object', required: ['before', 'after'] } },
    { if: { type: 'object', properties: { state: { const: 'blocked' } } }, then: { not: { type: 'object', required: ['after'] } } },
    { if: { type: 'object', required: ['after'], properties: { after: { type: 'object', properties: { normalizedValue: { type: 'boolean' } } } } }, then: { not: { anyOf: [{ type: 'object', required: ['exactNominal'] }, { type: 'object', required: ['derivedInterval'] }] } } },
  ] } as const;
const { calculation: _calculation, ...proposalListProperties } = proposalSchema.properties;
export const proposalListItemSchema = { ...proposalSchema, properties: proposalListProperties } as const;
export const proposalsPageSchema = { type: 'object', additionalProperties: false, required: ['items', 'nextCursor', 'total', 'versionId'], properties: {
  items: { type: 'array', items: proposalListItemSchema }, nextCursor: { type: ['string', 'null'] }, total: count, versionId: uuidSchema,
  sourceFiles: { type: 'array', items: sourceFileSchema },
} } as const;
export const previewSelectionRequestSchema = { type: 'object', additionalProperties: false, required: ['selectedIds'], properties: { selectedIds: { ...uuids, maxItems: 1_000_000 } } } as const;
export const previewSelectionSchema = { type: 'object', additionalProperties: false, required: ['selectedIds', 'requiredIds', 'closureHash', 'complete', 'state'], properties: {
  selectedIds: uuids, requiredIds: uuids, closureHash: hash, complete: { type: 'boolean' }, state: previewStates,
} } as const;
