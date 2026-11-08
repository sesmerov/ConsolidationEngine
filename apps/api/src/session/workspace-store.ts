import { randomUUID } from 'node:crypto';
import { MAX_SNAPSHOTS, SESSION_LIMIT_BYTES, UUID_PATTERN, isTerminalJob } from '@ce/contracts';
import type { JobDTO, JsonValue, PreviewBundle, Snapshot, SnapshotContent, SnapshotPublicationReason, WorkspaceDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash, immutable } from './canonical-state.js';
import { RetainedSize } from './retained-size.js';
import type { InspectionRecord, StateRecord, WorkerOutput } from '../workers/protocol.js';
import { activeReviewKey, releasedReview, reviewKey } from '../recalculation/direction-review-record.js';
import type { ReviewRecord } from '../recalculation/direction-review-record.js';
import { terminalSelection, type ProposalSelectionRecord } from '../recalculation/proposal-selection-record.js';
/** Reserved version identifiers are supplied only by main-thread publication preparation. */
export interface PublicationOutput extends WorkerOutput { readonly snapshotVersionId?: string; readonly snapshotValidationBasisId?: string }

interface WorkspaceState { id: string; name: string; state: 'empty' | 'ready' | 'closed'; sessionId: string; closing?: boolean;
  currentVersionId?: string; versionIds: readonly string[]; activeJobId?: string }
