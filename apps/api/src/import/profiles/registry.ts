import type { ImportContextDeclaration } from '@ce/contracts';
import { preflightXlsx } from '../xlsx-preflight.js';
import type { PreflightOptions, PreflightWorkbook } from '../xlsx-preflight.js';
import { COREP_LANGUAGE_PROFILE_ID, COREP_MAPPING_SHA256, COREP_PROFILE_ID } from './corep-structure.js';
import { readCorepWorkbookContext } from './context.js';
export interface InspectedReportWorkbook {
  readonly profileId: typeof COREP_PROFILE_ID; readonly languageProfileId: typeof COREP_LANGUAGE_PROFILE_ID; readonly preflight: PreflightWorkbook;
  readonly selectedSheets: readonly string[]; readonly excludedSheets: readonly string[]; readonly mappingSha256: string; readonly workbookContext?: ImportContextDeclaration;
}
/** Trusted server registry. The old ce-report-1 route remains on its strict, separate adapter. */
export async function inspectReportWorkbook(filePath: string, options: Pick<PreflightOptions, 'budget' | 'check'> = {}): Promise<InspectedReportWorkbook> {
  const preflight = await preflightXlsx(filePath, { ...options, profile: 'corep-ca1' });
  const workbookContext = readCorepWorkbookContext(preflight)?.declaration;
  return { profileId: COREP_PROFILE_ID, languageProfileId: COREP_LANGUAGE_PROFILE_ID, preflight, mappingSha256: COREP_MAPPING_SHA256, selectedSheets: ['CA1'],
    excludedSheets: preflight.sheets.map(sheet => sheet.name).filter(name => !['CA1', 'Contexto', 'Instrucciones'].includes(name)), ...(workbookContext ? { workbookContext } : {}) };
}
