import type { ImportContextDeclaration, ImportContextFormDTO, SourceFile } from '@ce/contracts';
import { ApiError } from '../../errors.js';
import { preflightXlsx } from '../xlsx-preflight.js';
import type { PreflightOptions, PreflightWorkbook } from '../xlsx-preflight.js';
import { COREP_LANGUAGE_PROFILE_ID, COREP_MAPPING_SHA256, COREP_PROFILE_ID } from './corep-structure.js';
import { readCorepWorkbookContext } from './context.js';
import { normalizeCorepCa1 } from './corep-ca1.js';
import type { NormalizedCorepReport } from './corep-ca1.js';
import { DEMO_TYPES_LANGUAGE_PROFILE_ID, DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_PROFILE_ID, normalizeDemoTypes, readDemoTypesWorkbookContext } from './demo-types.js';
export interface InspectedReportWorkbook {
  readonly profileId: typeof COREP_PROFILE_ID | typeof DEMO_TYPES_PROFILE_ID; readonly languageProfileId: typeof COREP_LANGUAGE_PROFILE_ID; readonly preflight: PreflightWorkbook;
  readonly selectedSheets: readonly string[]; readonly excludedSheets: readonly string[]; readonly mappingSha256: string; readonly workbookContext?: ImportContextDeclaration;
}
/** Trusted server registry. The old ce-report-1 route remains on its strict, separate adapter. */
export async function inspectReportWorkbook(filePath: string, options: Pick<PreflightOptions, 'budget' | 'check'> = {}): Promise<InspectedReportWorkbook> {
  const preflight = await preflightXlsx(filePath, { ...options, profile: 'visual-report' });
  if (!preflight.profile) {
    const workbookContext = readDemoTypesWorkbookContext(preflight)?.declaration;
    return { profileId: DEMO_TYPES_PROFILE_ID, languageProfileId: DEMO_TYPES_LANGUAGE_PROFILE_ID, preflight, mappingSha256: DEMO_TYPES_MAPPING_SHA256, selectedSheets: ['Datos'], excludedSheets: [], ...(workbookContext ? { workbookContext } : {}) };
  }
  const workbookContext = readCorepWorkbookContext(preflight)?.declaration;
  return { profileId: COREP_PROFILE_ID, languageProfileId: COREP_LANGUAGE_PROFILE_ID, preflight, mappingSha256: COREP_MAPPING_SHA256, selectedSheets: ['CA1'],
    excludedSheets: preflight.sheets.map(sheet => sheet.name).filter(name => !['CA1', 'Contexto', 'Instrucciones'].includes(name)), ...(workbookContext ? { workbookContext } : {}) };
}
export type NormalizedReport = NormalizedCorepReport;
/** Dispatch only the final server-recognized result; no client mapping or profile overrides. */
export function normalizeInspectedReport(inspected: InspectedReportWorkbook, source: SourceFile, formDeclaration?: ImportContextFormDTO, options: { check?: () => void } = {}): NormalizedReport {
  if (inspected.languageProfileId !== COREP_LANGUAGE_PROFILE_ID) throw new ApiError('INVALID_WORKBOOK');
  if (inspected.profileId === COREP_PROFILE_ID && inspected.mappingSha256 === COREP_MAPPING_SHA256 && inspected.preflight.profile === 'corep-ca1') return normalizeCorepCa1(inspected.preflight, source, formDeclaration, options);
  if (inspected.profileId === DEMO_TYPES_PROFILE_ID && inspected.mappingSha256 === DEMO_TYPES_MAPPING_SHA256 && !inspected.preflight.profile) return normalizeDemoTypes(inspected.preflight, source, formDeclaration, options);
  throw new ApiError('INVALID_WORKBOOK');
}
