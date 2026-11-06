import type { JsonObject, SourceLocator } from './common.js';
export const ERROR_STATUS = {
  INVALID_REQUEST: 400, INVALID_CURSOR: 400, INVALID_SESSION: 403, ORIGIN_NOT_ALLOWED: 403,
  RESOURCE_NOT_FOUND: 404, WORKSPACE_BUSY: 409, ACTIVE_WORKSPACE_EXISTS: 409,
  IDEMPOTENCY_CONFLICT: 409, SELECTION_NOT_CLOSED: 409, PREVIEW_NOT_APPLICABLE: 409,
  EXPORT_NOT_AVAILABLE: 409,
  DIRECTION_REVIEW_EXISTS: 409, STALE_DIRECTION_REVIEW: 409,
  DIRECTION_REVIEW_NOT_APPLICABLE: 409, DIRECTION_REVIEW_EXPIRED: 410,
  IMPORT_INSPECTION_EXISTS: 409, PARTIAL_COVERAGE_NOT_ACCEPTED: 409, IMPORT_INSPECTION_NOT_APPLICABLE: 409, IMPORT_INSPECTION_EXPIRED: 410,
  MISSING_CONTEXT: 422, CONTEXT_MISMATCH: 422,
  STALE_VERSION: 412, UPLOAD_LIMIT: 413, EXPANSION_LIMIT: 413, SESSION_LIMIT: 413, EXPORT_LIMIT: 413,
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
  DIRECTION_REVIEW_EXISTS: 'Ya existe una revisión de destinos activa.',
  STALE_DIRECTION_REVIEW: 'Las decisiones han cambiado. Actualiza la revisión.',
  DIRECTION_REVIEW_NOT_APPLICABLE: 'La revisión de destinos no admite esta operación.',
  DIRECTION_REVIEW_EXPIRED: 'La revisión ha caducado. Prepara una nueva revisión.',
  UPLOAD_LIMIT: 'La carga supera los límites admitidos.', EXPANSION_LIMIT: 'La expansión supera los límites admitidos.',
  SESSION_LIMIT: 'La sesión ha alcanzado su límite. Exporta y cierra el conjunto.',
  EXPORT_LIMIT: 'La exportación supera el límite de contenido o tamaño del paquete.',
  EXPORT_NOT_AVAILABLE: 'No se puede reconstruir esta exportación con la procedencia conservada.',
  IMPORT_INSPECTION_EXISTS: 'Ya hay una carga pendiente de confirmar. Confírmala o descártala antes de preparar otra.',
  PARTIAL_COVERAGE_NOT_ACCEPTED: 'Confirma expresamente las hojas excluidas antes de cargar este informe.',
  IMPORT_INSPECTION_NOT_APPLICABLE: 'La inspección ya no puede confirmarse o su contenido no coincide.',
  IMPORT_INSPECTION_EXPIRED: 'La inspección ha caducado. Prepara de nuevo los archivos y el contexto.',
  MISSING_CONTEXT: 'Completa los datos de contexto del informe.', CONTEXT_MISMATCH: 'Los datos del formulario no coinciden con el contexto del libro.',
  UNSUPPORTED_FILE_TYPE: 'Sólo se admiten archivos XLSX.', INVALID_WORKBOOK: 'El libro contiene datos no válidos.',
  INVALID_DIRECTION: 'La dirección de recálculo no es válida.', PRECONDITION_REQUIRED: 'Se requiere la versión de referencia.',
  INTERNAL_ERROR: 'No se pudo completar la operación.',
};
export const EXPORT_UNAVAILABLE_REASONS = ['MISSING_IMPORT_STATS', 'INVALID_REPORT_SOURCE', 'INCOMPLETE_VERSION_HISTORY'] as const;
export type ExportUnavailableReason = typeof EXPORT_UNAVAILABLE_REASONS[number];
