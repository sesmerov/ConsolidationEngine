import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type { AppOptions } from '../../apps/api/src/app.js';
import type { SnapshotContent } from '@ce/contracts';
import { reviewHarness } from './direction-review-harness.js';
import { uniqueTargetSnapshot } from './iteration005-fixtures.js';

export async function recalculationHarness(options: AppOptions & { content?: SnapshotContent } = {}) {
  const h = await reviewHarness({ controlled: true, content: uniqueTargetSnapshot().content, ...options,
    workerModules: { 'prepare-directions': new URL('../../apps/api/dist/workers/prepare-directions.worker.js', import.meta.url),
      'recalculation-operation': new URL('../../apps/api/dist/workers/recalculation-operation.worker.js', import.meta.url),
      'select-proposals': new URL('../../apps/api/dist/workers/select-proposals.worker.js', import.meta.url),
      apply: new URL('../../apps/api/dist/workers/apply.worker.js', import.meta.url), ...options.workerModules } });
  const get = (path: string) => h.app.inject({ url: path.startsWith('/api/') ? path : h.base + path, headers: h.headers });
  const post = (path: string, body: object, key = randomUUID(), tag: string | null = h.etag()) => h.app.inject({
    method: 'POST', url: h.base + path, headers: { ...h.headers, 'idempotency-key': key, ...(tag === null ? {} : { 'if-match': tag }) }, payload: body });
  const input = () => ({ ...h.input, baseVersionId: h.store.current(h.workspace.id)!.versionId,
    validationBasisId: h.store.current(h.workspace.id)!.validationBasisId! });
  const prepare = (body = input(), key = randomUUID()) => post('/recalculation-reviews', body, key);
  async function ready() {
    const accepted = await prepare(); expect(accepted.statusCode, accepted.body).toBe(202);
    const job = await h.finish(accepted.json().jobId); expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
    return (await get('/recalculation-reviews/' + job.resultRef!.id)).json();
  }
  const operate = (review: { id: string; revision: number; runId: string }, key = randomUUID(), tag = h.etag()) =>
    post('/recalculation-operations', { ...input(), runId: review.runId, reviewId: review.id, expectedRevision: review.revision }, key, tag);
  return { ...h, getCurrent: get, postCurrent: post, prepareCurrent: prepare, currentInput: input, readyCurrent: ready, operate };
}
