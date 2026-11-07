import { randomUUID } from 'node:crypto';
import type { Snapshot } from '@ce/contracts';
import { expect } from 'vitest';
import { reviewHarness } from './direction-review-harness.js';
import { selectionSnapshot } from './iteration004-fixtures.js';

/** Snapshot is explicitly seeded; preview, selection jobs and application use the production API/workers. */
export async function selectionHarness(input: Snapshot = selectionSnapshot(5)) {
  const workerModules = Object.fromEntries(['preview', 'apply', 'select-proposals'].map(kind => [kind, new URL(`../../apps/api/dist/workers/${kind}.worker.js`, import.meta.url)]));
  const h = await reviewHarness({ content: input.content, workerModules });
  // Use the public configured-direction endpoint and the actual validation results.
  const response = await h.app.inject({ url: h.base + '/runs/' + h.input.runId + '/results?limit=200', headers: h.headers });
  expect(response.statusCode, response.body).toBe(200);
  const rows = response.json().items as { instanceId: string }[];
  const configured = await h.app.inject({ method: 'PUT', url: h.base + '/directions', headers: { ...h.headers, 'if-match': h.etag() }, payload: { directions: rows.map(row => ({ instanceId: row.instanceId, targetSide: 'left' })) } });
  expect(configured.statusCode, configured.body).toBe(200);
  const snapshot = h.store.current(h.workspace.id)!;
  const previewResponse = await h.app.inject({ method: 'POST', url: h.base + '/previews', headers: { ...h.headers, 'if-match': h.etag(), 'idempotency-key': randomUUID() }, payload: { baseVersionId: snapshot.versionId } });
  expect(previewResponse.statusCode, previewResponse.body).toBe(202);
  const previewJob = await h.finish(previewResponse.json().jobId); expect(previewJob.status, JSON.stringify(previewJob.diagnostics)).toBe('succeeded');
  const previewId = previewJob.resultRef!.id, selectionUrl = h.base + '/previews/' + previewId + '/selection-state';
  const get = (suffix = '') => h.app.inject({ url: selectionUrl + suffix, headers: h.headers });
  const selectionResponse = await get(); expect(selectionResponse.statusCode, selectionResponse.body).toBe(200);
  async function edit(operations: object[]) {
    const current = (await get()).json();
    const response = await h.app.inject({ method: 'POST', url: selectionUrl + '/edits', headers: { ...h.headers, 'if-match': h.etag(), 'idempotency-key': randomUUID() }, payload: { selectionId: current.id, expectedRevision: current.revision, operations } });
    expect(response.statusCode, response.body).toBe(202); const job = await h.finish(response.json().jobId); expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return (await get()).json();
  }
  const apply = (body: object, key = randomUUID(), etag = h.etag()) => h.app.inject({ method: 'POST', url: h.base + '/applications', headers: { ...h.headers, 'if-match': etag, 'idempotency-key': key }, payload: body });
  async function body() { const selection = (await get()).json(); return { baseVersionId: snapshot.versionId, previewId, selectionRef: { id: selection.id, revision: selection.revision }, closureHash: selection.closureHash }; }
  return { ...h, configuredSnapshot: snapshot, previewId, previewJob, selectionUrl, selection: selectionResponse.json(), getSelection: get, editSelection: edit, applySelection: apply, applicationBody: body };
}
