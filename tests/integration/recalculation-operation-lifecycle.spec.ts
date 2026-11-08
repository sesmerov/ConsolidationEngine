import { expect, it } from 'vitest';
import { recalculationHarness } from '../helpers/recalculation-operation-harness.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { bothSidesSnapshot } from '../helpers/iteration005-fixtures.js';
import { selectionSnapshot } from '../helpers/iteration004-fixtures.js';
import type { WorkerOperation } from '../../apps/api/src/workers/protocol.js';

it('reuses a draft on ten entries and keeps decisions when another complete compatible run appears', async () => {
  const h = await recalculationHarness({ content: bothSidesSnapshot().content }), review = await h.readyCurrent();
  const row = (await h.getCurrent('/recalculation-reviews/' + review.id + '/rows?scope=pending')).json().items[0];
  await h.edit(review.id, 1, [{ op: 'set', instanceId: row.instanceId, choice: 'right' }]);
  const newer = h.validate();
  for (let i = 0; i < 10; i++) {
    const response = await h.prepareCurrent({ ...h.currentInput(), runId: newer.runId });
    expect(response.statusCode, response.body).toBe(202); expect(response.json().jobId).toBe(review.jobId);
    expect((await h.getCurrent('/recalculation-state')).json()).toMatchObject({ state: 'ready', compatibleRun: { id: review.runId }, review: { id: review.id, revision: 2 } });
  }
  expect(h.scheduled).toHaveLength(1); expect(h.store.get(h.workspace.id).versionIds).toEqual([h.snapshot.versionId]);
});

it('publishes configuration, effective preview and preselection together, then reuses an equivalent configuration', async () => {
  const h = await recalculationHarness(), review = await h.readyCurrent();
  const accepted = (await h.operate(review)).json();
  expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
  const job = await h.finish(accepted.jobId); expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
  const current = h.store.current(h.workspace.id)!;
  expect(current.versionId).toBe(accepted.effectiveVersionId); expect(current.validationBasisId).toBe(h.snapshot.validationBasisId);
  expect(current.content.facts).toEqual(h.snapshot.content.facts); expect(current.content.directions).toHaveLength(1);
  const preview = (await h.getCurrent('/previews/' + accepted.reservedPreviewId)).json();
  expect(preview.baseVersionId).toBe(current.versionId);
  const selection = (await h.getCurrent('/previews/' + accepted.reservedPreviewId + '/selection-state')).json();
  expect(selection).toMatchObject({ baseVersionId: current.versionId, revision: 1, selectedCount: 1, requiredCount: 0 });
  const second = await h.readyCurrent(), next = (await h.operate(second)).json();
  expect(next.effectiveVersionId).toBe(current.versionId);
  expect((await h.finish(next.jobId)).status).toBe('succeeded');
  expect(h.store.get(h.workspace.id).versionIds).toHaveLength(2);
  expect(h.store.listRecords('validation:' + h.workspace.id + ':')).toHaveLength(1);
});

it.each(['cancel', 'failure', 'quota'] as const)('preserves the complete prior version and draft after %s', async failure => {
  const h = await recalculationHarness(failure === 'quota' ? { store: new WorkspaceStore({ maxSnapshots: 1 }) } : {}), review = await h.readyCurrent();
  const response = await h.operate(review); expect(response.statusCode, response.body).toBe(202); const accepted = response.json();
  if (failure === 'cancel') await h.cancel(accepted.jobId);
  else if (failure === 'failure') {
    h.scheduled.at(-1)!.worker.emit('message', { type: 'result', output: { complete: false, diagnostics: [{ code: 'RESOURCE_LIMIT', message: 'Injected before publication' }] } });
    await h.app.ce.jobs.settle(accepted.jobId);
  } else expect((await h.finish(accepted.jobId)).status).toBe('failed');
  expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
  expect((await h.getCurrent('/previews/' + accepted.reservedPreviewId)).statusCode).toBe(404);
  expect((await h.getCurrent('/recalculation-state')).json()).toMatchObject({ state: 'ready', review: { id: review.id, revision: review.revision }, counts: review.counts });
  const receipt = (await h.getCurrent('/api/v1/operations/' + accepted.operationId)).json();
  expect(receipt.resultRef).toBeUndefined(); expect(receipt.newVersionId).toBeUndefined();
});

it('persists explicit all-omitted choices through a successful empty simulation and reentry without another version', async () => {
  const h = await recalculationHarness(), review = await h.readyCurrent();
  const omitted = (await h.edit(review.id, 1, [{ op: 'omitAll' }])).json().summary;
  expect((await h.getCurrent('/recalculation-state')).json().state).toBe('ready');
  const accepted = (await h.operate(omitted)).json(); expect((await h.finish(accepted.jobId)).status).toBe('succeeded');
  expect((await h.getCurrent('/previews/' + accepted.reservedPreviewId + '/selection-state')).json()).toMatchObject({ selectedCount: 0, availableCount: 0 });
  const next = await h.readyCurrent(); expect(next.counts).toMatchObject({ omitted: 1, included: 0, pending: 0 });
  for (let i = 0; i < 10; i++) await h.prepareCurrent();
  const repeated = (await h.operate(next)).json(); expect((await h.finish(repeated.jobId)).status).toBe('succeeded');
  expect(h.store.get(h.workspace.id).versionIds).toHaveLength(2);
});

