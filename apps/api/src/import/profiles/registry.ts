import type { ImportContextDeclaration, ImportContextFormDTO, SourceFile } from '@ce/contracts';
import { ApiError } from '../../errors.js';
import { preflightXlsx } from '../xlsx-preflight.js';
import type { PreflightOptions, PreflightWorkbook } from '../xlsx-preflight.js';
import { COREP_LANGUAGE_PROFILE_ID, COREP_MAPPING_SHA256, COREP_PROFILE_ID } from './corep-structure.js';
import { readCorepWorkbookContext } from './context.js';
import { normalizeCorepCa1 } from './corep-ca1.js';
import type { NormalizedCorepReport } from './corep-ca1.js';
import { DEMO_TYPES_LANGUAGE_PROFILE_ID, DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_PROFILE_ID, normalizeDemoTypes, readDemoTypesWorkbookContext } from './demo-types.js';
import { FINREP_MAPPING_SHA256, FINREP_PROFILE_ID, normalizeFinrepF0101, readFinrepWorkbookContext } from './finrep-f0101.js';
export interface InspectedReportWorkbook {
  readonly profileId: typeof COREP_PROFILE_ID | typeof DEMO_TYPES_PROFILE_ID | typeof FINREP_PROFILE_ID; readonly languageProfileId: typeof COREP_LANGUAGE_PROFILE_ID; readonly preflight: PreflightWorkbook;
  readonly selectedSheets: readonly string[]; readonly excludedSheets: readonly string[]; readonly mappingSha256: string; readonly workbookContext?: ImportContextDeclaration;
}
/** Trusted server registry. The old ce-report-1 route remains on its strict, separate adapter. */
export interface ReportInspectionOptions extends Pick<PreflightOptions,'budget'|'check'> { readonly profileId?:string; readonly reportIndex?:number; readonly sha256?:string; readonly formDeclaration?:ImportContextFormDTO }
export async function inspectReportWorkbook(filePath: string, options: ReportInspectionOptions = {}): Promise<InspectedReportWorkbook> {
  const preflight = await preflightXlsx(filePath, { ...options, profile: 'visual-report' });
  if (!preflight.profile) {
    if(options.profileId&&options.profileId!==DEMO_TYPES_PROFILE_ID)throw new ApiError('PROFILE_NOT_RECOGNIZED');
    const workbookContext = readDemoTypesWorkbookContext(preflight)?.declaration;
    return { profileId: DEMO_TYPES_PROFILE_ID, languageProfileId: DEMO_TYPES_LANGUAGE_PROFILE_ID, preflight, mappingSha256: DEMO_TYPES_MAPPING_SHA256, selectedSheets: ['Datos'], excludedSheets: [], ...(workbookContext ? { workbookContext } : {}) };
  }
  const candidates=(preflight.visualCandidates??[preflight.profile]).map(id=>id==='corep-ca1'?{profileId:COREP_PROFILE_ID,label:'COREP · C 01.00 · plantilla 4.0',tableCode:'C_01.00'}:{profileId:FINREP_PROFILE_ID,label:'FINREP · F 01.01 · plantilla 4.0',tableCode:'F_01.01'});
  if(options.profileId&&!candidates.some(c=>c.profileId===options.profileId))throw new ApiError('PROFILE_NOT_RECOGNIZED');
  const rawProfile=preflight.sheets.find(s=>s.name==='Contexto')?.cells.B2?.text;
  let workbookContext:ImportContextDeclaration|undefined;
  if(rawProfile===COREP_PROFILE_ID)workbookContext=readCorepWorkbookContext(preflight)?.declaration;
  else if(rawProfile===FINREP_PROFILE_ID)workbookContext=readFinrepWorkbookContext(preflight)?.declaration;
  else if(rawProfile!==undefined)throw new ApiError('CONTEXT_MISMATCH');
  const contextProfile=workbookContext?.framework==='COREP'?COREP_PROFILE_ID:workbookContext?.framework==='FINREP'?FINREP_PROFILE_ID:undefined;
  if(contextProfile&&options.profileId&&contextProfile!==options.profileId)throw new ApiError('CONTEXT_MISMATCH');
  let chosen=options.profileId??contextProfile;
  if(!chosen&&candidates.length===1)chosen=candidates[0]!.profileId;
  if(!chosen)throw new ApiError('REPORT_PROFILE_REQUIRED',options.reportIndex!==undefined&&options.sha256?{profileChoice:{reportIndex:options.reportIndex,sha256:options.sha256,candidates}}:{});
  if(!candidates.some(c=>c.profileId===chosen))throw new ApiError('PROFILE_NOT_RECOGNIZED');
  const finrep=chosen===FINREP_PROFILE_ID, sheet=finrep?'1.1':'CA1';
  return { profileId:finrep?FINREP_PROFILE_ID:COREP_PROFILE_ID,languageProfileId:COREP_LANGUAGE_PROFILE_ID,preflight:{...preflight,profile:finrep?'finrep-f0101':'corep-ca1'},mappingSha256:finrep?FINREP_MAPPING_SHA256:COREP_MAPPING_SHA256,selectedSheets:[sheet],
    excludedSheets:preflight.sheets.map(s=>s.name).filter(name=>![sheet,'Contexto','Instrucciones'].includes(name)),...(workbookContext?{workbookContext}:{})};
}
export type NormalizedReport = NormalizedCorepReport;
/** Dispatch only the final server-recognized result; no client mapping or profile overrides. */
export function normalizeInspectedReport(inspected: InspectedReportWorkbook, source: SourceFile, formDeclaration?: ImportContextFormDTO, options: { check?: () => void } = {}): NormalizedReport {
  if (inspected.languageProfileId !== COREP_LANGUAGE_PROFILE_ID) throw new ApiError('INVALID_WORKBOOK');
  if (inspected.profileId === COREP_PROFILE_ID && inspected.mappingSha256 === COREP_MAPPING_SHA256 && inspected.preflight.profile === 'corep-ca1') return normalizeCorepCa1(inspected.preflight, source, formDeclaration, options);
  if (inspected.profileId === FINREP_PROFILE_ID && inspected.mappingSha256 === FINREP_MAPPING_SHA256 && inspected.preflight.profile === 'finrep-f0101') return normalizeFinrepF0101(inspected.preflight, source, formDeclaration, options);
  if (inspected.profileId === DEMO_TYPES_PROFILE_ID && inspected.mappingSha256 === DEMO_TYPES_MAPPING_SHA256 && !inspected.preflight.profile) return normalizeDemoTypes(inspected.preflight, source, formDeclaration, options);
  throw new ApiError('INVALID_WORKBOOK');
}
