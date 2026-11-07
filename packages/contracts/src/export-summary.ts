import type { CivilDate } from './common.js';
import type { ReportProfileId } from './profiles.js';
import { civilDateSchema, uuidSchema } from './common.schemas.js';
export interface ReportExportSummaryDTO {
  readonly sourceFileId: string; readonly displayName: string; readonly profileId: ReportProfileId;
  readonly contextCount: number; readonly commonEntityId?: string; readonly commonReferenceDate?: CivilDate;
  readonly contextOrigin: 'form' | 'workbook'; readonly selectedSheets: readonly string[]; readonly excludedSheets: readonly string[];
  readonly scaleExponent?: 0 | 3 | 6; readonly displayDecimals?: number | 'INF';
}
/** Bounded by source files; contextCount covers all contexts, never a truncated sample. */
export interface VersionExportSummaryDTO {
  readonly versionId: string; readonly profileId: string; readonly createdAt: string; readonly reports: readonly ReportExportSummaryDTO[];
}
const sheets = { type: 'array', maxItems: 256, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 31 } } as const;
export const versionExportSummarySchema = { type: 'object', additionalProperties: false, required: ['versionId', 'profileId', 'createdAt', 'reports'], properties: {
  versionId: uuidSchema, profileId: { type: 'string' }, createdAt: { type: 'string', format: 'date-time' },
  reports: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false,
    required: ['sourceFileId', 'displayName', 'profileId', 'contextCount', 'contextOrigin', 'selectedSheets', 'excludedSheets'], properties: {
      sourceFileId: uuidSchema, displayName: { type: 'string', maxLength: 200 }, profileId: { enum: ['ce-report-1', 'eba-corep-of-4.0-ca1-v1', 'eba-finrep-4.0-f0101-v1', 'ce-demo-types-1'] },
      contextCount: { type: 'integer', minimum: 1, maximum: 200_000 }, commonEntityId: { type: 'string', maxLength: 32_767 }, commonReferenceDate: civilDateSchema,
      contextOrigin: { enum: ['form', 'workbook'] }, selectedSheets: sheets, excludedSheets: sheets, scaleExponent: { enum: [0, 3, 6] },
      displayDecimals: { anyOf: [{ type: 'integer', minimum: -18, maximum: 18 }, { const: 'INF' }] },
    } } },
} } as const;
