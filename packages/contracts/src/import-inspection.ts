import type { Diagnostic, SourceLocator } from './common.js';
import type { ImportContextDeclaration, ImportContextFormDTO } from './report.js';
import type { ReportProfileId } from './profiles.js';
import { civilDateV2Schema, sourceLocatorSchema, uuidSchema } from './common.schemas.js';
import { diagnosticSchema } from './catalog.js';
export const IMPORT_INSPECTION_TTL_MS = 900_000;
export type ImportContextInputDTO = { readonly source: 'workbook' } | { readonly source: 'form'; readonly declaration: ImportContextFormDTO };
export type ImportInspectionState = 'ready' | 'committing' | 'committed' | 'invalidated' | 'expired' | 'discarded';
export interface ImportInspectionProfileDTO { readonly profileId: ReportProfileId; readonly languageProfileId: string; readonly mappingSha256: string }
export interface ImportInspectionContextDTO {
  readonly sourceFileId: string; readonly origin: 'form' | 'workbook'; readonly declaration: ImportContextDeclaration;
  readonly locators?: Readonly<Record<string, SourceLocator>>;
}
export interface ImportInspectionReportDTO {
  readonly sourceFileId: string; readonly displayName: string; readonly sha256: string; readonly profileId: ReportProfileId;
  readonly tables: readonly string[]; readonly selectedSheets: readonly string[]; readonly excludedSheets: readonly string[];
  readonly coordinates: number; readonly values: number;
}
/** Terminal tombstones retain identity but release candidate and detailed report/context arrays. */
export interface ImportInspectionDTO {
  readonly id: string; readonly workspaceId: string; readonly baseVersionId?: string;
  readonly createdAt: string; readonly expiresAt: string; readonly state: ImportInspectionState; readonly inspectionHash: string;
  readonly profiles: readonly ImportInspectionProfileDTO[]; readonly context: readonly ImportInspectionContextDTO[];
  readonly reports: readonly ImportInspectionReportDTO[]; readonly diagnostics: readonly Diagnostic[]; readonly requiresPartialCoverageAcceptance: boolean;
  readonly commitJobId?: string; readonly committedVersionId?: string;
}
export interface ImportInspectionCommitDTO { readonly inspectionHash: string; readonly acceptedExcludedSheets: boolean }
export interface ActiveImportInspectionDTO { readonly active: ImportInspectionDTO | null }
const text = { type: 'string' } as const, hash = { type: 'string', pattern: '^[0-9a-f]{64}$' } as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const sheets = { type: 'array', maxItems: 256, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 31 } } as const;
const profiles = { enum: ['ce-report-1', 'eba-corep-of-4.0-ca1-v1', 'ce-demo-types-1'] } as const;
const declarationProperties = {
  entityId: { type: 'string', minLength: 1, maxLength: 200, pattern: '\\S' }, referenceDate: civilDateV2Schema, submissionDate: civilDateV2Schema,
  filingIndicators: { type: 'object', minProperties: 1, maxProperties: 256, propertyNames: { pattern: '^(?!v_)[A-Za-z][A-Za-z0-9_.-]*$' }, additionalProperties: { type: 'boolean' } },
  currency: { type: 'string', pattern: '^[A-Z]{3}$' }, scaleExponent: { enum: [0, 3, 6] },
  displayDecimals: { anyOf: [{ type: 'integer', minimum: -18, maximum: 18 }, { const: 'INF' }] },
} as const;
export const importContextFormSchema = { type: 'object', additionalProperties: false, required: ['entityId', 'referenceDate', 'filingIndicators'], properties: declarationProperties } as const;
export const importContextDeclarationSchema = { type: 'object', additionalProperties: false, required: [...importContextFormSchema.required, 'contextId', 'framework', 'moduleVersion'], properties: {
  ...declarationProperties, contextId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' }, framework: text, moduleVersion: text,
} } as const;
export const importContextInputSchema = { oneOf: [
  { type: 'object', additionalProperties: false, required: ['source'], properties: { source: { const: 'workbook' } } },
  { type: 'object', additionalProperties: false, required: ['source', 'declaration'], properties: { source: { const: 'form' }, declaration: importContextFormSchema } },
] } as const;
export const importInspectionSchema = { type: 'object', additionalProperties: false,
  required: ['id', 'workspaceId', 'createdAt', 'expiresAt', 'state', 'inspectionHash', 'profiles', 'context', 'reports', 'diagnostics', 'requiresPartialCoverageAcceptance'], properties: {
    id: uuidSchema, workspaceId: uuidSchema, baseVersionId: uuidSchema, createdAt: dateTime, expiresAt: dateTime,
    state: { enum: ['ready', 'committing', 'committed', 'invalidated', 'expired', 'discarded'] }, inspectionHash: hash,
    profiles: { type: 'array', maxItems: 1, items: { type: 'object', additionalProperties: false, required: ['profileId', 'languageProfileId', 'mappingSha256'], properties: { profileId: profiles, languageProfileId: text, mappingSha256: hash } } },
    context: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['sourceFileId', 'origin', 'declaration'], properties: {
      sourceFileId: uuidSchema, origin: { enum: ['form', 'workbook'] }, declaration: importContextDeclarationSchema,
      locators: { type: 'object', propertyNames: { enum: Object.keys(importContextDeclarationSchema.properties) }, additionalProperties: sourceLocatorSchema },
    } } },
    reports: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
      required: ['sourceFileId', 'displayName', 'sha256', 'profileId', 'tables', 'selectedSheets', 'excludedSheets', 'coordinates', 'values'], properties: {
        sourceFileId: uuidSchema, displayName: { type: 'string', maxLength: 200 }, sha256: hash, profileId: profiles,
        tables: { type: 'array', maxItems: 256, uniqueItems: true, items: text }, selectedSheets: sheets, excludedSheets: sheets,
        coordinates: { type: 'integer', minimum: 0, maximum: 100_000 }, values: { type: 'integer', minimum: 0, maximum: 100_000 },
      } } }, diagnostics: { type: 'array', maxItems: 128, items: diagnosticSchema }, requiresPartialCoverageAcceptance: { type: 'boolean' },
    commitJobId: uuidSchema, committedVersionId: uuidSchema,
  } } as const;
export const activeImportInspectionSchema = { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { anyOf: [importInspectionSchema, { type: 'null' }] } } } as const;
export const importInspectionCommitSchema = { type: 'object', additionalProperties: false, required: ['inspectionHash', 'acceptedExcludedSheets'], properties: { inspectionHash: hash, acceptedExcludedSheets: { type: 'boolean' } } } as const;