it('does not mutate an expired draft while reading current state, and rejects its operation', async () => {
  const h = await recalculationHarness(), review = await h.readyCurrent();
  h.advance(900_001);
  const before = h.store.bytes, records = h.store.listRecords('direction-review:');
  expect((await h.getCurrent('/recalculation-state')).json()).toMatchObject({ state: 'preparation_required', counts: null });
  expect(h.store.bytes).toBe(before); expect(h.store.listRecords('direction-review:')).toEqual(records);
  expect((await h.operate(review)).statusCode).toBe(410);
  expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
});

it('runs the bounded computation inside the accepted job and leaves the draft intact on budget failure', async () => {
  const h = await recalculationHarness({ recalculationOperationLimits: { milliseconds: 0 } }), review = await h.readyCurrent();
  const accepted = await h.operate(review); expect(accepted.statusCode, accepted.body).toBe(202);
  expect(await h.finish(accepted.json().jobId)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'DEADLINE_EXCEEDED' }] });
  expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
  expect((await h.getCurrent('/recalculation-state')).json().review).toMatchObject({ id: review.id, state: 'ready' });
});

it('rejects a malformed initial selection without publishing any prefix of the configured preview', async () => {
  const h = await recalculationHarness(), review = await h.readyCurrent(), accepted = (await h.operate(review)).json();
  const { worker, request } = h.scheduled.at(-1)!;
  const operation: WorkerOperation = await import(request.moduleUrl!);
  const output = await operation.execute(request.input, { job: request.job, snapshot: request.snapshot, cancelled: () => false, progress: () => {} });
  worker.emit('message', { type: 'result', output: { ...output, selectionProjection: { ...output.selectionProjection, selectedCount: 999 } } });
  await h.app.ce.jobs.settle(accepted.jobId);
  expect(h.app.ce.jobs.get(h.workspace.id, accepted.jobId).status).toBe('failed');
  expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
  expect((await h.getCurrent('/previews/' + accepted.reservedPreviewId)).statusCode).toBe(404);
  expect((await h.getCurrent('/recalculation-state')).json().review.revision).toBe(review.revision);
});

it('uses the effective base for selection CAS, dependencies beyond the page and atomic application/revalidation', async () => {
  const h = await recalculationHarness({ content: selectionSnapshot(51).content }), review = await h.readyCurrent();
  const accepted = (await h.operate(review)).json(); expect((await h.finish(accepted.jobId)).status).toBe('succeeded');
  const path = '/previews/' + accepted.reservedPreviewId + '/selection-state';
  const first = (await h.getCurrent(path)).json(), rows = (await h.getCurrent(path + '/rows?limit=50')).json();
  expect(first).toMatchObject({ selectedCount: 51, baseVersionId: accepted.effectiveVersionId });
  const original = { baseVersionId: accepted.effectiveVersionId, previewId: accepted.reservedPreviewId,
    selectionRef: { id: first.id, revision: first.revision }, closureHash: first.closureHash };
  const producer = rows.items.find((row: { code: string }) => row.code === 'SELECT_001') ?? rows.items[0];
  const edit = await h.postCurrent(path + '/edits', { selectionId: first.id, expectedRevision: first.revision,
    operations: [{ op: 'set', proposalId: producer.id, selected: false }] });
  expect(edit.statusCode, edit.body).toBe(202); expect((await h.finish(edit.json().jobId)).status).toBe('succeeded');
  const missing = (await h.getCurrent(path)).json(); expect(missing.requiredCount).toBe(1);
  expect((await h.postCurrent('/applications', original)).json().error.code).toBe('STALE_PROPOSAL_SELECTION');
  expect(h.store.current(h.workspace.id)!.versionId).toBe(accepted.effectiveVersionId);
  const restore = await h.postCurrent(path + '/edits', { selectionId: missing.id, expectedRevision: missing.revision,
    operations: [{ op: 'set', proposalId: producer.id, selected: true }] });
  expect((await h.finish(restore.json().jobId)).status).toBe('succeeded');
  const selected = (await h.getCurrent(path)).json();
  const applied = await h.postCurrent('/applications', { ...original, selectionRef: { id: selected.id, revision: selected.revision }, closureHash: selected.closureHash });
  expect(applied.statusCode, applied.body).toBe(202); const completed = await h.finish(applied.json().jobId);
  expect(completed.status, JSON.stringify(completed.diagnostics)).toBe('succeeded');
  const current = h.store.current(h.workspace.id)!;
  expect(current.versionId).toBe(completed.newVersionId); expect(current.validationBasisId).not.toBe(h.snapshot.validationBasisId);
  expect((await h.getCurrent('/recalculation-state')).json()).toMatchObject({ compatibleRun: { versionId: current.versionId, validationBasisId: current.validationBasisId } });
});
