import type { Diagnostic, JsonObject, SourceLocator } from './common.js';
import type { SourceFile } from './report.js';
import { civilDateSchema, sourceLocatorSchema, uuidSchema } from './common.schemas.js';
export const EBA_HEADERS = ['VR Code', 'Source', 'Framework', 'Modules', 'Cross module', 'Tables', 'Expression', 'Precondtion', 'Description', 'IsActive', 'FromReferenceDate', 'ToReferenceDate', 'Severity', 'FromSubmissionDate', 'Implemented in XBRL'] as const;
export type Severity = 'error' | 'warning' | 'unknown';
export interface RawRuleRecord {
  readonly id: string; readonly code: string; readonly sourceLocator: SourceLocator;
  readonly originalFields: JsonObject; readonly diagnostics: readonly Diagnostic[]; readonly variantId?: string;
}
export interface RuleVariant {
  readonly variantId: string; readonly code: string; readonly framework: string;
  readonly modules: readonly string[]; readonly crossModule: boolean; readonly tables: readonly string[];
  readonly expression: string; readonly precondition?: string; readonly active: boolean;
  readonly referenceWindow: { readonly from?: string; readonly to?: string }; readonly submissionFrom?: string;
  readonly severityOriginal: string; readonly severity: Severity;
  readonly sourceRecords: readonly string[]; readonly sourceLocators: readonly SourceLocator[];
}
export interface RuleAnalysis {
  readonly variantId: string; readonly grammarVersion: string; readonly profileId: string;
  readonly syntaxStatus: 'valid' | 'error'; readonly supportStatus: 'supported' | 'unsupported';
  readonly diagnostics: readonly Diagnostic[];
  /** Internal snapshot data only. HTTP responses explicitly omit these fields. */
  readonly ast?: JsonObject; readonly preconditionAst?: JsonObject;
}
export interface CatalogData {
  readonly records: readonly RawRuleRecord[]; readonly variants: readonly RuleVariant[]; readonly analyses: readonly RuleAnalysis[];
  readonly coverage: { readonly rows: number; readonly variants: number; readonly applicableVariants: number;
    readonly supportedVariants: number; readonly invalidRows: number; readonly duplicateRows: number; readonly conflictingVariants: number };
}
export interface RuleRowDTO extends RawRuleRecord {
  readonly expression?: string; readonly precondition?: string; readonly severity?: Severity;
  readonly active?: boolean; readonly modules?: readonly string[]; readonly tables?: readonly string[];
  readonly syntaxStatus?: 'valid' | 'error'; readonly supportStatus?: 'supported' | 'unsupported';
  readonly applicability?: 'applicable' | 'not_applicable' | 'not_evaluable';
}
export interface RulesPageDTO { readonly items: readonly RuleRowDTO[]; readonly total: number; readonly nextCursor: string | null; readonly versionId: string;
  readonly coverage: CatalogData['coverage']; readonly sources: readonly SourceFile[];
  readonly dataSummary: { readonly explicitNulls: number; readonly implicitNulls: number; readonly zeroValues: number } }
export interface CapabilitiesDTO { readonly profileId: string; readonly grammarVersion: string; readonly support: readonly string[]; readonly knownDifferences: readonly string[]; readonly limits: Readonly<Record<string, number>>;
  readonly languageProfiles?: readonly { readonly id: string; readonly support: readonly string[]; readonly recalculationPolicy: string }[];
  readonly reportProfiles?: readonly { readonly id: string; readonly name: string; readonly moduleVersion: string; readonly supportedTables: readonly string[]; readonly languageProfileId: string; readonly forms: readonly string[]; readonly contextFields: readonly string[] }[];
  readonly importInspection?: { readonly ttlSeconds: number; readonly maxActive: number };
}
const text = { type: 'string' } as const;
const sha256 = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
export const diagnosticSchema = { type: 'object', additionalProperties: false, required: ['code', 'message'], properties: {
  code: text, message: text, locator: sourceLocatorSchema, fileName: { type: 'string', maxLength: 200 }, severity: { enum: ['error', 'warning', 'info'] },
  line: { type: 'integer', minimum: 1 }, column: { type: 'integer', minimum: 0 }, start: { type: 'integer', minimum: 0 }, end: { type: 'integer', minimum: 0 },
} } as const;
export const rawRuleRecordSchema = { type: 'object', additionalProperties: false, required: ['id', 'code', 'sourceLocator', 'originalFields', 'diagnostics'], properties: {
  id: uuidSchema, code: text, sourceLocator: sourceLocatorSchema, originalFields: { type: 'object', additionalProperties: true },
  diagnostics: { type: 'array', items: diagnosticSchema }, variantId: sha256,
} } as const;
export const ruleVariantSchema = { type: 'object', additionalProperties: false, required: ['variantId', 'code', 'framework', 'modules', 'crossModule', 'tables', 'expression', 'active', 'referenceWindow', 'severityOriginal', 'severity', 'sourceRecords', 'sourceLocators'], properties: {
  variantId: sha256, code: text, framework: text, modules: { type: 'array', items: text, uniqueItems: true }, crossModule: { type: 'boolean' },
  tables: { type: 'array', items: text, uniqueItems: true }, expression: text, precondition: text, active: { type: 'boolean' },
  referenceWindow: { type: 'object', additionalProperties: false, properties: { from: civilDateSchema, to: civilDateSchema } }, submissionFrom: civilDateSchema,
  severityOriginal: text, severity: { enum: ['error', 'warning', 'unknown'] }, sourceRecords: { type: 'array', items: uuidSchema }, sourceLocators: { type: 'array', items: sourceLocatorSchema },
} } as const;
