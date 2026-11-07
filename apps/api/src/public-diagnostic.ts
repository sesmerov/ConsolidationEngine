import { ERROR_MESSAGES, ERROR_STATUS, safeDisplayName } from '@ce/contracts';
import type { Diagnostic, ErrorCode, SourceLocator } from '@ce/contracts';
import { ApiError } from './errors.js';
const REASONS: Readonly<Record<string, string>> = {
  MISSING_IMPORT_STATS: 'Faltan los tamaños originales de importación necesarios para verificar que el informe pueda volver a cargarse.',
  INVALID_REPORT_SOURCE: 'La procedencia conservada no permite reconstruir los informes originales.',
  INCOMPLETE_VERSION_HISTORY: 'El historial de versiones o aplicaciones está incompleto para esta exportación.',
  XML_WORKLOAD_LIMIT: 'La estimación conservadora de carga XML supera el límite de la vista Excel, aunque el ZIP final pudiera ser menor.',
  TEXT_CELL_REQUIRED: 'La celda debe ser texto de Excel. Vuelve a introducir el importe o código como texto para conservar su precisión.',
  INPUT_VALUE_LIMIT: 'El importe supera 128 dígitos significativos o 128 posiciones decimales.',
  INVALID_DECIMAL: 'El importe debe ser un decimal escrito como texto, sin separadores de miles.',
  DUPLICATE_CONTEXT_ID: 'El identificador de contexto debe ser único en todo el lote.',
  INCOMPATIBLE_ENTITY_OR_DATE: 'Todos los informes del conjunto deben declarar la misma entidad y fecha de referencia.',
  CONFLICTING_CONTEXT_ATTRIBUTES: 'El mismo contexto declara fechas de envío o indicadores de presentación incompatibles.',
  DUPLICATE_COORDINATE: 'La coordenada está declarada más de una vez.', DUPLICATE_FACT: 'El hecho está declarado más de una vez.',
  INVALID_UNIT: 'La unidad no tiene la forma canónica admitida.', INVALID_PRECISION: 'La precisión debe estar entre -18 y 18, o ser INF.',
  UNKNOWN_CONTEXT: 'El contexto de la celda no está declarado.', UNKNOWN_COORDINATE: 'El hecho no tiene una coordenada declarada.',
  FORMULA_IN_SELECTED_SHEET: 'La hoja seleccionada contiene una fórmula. Sustitúyela por un valor antes de inspeccionar el informe.',
  AMBIGUOUS_COREP_AMOUNT: 'El importe COREP debe ser un número o decimal en texto, sin formato de fecha, hora ni porcentaje.',
  AMBIGUOUS_FINREP_AMOUNT: 'El importe FINREP debe ser un número o decimal en texto, sin formato de fecha, hora ni porcentaje.',
  FINREP_CONTEXT_SHEET_LIMIT: 'El libro no tiene espacio para añadir la hoja Contexto necesaria para volver a cargarlo.',
  INVALID_CONTEXT_LAYOUT: 'La hoja Contexto no conserva los campos y posiciones de la plantilla.',
  UNEXPECTED_CONTEXT_CONTENT: 'La hoja Contexto contiene datos fuera de los campos definidos por la plantilla.',
  UNKNOWN_REPORT_PROFILE: 'El libro no coincide con ninguno de los formatos de informe admitidos.',
  INVALID_TYPED_LAYOUT: 'El ejemplo de texto y fechas no conserva sus hojas, campos y posiciones definidos.',
  UNEXPECTED_TYPED_CONTENT: 'El ejemplo contiene datos fuera de los campos definidos por su plantilla.',
  INVALID_TYPED_STATE: 'Indica Informado o Sin dato en la columna Estado de este campo.',
  NULL_WITH_VALUE: 'Un campo marcado Sin dato debe tener la celda de valor vacía.',
  INVALID_CIVIL_DATE: 'La fecha debe ser una fecha civil válida, sin hora, entre los años 0001 y 9999.',
  RULE_VALIDATION_ONLY: 'Esta regla contiene condicionales, texto o fechas y solo admite validación.',
};
const WORK_DIAGNOSTICS: Readonly<Record<string, string>> = { RESOURCE_LIMIT: 'La ejecución superó una cuota de cálculo y quedó incompleta.', CANCELLED: 'La ejecución fue cancelada.', DEADLINE_EXCEEDED: 'La ejecución superó su plazo.', PROFILE_MISMATCH: 'El perfil del conjunto no coincide con el motor.', RULE_VALIDATION_ONLY: REASONS.RULE_VALIDATION_ONLY!, NOT_EQUALITY: 'Solo una igualdad admite una dirección de recálculo.' };
const candidateLabels={ 'eba-corep-of-4.0-ca1-v1':{label:'COREP · C 01.00 · plantilla 4.0',tableCode:'C_01.00'},'eba-finrep-4.0-f0101-v1':{label:'FINREP · F 01.01 · plantilla 4.0',tableCode:'F_01.01'} } as const;
function profileChoice(raw:unknown):Diagnostic['profileChoice'] {
  if(!raw||typeof raw!=='object')return undefined;const r=raw as Record<string,unknown>;
  if(!Number.isInteger(r.reportIndex)||(r.reportIndex as number)<0||(r.reportIndex as number)>19||typeof r.sha256!=='string'||!/^[0-9a-f]{64}$/.test(r.sha256)||!Array.isArray(r.candidates)||r.candidates.length<1||r.candidates.length>3)return undefined;
  const candidates:NonNullable<Diagnostic['profileChoice']>['candidates'][number][]=[];
  for(const value of r.candidates){if(!value||typeof value!=='object'||!('profileId'in value)||typeof value.profileId!=='string'||!Object.hasOwn(candidateLabels,value.profileId))return undefined;const profileId=value.profileId as keyof typeof candidateLabels;if(candidates.some(c=>c.profileId===profileId))return undefined;candidates.push({profileId,...candidateLabels[profileId]});}
  return {reportIndex:r.reportIndex as number,sha256:r.sha256,candidates};
}
/** Only application-owned codes and a bounded locator cross the worker boundary. */
export function publicDiagnostic(error: unknown): Diagnostic {
  if (!(error instanceof ApiError)) return { code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR };
  const reason = error.details.reason;
  const choice=error.code==='REPORT_PROFILE_REQUIRED'?profileChoice(error.details.profileChoice):undefined;
  return { code: error.code, message: typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? REASONS[reason]! : ERROR_MESSAGES[error.code],
    ...(typeof error.details.displayName === 'string' ? { fileName: safeDisplayName(error.details.displayName) } : {}),
    ...(error.locator ? { locator: error.locator } : {}),...(choice?{profileChoice:choice}:{}) };
}
export function receivedDiagnostic(input: unknown): Diagnostic {
  if (!input || typeof input !== 'object') return publicDiagnostic(undefined);
  const value = input as Record<string, unknown>;
  if (typeof value.code === 'string' && Object.hasOwn(WORK_DIAGNOSTICS, value.code)) return { code: value.code, message: WORK_DIAGNOSTICS[value.code]! };
  if (typeof value.code !== 'string' || !Object.hasOwn(ERROR_STATUS, value.code)) return publicDiagnostic(undefined);
  const code = value.code as ErrorCode;
  // Messages are selected from the same finite catalogue; arbitrary worker strings never reach HTTP.
  const message = typeof value.message === 'string' && Object.values(REASONS).includes(value.message) ? value.message : ERROR_MESSAGES[code];
  let locator: SourceLocator | undefined;
  if (value.locator && typeof value.locator === 'object') {
    const raw = value.locator as Record<string, unknown>;
    locator = { ...(typeof raw.fileId === 'string' && /^[0-9a-f-]{36}$/i.test(raw.fileId) ? { fileId: raw.fileId } : {}),
      ...(typeof raw.sheet === 'string' && raw.sheet.length <= 31 ? { sheet: raw.sheet } : {}),
      ...(typeof raw.row === 'number' && Number.isSafeInteger(raw.row) && raw.row > 0 ? { row: raw.row } : {}),
      ...(typeof raw.column === 'string' && /^[A-Z]{1,3}$/.test(raw.column) ? { column: raw.column } : {}),
      ...(typeof raw.ruleCode === 'string' && raw.ruleCode.length <= 128 ? { ruleCode: raw.ruleCode } : {}) };
  }
  const choice=code==='REPORT_PROFILE_REQUIRED'?profileChoice(value.profileChoice):undefined;
  return { code, message, ...(typeof value.fileName === 'string' ? { fileName: safeDisplayName(value.fileName) } : {}), ...(locator ? { locator } : {}),...(choice?{profileChoice:choice}:{}) };
}
