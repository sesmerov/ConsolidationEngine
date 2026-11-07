import type { NormalizedValue, Rational, SourceFile } from './common.js';
import type { ProposalAfterDTO, ProposalState } from './recalculation.js';
import type { ValidationValueDTO } from './validation.js';
import { normalizedValueSchema, rationalSchema, uuidSchema } from './common.schemas.js';
import { sourceFileSchema } from './report.js';
import { proposalSchema } from './recalculation.js';
import { validationValueSchema } from './validation.js';

export const proposalSelectionStates = ['preparing', 'ready', 'updating', 'applying', 'applied', 'obsolete', 'discarded', 'failed'] as const;
export type ProposalSelectionState = typeof proposalSelectionStates[number];
export interface ProposalSelectionRefDTO { readonly id: string; readonly revision: number }
export interface ProposalSelectionSummaryDTO {
  readonly id: string; readonly workspaceId: string; readonly previewId: string; readonly baseVersionId: string;
  readonly revision: number; readonly state: ProposalSelectionState; readonly initializationJobId?: string; readonly pendingJobId?: string;
  readonly availableCount?: number; readonly selectedCount?: number; readonly requiredCount?: number; readonly complete?: boolean; readonly closureHash?: string;
}
export interface ProposalSelectionFilterDTO { readonly status?: ProposalState; readonly code?: string; readonly table?: string; readonly contextId?: string }
export type ProposalSelectionOperationDTO = { readonly op: 'set'; readonly proposalId: string; readonly selected: boolean }
  | { readonly op: 'selectMatching'; readonly filter: ProposalSelectionFilterDTO } | { readonly op: 'clear' };
export interface ProposalSelectionEditDTO { readonly selectionId: string; readonly expectedRevision: number; readonly operations: readonly ProposalSelectionOperationDTO[] }
export interface ProposalSelectionPrepareDTO { readonly baseVersionId: string; readonly seed: 'empty' }
export interface ProposalSelectionRowsQueryDTO extends ProposalSelectionFilterDTO { readonly scope?: 'all' | 'selected' | 'missing'; readonly limit?: string; readonly cursor?: string }
export interface ProposalTargetDTO { readonly contextId: string; readonly tableCode: string; readonly sheetCode: string; readonly rowCode: string; readonly columnCode: string; readonly contextLabel?: string; readonly conceptLabel?: string }
export interface ProposalOriginDTO { readonly fileId?: string; readonly sheet?: string; readonly cell?: string }
export interface ProposalBeforeDTO { readonly presence: 'value' | 'explicit_null' | 'implicit_null'; readonly normalizedValue?: NormalizedValue; readonly unit: string; readonly decimals: string }
export interface ProposalSelectionRowDTO {
  readonly id: string; readonly code: string; readonly state: ProposalState; readonly target: ProposalTargetDTO;
  readonly description: string; readonly descriptionTruncated: boolean; readonly before?: ProposalBeforeDTO; readonly after?: ProposalAfterDTO; readonly origin?: ProposalOriginDTO;
  readonly selected: boolean; readonly required: boolean; readonly predecessorCount: number; readonly requiredPredecessorCount: number;
  readonly rounded: boolean; readonly hasInterval: boolean; readonly diagnosticCount: number;
}
export interface ProposalSelectionPageDTO {
  readonly selectionId: string; readonly previewId: string; readonly revision: number; readonly state: ProposalSelectionState;
  readonly scope: 'all' | 'selected' | 'missing'; readonly items: readonly ProposalSelectionRowDTO[]; readonly total: number; readonly nextCursor: string | null;
  readonly summary: ProposalSelectionSummaryDTO; readonly sourceFiles: readonly SourceFile[];
  readonly filterCounts: { readonly matched: number; readonly available: number; readonly selected: number; readonly selectedOutsideFilter: number; readonly selectedOutsidePage: number };
}
export interface ProposalDependencyPageDTO {
  readonly selectionId: string; readonly previewId: string; readonly revision: number; readonly state: ProposalSelectionState; readonly proposalId: string;
  readonly scope: 'all' | 'missing'; readonly items: readonly ProposalSelectionRowDTO[]; readonly total: number; readonly nextCursor: string | null;
  readonly predecessorCount: number; readonly requiredPredecessorCount: number;
}
export type ScalarExplanationValueDTO = ValidationValueDTO extends infer T ? T extends ValidationValueDTO ? Omit<T, 'coordinate' | 'sourceLocator'> : never : never;
export interface ProposalExplanationDTO {
  readonly selectionId: string; readonly previewId: string; readonly baseVersionId: string; readonly revision: number; readonly state: ProposalSelectionState; readonly proposalId: string;
  readonly code: string; readonly target: ProposalTargetDTO; readonly before?: ProposalBeforeDTO; readonly after?: ProposalAfterDTO; readonly origin?: ProposalOriginDTO;
  readonly evidenceState: 'recorded' | 'unavailable'; readonly expression?: string; readonly precondition?: string; readonly sourceValue?: ScalarExplanationValueDTO; readonly preconditionValue?: ScalarExplanationValueDTO;
  readonly exactNominal?: Rational; readonly interval?: { readonly lo: Rational; readonly hi: Rational }; readonly rounded: boolean; readonly roundingLabel?: string; readonly decimals?: string; readonly unit?: string;
  readonly operandCount: number; readonly originCount: number; readonly diagnosticCount: number; readonly descriptionCount: number;
}
export type ProposalExplanationSection = 'operands' | 'origins' | 'diagnostics' | 'descriptions';
export interface ProposalOperandDTO extends ProposalTargetDTO { readonly itemId: string; readonly presence: ProposalBeforeDTO['presence']; readonly value?: NormalizedValue;
  readonly unit: string; readonly decimals: string; readonly fileName: string; readonly sheet: string; readonly cell: string;
  readonly originKind: 'report' | 'proposal' | 'application'; readonly fromProposalId?: string; readonly fromProposalCode?: string }
