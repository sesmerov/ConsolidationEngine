import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { INPUT_BATCH_MAX_BYTES } from '@ce/contracts';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { StagedFile } from '../import/multipart-staging.js';
import { preflightXlsx } from '../import/xlsx-preflight.js';
import type { OperationContext, WorkerOutput } from './protocol.js';

export interface LocalSealInput { readonly batchId: string; readonly files: readonly StagedFile[] }
export interface LocalSealedFile { readonly id: string; readonly size: number; readonly sha256: string; readonly expandedBytes: number }
/** Local parity still performs whole-file hashing and XLSX preflight in a bounded CPU worker. */
export async function execute(value: JsonValue, operation: OperationContext): Promise<WorkerOutput> {
  const input = value as unknown as LocalSealInput;
  if (!input || !Array.isArray(input.files) || input.files.length < 2 || input.files.length > 21 || input.files.reduce((sum, file) => sum + file.size, 0) > INPUT_BATCH_MAX_BYTES) throw new ApiError('TRANSFER_INCOMPLETE');
  const check = () => { if (operation.cancelled() || operation.job.deadline && Date.now() >= Date.parse(operation.job.deadline)) throw new ApiError('JOB_TIMED_OUT'); }, budget = { expandedBytes: 0 }, files: LocalSealedFile[] = [];
  for (const source of input.files) {
    check(); const stat = await lstat(source.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== source.size) throw new ApiError('TRANSFER_INCOMPLETE');
    const hash = createHash('sha256'); let size = 0;
    for await (const bytes of createReadStream(source.path, { highWaterMark: 64 * 1024 })) { check(); size += bytes.length; if (size > source.size) throw new ApiError('TRANSFER_INCOMPLETE'); hash.update(bytes); }
    if (size !== source.size || hash.digest('hex') !== source.sha256) throw new ApiError('TRANSFER_INCOMPLETE');
    const workbook = await preflightXlsx(source.path, { budget, retainCells: false, check, ...(source.kind === 'report' ? { profile: 'visual-report' as const } : {}) });
    files.push({ id: source.id, size, sha256: source.sha256, expandedBytes: workbook.expandedBytes }); operation.progress(files.length, input.files.length);
  }
  return { complete: true, resultRef: { type: 'upload-batch', id: input.batchId }, records: [{ key: 'local-seal', value: { files } as unknown as JsonValue }] };
}
