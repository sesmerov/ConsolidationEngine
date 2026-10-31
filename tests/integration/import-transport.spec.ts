import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { execute } from '../../apps/api/src/workers/import.worker.js';
import type { WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { canonicalStringify } from '../../apps/api/src/session/canonical-state.js';
import { ControlledWorker, content, nextTurn } from '../helpers/foundation.js';

const applications: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); });
async function setup() {
  const requests: WorkerRequest[] = [], workers: ControlledWorker[] = [];
  const app = await createApp({ workerFactory(request) { requests.push(structuredClone(request)); const worker = new ControlledWorker(); workers.push(worker); return worker; } }); applications.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Replacement transport' } })).json();
  const base = app.ce.store.publish(workspace.id, undefined, { ...content(), reportVersion: 'PREVIOUS_SNAPSHOT_SENTINEL' });
  const original = canonicalStringify(base);
  const boundary = 'ce-' + randomUUID(); const parts: Buffer[] = [];
  for (const [field, file] of [['catalog', 'eba-subset.xlsx'], ['reports', 'report-42.xlsx']] as const) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${file}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`),
      await readFile(new URL('../fixtures/generated/' + file, import.meta.url)), Buffer.from('\r\n'));
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const accepted = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/imports`, headers: { ...headers,
    'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID(), 'content-type': 'multipart/form-data; boundary=' + boundary }, payload: Buffer.concat(parts) });
  expect(accepted.statusCode).toBe(202); await nextTurn();
  const request = requests[0]!;
  const compute = () => execute(request.input, { job: request.job, ...(request.snapshot ? { snapshot: request.snapshot } : {}), cancelled: () => false, progress: () => {} });
  const assertTransport = () => {
    expect(request.job.baseVersionId).toBe(base.versionId); expect(request.snapshot).toBeUndefined();
    expect(JSON.stringify(request)).not.toContain('PREVIOUS_SNAPSHOT_SENTINEL');
  };
  const assertOriginal = () => { expect(app.ce.store.snapshot(workspace.id, base.versionId)).toBe(base); expect(canonicalStringify(base)).toBe(original); };
  return { app, workspace, base, request, worker: workers[0]!, jobId: accepted.json().jobId as string, compute, assertTransport, assertOriginal };
}
describe('replacement imports keep CAS without transporting the old snapshot', () => {
  it('computes the real replacement from staged files alone and retains its original version', async () => {
    const s = await setup(); s.assertTransport(); const output = await s.compute(); expect(output.complete).toBe(true);
    s.worker.complete(output); await nextTurn(); const job = s.app.ce.jobs.get(s.workspace.id, s.jobId);
    expect(job.status).toBe('succeeded'); expect(s.app.ce.store.current(s.workspace.id)!.content.facts).toHaveLength(5);
    expect(s.app.ce.store.current(s.workspace.id)!.versionId).toBe(job.newVersionId); s.assertOriginal();
  });
  it('preserves the original on worker failure without retaining it inside the request', async () => {
    const s = await setup(); s.assertTransport(); s.worker.emit('error', new Error('controlled import failure')); await nextTurn();
    expect(s.app.ce.jobs.get(s.workspace.id, s.jobId).status).toBe('failed'); expect(s.app.ce.store.current(s.workspace.id)).toBe(s.base); s.assertOriginal();
  });
  it('rechecks main-thread CAS after computing the real replacement, despite not sending its base facts', async () => {
    const s = await setup(); s.assertTransport(); const output = await s.compute();
    const newer = s.app.ce.store.publish(s.workspace.id, s.base.versionId, { ...s.base.content, configVersion: 'competing-change' });
    s.worker.complete(output); await nextTurn(); const job = s.app.ce.jobs.get(s.workspace.id, s.jobId);
    expect(job.status).toBe('failed'); expect(job.diagnostics).toContainEqual(expect.objectContaining({ code: 'STALE_VERSION' }));
    expect(s.app.ce.store.current(s.workspace.id)).toBe(newer); s.assertOriginal();
  });
});
