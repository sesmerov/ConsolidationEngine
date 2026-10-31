import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { isTerminalJob } from '@ce/contracts';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { JobManager } from '../../apps/api/src/jobs/job-manager.js';
import { getValidation, prepareValidation } from '../../apps/api/src/validation/validation-service.js';
import { content, controlledFactory, nextTurn } from '../helpers/foundation.js';
function setup(maxBytes?: number) {
  const store = new WorkspaceStore(maxBytes ? { maxBytes } : {}); const workspace = store.create('Validación');
  const base = content(), variantId = 'a'.repeat(64), recordId = randomUUID();
  const snapshot = store.publish(workspace.id, undefined, { ...base, facts: [], contexts: [{ contextId: 'demo', canonicalContextKey: 'context', entityId: 'SYNTHETIC', referenceDate: '2026-06-30', framework: 'COREP', moduleVersion: 'COREP_OF_4.2', filingIndicators: {} }],
    catalog: { ...base.catalog, records: [{ id: recordId, code: 'literal', variantId, sourceLocator: {}, originalFields: {}, diagnostics: [] }], variants: [{ variantId, code: 'literal', framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: [], expression: '1=1', active: true, referenceWindow: {}, severity: 'error', severityOriginal: 'Error', sourceRecords: [recordId], sourceLocators: [] }] } });
  return { store, workspace, snapshot };
}
it('publishes neither job nor initial run when acceptance exceeds the state quota', async () => {
  const { store, workspace, snapshot } = setup(10_000); const jobs = new JobManager(store, { workerFactory: controlledFactory().factory });
  const acceptance = prepareValidation(snapshot, workspace.id); const before = store.bytes;
  try { expect(() => jobs.start({ ...acceptance, workspaceId: workspace.id, kind: 'validate', baseVersionId: snapshot.versionId, input: acceptance.input!, initialRecords: [...acceptance.initialRecords!, { key: 'oversized', value: 'x'.repeat(10_000) }] })).toThrowError(/SESSION_LIMIT/);
    expect(store.bytes).toBe(before); expect(store.get(workspace.id).activeJobId).toBeUndefined(); expect(() => getValidation(store, workspace.id, acceptance.resultRef!.id)).toThrowError(/RESOURCE_NOT_FOUND/);
  } finally { await jobs.dispose(); }
});
it('uses the reserved space to retain an incomplete run when the completed candidate exceeds quota', async () => {
  const { store, workspace, snapshot } = setup(20_000), controlled = controlledFactory(); const jobs = new JobManager(store, { workerFactory: controlled.factory });
  const acceptance = prepareValidation(snapshot, workspace.id);
  try { const job = jobs.start({ ...acceptance, workspaceId: workspace.id, kind: 'validate', baseVersionId: snapshot.versionId, input: acceptance.input! }); await nextTurn();
    controlled.workers[0]!.complete({ records: [{ key: 'oversized', value: 'x'.repeat(30_000) }] });
    expect(jobs.get(workspace.id, job.jobId)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'SESSION_LIMIT' }] });
    expect(getValidation(store, workspace.id, acceptance.resultRef!.id)).toMatchObject({ run: { status: 'incomplete', summary: { complete: false } }, results: [] });
    expect(store.getRecord('oversized')).toBeUndefined(); expect(store.current(workspace.id)).toBe(snapshot);
  } finally { await jobs.dispose(); }
});
it('preserves RESOURCE_LIMIT from the actual validation worker as an incomplete run, never a completed approval', async () => {
  const { store, workspace, snapshot } = setup(); const jobs = new JobManager(store, { workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { validate: new URL('../../apps/api/dist/workers/validate.worker.js', import.meta.url) } });
  const acceptance = prepareValidation(snapshot, workspace.id, { instances: 0 });
  try { const job = jobs.start({ ...acceptance, workspaceId: workspace.id, kind: 'validate', baseVersionId: snapshot.versionId, input: acceptance.input! });
    for (let i = 0; i < 400 && !isTerminalJob(jobs.get(workspace.id, job.jobId).status); i++) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(jobs.get(workspace.id, job.jobId)).toMatchObject({ status: 'failed', diagnostics: [{ code: 'RESOURCE_LIMIT' }] });
    expect(getValidation(store, workspace.id, acceptance.resultRef!.id)).toMatchObject({ run: { status: 'incomplete', summary: { complete: false }, diagnostics: [{ code: 'RESOURCE_LIMIT' }] }, results: [] });
    expect(store.current(workspace.id)).toBe(snapshot);
  } finally { await jobs.dispose(); }
});
