import type { JsonObject, SourceLocator } from './common.js';
export const ERROR_STATUS = {
  INVALID_REQUEST: 400, INVALID_CURSOR: 400, INVALID_SESSION: 403, ORIGIN_NOT_ALLOWED: 403,
  RESOURCE_NOT_FOUND: 404, WORKSPACE_BUSY: 409, ACTIVE_WORKSPACE_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409, SELECTION_NOT_CLOSED: 409, PREVIEW_NOT_APPLICABLE: 409,
  STALE_VERSION: 412, UPLOAD_LIMIT: 413, EXPANSION_LIMIT: 413, SESSION_LIMIT: 413,
  UNSUPPORTED_FILE_TYPE: 415, INVALID_WORKBOOK: 422, INVALID_DIRECTION: 422,
  PRECONDITION_REQUIRED: 428, INTERNAL_ERROR: 500,
} as const;
export type ErrorCode = keyof typeof ERROR_STATUS;
export interface ApiErrorBody {
  readonly error: { readonly code: ErrorCode; readonly message: string; readonly requestId: string;
    readonly locator: SourceLocator | null; readonly details: JsonObject };
}
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  INVALID_REQUEST: 'La petición no tiene el formato esperado.', INVALID_CURSOR: 'La página solicitada no es válida.',
  INVALID_SESSION: 'La sesión no es válida. Recarga la aplicación.', ORIGIN_NOT_ALLOWED: 'El origen de la petición no está permitido.',
  RESOURCE_NOT_FOUND: 'El recurso no está disponible en esta sesión.', WORKSPACE_BUSY: 'Ya hay un trabajo en curso.',
  ACTIVE_WORKSPACE_EXISTS: 'Ya hay un conjunto abierto. Ciérralo antes de crear otro.',
  IDEMPOTENCY_CONFLICT: 'La clave ya se utilizó con otra petición.', SELECTION_NOT_CLOSED: 'Faltan cambios de los que depende la selección.',
  PREVIEW_NOT_APPLICABLE: 'La propuesta ya no puede aplicarse.', STALE_VERSION: 'La versión ha cambiado. Actualiza los datos antes de continuar.',
  UPLOAD_LIMIT: 'La carga supera los límites admitidos.', EXPANSION_LIMIT: 'La expansión supera los límites admitidos.',
  SESSION_LIMIT: 'La sesión ha alcanzado su límite. Exporta y cierra el conjunto.',
  UNSUPPORTED_FILE_TYPE: 'Sólo se admiten archivos XLSX.', INVALID_WORKBOOK: 'El libro contiene datos no válidos.',
  INVALID_DIRECTION: 'La dirección de recálculo no es válida.', PRECONDITION_REQUIRED: 'Se requiere la versión de referencia.',
  INTERNAL_ERROR: 'No se pudo completar la operación.',
};
