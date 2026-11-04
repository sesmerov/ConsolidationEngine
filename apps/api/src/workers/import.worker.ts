import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { importWorkspace } from '../import/import-workspace.js';
import type { StagedFile } from '../import/multipart-staging.js';
import type { OperationContext, WorkerOutput } from './protocol.js';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
export async function execute(input: JsonValue, context: OperationContext): Promise<WorkerOutput> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('files' in input) || !Array.isArray(input.files)) throw new ApiError('INVALID_REQUEST');
  if ('inspectionHash' in input && typeof input.inspectionHash === 'string') {
    for (const file of input.files as unknown as StagedFile[]) {
      const check = () => { if (context.cancelled() || context.job.deadline && Date.now() >= Date.parse(context.job.deadline)) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE'); };
      check(); const info = await lstat(file.path); if (!info.isFile() || info.isSymbolicLink() || info.size !== file.size) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(file.path)) { check(); size += chunk.length; if (size > file.size) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE'); hash.update(chunk); }
      if (size !== file.size || hash.digest('hex') !== file.sha256) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
    }
    return { complete: true, verifiedInspectionHash: input.inspectionHash };
  }
  return { complete: true, snapshotContent: await importWorkspace(input.files as unknown as StagedFile[], context) };
}
