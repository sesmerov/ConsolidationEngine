import { randomUUID } from 'node:crypto';
import { setImmediate as yieldToLoop } from 'node:timers/promises';
import { directionReviewDecisions } from '@ce/contracts';
import type {
  DirectionConflictCandidateDTO, DirectionConflictCandidateDetailDTO, DirectionReviewActiveDTO, DirectionReviewCommitDTO, DirectionReviewDecision, DirectionReviewMutationResponseDTO,
  DirectionReviewPatchDTO, DirectionReviewPrepareDTO, DirectionReviewReceiptDTO, DirectionReviewSummaryDTO, DirectionReviewScope, RecalculationReviewPrepareDTO, RecalculationOperationDTO, JsonValue,
} from '@ce/contracts';
import {
  DirectionReviewError, editDirectionProjection, readDirectionRows, readDirectionGroups, readDirectionCandidates, readDirectionCandidate, verifyDirectionCompilation, WorkBudget, WorkLimitError,
} from '@ce/engine';
import type { DirectionReviewProjection, ReviewSeed, WorkLimits } from '@ce/engine';
import { ApiError } from '../errors.js';
import { ruleSourceDetails } from '../presentation/rule-presentation.js';
import type { JobAcceptance } from '../jobs/job-manager.js';
import { canonicalHash, canonicalStringify, directionConfigurationVersion, immutable } from '../session/canonical-state.js';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { getValidation, validationMatchesBasis } from '../validation/validation-service.js';
import type { StateRecord, WorkerOutput } from '../workers/protocol.js';
import { activeReviewKey, latestDirectionCommitKey, releasedReview, reviewEntry, reviewKey } from './direction-review-record.js';
import type { ReviewRecord } from './direction-review-record.js';

const ttlMs = 15 * 60_000;
const json = (value: unknown) => value as JsonValue;
type Ready = ReviewRecord & { readonly projection: DirectionReviewProjection };
export interface ReviewPageFilter { readonly state?: DirectionReviewDecision; readonly scope?: DirectionReviewScope; readonly groupId?: string; readonly offset: number; readonly limit: number }
export interface DirectionReviewOptions { readonly now?: () => number; readonly limits?: Partial<WorkLimits> }

