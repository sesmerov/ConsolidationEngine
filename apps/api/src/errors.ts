import { ERROR_MESSAGES, ERROR_STATUS } from '@ce/contracts';
import type { ErrorCode, JsonObject, SourceLocator } from '@ce/contracts';
export class ApiError extends Error {
  readonly statusCode: number;
  constructor(readonly code: ErrorCode, readonly details: JsonObject = {}, readonly locator: SourceLocator | null = null) {
    super(code); this.statusCode = ERROR_STATUS[code];
  }
  get publicMessage(): string { return ERROR_MESSAGES[this.code]; }
}
