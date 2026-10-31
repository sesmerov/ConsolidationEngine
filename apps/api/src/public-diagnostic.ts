import { ERROR_MESSAGES, ERROR_STATUS, safeDisplayName } from '@ce/contracts';
import type { Diagnostic, ErrorCode, SourceLocator } from '@ce/contracts';
import { ApiError } from './errors.js';
const REASONS: Readonly<Record<string, string>> = {
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
};
const WORK_DIAGNOSTICS: Readonly<Record<string, string>> = { RESOURCE_LIMIT: 'La ejecución superó una cuota de cálculo y quedó incompleta.', CANCELLED: 'La ejecución fue cancelada.', DEADLINE_EXCEEDED: 'La ejecución superó su plazo.', PROFILE_MISMATCH: 'El perfil del conjunto no coincide con el motor.' };
/** Only application-owned codes and a bounded locator cross the worker boundary. */
export function publicDiagnostic(error: unknown): Diagnostic {
  if (!(error instanceof ApiError)) return { code: 'INTERNAL_ERROR', message: ERROR_MESSAGES.INTERNAL_ERROR };
  const reason = error.details.reason;
  return { code: error.code, message: typeof reason === 'string' && Object.hasOwn(REASONS, reason) ? REASONS[reason]! : ERROR_MESSAGES[error.code],
    ...(typeof error.details.displayName === 'string' ? { fileName: safeDisplayName(error.details.displayName) } : {}),
    ...(error.locator ? { locator: error.locator } : {}) };
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
  return { code, message, ...(typeof value.fileName === 'string' ? { fileName: safeDisplayName(value.fileName) } : {}), ...(locator ? { locator } : {}) };
}
