import { randomUUID } from 'node:crypto';
import { MAX_SNAPSHOTS, SESSION_LIMIT_BYTES, isTerminalJob } from '@ce/contracts';
import type { JobDTO, Snapshot, SnapshotContent, WorkspaceDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash, canonicalStateBytes, immutable } from './canonical-state.js';
import type { StateRecord, WorkerOutput } from '../workers/protocol.js';

interface WorkspaceState { id: string; name: string; state: 'empty' | 'ready' | 'closed'; sessionId: string; closing?: boolean;
  currentVersionId?: string; versionIds: readonly string[]; activeJobId?: string }
export interface StoreOptions { sessionId?: string; maxBytes?: number; maxSnapshots?: number }
export class WorkspaceStore {
  readonly sessionId: string;
  private workspace: WorkspaceState | undefined;
  private snapshots = new Map<string, Snapshot>();
  private records = new Map<string, unknown>();
  private readonly maxBytes: number;
  private readonly maxSnapshots: number;
  constructor(options: StoreOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID(); this.maxBytes = options.maxBytes ?? SESSION_LIMIT_BYTES;
    this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
  }
  create(name: string): WorkspaceDTO {
    if (this.workspace && this.workspace.state !== 'closed') throw new ApiError('ACTIVE_WORKSPACE_EXISTS');
    const workspace: WorkspaceState = { id: randomUUID(), name, state: 'empty', sessionId: this.sessionId, versionIds: [] };
    this.check(workspace, new Map(), new Map()); this.workspace = workspace; this.snapshots = new Map(); this.records = new Map();
    return this.get(workspace.id);
  }
  private require(id: string): WorkspaceState {
    if (!this.workspace || this.workspace.id !== id || this.workspace.state === 'closed') throw new ApiError('RESOURCE_NOT_FOUND');
    return this.workspace;
  }
  get(id: string): WorkspaceDTO {
    const w = this.require(id); const current = w.currentVersionId ? this.snapshots.get(w.currentVersionId) : undefined;
    return immutable({ id: w.id, name: w.name, state: w.state, versionIds: w.versionIds,
      ...(w.currentVersionId ? { currentVersionId: w.currentVersionId } : {}), ...(w.activeJobId ? { activeJobId: w.activeJobId } : {}),
      contexts: current?.content.contexts ?? [], counts: { snapshots: w.versionIds.length, coordinates: current?.content.coordinates.length ?? 0,
        facts: current?.content.facts.length ?? 0, sources: current?.content.sources.length ?? 0 }, sessionBytes: this.bytes });
  }
  get currentWorkspaceId(): string | undefined { return this.workspace?.state === 'closed' ? undefined : this.workspace?.id; }
  get bytes(): number { return this.size(this.workspace, this.snapshots, this.records); }
  current(id: string): Snapshot | undefined { const w = this.require(id); return w.currentVersionId ? this.snapshot(id, w.currentVersionId) : undefined; }
  snapshot(id: string, versionId: string): Snapshot { this.require(id); const result = this.snapshots.get(versionId); if (!result) throw new ApiError('RESOURCE_NOT_FOUND'); return result; }
  etag(id: string): string { const version = this.require(id).currentVersionId; return version ? '"v-' + version + '"' : '"empty"'; }
  assertBase(id: string, versionId: string | undefined): void {
    if (this.require(id).currentVersionId !== versionId) throw new ApiError('STALE_VERSION', { expectedVersionId: versionId ?? null, currentVersionId: this.require(id).currentVersionId ?? null });
  }
  assertIdle(id: string): void { if (this.require(id).activeJobId) throw new ApiError('WORKSPACE_BUSY'); }
  assertAccepting(id: string): void { if (this.require(id).closing) throw new ApiError('WORKSPACE_BUSY'); }
  beginClose(id: string): void { this.workspace = { ...this.require(id), closing: true }; }
  private size(w: WorkspaceState | undefined, snapshots: Map<string, Snapshot>, records: Map<string, unknown>): number {
    return canonicalStateBytes([...(w ? [w] : []), ...snapshots.values(), ...Array.from(records, ([key, value]) => ({ key, value }))]);
  }
  private check(w: WorkspaceState | undefined, snapshots: Map<string, Snapshot>, records: Map<string, unknown>): void {
    if (snapshots.size > this.maxSnapshots || this.size(w, snapshots, records) > this.maxBytes) throw new ApiError('SESSION_LIMIT');
  }
  private candidate(w: WorkspaceState, content: SnapshotContent): Snapshot {
    return immutable({ versionId: randomUUID(), ...(w.currentVersionId ? { parentVersionId: w.currentVersionId } : {}),
      contentHash: canonicalHash(content), createdAt: new Date().toISOString(), content: immutable(content) });
  }
  publish(id: string, base: string | undefined, content: SnapshotContent, additions: readonly StateRecord[] = []): Snapshot {
    this.assertBase(id, base); const w = this.require(id); const snapshot = this.candidate(w, content);
    const next = { ...w, state: 'ready' as const, currentVersionId: snapshot.versionId, versionIds: [...w.versionIds, snapshot.versionId] };
    const snapshots = new Map(this.snapshots).set(snapshot.versionId, snapshot); const records = this.withRecords(additions);
    this.check(next, snapshots, records); this.workspace = next; this.snapshots = snapshots; this.records = records; return snapshot;
  }
  private withRecords(additions: readonly StateRecord[]): Map<string, unknown> {
    const records = new Map(this.records);
    for (const entry of additions) {
      if (entry.key.startsWith('job:') || entry.key.startsWith('reserve:') || entry.key.startsWith('idempotency:')) throw new ApiError('INTERNAL_ERROR');
      records.set(entry.key, immutable(entry.value));
    }
    return records;
  }
  putRecords(additions: readonly StateRecord[]): void { const records = this.withRecords(additions); this.check(this.workspace, this.snapshots, records); this.records = records; }
  getRecord<T = unknown>(key: string): T | undefined { return this.records.get(key) as T | undefined; }
  putInternalRecord(key: string, value: unknown): void {
    const records = new Map(this.records).set(key, immutable(value)); this.check(this.workspace, this.snapshots, records); this.records = records;
  }
  deleteInternalRecord(key: string): void { const records = new Map(this.records); records.delete(key); this.records = records; }
  job(id: string, jobId: string): JobDTO {
    this.require(id); const job = this.getRecord<JobDTO>('job:' + jobId);
    if (!job || job.workspaceId !== id) throw new ApiError('RESOURCE_NOT_FOUND'); return job;
  }
  registerJob(job: JobDTO, additions: readonly StateRecord[] = []): void {
    this.assertAccepting(job.workspaceId); this.assertIdle(job.workspaceId); this.assertBase(job.workspaceId, job.baseVersionId);
    const w = { ...this.require(job.workspaceId), activeJobId: job.jobId }; const records = this.withRecords(additions).set('job:' + job.jobId, immutable(job));
    // Account an actual retained reserve so terminal diagnostics fit even when the candidate exhausts the quota.
    records.set('reserve:' + job.jobId, ' '.repeat(4096)); this.check(w, this.snapshots, records); this.workspace = w; this.records = records;
  }
  updateJob(job: JobDTO, additions: readonly StateRecord[] = []): void {
    const prior = this.job(job.workspaceId, job.jobId); if (isTerminalJob(prior.status)) return;
    const records = this.withRecords(additions).set('job:' + job.jobId, immutable(job)); let w = this.require(job.workspaceId);
    if (isTerminalJob(job.status)) { records.delete('reserve:' + job.jobId); const { activeJobId: _active, ...rest } = w; w = rest; }
    this.check(w, this.snapshots, records); this.workspace = w; this.records = records;
  }
  publishJobResult(job: JobDTO, output: WorkerOutput, assertCommit: () => void = () => undefined): JobDTO {
    this.assertAccepting(job.workspaceId); this.assertBase(job.workspaceId, job.baseVersionId); let w = this.require(job.workspaceId);
    if (w.activeJobId !== job.jobId || this.job(job.workspaceId, job.jobId).status !== 'running' || !output.complete) throw new ApiError('INTERNAL_ERROR');
    const records = this.withRecords(output.records ?? []); const snapshots = new Map(this.snapshots);
    const snapshot = output.snapshotContent ? this.candidate(w, output.snapshotContent) : undefined;
    if (snapshot) { snapshots.set(snapshot.versionId, snapshot); w = { ...w, state: 'ready', currentVersionId: snapshot.versionId, versionIds: [...w.versionIds, snapshot.versionId] }; }
    const result: JobDTO = immutable({ ...job, status: 'succeeded', endedAt: new Date().toISOString(), progress: { ...job.progress, complete: true },
      ...(snapshot ? { newVersionId: snapshot.versionId } : {}), ...(output.resultRef ? { resultRef: output.resultRef } : {}), diagnostics: output.diagnostics ?? [] });
    records.set('job:' + job.jobId, result); records.delete('reserve:' + job.jobId);
    const { activeJobId: _active, ...next } = w;
    this.check(next, snapshots, records); assertCommit(); this.workspace = next; this.snapshots = snapshots; this.records = records; return result;
  }
  close(id: string): void {
    this.assertIdle(id); const w = this.require(id); this.workspace = { id: w.id, name: w.name, sessionId: w.sessionId, state: 'closed', versionIds: [] };
    this.snapshots = new Map(); this.records = new Map();
  }
}