/** All business data and mutation receipts live in the workspace quota. Only the expiry timer is external. */
export class DirectionReviewService {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private staging = false;
  constructor(private readonly store: WorkspaceStore, private readonly options: DirectionReviewOptions = {}) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private budget() { return new WorkBudget(this.options.limits ? { limits: this.options.limits } : {}); }
  private record(w: string, id: string): ReviewRecord {
    this.store.get(w);
    const record = this.store.getRecord<ReviewRecord>(reviewKey(w, id));
    if (!record || record.summary.workspaceId !== w) throw new ApiError('RESOURCE_NOT_FOUND');
    return record;
  }
  private finish(w: string, record: ReviewRecord): StateRecord[] {
    const entries = [reviewEntry(record)];
    if (this.store.getRecord(activeReviewKey(w)) === record.summary.id) entries.push({ key: activeReviewKey(w), value: null });
    return entries;
  }
  private expire(w: string): void {
    const id = this.store.getRecord<string>(activeReviewKey(w));
    if (!id) return;
    const prior = this.record(w, id), summary = prior.summary;
    if (summary.state === 'ready' && this.now() >= Date.parse(summary.expiresAt!)) {
      this.store.putRecords(this.finish(w, releasedReview(prior, 'expired')));
    }
  }
  private schedule(w: string): void {
    this.close();
    if (this.store.currentWorkspaceId !== w) return;
    const current = this.active(w).active;
    if (current?.state === 'ready') {
      this.timer = setTimeout(() => {
        if (this.store.currentWorkspaceId === w) this.expire(w);
      }, Math.max(1, Date.parse(current.expiresAt!) - this.now()));
      this.timer.unref();
    }
  }
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
  /** A read-only view: expiration never mutates authority from recalculation-state GET. */
  peekCompatible(w: string): ReviewRecord | undefined {
    const snapshot = this.store.current(w), id = this.store.getRecord<string>(activeReviewKey(w));
    if (!snapshot || !id) return;
    const record = this.record(w, id), summary = record.summary;
    if (!['preparing', 'ready', 'committing'].includes(summary.state) || summary.baseVersionId !== snapshot.versionId
      || summary.state === 'ready' && this.now() >= Date.parse(summary.expiresAt!)) return;
    try { if (validationMatchesBasis(getValidation(this.store, w, summary.runId), snapshot)) return record; } catch { /* Released run. */ }
  }
  assertCurrentInput(w: string, body: RecalculationReviewPrepareDTO): void {
    this.store.assertBase(w, body.baseVersionId);
    const snapshot = this.store.snapshot(w, body.baseVersionId);
    if (body.validationBasisId !== (snapshot.validationBasisId ?? snapshot.versionId)) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE', { reason: 'BASIS_MISMATCH' });
    if (!validationMatchesBasis(getValidation(this.store, w, body.runId), snapshot)) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE', { reason: 'VALIDATION_REQUIRED' });
  }
  reusable(w: string, body: RecalculationReviewPrepareDTO): string | undefined {
    this.assertCurrentInput(w, body);
    const record = this.peekCompatible(w);
    return record && ['ready', 'preparing'].includes(record.summary.state) ? record.summary.jobId : undefined;
  }
  prepareCurrent(w: string, body: RecalculationReviewPrepareDTO, jobId: string): Promise<JobAcceptance> {
    this.assertCurrentInput(w, body);
    return this.prepare(w, body, jobId);
  }
  operationLease(w: string, body: RecalculationOperationDTO, jobId: string) {
    this.assertCurrentInput(w, body);
    const old = this.ready(w, body.reviewId);
    this.checkRevision(old, body.expectedRevision);
    if (old.summary.runId !== body.runId || old.summary.baseVersionId !== body.baseVersionId) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
    const counts = old.projection.counts;
    if (counts.pending || counts.conflicted || counts.undetermined) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE', { reason: 'UNRESOLVED_DECISIONS' });
    if (!counts.included && !counts.omitted) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE', { reason: 'NO_CANDIDATES' });
    const run = getValidation(this.store, w, body.runId);
    const pending: ReviewRecord = { ...old, summary: { ...old.summary, state: 'committing', jobId } };
    const assertCommit = () => {
      this.assertLease(w, body.reviewId, 'committing', jobId, body.expectedRevision);
      this.assertCurrentInput(w, body);
      if (getValidation(this.store, w, body.runId) !== run) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
    };
    return { review: old, pending, assertCommit,
      initialRecords: [reviewEntry(pending)],
      assertStart: () => { if (this.ready(w, body.reviewId) !== old) throw new ApiError('STALE_DIRECTION_REVIEW'); },
      onTerminal: () => {
        const current = this.record(w, body.reviewId);
        if (current.summary.state !== 'committing' || current.summary.jobId !== jobId) return [];
        try { this.store.assertAccepting(w); this.assertCurrentInput(w, body); } catch { return this.finish(w, releasedReview(current, 'obsolete')); }
        if (this.now() >= Date.parse(old.summary.expiresAt!)) return this.finish(w, releasedReview(current, 'expired'));
        queueMicrotask(() => this.schedule(w));
        return [reviewEntry(old)];
      },
      finalize: async () => this.schedule(w),
    };
  }
  /** A committed decision remains valid for its exact configured version, without refreshing a draft. */
  peekCommitted(w: string): DirectionReviewSummaryDTO | undefined {
    const snapshot = this.store.current(w), receipt = this.store.getRecord<DirectionReviewReceiptDTO>(latestDirectionCommitKey(w));
    if (!snapshot || !receipt || receipt.newVersionId !== snapshot.versionId || receipt.configVersion !== snapshot.content.configVersion) return undefined;
    const summary = this.record(w, receipt.reviewId).summary;
    return summary.state === 'committed' && summary.validationBasisId === snapshot.validationBasisId ? summary : undefined;
  }
  active(w: string): DirectionReviewActiveDTO {
    const workspace = this.store.get(w);
    this.expire(w);
    const id = this.store.getRecord<string>(activeReviewKey(w));
    const latest = this.store.getRecord<DirectionReviewReceiptDTO>(latestDirectionCommitKey(w));
    return { active: id ? this.record(w, id).summary : null,
      ...(latest && latest.newVersionId === workspace.currentVersionId ? { latestCommit: latest } : {}) };
  }
  get(w: string, id: string): DirectionReviewSummaryDTO {
    this.expire(w);
    return this.record(w, id).summary;
  }
  private ready(w: string, id: string): Ready {
    this.expire(w);
    const record = this.record(w, id);
    if (record.summary.state === 'expired') throw new ApiError('DIRECTION_REVIEW_EXPIRED');
    if (record.summary.state !== 'ready' || !record.projection) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
    this.store.assertBase(w, record.summary.baseVersionId);
    return record as Ready;
  }
  rows(w: string, id: string, filter: ReviewPageFilter) {
    const record = this.ready(w, id);
    try {
      const page = readDirectionRows(record.projection, filter);
      return { reviewId: id, revision: record.summary.revision, ...page };
    } catch (error) {
      if (error instanceof DirectionReviewError && error.reason === 'UNKNOWN_GROUP') throw new ApiError('RESOURCE_NOT_FOUND');
      throw error;
    }
  }
  private readResource<T>(read: () => T): T {
    try { return read(); } catch (error) {
      if (error instanceof DirectionReviewError && ['UNKNOWN_GROUP', 'UNKNOWN_CANDIDATE', 'UNKNOWN_INSTANCE'].includes(error.reason)) throw new ApiError('RESOURCE_NOT_FOUND');
      throw error;
    }
  }
  groups(w: string, id: string, page: { offset: number; limit: number; scope?: DirectionReviewScope }) {
    const record = this.ready(w, id);
    return { reviewId: id, revision: record.summary.revision, ...this.readResource(() => readDirectionGroups(record.projection, page)) };
  }
  private candidatePresentation(record: Ready, identity: ReturnType<typeof readDirectionCandidate>, source: ReturnType<typeof ruleSourceDetails>) {
    const row = record.projection.rows[record.projection.byInstance[identity.instanceId]!]!;
    const details = source(row.seed.variantIds), description = details.descriptions[0]?.description;
    const candidate: DirectionConflictCandidateDTO = { ...identity, expressionPreview: details.expression.slice(0, 512),
      expressionTruncated: details.expression.length > 512, descriptionTruncated: (description?.length ?? 0) > 512,
      ...(description === undefined ? {} : { descriptionPreview: description.slice(0, 512) }) };
    return { candidate, ...details };
  }
  candidates(w: string, id: string, groupId: string, page: { offset: number; limit: number }) {
    const record = this.ready(w, id);
    const result = this.readResource(() => readDirectionCandidates(record.projection, groupId, page));
    const source = ruleSourceDetails(this.store.snapshot(w, record.summary.baseVersionId).content);
    return { reviewId: id, revision: record.summary.revision, ...result,
      items: result.items.map(identity => this.candidatePresentation(record, identity, source).candidate) };
  }
  candidate(w: string, id: string, groupId: string, instanceId: string): DirectionConflictCandidateDetailDTO {
    const record = this.ready(w, id);
    const identity = this.readResource(() => readDirectionCandidate(record.projection, groupId, instanceId));
    const source = ruleSourceDetails(this.store.snapshot(w, record.summary.baseVersionId).content);
    return { reviewId: id, revision: record.summary.revision, ...this.candidatePresentation(record, identity, source) };
  }
  discard(w: string, id: string): DirectionReviewSummaryDTO {
    if (this.get(w, id).state === 'discarded') return this.record(w, id).summary;
    const discarded = releasedReview(this.ready(w, id), 'discarded');
    this.store.putRecords(this.finish(w, discarded));
    this.schedule(w);
    return discarded.summary;
  }
  patch(w: string, id: string, body: DirectionReviewPatchDTO): DirectionReviewMutationResponseDTO {
    const old = this.ready(w, id);
    const hash = canonicalHash({ workspaceId: w, reviewId: id, operation: 'patch-directions', body });
    const replay = old.mutations?.[body.mutationId];
    if (replay) {
      if (replay.hash !== hash) throw new ApiError('IDEMPOTENCY_CONFLICT');
      return { summary: old.summary, appliedRevision: replay.appliedRevision };
    }
    this.store.assertIdle(w);
    this.checkRevision(old, body.expectedRevision);
    let projection: DirectionReviewProjection;
    try {
      projection = editDirectionProjection(old.projection, body.operations, { budget: this.budget() });
    } catch (error) {
      if (error instanceof DirectionReviewError && error.reason === 'GROUP_CANDIDATE_ASSIGNED_ELSEWHERE') throw new ApiError('GROUP_CANDIDATE_ASSIGNED_ELSEWHERE');
      if (error instanceof DirectionReviewError && ['UNKNOWN_GROUP', 'UNKNOWN_INSTANCE'].includes(error.reason)) throw new ApiError('RESOURCE_NOT_FOUND');
      if (error instanceof DirectionReviewError) throw new ApiError('INVALID_DIRECTION', { reason: error.reason });
      if (error instanceof WorkLimitError) throw new ApiError('INVALID_DIRECTION', { reason: error.code });
      throw error;
    }
    const revision = old.summary.revision + 1;
    const summary: DirectionReviewSummaryDTO = { ...old.summary, revision, counts: projection.counts, conflictGroupCount: projection.conflictGroupCount };
    const next: ReviewRecord = { summary, projection, mutations: { ...old.mutations, [body.mutationId]: { hash, appliedRevision: revision } } };
    this.store.assertTransientCapacity([next]);
    if (this.ready(w, id) !== old) throw new ApiError('STALE_DIRECTION_REVIEW');
    this.store.putRecords([reviewEntry(next)]);
    return { summary, appliedRevision: revision };
  }
  private checkRevision(record: ReviewRecord, revision: number): void {
    if (revision !== record.summary.revision) throw new ApiError('STALE_DIRECTION_REVIEW', { currentRevision: record.summary.revision });
  }
  private assertOutput(output: WorkerOutput, key: 'directionReviewProjection' | 'directionCompilation', id: string): void {
    if (!output[key] || output.resultRef?.type !== 'direction-review' || output.resultRef.id !== id ||
      Object.keys(output).some(field => !['complete','resultRef',key].includes(field))) throw new ApiError('INTERNAL_ERROR');
  }
  async prepare(w: string, body: DirectionReviewPrepareDTO, jobId: string): Promise<JobAcceptance> {
    if (this.staging) throw new ApiError('WORKSPACE_BUSY');
    this.staging = true;
    try { return await this.prepareSeeds(w, body, jobId); }
    finally { this.staging = false; }
  }
  private async prepareSeeds(w: string, body: DirectionReviewPrepareDTO, jobId: string): Promise<JobAcceptance> {
    if (this.active(w).active) throw new ApiError('DIRECTION_REVIEW_EXISTS');
    this.store.assertIdle(w);
    this.store.assertBase(w, body.baseVersionId);
    const run = getValidation(this.store, w, body.runId);
    if (!validationMatchesBasis(run, this.store.snapshot(w, body.baseVersionId)))
      throw new ApiError('INVALID_DIRECTION', { reason: 'VALIDATION_REQUIRED' });
    const seeds: ReviewSeed[] = [];
    const budget = new WorkBudget();
    let bytes = 2;
    for (const row of run.results) {
      if (seeds.length % 256 === 0) {
        await yieldToLoop();
        this.store.assertAccepting(w);
        this.store.assertBase(w, body.baseVersionId);
      }
      const seed: ReviewSeed = { id: row.id, code: row.code, variantIds: row.variantIds, coverageOnly: row.coverageOnly,
        ...(row.instanceId ? { instanceId: row.instanceId } : {}), ...(row.binding ? { binding: row.binding } : {}) };
      bytes += Buffer.byteLength(canonicalStringify(seed)) + 1;
      if (bytes > this.store.availableBytes) throw new ApiError('SESSION_LIMIT');
      // Engine quota violations are reported by the accepted job; this budget bounds staging time only.
      if (seeds.length % 256 === 0) {
        try { budget.check(); } catch (error) {
          if (error instanceof WorkLimitError) throw new ApiError('INVALID_DIRECTION', { reason: error.code });
          throw error;
        }
      }
      seeds.push(seed);
    }
    const id = randomUUID(), summary: DirectionReviewSummaryDTO = { id, workspaceId: w, baseVersionId: body.baseVersionId,
      validationBasisId: this.store.snapshot(w, body.baseVersionId).validationBasisId ?? body.baseVersionId,
      runId: body.runId, state: 'preparing', revision: 0, jobId };
    const initial: ReviewRecord = { summary };
    const input = immutable({ seeds, reviewId: id, ...(this.options.limits ? { limits: this.options.limits } : {}) });
    return { initialRecords: [reviewEntry(initial), { key: activeReviewKey(w), value: id }], input: json(input), retainedState: json(input),
      resultRef: { type: 'direction-review', id },
      assertStart: () => {
        if (this.active(w).active) throw new ApiError('DIRECTION_REVIEW_EXISTS');
        if (getValidation(this.store, w, body.runId) !== run) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
      },
      preparePublication: (_job, output) => {
        this.assertOutput(output, 'directionReviewProjection', id);
        const p = output.directionReviewProjection!, now = this.now();
        if (p.reviewId !== id || p.baseVersionId !== body.baseVersionId || !Array.isArray(p.rows) || p.rows.length !== seeds.length ||
          !Array.isArray(p.groups) || !Array.isArray(p.decisions) || !Array.isArray(p.blockCounts) || !Array.isArray(p.members) ||
          !Array.isArray(p.candidates) || !Array.isArray(p.observedGroups) || !Array.isArray(p.observedFlags) || !Array.isArray(p.omittedFlags) ||
          !Number.isSafeInteger(p.conflictGroupCount) || p.conflictGroupCount < 0 || p.conflictGroupCount > p.groups.length ||
          p.counts.totalRows !== seeds.length ||
          directionReviewDecisions.some(state => !Number.isSafeInteger(p.counts[state]) || p.counts[state] < 0) ||
          directionReviewDecisions.reduce((n, state) => n + p.counts[state], 0) !== seeds.length) throw new ApiError('INTERNAL_ERROR');
        this.store.assertTransientCapacity([p]);
        const ready: ReviewRecord = { projection: p, summary: { ...summary, revision: 1, state: 'ready', readyAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttlMs).toISOString(), counts: p.counts, conflictGroupCount: p.conflictGroupCount } };
        return { output: { complete: true, records: [reviewEntry(ready)], resultRef: output.resultRef! },
          assertCommit: () => {
            this.assertLease(w, id, 'preparing', jobId, 0);
            if (getValidation(this.store, w, body.runId) !== run) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
          } };
      },
      onTerminal: () => {
        const current = this.record(w, id);
        return current.summary.state === 'preparing' && current.summary.jobId === jobId
          ? this.finish(w, releasedReview(current, 'failed')) : [];
      },
      finalize: async () => this.schedule(w),
    };
  }
  private assertLease(w: string, id: string, state: 'preparing' | 'committing', jobId: string, revision: number): void {
    const current = this.record(w, id).summary;
    if (current.state !== state || current.jobId !== jobId || current.revision !== revision || this.store.getRecord(activeReviewKey(w)) !== id)
      throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
    this.store.assertBase(w, current.baseVersionId);
  }
  commit(w: string, id: string, body: DirectionReviewCommitDTO, jobId: string): JobAcceptance {
    const old = this.ready(w, id);
    this.checkRevision(old, body.expectedRevision);
    const counts = old.projection.counts;
    if (counts.conflicted) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE', { reason: 'UNRESOLVED_PRODUCERS' });
    if ((counts.pending || counts.undetermined) && !body.acceptPartial)
      throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE', { reason: 'PARTIAL_REVIEW_NOT_ACCEPTED' });
    const { runId, baseVersionId, revision } = old.summary;
    const validation = getValidation(this.store, w, runId);
    if (!validationMatchesBasis(validation, this.store.snapshot(w, baseVersionId)))
      throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
    const newVersionId = randomUUID(), ref = { type: 'direction-review', id };
    const committing: ReviewRecord = { ...old, summary: { ...old.summary, state: 'committing', jobId } };
    const input = { projection: old.projection, ...(this.options.limits ? { limits: this.options.limits } : {}) };
    return { initialRecords: [reviewEntry(committing)], resultRef: ref, input: json(input),
      assertStart: () => {
        const live = this.ready(w, id);
        this.checkRevision(live, revision);
        if (live !== old) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
      },
      preparePublication: (_job, output) => {
        this.assertLease(w, id, 'committing', jobId, revision);
        this.assertOutput(output, 'directionCompilation', id);
        const candidate = output.directionCompilation!;
        if (!verifyDirectionCompilation(old.projection, candidate, { budget: this.budget() })) throw new ApiError('INTERNAL_ERROR');
        this.store.assertTransientCapacity([candidate]);
        const base = this.store.snapshot(w, baseVersionId);
        const configVersion = directionConfigurationVersion(candidate.directions, candidate.decisionState);
        const receipt: DirectionReviewReceiptDTO = { reviewId: id, runId, baseVersionId, newVersionId, configVersion, included: counts.included };
        const committed: ReviewRecord = { summary: { ...committing.summary, state: 'committed', receipt } };
        const records = [...this.finish(w, committed), { key: latestDirectionCommitKey(w), value: json(receipt) }];
        return { output: { complete: true, snapshotVersionId: newVersionId, snapshotContent: {
          ...base.content, directions: candidate.directions, directionDecisionState: candidate.decisionState, configVersion }, records, resultRef: ref },
          assertCommit: () => {
            this.assertLease(w, id, 'committing', jobId, revision);
            if (getValidation(this.store, w, runId) !== validation) throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
          } };
      },
      onTerminal: () => {
        const current = this.record(w, id);
        if (current.summary.state !== 'committing' || current.summary.jobId !== jobId) return [];
        try {
          this.store.assertAccepting(w);
          this.store.assertBase(w, baseVersionId);
          if (getValidation(this.store, w, runId) !== validation || current.projection !== old.projection) throw new Error('Review base changed');
        } catch { return this.finish(w, releasedReview(current, 'obsolete')); }
        if (this.now() >= Date.parse(old.summary.expiresAt!)) return this.finish(w, releasedReview(current, 'expired'));
        queueMicrotask(() => this.schedule(w));
        return [reviewEntry(old)];
      },
      finalize: async () => this.schedule(w),
    };
  }
}
