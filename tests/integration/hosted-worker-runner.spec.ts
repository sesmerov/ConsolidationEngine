import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject } from '@ce/contracts';
import { HostedWorkerRunner } from '../../apps/api/src/hosted/worker-runner.js';
import { HostedPublication } from '../../apps/api/src/hosted/publication.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { ObjectLedger } from '../../apps/api/src/hosted/object-ledger.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('awaited hosted runner with real worker threads and PostgreSQL authority', () => {
  let h: HostedHarness;
  beforeEach(async () => { h = await createHostedHarness(); });
  afterEach(async () => { await h?.close(); });
  async function scenario(mode: string) {
    const fixture = await seedHostedWorkspace(h), reference = await fixture.queuedJob(), run = await fixture.validation(), resultId = randomUUID();
    const output = { kind: 'validate', resultRef: { type: 'validation', id: resultId }, canonicalRoots: [], indexes: [], validations: [{ id: resultId,
      versionId: fixture.snapshot.versionId, basisId: fixture.snapshot.validationBasisId, profileId: fixture.snapshot.content.profileId,
      summary: run.summary, resultIndexRef: {}, diagnosticsRef: {} }] };
    await h.databases[0].query('UPDATE jobs SET input_refs=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3',
      [reference.sessionId, reference.workspaceId, reference.jobId, { testMode: mode, testOutput: output, publication: { runIds: [resultId], resultId } }]);
    const coordinator = new HostedJobCoordinator(h.databases[0], { config: h.config, instanceId: 'runner', now: h.clock.now });
    const other = new HostedJobCoordinator(h.databases[1], { config: h.config, instanceId: 'other', now: h.clock.now });
    const quotas = new QuotaLedger(h.databases[0], h.config), ledger = new ObjectLedger(h.databases[0], h.objectTransport, quotas, () => h.clock.date());
    const publication = new HostedPublication(h.databases[0], quotas, ledger, { now: h.clock.now });
    let workers = 0, exited = false, notifyReady!: () => void;
    const ready = new Promise<void>(resolve => { notifyReady = resolve; });
    const runner = new HostedWorkerRunner(coordinator, publication, { now: h.clock.now, schema: h.schema, workerFactory: request => {
      workers++; const worker = new Worker(new URL('../helpers/hosted-runner-worker.mjs', import.meta.url), { workerData: request,
        resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 } });
      worker.on('exit', () => { exited = true; }); worker.on('message', () => notifyReady()); return worker;
    } });
    return { ...fixture, reference, resultId, coordinator, other, runner, ready, workers: () => workers, exited: () => exited };
  }
  it('waits for process termination and publication before returning a terminal callback', async () => {
    const s = await scenario('result'), outcome = await s.runner.run(s.reference);
    expect(outcome).toMatchObject({ state: 'terminal', job: { status: 'succeeded', resultRef: { id: s.resultId } } });
    expect(s.exited()).toBe(true);
    expect((await h.databases[1].query('SELECT count(*)::int AS count FROM validation_runs WHERE id=$1', [s.resultId])).rows[0].count).toBe(1);
    expect((await h.databases[1].query('SELECT count(*)::int AS count FROM cpu_permits WHERE released_at IS NULL')).rows[0].count).toBe(0);
    expect(await s.runner.run(s.reference)).toMatchObject({ state: 'terminal', job: { status: 'succeeded' } });
    expect(s.workers()).toBe(1);
  });
  it('keeps duplicate delivery busy and stops a worker after cancellation from the other instance', async () => {
    const s = await scenario('wait'), execution = s.runner.run(s.reference); await s.ready;
    expect(await s.runner.run(s.reference)).toMatchObject({ state: 'busy' });
    await s.other.cancel(s.reference);
    expect(await execution).toMatchObject({ state: 'terminal', job: { status: 'cancelled' } });
    expect(s.exited()).toBe(true); expect(s.workers()).toBe(1);
    expect((await h.databases[1].query('SELECT count(*)::int AS count FROM validation_runs WHERE id=$1', [s.resultId])).rows[0].count).toBe(0);
  });
  it('uses the first SQL deadline including I/O and does not restart a timed-out worker', async () => {
    const s = await scenario('wait'), execution = s.runner.run(s.reference); await s.ready; h.clock.advance(60001);
    expect(await execution).toMatchObject({ state: 'terminal', job: { status: 'timed_out' } });
    expect(s.exited()).toBe(true);
    expect(await s.runner.run(s.reference)).toMatchObject({ state: 'terminal', job: { status: 'timed_out' } });
    expect(s.workers()).toBe(1);
  });
  it.each(['failure', 'crash'])('turns %s into a durable terminal result and releases only the terminated attempt', async mode => {
    const s = await scenario(mode);
    expect(await s.runner.run(s.reference)).toMatchObject({ state: 'terminal', job: { status: 'failed' } });
    expect(s.exited()).toBe(true);
    expect((await h.databases[1].query('SELECT count(*)::int AS count FROM cpu_permits WHERE released_at IS NULL')).rows[0].count).toBe(0);
  });
});
