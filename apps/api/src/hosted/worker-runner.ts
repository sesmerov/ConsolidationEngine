import { Worker } from 'node:worker_threads';
import type { Diagnostic, JobDTO } from '@ce/contracts';
import { isTerminalJob } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { receivedDiagnostic } from '../public-diagnostic.js';
import type { AcceptedJobReference } from '../ports/job-dispatcher.js';
import type { HostedWorkerMessage, HostedWorkerRequest, HostedWorkerRuntime } from '../workers/protocol.js';
import { HostedJobCoordinator, type HostedJobClaim } from './job-coordinator.js';
import type { HostedPublication, PublicationEnvelope } from './publication.js';

export type HostedRunOutcome = { readonly state: 'terminal'; readonly job: JobDTO } | { readonly state: 'busy'; readonly retryAfterMs: number };
export type HostedWorkerHandle = Pick<Worker, 'on' | 'terminate'>;
export interface HostedRunnerOptions {
  readonly schema: string; readonly commandModule?: URL; readonly workerEntry?: URL; readonly now?: () => number;
  readonly runtime?: HostedWorkerRuntime;
  /** Tests can supply a real isolated worker fixture. Production requires the fixed server commandModule. */
  readonly workerFactory?: (request: HostedWorkerRequest) => HostedWorkerHandle;
}
type WorkerOutcome = { readonly output: PublicationEnvelope } | { readonly status: 'failed' | 'cancelled' | 'timed_out'; readonly diagnostic: Diagnostic };
const terminalStatus = (code: string) => ['JOB_TIMED_OUT', 'DEADLINE_EXCEEDED'].includes(code) ? 'timed_out' as const : code === 'CANCELLED' ? 'cancelled' as const : 'failed' as const;
const failure = (code = 'INTERNAL_ERROR'): WorkerOutcome => ({ status: terminalStatus(code), diagnostic: receivedDiagnostic({ code }) });

