import { randomUUID } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { ERROR_MESSAGES, JOB_DEADLINE_MS, isTerminalJob } from '@ce/contracts';
import type { JobDTO, JobKind, JsonValue, OperationReservationDTO, ResultRef } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { WorkLimitError } from '@ce/engine';
import type { PublicationOutput, WorkspaceStore } from '../session/workspace-store.js';
import type { StateRecord, WorkerMessage, WorkerOutput, WorkerRequest } from '../workers/protocol.js';
import { receivedDiagnostic } from '../public-diagnostic.js';
import type { AcceptedJobReference, JobDispatcher } from '../ports/job-dispatcher.js';
import { LocalJobDispatcher } from '../local/local-job-dispatcher.js';

export type WorkerHandle = Pick<Worker, 'on' | 'terminate'>;
export type WorkerFactory = (request: WorkerRequest) => WorkerHandle;
export interface JobManagerOptions {
  workerFactory?: WorkerFactory; workerModules?: Partial<Record<JobKind, URL>>; deadlineMs?: number; workerEntry?: URL;
}
export interface JobAcceptance { input?: JsonValue; initialRecords?: readonly StateRecord[]; resultRef?: ResultRef; includeSnapshot?: boolean;
  /** Reserved IDs exposed through a receipt, never as an already-published job result. */
  reservation?: OperationReservationDTO;
  retainedState?: JsonValue;
  /** Final synchronous resource CAS after asynchronous acceptance and before publishing initial records. */
  assertStart?: () => void;
  preparePublication?: (job: JobDTO, output: WorkerOutput) => { output: PublicationOutput; assertCommit?: () => void } | Promise<{ output: PublicationOutput; assertCommit?: () => void }>;
  onTerminal?: (job: JobDTO) => readonly StateRecord[]; finalize?: () => Promise<void> }
