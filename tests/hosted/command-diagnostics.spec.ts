import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { build } from 'esbuild';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { HostedWorkerMessage } from '../../apps/api/src/workers/protocol.js';

let directory: string;
beforeAll(async () => {
  directory = await mkdtemp(path.resolve('.tools/hosted-diagnostics-'));
  await build({ entryPoints: ['apps/api/src/workers/hosted-operation-worker.ts'], outfile: path.join(directory, 'worker.mjs'),
    bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
});
afterAll(async () => { if (directory && path.resolve(directory).startsWith(path.resolve('.tools') + path.sep)) await rm(directory, { recursive: true, force: true }); });
async function run(mode: string, options: { cancelled?: boolean; expired?: boolean } = {}): Promise<HostedWorkerMessage> {
  const signal = new Int32Array(new SharedArrayBuffer(4)); if (options.cancelled) Atomics.store(signal, 0, 1);
  const worker = new Worker(pathToFileURL(path.join(directory, 'worker.mjs')), { workerData: {
    cancellation: signal.buffer, commandModule: new URL('../helpers/hosted-command-diagnostics.mjs', import.meta.url).href,
    claim: { deadlineAt: new Date(Date.now() + (options.expired ? -1 : 30000)).toISOString(), inputRefs: { mode } },
  }, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
  try { return await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.once('exit', code => { if (code) reject(new Error('Worker exited')); }); }); }
  finally { await worker.terminate(); }
}
it.each([['quota','RESOURCE_LIMIT'],['selection','PROPOSAL_SELECTION_NOT_APPLICABLE'],['application','SELECTION_NOT_CLOSED'],['cancelled','CANCELLED'],['deadline','DEADLINE_EXCEEDED'],['unknown','INTERNAL_ERROR']])('maps %s to one safe diagnostic code', async (mode, code) => {
  const output = await run(mode!); expect(output).toMatchObject({ type: 'failure', diagnostic: { code } }); expect(JSON.stringify(output)).not.toContain('Private');
});
it('rejects cancellation and an expired deadline before importing a command', async () => {
  expect(await run('unknown', { cancelled: true })).toMatchObject({ type: 'failure', diagnostic: { code: 'CANCELLED' } });
  expect(await run('unknown', { expired: true })).toMatchObject({ type: 'failure', diagnostic: { code: 'DEADLINE_EXCEEDED' } });
});
it('rechecks cancellation and the deadline after command work before emitting a publication', async () => {
  expect(await run('late-cancel')).toMatchObject({ type: 'failure', diagnostic: { code: 'CANCELLED' } });
  expect(await run('late-deadline')).toMatchObject({ type: 'failure', diagnostic: { code: 'DEADLINE_EXCEEDED' } });
});
it('rejects an oversized publication envelope before it crosses the worker boundary', async () => {
  const output = await run('oversize'); expect(output).toMatchObject({ type: 'failure', diagnostic: { code: 'INTERNAL_ERROR' } }); expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThan(1024);
});
