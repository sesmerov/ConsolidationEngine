import { ERROR_STATUS, type ErrorCode } from '@ce/contracts';

const events = ['request_failed', 'job_accepted', 'dispatch_uncertain', 'job_claimed', 'job_terminal',
  'quota_rejected', 'cleanup_delayed', 'cleanup_completed'] as const;
export type OperationalEvent = typeof events[number];
export interface OperationalFields {
  readonly requestId?: string; readonly jobId?: string; readonly code?: ErrorCode;
  readonly statusCode?: number; readonly durationMs?: number; readonly count?: number;
}
export type OperationalLogger = (event: OperationalEvent, fields: OperationalFields) => void;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
/** Never accepts arbitrary metadata or errors: provider bodies and visitor input cannot enter the log. */
export function createOperationalLogger(sink: (line: string) => void = line => process.stdout.write(line + '\n')): OperationalLogger {
  return (event, fields) => {
    if (!events.includes(event)) return;
    const output: Record<string, string | number> = { event };
    for (const key of ['requestId', 'jobId'] as const) if (typeof fields[key] === 'string' && uuid.test(fields[key])) output[key] = fields[key];
    if (fields.code && Object.hasOwn(ERROR_STATUS, fields.code)) output['code'] = fields.code;
    if (Number.isInteger(fields.statusCode) && fields.statusCode! >= 100 && fields.statusCode! <= 599) output['statusCode'] = fields.statusCode!;
    for (const key of ['durationMs', 'count'] as const) if (Number.isSafeInteger(fields[key]) && fields[key]! >= 0) output[key] = fields[key]!;
    try { sink(JSON.stringify(output)); } catch { /* Logging is not publication authority and cannot roll back committed state. */ }
  };
}