/** One awaited callback owns execution. SQL remains the cross-instance authority; this local slot is only an additional bound. */
export class HostedWorkerRunner {
  private active = false; private stopped = false; private cancellation: Int32Array | undefined; private activeRun: Promise<HostedRunOutcome> | undefined;
  private readonly factory: (request: HostedWorkerRequest) => HostedWorkerHandle;
  constructor(readonly coordinator: HostedJobCoordinator, readonly publication: HostedPublication, readonly options: HostedRunnerOptions) {
    if (!options.workerFactory && !options.commandModule) throw new TypeError('Hosted execution requires a server command module');
    this.factory = options.workerFactory ?? (request => {
      const worker = new Worker(options.workerEntry ?? new URL('../workers/hosted-operation-worker.js', import.meta.url), {
        workerData: request, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }, stdout: true, stderr: true,
      });
      worker.stdout.resume(); worker.stderr.resume(); return worker;
    });
  }
  run(reference: AcceptedJobReference): Promise<HostedRunOutcome> {
    if (this.active || this.stopped) return Promise.resolve({ state: 'busy', retryAfterMs: 5000 });
    this.active = true;
    const execution = this.execute(reference).finally(() => { this.active = false; this.activeRun = undefined; this.cancellation = undefined; });
    this.activeRun = execution; return execution;
  }
  async close(): Promise<void> {
    this.stopped = true; if (this.cancellation) Atomics.store(this.cancellation, 0, 1);
    await this.activeRun;
  }
  private now() { return (this.options.now ?? Date.now)(); }
  private async execute(reference: AcceptedJobReference): Promise<HostedRunOutcome> {
    const reconciled = await this.coordinator.reconcileInternal(reference);
    if (isTerminalJob(reconciled.status)) return { state: 'terminal', job: reconciled };
    const outcome = await this.coordinator.claim(reference);
    if (outcome.state !== 'claimed') return outcome;
    const claim = outcome.claim, cancellation = new Int32Array(new SharedArrayBuffer(4)); this.cancellation = cancellation;
    let worker: HostedWorkerHandle | undefined, terminated = false, polling: Promise<void> | undefined;
    let timer: NodeJS.Timeout | undefined, interval: NodeJS.Timeout | undefined;
    try {
      worker = this.factory({ claim, schema: this.options.schema, cancellation: cancellation.buffer as SharedArrayBuffer,
        ...(this.options.runtime ? { runtime: this.options.runtime } : {}),
        ...(this.options.commandModule ? { commandModule: this.options.commandModule.href } : {}) });
      const result = await new Promise<WorkerOutcome>(resolve => {
        let settled = false;
        const finish = (value: WorkerOutcome) => { if (!settled) { settled = true; resolve(value); } };
        worker!.on('message', (value: unknown) => {
          if (!value || typeof value !== 'object' || !('type' in value)) { finish(failure()); return; }
          const message = value as HostedWorkerMessage;
          if (message.type === 'result') {
            if (!message.output || Buffer.byteLength(JSON.stringify(message.output), 'utf8') > 262_144) finish(failure());
            else finish({ output: message.output });
          } else if (message.type === 'failure') { const diagnostic = receivedDiagnostic(message.diagnostic); finish({ status: terminalStatus(diagnostic.code), diagnostic }); }
          else if (message.type !== 'progress' || !Number.isSafeInteger(message.completed) || !Number.isSafeInteger(message.total) || message.completed < 0 || message.total < message.completed) finish(failure());
        });
        worker!.on('error', () => finish(failure())); worker!.on('exit', () => finish(failure()));
        timer = setTimeout(() => { Atomics.store(cancellation, 0, 1); finish(failure('JOB_TIMED_OUT')); }, Math.max(1, Date.parse(claim.deadlineAt) - this.now()));
        interval = setInterval(() => {
          if (polling || settled) return;
          polling = (async () => {
            if (Atomics.load(cancellation, 0)) { finish(failure('CANCELLED')); return; }
            const authority = await this.coordinator.poll(claim);
            if (authority.cancelled) { Atomics.store(cancellation, 0, 1); finish(failure(authority.reason === 'deadline' ? 'JOB_TIMED_OUT' : authority.reason === 'base_changed' ? 'STALE_VERSION' : 'CANCELLED')); }
          })().catch(() => { Atomics.store(cancellation, 0, 1); finish(failure()); }).finally(() => { polling = undefined; });
        }, 750);
      });
      if (timer) clearTimeout(timer); if (interval) clearInterval(interval); await polling;
      Atomics.store(cancellation, 0, 1);
      // A result message is not proof of process termination. Wait before publication or releasing a permit.
      await worker.terminate(); terminated = true;
      if ('output' in result) {
        const authority = await this.coordinator.poll(claim);
        if (authority.cancelled) return this.failed(claim, failure(authority.reason === 'deadline' ? 'JOB_TIMED_OUT' : authority.reason === 'base_changed' ? 'STALE_VERSION' : 'CANCELLED'));
        return { state: 'terminal', job: await this.publication.publish(claim, result.output) };
      }
      return this.failed(claim, result);
    } catch (error) {
      if (worker && !terminated) { Atomics.store(cancellation, 0, 1); await worker.terminate(); terminated = true; }
      return this.failed(claim, failure(error instanceof ApiError ? error.code : 'INTERNAL_ERROR'));
    } finally {
      if (timer) clearTimeout(timer); if (interval) clearInterval(interval); await polling;
      // If process death cannot be proven, the SQL lease remains occupied until the 120-second safety ceiling.
      if (terminated || !worker) await this.coordinator.confirmTerminated(claim);
    }
  }
  private async failed(claim: HostedJobClaim, outcome: WorkerOutcome): Promise<HostedRunOutcome> {
    if ('output' in outcome) throw new Error('Expected terminal failure');
    const current = await this.coordinator.reconcileInternal(claim);
    return { state: 'terminal', job: isTerminalJob(current.status) ? current : await this.coordinator.fail(claim, [outcome.diagnostic], outcome.status) };
  }
}
