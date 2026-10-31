import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { importWorkspace } from '../import/import-workspace.js';
import type { StagedFile } from '../import/multipart-staging.js';
import type { OperationContext, WorkerOutput } from './protocol.js';
export async function execute(input: JsonValue, context: OperationContext): Promise<WorkerOutput> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('files' in input) || !Array.isArray(input.files)) throw new ApiError('INVALID_REQUEST');
  return { complete: true, snapshotContent: await importWorkspace(input.files as unknown as StagedFile[], context) };
}