export interface StartJob extends JobAcceptance { workspaceId: string; kind: JobKind; baseVersionId?: string; input: JsonValue; jobId?: string }
interface Running extends Pick<JobAcceptance, 'onTerminal' | 'includeSnapshot' | 'finalize' | 'preparePublication'> { input: JsonValue; cancellation: Int32Array; worker?: WorkerHandle; timer?: NodeJS.Timeout; expiresAt: number; stopping: boolean; publishing?: boolean; stopPromise?: Promise<JobDTO> }
class DeadlineElapsed extends Error {}
export class JobManager {
  readonly dispatcher: JobDispatcher;
  private readonly running = new Map<string, Running>();
  private readonly terminations = new Set<Promise<unknown>>();
  private readonly settling = new Map<string, Promise<unknown>>();
  private readonly factory: WorkerFactory;
  private readonly deadlineMs: number;
  private readonly modules: Partial<Record<JobKind, URL>>;
  private disposed = false;
  constructor(readonly store: WorkspaceStore, options: JobManagerOptions = {}) {
    this.dispatcher = new LocalJobDispatcher(reference => this.deliver(reference));
    this.deadlineMs = options.deadlineMs ?? JOB_DEADLINE_MS;
    if (this.deadlineMs <= 0 || this.deadlineMs > JOB_DEADLINE_MS) throw new Error('Invalid worker deadline.');
    this.modules = options.workerModules ?? {};
    this.factory = options.workerFactory ?? ((request) => {
      const worker = new Worker(options.workerEntry ?? new URL('../workers/operation-worker.js', import.meta.url), {
        workerData: request, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 }, stdout: true, stderr: true,
      });
      worker.stdout.resume(); worker.stderr.resume(); return worker;
    });
  }
  start(input: StartJob): JobDTO {
    if (this.disposed) throw new ApiError('RESOURCE_NOT_FOUND');
    const job: JobDTO = { jobId: input.jobId ?? randomUUID(), workspaceId: input.workspaceId, kind: input.kind, status: 'queued',
      ...(input.baseVersionId ? { baseVersionId: input.baseVersionId } : {}), ...(input.resultRef ? { resultRef: input.resultRef } : {}), progress: { completed: 0, total: 0, complete: false }, diagnostics: [], pollAfterMs: 1000 };
    input.assertStart?.();
    this.store.registerJob(job, input.initialRecords, input.retainedState);
    const running: Running = { input: input.input, cancellation: new Int32Array(new SharedArrayBuffer(4)), expiresAt: Infinity, stopping: false, ...(input.finalize ? { finalize: input.finalize } : {}),
      ...(input.onTerminal ? { onTerminal: input.onTerminal } : {}), ...(input.preparePublication ? { preparePublication: input.preparePublication } : {}), ...(input.includeSnapshot !== undefined ? { includeSnapshot: input.includeSnapshot } : {}) };
    this.running.set(job.jobId, running);
    void this.dispatcher.dispatch({ sessionId: this.store.sessionId, workspaceId: job.workspaceId, jobId: job.jobId }).catch(error => this.fail(job, error));
    return this.get(job.workspaceId, job.jobId);
  }
  get(workspaceId: string, jobId: string): JobDTO { return this.store.job(workspaceId, jobId); }
  private deliver(reference: AcceptedJobReference): void {
    if (reference.sessionId !== this.store.sessionId) throw new ApiError('RESOURCE_NOT_FOUND');
    const job = this.get(reference.workspaceId, reference.jobId);
    // Transport duplicates are harmless; the accepted job is the authority.
    if (job.status !== 'queued') return;
    const running = this.running.get(job.jobId);
    if (!running) throw new ApiError('RESOURCE_NOT_FOUND');
    this.begin(job, running.input, running);
  }
  private begin(queued: JobDTO, input: JsonValue, running: Running): void {
    if (running.stopping || this.disposed) return;
    try {
      const now = Date.now(); running.expiresAt = now + this.deadlineMs;
      const job: JobDTO = { ...queued, status: 'running', startedAt: new Date(now).toISOString(), deadline: new Date(running.expiresAt).toISOString() };
      this.store.updateJob(job);
      const snapshot = job.baseVersionId && running.includeSnapshot !== false ? this.store.snapshot(job.workspaceId, job.baseVersionId) : undefined;
      const moduleUrl = this.modules[job.kind]?.href;
      const request: WorkerRequest = { job, input, cancellation: running.cancellation.buffer as SharedArrayBuffer,
        ...(snapshot ? { snapshot } : {}), ...(moduleUrl ? { moduleUrl } : {}) };
      const worker = this.factory(request); running.worker = worker;
      running.timer = setTimeout(() => { void this.stop(job, 'timed_out'); }, this.deadlineMs);
      worker.on('message', (message: unknown) => { void this.message(job, running, message); });
      worker.on('error', () => { this.fail(job, new ApiError('INTERNAL_ERROR')); });
      worker.on('exit', () => {
        if (!running.stopping && !running.publishing && !isTerminalJob(this.get(job.workspaceId, job.jobId).status)) this.fail(job, new ApiError('INTERNAL_ERROR'));
      });
    } catch (error) { this.fail(queued, error); }
  }
  private async message(original: JobDTO, running: Running, value: unknown): Promise<void> {
    if (running.stopping || running.publishing || Atomics.load(running.cancellation, 0) || isTerminalJob(this.get(original.workspaceId, original.jobId).status)) return;
    if (Date.now() >= running.expiresAt) { void this.stop(original, 'timed_out'); return; }
    try {
      if (!value || typeof value !== 'object' || !('type' in value)) throw new ApiError('INTERNAL_ERROR');
      const message = value as WorkerMessage; const job = this.get(original.workspaceId, original.jobId);
      if (message.type === 'progress') {
        if (!Number.isSafeInteger(message.completed) || !Number.isSafeInteger(message.total) || message.completed < 0 || message.total < message.completed) throw new ApiError('INTERNAL_ERROR');
        this.store.updateJob({ ...job, progress: { completed: message.completed, total: message.total, complete: false } });
      } else if (message.type === 'result') {
        if (message.output?.complete === false) {
          const failed: JobDTO = { ...job, status: 'failed', endedAt: new Date().toISOString(), progress: { ...job.progress, complete: false }, diagnostics: (message.output.diagnostics ?? []).map(receivedDiagnostic) };
          this.store.updateJob(failed, running.onTerminal?.(failed)); this.cleanup(job.jobId); return;
        }
        if (!message.output || message.output.complete !== true) throw new ApiError('INTERNAL_ERROR');
        // All three guards run again immediately before the synchronous main-thread commit.
        this.store.assertBase(job.workspaceId, job.baseVersionId);
        if (Atomics.load(running.cancellation, 0)) return;
        if (Date.now() >= running.expiresAt) { void this.stop(job, 'timed_out'); return; }
        running.publishing = true;
        const prepared = running.preparePublication?.(job, message.output) ?? { output: message.output };
        // Keep the legacy synchronous publication boundary; only cooperative preparation yields.
        const publication: { output: PublicationOutput; assertCommit?: () => void } = prepared instanceof Promise ? await prepared : prepared;
        if (running.stopping || Atomics.load(running.cancellation, 0) || isTerminalJob(this.get(original.workspaceId, original.jobId).status)) return;
        this.store.publishJobResult(job, publication.output, () => {
          this.store.assertBase(job.workspaceId, job.baseVersionId);
          if (Date.now() >= running.expiresAt) throw new DeadlineElapsed();
          if (Atomics.load(running.cancellation, 0)) throw new ApiError('INTERNAL_ERROR');
          publication.assertCommit?.();
        });
        this.cleanup(job.jobId);
      } else if (message.type === 'failure') {
        const failed: JobDTO = { ...job, status: 'failed', endedAt: new Date().toISOString(), progress: { ...job.progress, complete: false }, diagnostics: [receivedDiagnostic(message.diagnostic)] };
        this.store.updateJob(failed, running.onTerminal?.(failed));
        this.cleanup(job.jobId);
      } else throw new ApiError('INTERNAL_ERROR');
    } catch (error) { if (error instanceof DeadlineElapsed) void this.stop(original, 'timed_out'); else this.fail(original, error); }
  }
  private fail(original: JobDTO, error: unknown): void {
    const running = this.running.get(original.jobId); if (!running || running.stopping) return;
    const current = this.get(original.workspaceId, original.jobId); if (isTerminalJob(current.status)) return;
    const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
    // Preserve the finite policy explanation at main-thread rejection as well as at worker rejection.
    const policyDiagnostics = error instanceof ApiError && code === 'INVALID_DIRECTION' && error.details.reason === 'RULE_VALIDATION_ONLY'
      ? [receivedDiagnostic({ code: 'RULE_VALIDATION_ONLY' })] : [];
    const failure = error instanceof WorkLimitError ? receivedDiagnostic({ code: error.code }) : { code, message: ERROR_MESSAGES[code] };
    const failed: JobDTO = { ...current, status: 'failed', endedAt: new Date().toISOString(), progress: { ...current.progress, complete: false }, diagnostics: [failure] };
    const explained: JobDTO = policyDiagnostics.length ? { ...failed, diagnostics: [...failed.diagnostics, ...policyDiagnostics] } : failed;
    this.store.updateJob(explained, running.onTerminal?.(explained));
    this.cleanup(original.jobId);
  }
  private cleanup(id: string): void {
    const running = this.running.get(id); if (!running) return;
    running.stopping = true; Atomics.store(running.cancellation, 0, 1); if (running.timer) clearTimeout(running.timer);
    const termination = (async () => { await running.worker?.terminate().catch(() => undefined); await running.finalize?.(); })();
    this.terminations.add(termination); this.settling.set(id, termination);
    void termination.then(() => { this.terminations.delete(termination); this.settling.delete(id); }, () => { /* Retain cleanup failure for settle/close; never create an unhandled rejection. */ });
    this.running.delete(id);
  }
  private stop(original: JobDTO, status: 'cancelled' | 'timed_out'): Promise<JobDTO> {
    const running = this.running.get(original.jobId);
    if (running?.stopPromise) return running.stopPromise;
    if (!running || isTerminalJob(this.get(original.workspaceId, original.jobId).status)) return Promise.resolve(this.get(original.workspaceId, original.jobId));
    running.stopping = true; Atomics.store(running.cancellation, 0, 1); if (running.timer) clearTimeout(running.timer);
    running.stopPromise = (async () => {
      if (running.worker) await running.worker.terminate().catch(() => undefined);
      await running.finalize?.();
      const current = this.get(original.workspaceId, original.jobId);
      const result: JobDTO = isTerminalJob(current.status) ? current : { ...current, status, endedAt: new Date().toISOString(), progress: { ...current.progress, complete: false },
        diagnostics: status === 'timed_out' ? [{ code: 'JOB_TIMEOUT', message: 'El trabajo superó el plazo de ejecución y quedó incompleto.' }] : [] };
      if (!isTerminalJob(current.status)) this.store.updateJob(result, running.onTerminal?.(result));
      this.running.delete(original.jobId); return result;
    })();
    return running.stopPromise;
  }
  async cancel(workspaceId: string, jobId: string): Promise<JobDTO> { return this.stop(this.get(workspaceId, jobId), 'cancelled'); }
  async cancelActive(workspaceId: string): Promise<void> {
    const id = this.store.get(workspaceId).activeJobId; if (id) await this.cancel(workspaceId, id);
    await Promise.all(this.terminations);
  }
  async settle(jobId: string): Promise<void> { await this.settling.get(jobId); }
  async dispose(): Promise<void> {
    this.disposed = true; const id = this.store.currentWorkspaceId; if (id) await this.cancelActive(id);
  }
}
