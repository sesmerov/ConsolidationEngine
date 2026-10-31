import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { IdempotencyStore } from '../../apps/api/src/session/idempotency-store.js';
import { SessionFiles } from '../../apps/api/src/storage/session-files.js';
import { registerJobRoute } from '../../apps/api/src/routes/jobs.js';
import type { WorkerFactory } from '../../apps/api/src/jobs/job-manager.js';
import { content } from '../helpers/foundation.js';

const applications: Awaited<ReturnType<typeof createApp>>[] = [], roots: string[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) {
    const relative = path.relative(path.resolve('.cache'), root);
    if (!relative.startsWith('resource-lifecycle-') || relative.includes(path.sep)) throw new Error('Unsafe cleanup');
    await rm(root, { recursive: true, force: true });
  }
});
async function rootDirectory() { await mkdir('.cache', { recursive: true }); const root = await mkdtemp(path.resolve('.cache/resource-lifecycle-')); roots.push(root); return root; }
async function waitFor(predicate: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error('Fixture did not reach expected state'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
/** Synthetic uncooperative CPU operation in an actual Node Worker, not a regulatory throughput benchmark. */
async function setup(deadlineMs = 5000, root?: string) {
  const directory = root ?? await rootDirectory(), modulePath = path.join(directory, randomUUID() + '.mjs');
  await writeFile(modulePath, `export async function execute(input, context) {
    context.progress(1, 2);
    if (input.mode === 'success') return {complete:true,records:[{key:'probe:finished',value:true}]};
    let count = 0; for (;;) { count = (count + 1) % 1000000; }
  }`);
  const workers: Worker[] = [], exits: number[] = [], store = new WorkspaceStore(), files = await SessionFiles.create(store.sessionId, directory);
  const workerFactory: WorkerFactory = request => {
    const worker = new Worker(new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), { workerData: request, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }, stdout: true, stderr: true });
    worker.stdout.resume(); worker.stderr.resume(); worker.once('exit', code => exits.push(code)); workers.push(worker); return worker;
  };
  const app = await createApp({ store, files, deadlineMs, workerFactory, workerModules: { validate: pathToFileURL(modulePath) } }); applications.push(app);
  registerJobRoute(app, { path: '/workspaces/:workspaceId/lifecycle-probe', kind: 'validate', bodySchema: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { enum: ['spin', 'success'] } } }, prepare: request => ({ input: request.body as { mode: string } }) });
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' }; headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Synthetic lifecycle probe' } })).json();
  const snapshot = store.publish(workspace.id, undefined, content());
  const start = async (mode = 'spin') => {
    const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/lifecycle-probe`, headers: { ...headers, 'if-match': store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { mode } });
    expect(response.statusCode).toBe(202); return response.json();
  };
  return { app, headers, workspace, snapshot, start, workers, exits, directory };
}

describe('accumulated resources and real worker lifecycle', () => {
  it('accounts the idempotency cache cumulatively and releases it on workspace close without changing snapshots', () => {
    const store = new WorkspaceStore({ maxBytes: 12_000 }), cache = new IdempotencyStore(store), workspace = store.create('Bounded cache');
    const snapshot = store.publish(workspace.id, undefined, content()), originalHash = canonicalHash(snapshot), entries: { scope: { workspaceId: string; operation: string; key: string }; body: string; job: string }[] = [];
    let exceeded = false;
    for (let index = 0; index < 100; index++) {
      const entry = { scope: { workspaceId: workspace.id, operation: 'validation', key: randomUUID() }, body: canonicalHash({ index }), job: randomUUID() }, previous = store.bytes;
      try { cache.remember(entry.scope, entry.body, entry.job); entries.push(entry); expect(store.bytes).toBeGreaterThan(previous); }
      catch (error) { expect(error).toMatchObject({ code: 'SESSION_LIMIT' }); expect(store.bytes).toBe(previous); expect(cache.lookup(entry.scope, entry.body)).toBeUndefined(); exceeded = true; break; }
    }
    expect(exceeded).toBe(true); expect(entries.length).toBeGreaterThan(1); expect(store.bytes).toBeLessThanOrEqual(12_000);
    const first = entries[0]!, bytes = store.bytes; expect(cache.lookup(first.scope, first.body)).toBe(first.job);
    cache.remember(first.scope, first.body, first.job); expect(store.bytes).toBe(bytes); expect(canonicalHash(store.current(workspace.id))).toBe(originalHash);
    cache.forget(first.scope); expect(store.bytes).toBeLessThan(bytes); expect(cache.lookup(first.scope, first.body)).toBeUndefined();
    store.close(workspace.id); expect(store.listRecords('idempotency:')).toEqual([]); expect(() => store.snapshot(workspace.id, snapshot.versionId)).toThrowError(expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }));
    const replacement = store.create('Fresh cache'); expect(store.bytes).toBeLessThan(1000); expect(cache.lookup({ ...first.scope, workspaceId: replacement.id }, first.body)).toBeUndefined();
  });
  it('serves GET while CPU is busy and DELETE cancellation waits for actual worker exit', async () => {
    const f = await setup(), original = canonicalHash(f.snapshot), job = await f.start();
    await waitFor(() => f.app.ce.jobs.get(f.workspace.id, job.jobId).progress.completed === 1); expect(f.workers[0]!.threadId).toBeGreaterThan(0);
    const capabilities = await f.app.inject({ url: '/api/v1/capabilities', headers: f.headers }); expect(capabilities.statusCode).toBe(200);
    const status = await f.app.inject({ url: `/api/v1/workspaces/${f.workspace.id}/jobs/${job.jobId}`, headers: f.headers }); expect(status.json().status).toBe('running');
    const cancelled = await f.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${f.workspace.id}/jobs/${job.jobId}`, headers: f.headers });
    expect(cancelled.statusCode).toBe(202); expect(cancelled.json()).toMatchObject({ status: 'cancelled', progress: { complete: false } });
    expect(f.workers[0]!.threadId).toBe(-1); expect(f.exits).toHaveLength(1); expect(canonicalHash(f.app.ce.store.current(f.workspace.id))).toBe(original);
    expect(f.app.ce.store.get(f.workspace.id).activeJobId).toBeUndefined(); expect(f.app.ce.store.listRecords('reserve:')).toEqual([]); expect(f.app.ce.store.listRecords('operation:')).toEqual([]);
    const next = await f.start('success'); await waitFor(() => f.app.ce.jobs.get(f.workspace.id, next.jobId).status === 'succeeded'); await f.app.ce.jobs.settle(next.jobId);
    expect(f.workers[1]!.threadId).toBe(-1); expect(f.app.ce.store.getRecord('probe:finished')).toBe(true); expect(f.app.ce.store.current(f.workspace.id)).toBe(f.snapshot);
  });
  it('terminates a real uncooperative worker at the configured deadline and preserves original input bytes', async () => {
    const f = await setup(500), fixture = path.resolve('tests/fixtures/generated/report-42.xlsx'), bytes = await readFile(fixture), before = createHash('sha256').update(bytes).digest('hex');
    const copied = await f.app.ce.files.write(f.workspace.id, bytes), job = await f.start();
    await waitFor(() => f.app.ce.jobs.get(f.workspace.id, job.jobId).status === 'timed_out');
    const state = f.app.ce.jobs.get(f.workspace.id, job.jobId); expect(state.progress).toMatchObject({ completed: 1, complete: false }); expect(state.diagnostics.map(d => d.code)).toEqual(['JOB_TIMEOUT']);
    expect(f.workers[0]!.threadId).toBe(-1); expect(f.exits).toHaveLength(1); expect(f.app.ce.store.current(f.workspace.id)).toBe(f.snapshot);
    expect(createHash('sha256').update(await readFile(fixture)).digest('hex')).toBe(before); expect(await readFile(copied.path)).toEqual(bytes);
    expect(f.app.ce.files.usage(f.workspace.id).reservedBytes).toBe(0);
  });
  it('closes only its owned directory after real worker termination, preserving sibling sessions and saved files', async () => {
    const root = await rootDirectory(), original = path.join(root, 'original.xlsx'), saved = path.join(root, 'saved-report.zip'); await writeFile(original, 'outside original'); await writeFile(saved, 'outside saved download');
    const first = await setup(5000, root), sibling = await setup(5000, root), copied = await first.app.ce.files.write(first.workspace.id, Buffer.from('first owned')), other = await sibling.app.ce.files.write(sibling.workspace.id, Buffer.from('sibling owned'));
    const job = await first.start(); await waitFor(() => first.app.ce.jobs.get(first.workspace.id, job.jobId).progress.completed === 1);
    const removed = await first.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${first.workspace.id}`, headers: { ...first.headers, 'if-match': first.app.ce.store.etag(first.workspace.id) } });
    expect(removed.statusCode).toBe(204); expect(first.workers[0]!.threadId).toBe(-1); await expect(access(copied.path)).rejects.toThrow();
    expect(first.app.ce.store.listRecords('')).toEqual([]); expect(await readFile(other.path, 'utf8')).toBe('sibling owned');
    await first.app.close(); applications.splice(applications.indexOf(first.app), 1); await expect(access(first.app.ce.files.directory)).rejects.toThrow();
    expect(await readFile(original, 'utf8')).toBe('outside original'); expect(await readFile(saved, 'utf8')).toBe('outside saved download'); expect(await readFile(other.path, 'utf8')).toBe('sibling owned');
  });
});
