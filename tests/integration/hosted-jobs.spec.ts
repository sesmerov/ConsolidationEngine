import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';

describe('durable claim, cancellation and fencing on real PostgreSQL', () => {
  let h: HostedHarness;
  beforeEach(async () => { h = await createHostedHarness(); });
  afterEach(async () => { await h?.close(); });
  const coordinators = () => h.databases.map((database, index) => new HostedJobCoordinator(database,
    { now: h.clock.now, config: h.config, instanceId: 'instance-' + index }));

  it('admits exactly one claim for concurrent duplicate deliveries and a single global CPU', async () => {
    const a = await seedHostedWorkspace(h), b = await seedHostedWorkspace(h), job = await a.queuedJob(), other = await b.queuedJob();
    const [one, two] = coordinators();
    const results = await Promise.all([one!.claim(job), two!.claim(job)]);
    expect(results.filter(result => result.state === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.state === 'busy')).toHaveLength(1);
    expect((await two!.claim(other)).state).toBe('busy');
    const stored = (await h.databases[1].query("SELECT count(*)::int AS count FROM jobs WHERE status='running'")).rows[0];
    expect(stored.count).toBe(1);
  });
  it('expires a lost attempt at 60 seconds but retains its permit until 120 seconds, rejecting its stale fence', async () => {
    const a = await seedHostedWorkspace(h), b = await seedHostedWorkspace(h), job = await a.queuedJob(), other = await b.queuedJob();
    const [one, two] = coordinators(), claimed = await one!.claim(job); expect(claimed.state).toBe('claimed');
    if (claimed.state !== 'claimed') throw new Error('Expected claim');
    const started = claimed.claim.startedAt, deadline = claimed.claim.deadlineAt;
    h.clock.advance(60_001);
    expect(await two!.get(job)).toMatchObject({ status: 'timed_out', startedAt: started, deadline });
    expect((await two!.claim(other)).state).toBe('busy');
    h.clock.advance(60_000);
    const replacement = await two!.claim(other); expect(replacement.state).toBe('claimed');
    if (replacement.state !== 'claimed') throw new Error('Expected replacement');
    expect(BigInt(replacement.claim.fence)).toBeGreaterThan(BigInt(claimed.claim.fence));
    await one!.confirmTerminated(claimed.claim);
    expect((await two!.poll(replacement.claim)).cancelled).toBe(false);
    expect((await one!.poll(claimed.claim)).cancelled).toBe(true);
    expect((await one!.claim(job)).state).toBe('terminal');
  });
  it('does not renew the first deadline on duplicate delivery and persists cancellation before releasing CPU', async () => {
    const a = await seedHostedWorkspace(h), b = await seedHostedWorkspace(h), job = await a.queuedJob(), other = await b.queuedJob();
    const [one, two] = coordinators(), accepted = await one!.claim(job); if (accepted.state !== 'claimed') throw new Error('Expected claim');
    h.clock.advance(10_000);
    expect((await two!.claim(job)).state).toBe('busy');
    expect(await two!.get(job)).toMatchObject({ startedAt: accepted.claim.startedAt, deadline: accepted.claim.deadlineAt });
    expect((await two!.cancel(job)).status).toBe('cancelled');
    expect((await one!.poll(accepted.claim)).cancelled).toBe(true);
    expect((await two!.claim(other)).state).toBe('busy');
    await one!.confirmTerminated(accepted.claim);
    expect((await two!.claim(other)).state).toBe('claimed');
  });
  it('never runs a queue item after ten minutes and never allocates a CPU permit for it', async () => {
    const a = await seedHostedWorkspace(h), job = await a.queuedJob(), [one] = coordinators();
    h.clock.advance(600_001);
    const outcome = await one!.claim(job);
    expect(outcome).toMatchObject({ state: 'terminal', job: { status: 'timed_out', diagnostics: [{ code: 'JOB_QUEUE_EXPIRED' }] } });
    expect((await h.databases[0].query('SELECT count(*)::int AS count FROM cpu_permits WHERE job_id IS NOT NULL')).rows[0].count).toBe(0);
  });
});