export interface StoreOptions { sessionId?: string; maxBytes?: number; maxSnapshots?: number }
export class WorkspaceStore {
  readonly sessionId: string;
  private workspace: WorkspaceState | undefined;
  private snapshots = new Map<string, Snapshot>();
  private records = new Map<string, unknown>();
  private readonly retained = new RetainedSize();
  private recordRoots = new Map<string, Readonly<{ key: string; value: unknown }>>();
  private readonly maxBytes: number;
  private inspectionInvalidated: ((workspaceId: string) => void) | undefined;
  onInspectionInvalidated(callback: (workspaceId: string) => void): void { this.inspectionInvalidated = callback; }
  private readonly maxSnapshots: number;
  constructor(options: StoreOptions = {}) {
    this.sessionId = options.sessionId ?? randomUUID(); this.maxBytes = options.maxBytes ?? SESSION_LIMIT_BYTES;
    this.maxSnapshots = options.maxSnapshots ?? MAX_SNAPSHOTS;
  }
  create(name: string): WorkspaceDTO {
    if (this.workspace && this.workspace.state !== 'closed') throw new ApiError('ACTIVE_WORKSPACE_EXISTS');
    const workspace: WorkspaceState = { id: randomUUID(), name, state: 'empty', sessionId: this.sessionId, versionIds: [], closing: false };
    const commitSize = this.check(workspace, new Map(), new Map()); commitSize(); this.workspace = workspace; this.snapshots = new Map(); this.records = new Map();
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
      ...(current?.validationBasisId ? { validationBasisId: current.validationBasisId } : {}),
      contexts: current?.content.contexts ?? [], counts: { snapshots: w.versionIds.length, coordinates: current?.content.coordinates.length ?? 0,
        facts: current?.content.facts.length ?? 0, sources: current?.content.sources.length ?? 0 }, sessionBytes: this.bytes });
  }
  get currentWorkspaceId(): string | undefined { return this.workspace?.state === 'closed' ? undefined : this.workspace?.id; }
  get bytes(): number { return this.retained.bytes; }
  get availableBytes(): number { return this.maxBytes - this.bytes; }
  /** Check peak occupancy while an old projection and its replacement are both alive. */
  assertTransientCapacity(extra: readonly unknown[]): void {
    const roots = [...(this.workspace ? [this.workspace] : []), ...this.snapshots.values(), ...this.recordRoots.values(), ...extra];
    if (this.retained.prepare(roots).bytes > this.maxBytes) throw new ApiError('SESSION_LIMIT');
  }
  current(id: string): Snapshot | undefined { const w = this.require(id); return w.currentVersionId ? this.snapshot(id, w.currentVersionId) : undefined; }
  snapshot(id: string, versionId: string): Snapshot { this.require(id); const result = this.snapshots.get(versionId); if (!result) throw new ApiError('RESOURCE_NOT_FOUND'); return result; }
  etag(id: string): string { const version = this.require(id).currentVersionId; return version ? '"v-' + version + '"' : '"empty"'; }
  assertBase(id: string, versionId: string | undefined): void {
    if (this.require(id).currentVersionId !== versionId) throw new ApiError('STALE_VERSION', { expectedVersionId: versionId ?? null, currentVersionId: this.require(id).currentVersionId ?? null });
  }
  assertIdle(id: string): void { if (this.require(id).activeJobId) throw new ApiError('WORKSPACE_BUSY'); }
  assertAccepting(id: string): void { if (this.require(id).closing) throw new ApiError('WORKSPACE_BUSY'); }
  beginClose(id: string): void { const workspace = { ...this.require(id), closing: true }; const commitSize = this.check(workspace, this.snapshots, this.records); commitSize(); this.workspace = workspace; }
  private check(w: WorkspaceState | undefined, snapshots: Map<string, Snapshot>, records: Map<string, unknown>): () => void {
    if (snapshots.size > this.maxSnapshots) throw new ApiError('SESSION_LIMIT');
    const recordRoots = new Map<string, Readonly<{ key: string; value: unknown }>>();
    for (const [key, value] of records) { const prior = this.recordRoots.get(key); recordRoots.set(key, prior && prior.value === value ? prior : Object.freeze({ key, value })); }
    const prepared = this.retained.prepare([...(w ? [w] : []), ...snapshots.values(), ...recordRoots.values()]);
    if (prepared.bytes > this.maxBytes) throw new ApiError('SESSION_LIMIT');
    return () => { prepared.commit(); this.recordRoots = recordRoots; };
  }
  private assertSameValidationInputs(previous: SnapshotContent, next: SnapshotContent): void {
    const excluded = new Set(['configVersion', 'directions', 'directionDecisionState']);
    for (const key of new Set([...Object.keys(previous), ...Object.keys(next)])) {
      if (excluded.has(key)) continue;
      const before = previous[key as keyof SnapshotContent], after = next[key as keyof SnapshotContent];
      if (before === after) continue;
      if (before === undefined || after === undefined || canonicalHash(before) !== canonicalHash(after)) throw new ApiError('INTERNAL_ERROR');
    }
  }
  private candidate(w: WorkspaceState, content: SnapshotContent, versionId: string = randomUUID(), reason: SnapshotPublicationReason = 'import', reservedBasisId?: string): Snapshot {
    if (!UUID_PATTERN.test(versionId) || this.snapshots.has(versionId)) throw new ApiError('INTERNAL_ERROR');
    const previous = w.currentVersionId ? this.snapshots.get(w.currentVersionId) : undefined;
    if (reason === 'configuration') {
      if (!previous || reservedBasisId !== undefined) throw new ApiError('INTERNAL_ERROR');
      this.assertSameValidationInputs(previous.content, content);
    }
    const validationBasisId = reason === 'configuration' ? previous!.validationBasisId ?? previous!.versionId : reservedBasisId ?? randomUUID();
    if (!UUID_PATTERN.test(validationBasisId) || reason !== 'configuration' && validationBasisId === previous?.validationBasisId) throw new ApiError('INTERNAL_ERROR');
    return immutable({ versionId, ...(w.currentVersionId ? { parentVersionId: w.currentVersionId } : {}),
      validationBasisId, contentHash: canonicalHash(content), createdAt: new Date().toISOString(), content: immutable(content) });
  }
  publish(id: string, base: string | undefined, content: SnapshotContent, additions: readonly StateRecord[] = [], reason: SnapshotPublicationReason = 'import'): Snapshot {
    this.assertBase(id, base); const w = this.require(id); const snapshot = this.candidate(w, content, undefined, reason);
    const next = { ...w, state: 'ready' as const, currentVersionId: snapshot.versionId, versionIds: [...w.versionIds, snapshot.versionId] };
    const snapshots = new Map(this.snapshots).set(snapshot.versionId, snapshot); const records = this.invalidateInspections(this.obsoletePreviews(this.withRecords(additions), snapshot.versionId), snapshot.versionId);
    this.invalidateDirectionReview(records, id, snapshot.versionId);
    const commitSize = this.check(next, snapshots, records); commitSize(); this.workspace = next; this.snapshots = snapshots; this.records = records; this.inspectionInvalidated?.(id); return snapshot;
  }
  private withRecords(additions: readonly StateRecord[]): Map<string, unknown> {
    const records = new Map(this.records);
    for (const entry of additions) {
      if (entry.key.startsWith('job:') || entry.key.startsWith('reserve:') || entry.key.startsWith('operation:') || entry.key.startsWith('operation-receipt:') || entry.key.startsWith('idempotency:')) throw new ApiError('INTERNAL_ERROR');
      records.set(entry.key, immutable(entry.value));
    }
    return records;
  }
  private invalidateDirectionReview(records: Map<string, unknown>, workspaceId: string, versionId: string): void {
    const active = activeReviewKey(workspaceId), id = records.get(active);
    if (typeof id !== 'string') return;
    const key = reviewKey(workspaceId, id), prior = records.get(key) as ReviewRecord | undefined;
    if (!prior || prior.summary.baseVersionId === versionId) return;
    records.set(key, immutable(releasedReview(prior, 'obsolete')));
    records.delete(active);
  }
  putRecords(additions: readonly StateRecord[]): void { const records = this.withRecords(additions); const commitSize = this.check(this.workspace, this.snapshots, records); commitSize(); this.records = records; }
  getRecord<T = unknown>(key: string): T | undefined { return this.records.get(key) as T | undefined; }
  listRecords<T>(prefix: string): readonly { key: string; value: T }[] { return [...this.records].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, value: value as T })); }
  private obsoletePreviews(records: Map<string, unknown>, versionId: string): Map<string, unknown> {
    for (const [key, value] of records) if (key.startsWith('preview:')) {
      const bundle = value as PreviewBundle;
      if (bundle.preview?.state === 'ready' && bundle.preview.baseVersionId !== versionId) records.set(key, immutable({ ...bundle,
        preview: { ...bundle.preview, state: 'obsolete' }, proposals: bundle.proposals.map(proposal => proposal.state === 'available' ? { ...proposal, state: 'obsolete' } : proposal) }));
    }
    for (const [key, value] of records) if (key.startsWith('proposal-selection:')) {
      const selection = value as ProposalSelectionRecord;
      if (selection.summary.baseVersionId !== versionId && !['applied', 'discarded', 'obsolete'].includes(selection.summary.state)) {
        const { pendingJobId: _pending, ...summary } = selection.summary;
        records.set(key, immutable(selection.projection ? terminalSelection(selection, 'obsolete') : { summary: { ...summary, state: 'failed' } }));
      }
    }
    for (const key of records.keys()) if (key.startsWith('proposal-selection-cache:')) records.delete(key);
    return records;
  }
  private invalidateInspections(records: Map<string, unknown>, versionId: string): Map<string, unknown> {
    for (const [key, value] of records) if (key.startsWith('inspection:')) {
      const record = value as InspectionRecord;
      if (record.inspection?.state === 'ready' && record.inspection.baseVersionId !== versionId) records.set(key, immutable({
        inspection: { ...record.inspection, state: 'invalidated', profiles: [], context: [], reports: [], diagnostics: [] },
        ...(record.files?.length ? { cleanupFileIds: record.files.map(file => file.id) } : {}),
      }));
    }
    return records;
  }
  putInternalRecord(key: string, value: unknown): void {
    this.putInternalRecords([{ key, value }]);
  }
  /** Single quota-checked publication for coupled internal indexes; no partial receipt survives a failure. */
  putInternalRecords(additions: readonly { readonly key: string; readonly value: unknown }[], removals: readonly string[] = []): void {
    const records = new Map(this.records);
    for (const key of removals) records.delete(key);
    for (const { key, value } of additions) records.set(key, immutable(value));
    const commitSize = this.check(this.workspace, this.snapshots, records); commitSize(); this.records = records;
  }
  deleteInternalRecord(key: string): void { this.putInternalRecords([], [key]); }
  job(id: string, jobId: string): JobDTO {
    this.require(id); const job = this.getRecord<JobDTO>('job:' + jobId);
    if (!job || job.workspaceId !== id) throw new ApiError('RESOURCE_NOT_FOUND'); return job;
  }
  registerJob(job: JobDTO, additions: readonly StateRecord[] = [], retainedState?: JsonValue): void {
    this.assertAccepting(job.workspaceId); this.assertIdle(job.workspaceId); this.assertBase(job.workspaceId, job.baseVersionId);
    const w = { ...this.require(job.workspaceId), activeJobId: job.jobId }; const records = this.withRecords(additions).set('job:' + job.jobId, immutable(job));
    // Account an actual retained reserve so terminal diagnostics fit even when the candidate exhausts the quota.
    records.set('reserve:' + job.jobId, ' '.repeat(4096));
    if (retainedState !== undefined) records.set('operation:' + job.jobId, immutable(retainedState));
    const commitSize = this.check(w, this.snapshots, records); commitSize(); this.workspace = w; this.records = records;
  }
  updateJob(job: JobDTO, additions: readonly StateRecord[] = []): void {
    const prior = this.job(job.workspaceId, job.jobId); if (isTerminalJob(prior.status)) return;
    const records = this.withRecords(additions).set('job:' + job.jobId, immutable(job)); let w = this.require(job.workspaceId);
    if (isTerminalJob(job.status)) { records.delete('reserve:' + job.jobId); records.delete('operation:' + job.jobId); const { activeJobId: _active, ...rest } = w; w = rest; }
    const commitSize = this.check(w, this.snapshots, records); commitSize(); this.workspace = w; this.records = records;
  }
  publishJobResult(job: JobDTO, output: PublicationOutput, assertCommit: () => void = () => undefined): JobDTO {
    this.assertAccepting(job.workspaceId); this.assertBase(job.workspaceId, job.baseVersionId); let w = this.require(job.workspaceId);
    if (w.activeJobId !== job.jobId || this.job(job.workspaceId, job.jobId).status !== 'running' || !output.complete) throw new ApiError('INTERNAL_ERROR');
    if (job.kind === 'apply') {
      if (!output.applicationCandidate || !output.snapshotContent || !output.snapshotVersionId || !output.snapshotValidationBasisId) throw new ApiError('INTERNAL_ERROR');
    } else if (job.kind === 'commit-directions') {
      if (!output.snapshotVersionId || !output.snapshotContent || output.applicationCandidate) throw new ApiError('INTERNAL_ERROR');
    } else if (output.snapshotVersionId !== undefined || output.applicationCandidate !== undefined) throw new ApiError('INTERNAL_ERROR');
    if (job.kind !== 'apply' && output.snapshotValidationBasisId !== undefined) throw new ApiError('INTERNAL_ERROR');
    let records = this.withRecords(output.records ?? []); const snapshots = new Map(this.snapshots);
    const reason = job.kind === 'apply' ? 'application' : job.kind === 'commit-directions' ? 'configuration' : 'import';
    const snapshot = output.snapshotContent ? this.candidate(w, output.snapshotContent, output.snapshotVersionId, reason, output.snapshotValidationBasisId) : undefined;
    if (snapshot) { snapshots.set(snapshot.versionId, snapshot); records = this.invalidateInspections(this.obsoletePreviews(records, snapshot.versionId), snapshot.versionId); this.invalidateDirectionReview(records, w.id, snapshot.versionId); w = { ...w, state: 'ready', currentVersionId: snapshot.versionId, versionIds: [...w.versionIds, snapshot.versionId] }; }
    if (snapshot && job.kind === 'import') for (const [key, value] of records) if (key.startsWith(`inspection:${job.workspaceId}:`)) {
      const record = value as InspectionRecord;
      if (record.inspection.state === 'committed' && record.inspection.commitJobId === job.jobId && !record.inspection.committedVersionId)
        records.set(key, immutable({ ...record, inspection: { ...record.inspection, committedVersionId: snapshot.versionId } }));
    }
    const result: JobDTO = immutable({ ...job, status: 'succeeded', endedAt: new Date().toISOString(), progress: { ...job.progress, complete: true },
      ...(snapshot ? { newVersionId: snapshot.versionId } : {}), ...(output.resultRef ? { resultRef: output.resultRef } : {}), diagnostics: output.diagnostics ?? [] });
    records.set('job:' + job.jobId, result); records.delete('reserve:' + job.jobId); records.delete('operation:' + job.jobId);
    const { activeJobId: _active, ...next } = w;
    const commitSize = this.check(next, snapshots, records); assertCommit(); commitSize(); this.workspace = next; this.snapshots = snapshots; this.records = records;
    if (snapshot) this.inspectionInvalidated?.(job.workspaceId); return result;
  }
  close(id: string): void {
    this.assertIdle(id); const w = this.require(id); const next: WorkspaceState = { id: w.id, name: w.name, sessionId: w.sessionId, state: 'closed', versionIds: [] };
    const commitSize = this.check(next, new Map(), new Map()); commitSize(); this.workspace = next; this.snapshots = new Map(); this.records = new Map();
  }
}
