import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '@ce/contracts';
import type { OperationContext, WorkerMessage, WorkerOperation, WorkerOutput } from '../../apps/api/src/workers/protocol.js';
import { applicationFixture } from '../../packages/engine/test/helpers/application-fixture.js';
function setup() {
  const f = applicationFixture();
  const input = { ...f.options, preview: f.preview } as unknown as JsonValue;
  const context: OperationContext = { snapshot: f.snapshot, cancelled: () => false, progress: () => {}, job: {
    jobId: randomUUID(), workspaceId: randomUUID(), kind: 'apply', status: 'running', baseVersionId: f.snapshot.versionId,
    progress: { completed: 0, total: 0, complete: false }, diagnostics: [], pollAfterMs: 100,
  } };
  return { f, input, context };
}
async function execute(input: JsonValue, context: OperationContext) {
  const modulePath = '../../apps/api/src/workers/apply.worker.js';
  return (await import(modulePath) as WorkerOperation).execute(input, context);
}
describe('application worker without publication', () => {
  it('returns JSON patches and complete validations with reserved IDs, without snapshots or records', async () => {
    const { f, input, context } = setup(), original = JSON.stringify(context.snapshot);
    const output = await execute(structuredClone(input), { ...context, snapshot: structuredClone(context.snapshot!) });
    expect(output.complete).toBe(true); expect(output.resultRef).toEqual({ type: 'application', id: f.options.receiptId });
    expect(output.applicationCandidate?.validation.run).toMatchObject({ id: f.options.runId, versionId: f.options.newVersionId, status: 'completed' });
    expect(output.applicationCandidate?.beforeValidation.run.id).toBe(f.options.beforeRunId);
    expect(output.snapshotContent).toBeUndefined(); expect(output.records).toBeUndefined();
    expect(() => JSON.stringify(output)).not.toThrow(); expect(JSON.stringify(context.snapshot)).toBe(original);
  });
  it.each(['RESOURCE_LIMIT', 'CANCELLED', 'DEADLINE_EXCEEDED'])('returns no partial candidate when work ends with %s', async code => {
    const { input, context } = setup();
    const limits = code === 'RESOURCE_LIMIT' ? { reads: 0 } : code === 'DEADLINE_EXCEEDED' ? { milliseconds: 0 } : {};
    const output = await execute({ ...(input as Record<string, JsonValue>), limits }, { ...context, cancelled: () => code === 'CANCELLED' });
    expect(output.complete).toBe(false); expect(output.diagnostics).toContainEqual(expect.objectContaining({ code }));
    expect(output.applicationCandidate).toBeUndefined(); expect(output.records).toBeUndefined(); expect(output.resultRef).toBeUndefined();
  });
  it('rejects malformed internal input rather than executing a partial request', async () => {
    const { context } = setup(); await expect(execute({}, context)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
  it('executes the compiled real worker thread and transports only a candidate, never publication state', async () => {
    const { f, input, context } = setup();
    const worker = new Worker(new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), { workerData: {
      job: context.job, snapshot: context.snapshot, input, cancellation: new SharedArrayBuffer(4),
      moduleUrl: new URL('../../apps/api/dist/workers/apply.worker.js', import.meta.url).href,
    } });
    try {
      const output = await new Promise<WorkerOutput>((resolve, reject) => {
        worker.on('message', (message: WorkerMessage) => { if (message.type === 'result') resolve(message.output); if (message.type === 'failure') reject(new Error(JSON.stringify(message.diagnostic))); });
        worker.on('error', reject); worker.on('exit', code => { if (code !== 0) reject(new Error('Worker exit ' + code)); });
      });
      expect(output.complete).toBe(true); expect(output.applicationCandidate?.factPatches).toHaveLength(2);
      expect(output.applicationCandidate?.validation.run.versionId).toBe(f.options.newVersionId);
      expect(output.snapshotContent).toBeUndefined(); expect(output.records).toBeUndefined();
    } finally { await worker.terminate(); }
  });
});
