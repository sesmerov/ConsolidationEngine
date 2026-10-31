import type { CivilDate, Diagnostic, Rational, SourceLocator } from './common.js';
import { civilDateSchema, rationalSchema, sourceLocatorSchema, uuidSchema } from './common.schemas.js';
export const REPORT_TEMPLATE_VERSION = 'ce-report-1' as const;
export const REPORT_SHEETS = ['Instructions', 'Contexts', 'Coordinates', 'Facts'] as const;
export const CONTEXT_HEADERS = ['templateVersion', 'contextId', 'entityId', 'referenceDate', 'submissionDate', 'framework', 'moduleVersion', 'filingIndicators'] as const;
export const COORDINATE_HEADERS = ['contextId', 'tableCode', 'sheetCode', 'rowCode', 'columnCode', 'dataType', 'unit', 'decimals', 'axes'] as const;
export const FACT_HEADERS = ['contextId', 'tableCode', 'sheetCode', 'rowCode', 'columnCode', 'presence', 'value'] as const;
export interface SourceFile {
  readonly id: string; readonly sha256: string; readonly displayName: string;
  readonly kind: 'catalog' | 'report'; readonly size: number; readonly importedAt: string;
  /** Measured by the XLSX preflight, never supplied by an upload caller. Older fixtures may omit it. */
  readonly expandedBytes?: number;
}
export interface ReportContext {
  readonly canonicalContextKey: string; readonly contextId: string; readonly entityId: string;
  readonly referenceDate: CivilDate; readonly submissionDate?: CivilDate; readonly framework: string;
  readonly moduleVersion: string; readonly filingIndicators: Readonly<Record<string, boolean>>;
  readonly filingIndicatorsLocator?: SourceLocator;
}
export interface FactIdentity {
  readonly factKey: string; readonly contextId: string; readonly tableCode: string;
  readonly sheetCode: string; readonly rowCode: string; readonly columnCode: string;
}
/** A computed value retains its original input locator and identifies the application that produced it. */
export interface FactDerivation { readonly receiptId: string; readonly previewId: string; readonly proposalId: string; readonly baseVersionId: string }
export interface Coordinate extends FactIdentity {
  readonly dataType: 'number' | 'boolean'; readonly unit: string; readonly decimals: string;
  readonly axes: Readonly<Record<string, string>>; readonly sourceLocator: SourceLocator;
}
export interface ReportedFact extends FactIdentity {
  readonly presence: 'value' | 'null'; readonly originalText?: string;
  readonly normalizedValue?: Rational | boolean; readonly sourceLocator: SourceLocator; readonly derivation?: FactDerivation;
}
export interface ImportedReport {
  readonly contexts: readonly ReportContext[]; readonly coordinates: readonly Coordinate[];
  readonly facts: readonly ReportedFact[]; readonly diagnostics: readonly Diagnostic[];
}
const text = { type: 'string' } as const;
const contextId = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } as const;
const code = { type: 'string', pattern: '^[A-Za-z0-9]+$' } as const;
const identity = { factKey: text, contextId, tableCode: { type: 'string', pattern: '^[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$' }, sheetCode: { type: 'string', pattern: '^[A-Za-z0-9]*$' }, rowCode: code, columnCode: code } as const;
export const factDerivationSchema = { type: 'object', additionalProperties: false, required: ['receiptId', 'previewId', 'proposalId', 'baseVersionId'], properties: {
  receiptId: uuidSchema, previewId: uuidSchema, proposalId: uuidSchema, baseVersionId: uuidSchema,
} } as const;
export const sourceFileSchema = { type: 'object', additionalProperties: false, required: ['id', 'sha256', 'displayName', 'kind', 'size', 'importedAt'], properties: {
  id: uuidSchema, sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' }, displayName: { type: 'string', maxLength: 200, pattern: '^[^\\/\\\\\\u0000-\\u001f]*$' },
  kind: { enum: ['catalog', 'report'] }, size: { type: 'integer', minimum: 0 }, importedAt: { type: 'string', format: 'date-time' },
  expandedBytes: { type: 'integer', minimum: 0, maximum: 100 * 1024 * 1024 },
} } as const;
export const reportContextSchema = { type: 'object', additionalProperties: false, required: ['canonicalContextKey', 'contextId', 'entityId', 'referenceDate', 'framework', 'moduleVersion', 'filingIndicators'], properties: {
  canonicalContextKey: text, contextId, entityId: { type: 'string', minLength: 1 }, referenceDate: civilDateSchema, submissionDate: civilDateSchema,
  framework: text, moduleVersion: text, filingIndicators: { type: 'object', propertyNames: { pattern: '^(?!v_)[A-Za-z](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$' }, additionalProperties: { type: 'boolean' } }, filingIndicatorsLocator: sourceLocatorSchema,
} } as const;
export const coordinateSchema = { type: 'object', additionalProperties: false, required: [...Object.keys(identity), 'dataType', 'unit', 'decimals', 'axes', 'sourceLocator'], properties: {
  ...identity, dataType: { enum: ['number', 'boolean'] }, unit: text, decimals: text, axes: { type: 'object', additionalProperties: { type: 'string' } }, sourceLocator: sourceLocatorSchema,
} } as const;
export const reportedFactSchema = { type: 'object', additionalProperties: false, required: [...Object.keys(identity), 'presence', 'sourceLocator'], properties: {
  ...identity, presence: { enum: ['value', 'null'] }, originalText: text, normalizedValue: { anyOf: [rationalSchema, { type: 'boolean' }] }, sourceLocator: sourceLocatorSchema, derivation: factDerivationSchema,
}, allOf: [{ if: { type: 'object', required: ['derivation'] }, then: { type: 'object', required: ['originalText', 'normalizedValue'], properties: { presence: { const: 'value' } } } }] } as const;
