import { ERROR_STATUS, type ErrorCode } from '@ce/contracts';

const events = ['request_failed', 'job_accepted', 'dispatch_uncertain', 'job_claimed', 'job_terminal',
  'quota_rejected', 'cleanup_delayed', 'cleanup_completed', 'provider_failed'] as const;
const providerOperations = ['blob-put', 'blob-get', 'blob-read', 'blob-delete', 'qstash-publish'] as const;
const providerReasons = ['access', 'store-missing', 'store-suspended', 'rate-limit', 'timeout', 'provider-error', 'missing-length', 'invalid-length', 'read-limit', 'incomplete-read', 'other',
  'request-rejected', 'redaction-invalid', 'timeout-invalid', 'flow-control-invalid', 'retry-invalid', 'invalid-response', 'network-error'] as const;
const requestFailureKinds = ['database-permission', 'database-constraint', 'database-timeout', 'database-error', 'body-parser', 'type-error', 'range-error', 'timeout', 'unknown'] as const;
export type ProviderOperation = typeof providerOperations[number];
export type ProviderFailureReason = typeof providerReasons[number];
export type RequestFailureKind = typeof requestFailureKinds[number];
export type OperationalEvent = typeof events[number];
export interface OperationalFields {
  readonly requestId?: string; readonly jobId?: string; readonly code?: ErrorCode;
  readonly statusCode?: number; readonly durationMs?: number; readonly count?: number;
  readonly providerOperation?: ProviderOperation; readonly providerReason?: ProviderFailureReason; readonly failureKind?: RequestFailureKind;
}
export type OperationalLogger = (event: OperationalEvent, fields: OperationalFields) => void;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Classify failures into fixed labels; never copy messages, SQL, URLs or provider response fields. */
export function requestFailureKind(error: unknown): RequestFailureKind {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  if (code === '42501') return 'database-permission';
  if (typeof code === 'string' && /^23[0-9A-Z]{3}$/.test(code)) return 'database-constraint';
  if (code === '57014' || code === '55P03') return 'database-timeout';
  if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return 'database-error';
  if (typeof code === 'string' && code.startsWith('FST_ERR_CTP_')) return 'body-parser';
  if (error instanceof TypeError) return 'type-error';
  if (error instanceof RangeError) return 'range-error';
  if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return 'timeout';
  return 'unknown';
}
/** Never accepts arbitrary metadata or errors: provider bodies and visitor input cannot enter the log. */
export function createOperationalLogger(sink: (line: string) => void = line => process.stdout.write(line + '\n')): OperationalLogger {
  return (event, fields) => {
    if (!events.includes(event)) return;
    const output: Record<string, string | number> = { event };
    for (const key of ['requestId', 'jobId'] as const) if (typeof fields[key] === 'string' && uuid.test(fields[key])) output[key] = fields[key];
    if (fields.code && Object.hasOwn(ERROR_STATUS, fields.code)) output['code'] = fields.code;
    if (Number.isInteger(fields.statusCode) && fields.statusCode! >= 100 && fields.statusCode! <= 599) output['statusCode'] = fields.statusCode!;
    for (const key of ['durationMs', 'count'] as const) if (Number.isSafeInteger(fields[key]) && fields[key]! >= 0) output[key] = fields[key]!;
    if (fields.providerOperation && providerOperations.includes(fields.providerOperation)) output['providerOperation'] = fields.providerOperation;
    if (fields.providerReason && providerReasons.includes(fields.providerReason)) output['providerReason'] = fields.providerReason;
    if (fields.failureKind && requestFailureKinds.includes(fields.failureKind)) output['failureKind'] = fields.failureKind;
    try { sink(JSON.stringify(output)); } catch { /* Logging is not publication authority and cannot roll back committed state. */ }
  };
}