export interface ProposalExplanationOriginDTO { readonly itemId: string; readonly kind: 'report' | 'proposal' | 'application' | 'catalog'; readonly fileName: string;
  readonly sheet?: string; readonly row?: number; readonly column?: string; readonly cell?: string; readonly label: string }
export interface ProposalExplanationDiagnosticDTO { readonly itemId: string; readonly severity: 'error' | 'warning' | 'info'; readonly code: string; readonly message: string; readonly location: string; readonly messageTruncated: boolean }
export interface ProposalExplanationDescriptionDTO { readonly itemId: string; readonly description: string; readonly expression: string; readonly precondition?: string; readonly fileName: string; readonly sheet?: string; readonly row?: number }
export type ProposalExplanationItemDTO = ProposalOperandDTO | ProposalExplanationOriginDTO | ProposalExplanationDiagnosticDTO | ProposalExplanationDescriptionDTO;
export interface ProposalExplanationPageDTO { readonly selectionId: string; readonly previewId: string; readonly baseVersionId: string; readonly revision: number; readonly state: ProposalSelectionState;
  readonly proposalId: string; readonly section: ProposalExplanationSection; readonly items: readonly ProposalExplanationItemDTO[]; readonly total: number; readonly nextCursor: string | null }

const count = { type: 'integer', minimum: 0 } as const, positive = { type: 'integer', minimum: 1 } as const;
const text = { type: 'string' } as const, short = { type: 'string', maxLength: 500 } as const, original = { type: 'string', maxLength: 32767 } as const;
const bool = { type: 'boolean' } as const, hash = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const closed = (properties: object, required: readonly string[]) => ({ type: 'object', additionalProperties: false, properties, required });
export const proposalSelectionRefSchema = closed({ id: uuidSchema, revision: positive }, ['id', 'revision']);
const summaryProperties = { id: uuidSchema, workspaceId: uuidSchema, previewId: uuidSchema, baseVersionId: uuidSchema, revision: count, state: { enum: proposalSelectionStates }, initializationJobId: uuidSchema,
  pendingJobId: uuidSchema, availableCount: count, selectedCount: count, requiredCount: count, complete: bool, closureHash: hash };
