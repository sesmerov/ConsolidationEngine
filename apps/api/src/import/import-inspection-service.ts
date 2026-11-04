import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { IMPORT_INSPECTION_TTL_MS, LANGUAGE_PROFILE_V2, validateProfileValues } from '@ce/contracts';
import type { ImportContextInputDTO, ImportInspectionCommitDTO, ImportInspectionDTO, JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { JobAcceptance } from '../jobs/job-manager.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import type { SessionFiles } from '../storage/session-files.js';
import type { InspectionRecord, StateRecord } from '../workers/protocol.js';
import type { StagedFile, StagedUpload } from './multipart-staging.js';
export const inspectionKey = (workspaceId: string, inspectionId: string) => `inspection:${workspaceId}:${inspectionId}`;
const asState = (key: string, value: InspectionRecord): StateRecord => ({ key, value: value as unknown as JsonValue });
function released(record: InspectionRecord, state: ImportInspectionDTO['state'], extra: Partial<ImportInspectionDTO> = {}): InspectionRecord {
  return { inspection: { ...record.inspection, state, profiles: [], context: [], reports: [], diagnostics: [], ...extra },
    ...((record.files?.length || record.cleanupFileIds?.length) ? { cleanupFileIds: record.files?.map(file => file.id) ?? record.cleanupFileIds! } : {}) };
}
/** Business state lives exclusively in the quota-accounted store. Timers/promises only coordinate cleanup. */
export class ImportInspectionService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly cleaning = new Map<string, Promise<void>>();
  private disposed = false;
  constructor(private readonly store: WorkspaceStore, private readonly files: SessionFiles, private readonly options: { now?: () => number } = {}) {
    store.onInspectionInvalidated(workspaceId => { this.queueCleanup(workspaceId); });
  }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private records(workspaceId: string) { this.store.get(workspaceId); return this.store.listRecords<InspectionRecord>(`inspection:${workspaceId}:`); }
  private record(workspaceId: string, id: string): InspectionRecord {
    this.store.get(workspaceId); const record = this.store.getRecord<InspectionRecord>(inspectionKey(workspaceId, id));
    if (!record || record.inspection.workspaceId !== workspaceId) throw new ApiError('RESOURCE_NOT_FOUND'); return record;
  }
  private expire(workspaceId: string): void {
    const updates = this.records(workspaceId).flatMap(({ key, value }) => {
      if (value.inspection.state !== 'ready') return [];
      const state = value.inspection.baseVersionId !== this.store.current(workspaceId)?.versionId ? 'invalidated' : this.now() >= Date.parse(value.inspection.expiresAt) ? 'expired' : undefined;
      return state ? [asState(key, released(value, state))] : [];
    });
    if (updates.length) this.store.putRecords(updates);
    this.queueCleanup(workspaceId);
  }
  private queueCleanup(workspaceId: string): void {
    if (this.disposed || this.cleaning.has(workspaceId)) return;
    const work = Promise.resolve().then(async () => {
      for (;;) {
      const pending = this.records(workspaceId).filter(row => row.value.cleanupFileIds?.length); if (!pending.length) break;
      for (const { key, value } of pending) {
        await this.files.removeFiles(workspaceId, value.cleanupFileIds!);
        if (this.store.getRecord(key) === value) this.store.putRecords([asState(key, { inspection: value.inspection })]);
      }
      }
    });
    this.cleaning.set(workspaceId, work);
    void work.then(() => { if (this.cleaning.get(workspaceId) === work) this.cleaning.delete(workspaceId); }, () => { /* settle reports failure before closing owned files. */ });
  }
  async settle(workspaceId: string): Promise<void> { await this.cleaning.get(workspaceId); }
  private schedule(workspaceId: string): void {
    if (this.timer) clearTimeout(this.timer); if (this.disposed) return;
    const ready = this.records(workspaceId).find(row => row.value.inspection.state === 'ready')?.value;
    if (ready) { this.timer = setTimeout(() => { this.expire(workspaceId); }, Math.max(1, Date.parse(ready.inspection.expiresAt) - this.now())); this.timer.unref(); }
  }
  async active(workspaceId: string): Promise<ImportInspectionDTO | null> {
    this.expire(workspaceId); await this.settle(workspaceId);
    return this.records(workspaceId).find(row => ['ready', 'committing'].includes(row.value.inspection.state))?.value.inspection ?? null;
  }
  async get(workspaceId: string, id: string): Promise<ImportInspectionDTO> { this.expire(workspaceId); await this.settle(workspaceId); return this.record(workspaceId, id).inspection; }
  async assertAvailable(workspaceId: string): Promise<void> { if (await this.active(workspaceId)) throw new ApiError('IMPORT_INSPECTION_EXISTS'); }
  async cleanupStaged(workspaceId: string, id: string, staged: StagedUpload): Promise<void> {
    const record = this.store.getRecord<InspectionRecord>(inspectionKey(workspaceId, id));
    if (!record?.files || !['ready', 'committing'].includes(record.inspection.state)) await staged.cleanup();
  }
  prepareInspection(workspaceId: string, id: string, staged: { files: readonly StagedFile[]; context: ImportContextInputDTO }, baseVersionId?: string): JobAcceptance {
    const key = inspectionKey(workspaceId, id);
    return { includeSnapshot: false,
      preparePublication: (_job, output) => {
        const candidate = output.inspectionCandidate;
        if (!candidate || output.snapshotContent || output.records || candidate.content.profileId !== LANGUAGE_PROFILE_V2 || candidate.profiles.length !== 1 || candidate.reports.length !== staged.files.filter(file => file.kind === 'report').length
          || candidate.content.directions.length || validateProfileValues(candidate.content).length) throw new ApiError('INTERNAL_ERROR');
        if (canonicalHash(candidate.content.sources.map(({ id, sha256, size, displayName, kind }) => ({ id, sha256, size, displayName, kind }))) !== canonicalHash(staged.files.map(({ id, sha256, size, displayName, kind }) => ({ id, sha256, size, displayName, kind })))) throw new ApiError('INTERNAL_ERROR');
        if (this.records(workspaceId).some(row => ['ready', 'committing'].includes(row.value.inspection.state))) throw new ApiError('IMPORT_INSPECTION_EXISTS');
        const now = this.now(), inspectionHash = canonicalHash({ baseVersionId: baseVersionId ?? null, inputs: staged.files.map(({ kind, sha256, size, displayName }) => ({ kind, sha256, size, displayName })), declaration: staged.context,
          profiles: candidate.profiles, scope: candidate.reports, candidateHash: canonicalHash(candidate.content) });
        const inspection: ImportInspectionDTO = { id, workspaceId, ...(baseVersionId ? { baseVersionId } : {}), state: 'ready', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + IMPORT_INSPECTION_TTL_MS).toISOString(), inspectionHash,
          profiles: candidate.profiles, context: candidate.context, reports: candidate.reports, diagnostics: candidate.diagnostics.slice(0, 128), requiresPartialCoverageAcceptance: candidate.reports.some(report => report.excludedSheets.length > 0) };
        return { output: { complete: true, records: [asState(key, { inspection, candidate: candidate.content, files: staged.files, declaration: staged.context })], resultRef: { type: 'import-inspection', id } } };
      }, finalize: async () => { const record = this.store.getRecord<InspectionRecord>(key); if (record?.inspection.state === 'ready') this.schedule(workspaceId); },
    };
  }
  private async verifyFiles(workspaceId: string, files: readonly StagedFile[], check: () => void): Promise<void> {
    for (const file of files) {
      check(); const actualPath = await this.files.filePath(workspaceId, file.id), stat = await lstat(actualPath);
      if (actualPath !== file.path || !stat.isFile() || stat.isSymbolicLink() || stat.size !== file.size) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
      const hash = createHash('sha256'); let size = 0;
      for await (const chunk of createReadStream(actualPath)) { check(); size += chunk.length; if (size > file.size) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE'); hash.update(chunk); }
      if (size !== file.size || hash.digest('hex') !== file.sha256) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
    }
  }
  async prepareCommit(workspaceId: string, id: string, body: ImportInspectionCommitDTO, jobId: string): Promise<JobAcceptance> {
    await this.get(workspaceId, id); const initial = this.record(workspaceId, id), inspection = initial.inspection, key = inspectionKey(workspaceId, id);
    this.store.assertBase(workspaceId, inspection.baseVersionId);
    if (inspection.state === 'expired') throw new ApiError('IMPORT_INSPECTION_EXPIRED');
    if (inspection.state !== 'ready' || !initial.candidate || !initial.files || inspection.inspectionHash !== body.inspectionHash) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
    if (inspection.requiresPartialCoverageAcceptance && !body.acceptedExcludedSheets) throw new ApiError('PARTIAL_COVERAGE_NOT_ACCEPTED');
    const check = () => { this.store.assertAccepting(workspaceId); this.store.assertBase(workspaceId, inspection.baseVersionId); if (this.now() >= Date.parse(inspection.expiresAt)) throw new ApiError('IMPORT_INSPECTION_EXPIRED'); };
    try { await this.verifyFiles(workspaceId, initial.files, check); check(); }
    catch (error) {
      if (this.store.getRecord(key) === initial) this.store.putRecords([asState(key, released(initial, this.now() >= Date.parse(inspection.expiresAt) ? 'expired' : 'invalidated'))]);
      this.queueCleanup(workspaceId); await this.settle(workspaceId); if (error instanceof ApiError) throw error; throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
    }
    if (this.store.getRecord(key) !== initial) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
    const committing: InspectionRecord = { ...initial, inspection: { ...inspection, state: 'committing', commitJobId: jobId } };
    return { includeSnapshot: false, input: { inspectionHash: inspection.inspectionHash, files: initial.files } as unknown as JsonValue,
      initialRecords: [asState(key, committing)],
      preparePublication: (_job, output) => {
        const current = this.record(workspaceId, id);
        if (current.inspection.state !== 'committing' || current.inspection.commitJobId !== jobId || current.candidate !== initial.candidate || output.verifiedInspectionHash !== inspection.inspectionHash || output.snapshotContent) throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
        return { output: { complete: true, snapshotContent: initial.candidate!, records: [asState(key, released(current, 'committed'))], resultRef: { type: 'import', id } },
          assertCommit: () => { this.store.assertBase(workspaceId, inspection.baseVersionId); this.store.assertAccepting(workspaceId); } };
      }, finalize: async () => {
        const current = this.record(workspaceId, id);
        if (current.inspection.state === 'committing' && current.inspection.commitJobId === jobId) {
          let state: 'ready' | 'expired' | 'invalidated' = this.now() >= Date.parse(inspection.expiresAt) ? 'expired' : 'ready';
          try { this.store.assertAccepting(workspaceId); this.store.assertBase(workspaceId, inspection.baseVersionId); if (state === 'ready') await this.verifyFiles(workspaceId, initial.files!, () => { this.store.assertAccepting(workspaceId); }); }
          catch { state = 'invalidated'; }
          if (state === 'ready') this.store.putRecords([asState(key, initial)]);
          else this.store.putRecords([asState(key, released(current, state))]);
        }
        this.queueCleanup(workspaceId); await this.settle(workspaceId); this.schedule(workspaceId);
      },
    };
  }
  async discard(workspaceId: string, id: string): Promise<ImportInspectionDTO> {
    const inspection = await this.get(workspaceId, id); this.store.assertAccepting(workspaceId);
    if (inspection.state === 'committing' || inspection.state === 'committed') throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE', inspection.commitJobId ? { commitJobId: inspection.commitJobId } : {});
    if (inspection.state === 'ready') this.store.putRecords([asState(inspectionKey(workspaceId, id), released(this.record(workspaceId, id), 'discarded'))]);
    this.queueCleanup(workspaceId); await this.settle(workspaceId); this.schedule(workspaceId); return this.record(workspaceId, id).inspection;
  }
  async close(workspaceId: string): Promise<void> { if (this.timer) clearTimeout(this.timer); await this.settle(workspaceId); }
  async dispose(): Promise<void> { this.disposed = true; if (this.timer) clearTimeout(this.timer); await Promise.all(this.cleaning.values()); }
}
