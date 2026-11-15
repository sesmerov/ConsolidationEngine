import { createHash, randomUUID } from 'node:crypto';
import { INPUT_BATCH_MAX_BYTES, INPUT_EXPANDED_MAX_BYTES } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { SessionFiles } from '../storage/session-files.js';
import type { SealedBatchCandidate, TransferFileDescriptor } from '../storage/upload-batches.js';
import type { ObjectLedger } from '../hosted/object-ledger.js';
import type { HostedJobClaim } from '../hosted/job-coordinator.js';
import { preflightXlsx } from '../import/xlsx-preflight.js';

/** Executed only by the durable hosted worker runner; publication remains a separate fenced SQL transaction. */
export interface SealUploadStore { readonly objects: Pick<ObjectLedger, 'getObject'>; now(): Date; filesForSeal(claim: HostedJobClaim, batchId: string): Promise<readonly TransferFileDescriptor[]> }
export async function sealUploadedBatch(store: SealUploadStore, claim: HostedJobClaim, batchId: string, cancelled: () => boolean = () => false): Promise<SealedBatchCandidate> {
  const descriptors = await store.filesForSeal(claim, batchId), temporary = await SessionFiles.create(claim.sessionId, undefined, INPUT_BATCH_MAX_BYTES);
  const budget = { expandedBytes: 0 }, files: SealedBatchCandidate['files'][number][] = [];
  const check = () => { if (cancelled() || +store.now() >= Date.parse(claim.deadlineAt)) throw new ApiError('JOB_TIMED_OUT'); };
  try {
    await temporary.createWorkspace(claim.workspaceId);
    for (const descriptor of descriptors) {
      check(); const lease = temporary.reserve(claim.workspaceId, descriptor.source.size), output = await temporary.openFile(claim.workspaceId, lease), hash = createHash('sha256'); let size = 0;
      try {
        for (const part of descriptor.parts) {
          check(); const bytes = await store.objects.getObject(claim, part, { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt, cancelled });
          size += bytes.byteLength; if (size > descriptor.source.size) throw new ApiError('TRANSFER_INCOMPLETE'); hash.update(bytes); await output.handle.writeFile(bytes);
        }
        await output.handle.close(); check(); if (size !== descriptor.source.size || hash.digest('hex') !== descriptor.source.sha256) throw new ApiError('TRANSFER_INCOMPLETE');
        const workbook = await preflightXlsx(output.path, { budget, retainCells: false, check, ...(descriptor.source.kind === 'report' ? { profile: 'visual-report' as const } : {}) });
        if (budget.expandedBytes > INPUT_EXPANDED_MAX_BYTES) throw new ApiError('EXPANSION_LIMIT');
        files.push({ fileId: descriptor.source.id, manifestId: randomUUID(), byteLength: size, sha256: descriptor.source.sha256, partCount: descriptor.parts.length, expandedBytes: workbook.expandedBytes });
      } finally { await output.handle.close().catch(() => undefined); await temporary.removeFiles(claim.workspaceId, [output.id]); lease.release(); }
    }
    check(); return { batchId, files };
  } finally { await temporary.close(); }
}
