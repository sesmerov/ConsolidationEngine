import type { Diagnostic } from './common.js';
import { uuidSchema } from './common.schemas.js';
import { diagnosticSchema } from './catalog.js';
import type { ImportInspectionContextDTO, ImportInspectionDTO, ImportInspectionReportDTO } from './import-inspection.js';
import { importContextInputSchema, importInspectionSchema } from './import-inspection.js';
import type { LargeValueDescriptorDTO } from './compact.js';
import { compactPageSchema, largeValueDescriptorSchema } from './compact.js';

export type CompactImportInspectionDTO = Omit<ImportInspectionDTO, 'reports'|'context'|'diagnostics'> & {
  readonly reportCount: number; readonly contextCount: number; readonly diagnosticsCount: number;
};
export type ImportInspectionSection = 'reports'|'context'|'diagnostics';
export type ImportInspectionItemDTO = ImportInspectionReportDTO|ImportInspectionContextDTO|Diagnostic;
/** The initial inspection precedes the first version; absence never becomes an invented version identity. */
export interface CompactImportInspectionPageDTO {
  readonly workspaceId: string; readonly inspectionId: string; readonly section: ImportInspectionSection;
  readonly versionId?: string; readonly validationBasisId?: string; readonly revision: number;
  readonly items: readonly (ImportInspectionItemDTO|LargeValueDescriptorDTO)[]; readonly total: number; readonly nextCursor: string|null;
}
const count = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
const { reports: _reports, context: _context, diagnostics: _diagnostics, ...summaryProperties } = importInspectionSchema.properties;
export const compactImportInspectionSchema = { type: 'object', additionalProperties: false,
  required: [...importInspectionSchema.required.filter(key => !['reports','context','diagnostics'].includes(key)), 'reportCount','contextCount','diagnosticsCount'],
  properties: { ...summaryProperties, reportCount: { ...count, maximum: 20 }, contextCount: count, diagnosticsCount: count },
} as const;
export const compactActiveImportInspectionSchema = { type: 'object', additionalProperties: false, required: ['active'], properties: { active: { anyOf: [compactImportInspectionSchema, { type: 'null' }] } } } as const;
export const compactInspectionQuerySchema = { type: 'object', additionalProperties: false, properties: { compact: { const: 'true' } } } as const;
export const inspectionItemsQuerySchema = { type: 'object', additionalProperties: false, required: ['section'], properties: {
  section: { enum: ['reports','context','diagnostics'] }, limit: { type: 'string', pattern: '^(?:[1-9]|[1-4][0-9]|50)$' }, cursor: { type: 'string', minLength: 1, maxLength: 8192 },
} } as const;
export const compactImportInspectionPageSchema = { oneOf: Object.entries({ reports: importInspectionSchema.properties.reports.items, context: importInspectionSchema.properties.context.items, diagnostics: diagnosticSchema }).map(([section, item]) => {
  const page = compactPageSchema({ anyOf: [item, largeValueDescriptorSchema] });
  return { ...page, required: [...page.required.filter(key => key !== 'versionId'), 'inspectionId','section','revision'], properties: { ...page.properties, inspectionId: uuidSchema, section: { const: section } } };
}) };
export const inspectUploadedBatchSchema = { type: 'object', additionalProperties: false, required: ['uploadBatchId','context'], properties: { uploadBatchId: uuidSchema, context: importContextInputSchema } } as const;
export function compactImportInspection(value: ImportInspectionDTO): CompactImportInspectionDTO {
  const { reports, context, diagnostics, ...summary } = value; return { ...summary, reportCount: reports.length, contextCount: context.length, diagnosticsCount: diagnostics.length };
}