const projectionFields = ['availableCount', 'selectedCount', 'requiredCount', 'complete', 'closureHash'];
export const proposalSelectionSummarySchema = { ...closed(summaryProperties, ['id', 'workspaceId', 'previewId', 'baseVersionId', 'revision', 'state']), allOf: [{
  if: { type: 'object', properties: { revision: { const: 0 } } },
  then: { type: 'object', properties: { state: { enum: ['preparing', 'failed'] } }, not: { anyOf: projectionFields.map(field => ({ type: 'object', required: [field] })) } },
  else: { type: 'object', required: projectionFields },
}] };
export const proposalSelectionFilterSchema = closed({ status: proposalSchema.properties.state, code: { type: 'string', maxLength: 128 }, table: { type: 'string', maxLength: 128 }, contextId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } }, []);
const setSchema = closed({ op: { const: 'set' }, proposalId: uuidSchema, selected: bool }, ['op', 'proposalId', 'selected']);
export const proposalSelectionEditSchema = closed({ selectionId: uuidSchema, expectedRevision: positive, operations: { oneOf: [
  { type: 'array', minItems: 1, maxItems: 200, uniqueItems: true, items: setSchema },
  { type: 'array', minItems: 1, maxItems: 1, items: { oneOf: [closed({ op: { const: 'clear' } }, ['op']), closed({ op: { const: 'selectMatching' }, filter: proposalSelectionFilterSchema }, ['op', 'filter'])] } },
] } }, ['selectionId', 'expectedRevision', 'operations']);
export const proposalSelectionPrepareSchema = closed({ baseVersionId: uuidSchema, seed: { const: 'empty' } }, ['baseVersionId', 'seed']);
const paging = { limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' }, cursor: { type: 'string', maxLength: 8192 } };
export const proposalSelectionRowsQuerySchema = closed({ ...proposalSelectionFilterSchema.properties, ...paging, scope: { enum: ['all', 'selected', 'missing'] } }, []);
export const proposalDependenciesQuerySchema = closed({ ...paging, scope: { enum: ['all', 'missing'] } }, []);
export const proposalExplanationItemsQuerySchema = closed({ ...paging, section: { enum: ['operands', 'origins', 'diagnostics', 'descriptions'] } }, ['section']);
const targetProperties = { contextId: text, tableCode: text, sheetCode: text, rowCode: text, columnCode: text, contextLabel: short, conceptLabel: short };
export const proposalTargetSchema = closed(targetProperties, ['contextId', 'tableCode', 'sheetCode', 'rowCode', 'columnCode']);
const origin = closed({ fileId: uuidSchema, sheet: text, cell: text }, []);
const before = closed({ presence: { enum: ['value', 'explicit_null', 'implicit_null'] }, normalizedValue: normalizedValueSchema, unit: text, decimals: text }, ['presence', 'unit', 'decimals']);
const scalarFields = { code: text, target: proposalTargetSchema, before, after: proposalSchema.properties.after, origin };
export const proposalSelectionRowSchema = closed({ id: uuidSchema, ...scalarFields, state: proposalSchema.properties.state, description: short, descriptionTruncated: bool, selected: bool, required: bool,
  predecessorCount: count, requiredPredecessorCount: count, rounded: bool, hasInterval: bool, diagnosticCount: count },
['id', 'code', 'target', 'state', 'description', 'descriptionTruncated', 'selected', 'required', 'predecessorCount', 'requiredPredecessorCount', 'rounded', 'hasInterval', 'diagnosticCount']);
const pageFields = { selectionId: uuidSchema, previewId: uuidSchema, revision: positive, state: { enum: proposalSelectionStates }, items: { type: 'array', maxItems: 200, items: proposalSelectionRowSchema }, total: count, nextCursor: { type: ['string', 'null'] } };
export const proposalSelectionPageSchema = closed({ ...pageFields, scope: { enum: ['all', 'selected', 'missing'] }, summary: proposalSelectionSummarySchema,
  sourceFiles: { type: 'array', items: sourceFileSchema }, filterCounts: closed({ matched: count, available: count, selected: count, selectedOutsideFilter: count, selectedOutsidePage: count }, ['matched', 'available', 'selected', 'selectedOutsideFilter', 'selectedOutsidePage']) },
['selectionId', 'previewId', 'revision', 'state', 'items', 'total', 'nextCursor', 'scope', 'summary', 'sourceFiles', 'filterCounts']);
export const proposalDependencyPageSchema = closed({ ...pageFields, proposalId: uuidSchema, scope: { enum: ['all', 'missing'] }, predecessorCount: count, requiredPredecessorCount: count },
['selectionId', 'previewId', 'revision', 'state', 'proposalId', 'scope', 'items', 'total', 'nextCursor', 'predecessorCount', 'requiredPredecessorCount']);
export const scalarExplanationValueSchema = { oneOf: validationValueSchema.oneOf.map(value => {
  const { coordinate: _coordinate, sourceLocator: _locator, ...properties } = value.properties; return { ...value, properties };
}) };
const explanationIdentity = { selectionId: uuidSchema, previewId: uuidSchema, baseVersionId: uuidSchema, revision: positive, state: { enum: proposalSelectionStates }, proposalId: uuidSchema };
export const proposalExplanationSchema = { ...closed({ ...explanationIdentity, ...scalarFields, evidenceState: { enum: ['recorded', 'unavailable'] }, expression: original, precondition: original,
  sourceValue: scalarExplanationValueSchema, preconditionValue: scalarExplanationValueSchema, exactNominal: rationalSchema, interval: proposalSchema.properties.derivedInterval,
  rounded: bool, roundingLabel: short, decimals: text, unit: text, operandCount: count, originCount: count, diagnosticCount: count, descriptionCount: count },
['selectionId', 'previewId', 'baseVersionId', 'revision', 'state', 'proposalId', 'code', 'target', 'evidenceState', 'rounded', 'operandCount', 'originCount', 'diagnosticCount', 'descriptionCount']),
allOf: [{ if: { type: 'object', properties: { evidenceState: { const: 'recorded' } } }, then: { type: 'object', required: ['expression'] } }] };
const itemSchemas = {
  operands: closed({ itemId: text, ...targetProperties, presence: { enum: ['value', 'explicit_null', 'implicit_null'] }, value: normalizedValueSchema, unit: text, decimals: text, fileName: text, sheet: text, cell: text, originKind: { enum: ['report', 'proposal', 'application'] }, fromProposalId: uuidSchema, fromProposalCode: text }, ['itemId', 'contextId', 'tableCode', 'sheetCode', 'rowCode', 'columnCode', 'presence', 'unit', 'decimals', 'fileName', 'sheet', 'cell', 'originKind']),
  origins: closed({ itemId: text, kind: { enum: ['report', 'proposal', 'application', 'catalog'] }, fileName: text, sheet: text, row: positive, column: text, cell: text, label: text }, ['itemId', 'kind', 'fileName', 'label']),
  diagnostics: closed({ itemId: text, severity: { enum: ['error', 'warning', 'info'] }, code: text, message: { type: 'string', maxLength: 4096 }, location: text, messageTruncated: bool }, ['itemId', 'severity', 'code', 'message', 'location', 'messageTruncated']),
  descriptions: closed({ itemId: text, description: original, expression: original, precondition: original, fileName: text, sheet: text, row: positive }, ['itemId', 'description', 'expression', 'fileName']),
};
export const proposalExplanationPageSchema = { oneOf: Object.entries(itemSchemas).map(([section, items]) => closed({ ...explanationIdentity, section: { const: section }, items: { type: 'array', maxItems: 200, items }, total: count, nextCursor: { type: ['string', 'null'] } }, ['selectionId', 'previewId', 'baseVersionId', 'revision', 'state', 'proposalId', 'section', 'items', 'total', 'nextCursor'])) };
