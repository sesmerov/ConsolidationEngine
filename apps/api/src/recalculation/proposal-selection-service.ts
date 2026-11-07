import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { JsonValue, PreviewBundle, ProposalDependencyPageDTO, ProposalDTO, ProposalSelectionEditDTO, ProposalSelectionFilterDTO, ProposalSelectionPageDTO, ProposalSelectionRowDTO, ProposalSelectionRowsQueryDTO, ProposalSelectionSummaryDTO, Snapshot } from '@ce/contracts';
import { proposalMatchesFilter, selectionMaskReader, WorkBudget, WorkLimitError } from '@ce/engine';
import type { WorkLimits } from '@ce/engine';
import type { WorkspaceStore } from '../session/workspace-store.js';
import type { JobAcceptance } from '../jobs/job-manager.js';
import { ApiError } from '../errors.js';
import { canonicalHash, immutable } from '../session/canonical-state.js';
import { getPreview } from './preview-store.js';
import { proposalSelectionCacheKey, proposalSelectionKey, selectionSummary, type ProposalSelectionRecord } from './proposal-selection-record.js';
import { rulePresentation } from '../presentation/rule-presentation.js';

export interface SelectionContext { readonly workspaceId: string; readonly previewId: string; readonly record: ProposalSelectionRecord; readonly bundle: PreviewBundle; readonly snapshot: Snapshot }
interface CachedQuery { readonly fingerprint: string; readonly indices: readonly number[]; readonly counts: ProposalSelectionPageDTO['filterCounts'] }
export class ProposalSelectionService {
  private readonly secret = randomBytes(32);
  constructor(readonly store: WorkspaceStore, private readonly limits?: Partial<WorkLimits>) {}
  close(): void { /* Caches are JSON records owned, accounted and released by WorkspaceStore. */ }
  context(workspaceId: string, previewId: string): SelectionContext {
    const bundle = getPreview(this.store, workspaceId, previewId), record = this.store.getRecord<ProposalSelectionRecord>(proposalSelectionKey(workspaceId, previewId));
    if (!record || record.summary.workspaceId !== workspaceId || record.summary.previewId !== previewId || record.summary.baseVersionId !== bundle.preview.baseVersionId) throw new ApiError('RESOURCE_NOT_FOUND');
    return { workspaceId, previewId, record, bundle, snapshot: this.store.snapshot(workspaceId, bundle.preview.baseVersionId) };
  }
  summary(workspaceId: string, previewId: string): ProposalSelectionSummaryDTO { return this.context(workspaceId, previewId).record.summary; }
  current(context: SelectionContext): void { if (this.store.getRecord(proposalSelectionKey(context.workspaceId, context.previewId)) !== context.record) throw new ApiError('STALE_PROPOSAL_SELECTION'); this.store.get(context.workspaceId); }
  private editable(context: SelectionContext): void {
    this.store.assertAccepting(context.workspaceId); this.store.assertIdle(context.workspaceId); this.store.assertBase(context.workspaceId, context.record.summary.baseVersionId);
    if (context.bundle.preview.state !== 'ready' || context.record.summary.state !== 'ready' || !context.record.projection) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE');
  }
  prepare(workspaceId: string, previewId: string, baseVersionId: string, jobId: string): JobAcceptance {
    this.store.assertAccepting(workspaceId); this.store.assertIdle(workspaceId); this.store.assertBase(workspaceId, baseVersionId);
    const bundle = getPreview(this.store, workspaceId, previewId), key = proposalSelectionKey(workspaceId, previewId), prior = this.store.getRecord<ProposalSelectionRecord>(key);
    if (bundle.preview.state !== 'ready' || bundle.preview.baseVersionId !== baseVersionId || prior && (prior.summary.revision > 0 || prior.summary.state !== 'failed')) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE');
    const record: ProposalSelectionRecord = { summary: { id: prior?.summary.id ?? randomUUID(), workspaceId, previewId, baseVersionId, revision: 0, state: 'preparing', initializationJobId: jobId, pendingJobId: jobId } };
    return this.accept(bundle, prior, record, jobId);
  }
  async edit(workspaceId: string, previewId: string, body: ProposalSelectionEditDTO, jobId: string): Promise<JobAcceptance> {
    const context = this.context(workspaceId, previewId), prior = context.record;
    if (prior.summary.id !== body.selectionId) throw new ApiError('RESOURCE_NOT_FOUND');
    if (prior.summary.revision !== body.expectedRevision) throw new ApiError('STALE_PROPOSAL_SELECTION');
    this.editable(context);
    const ids = body.operations.flatMap(op => op.op === 'set' ? [op.proposalId] : []);
    if (new Set(ids).size !== ids.length || ids.length && ids.length !== body.operations.length) throw new ApiError('INVALID_REQUEST');
    for (const op of body.operations) if (op.op === 'selectMatching') this.validateFilter(context, op.filter);
    if (ids.length) {
      const pending = new Set(ids);
      await this.scan(context.bundle.proposals, row => { if (!pending.has(row.id)) return;
        if (row.state !== 'available' || !row.before || !row.after) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE'); pending.delete(row.id);
      });
      if (pending.size) throw new ApiError('INVALID_REQUEST'); this.current(context);
    }
    const pending: ProposalSelectionRecord = { ...prior, summary: { ...prior.summary, state: 'updating', pendingJobId: jobId } };
    return this.accept(context.bundle, prior, pending, jobId, body.operations);
  }
  private accept(bundle: PreviewBundle, previous: ProposalSelectionRecord | undefined, pending: ProposalSelectionRecord, jobId: string, operations?: ProposalSelectionEditDTO['operations']): JobAcceptance {
    const { workspaceId, previewId, baseVersionId } = pending.summary, key = proposalSelectionKey(workspaceId, previewId);
    const isInitial = pending.summary.revision === 0;
    const assertStart = () => { this.store.assertBase(workspaceId, baseVersionId); if (this.store.getRecord(key) !== previous || getPreview(this.store, workspaceId, previewId) !== bundle) throw new ApiError('STALE_PROPOSAL_SELECTION'); };
    const assertPending = () => { this.store.assertBase(workspaceId, baseVersionId); const current = this.store.getRecord<ProposalSelectionRecord>(key);
      if (current?.summary.pendingJobId !== jobId || current.summary.revision !== pending.summary.revision || getPreview(this.store, workspaceId, previewId) !== bundle) throw new ApiError('STALE_PROPOSAL_SELECTION'); };
    return { includeSnapshot: false, assertStart, initialRecords: [{ key, value: pending as unknown as JsonValue }],
      input: { selectionId: pending.summary.id, preview: bundle as unknown as JsonValue, ...(operations && previous?.projection ? { operations: operations as unknown as JsonValue, prior: previous.projection as unknown as JsonValue } : {}), ...(this.limits ? { limits: this.limits as unknown as JsonValue } : {}) },
      retainedState: { selectionId: pending.summary.id, expectedRevision: pending.summary.revision },
      preparePublication: (_job, output) => {
        assertPending(); const projection = output.selectionProjection;
        if (!projection || output.resultRef?.type !== 'proposal-selection' || output.resultRef.id !== pending.summary.id || projection.cardinality !== bundle.proposals.length || output.snapshotContent) throw new ApiError('INTERNAL_ERROR');
        const { pendingJobId: _pending, ...summary } = pending.summary;
        const record: ProposalSelectionRecord = { summary: selectionSummary({ ...summary, revision: summary.revision + 1, state: 'ready' }, projection), projection };
        this.store.assertTransientCapacity([record]);
        return { assertCommit: assertPending, output: { complete: true, resultRef: output.resultRef, records: [{ key, value: record as unknown as JsonValue }, { key: proposalSelectionCacheKey(workspaceId, previewId), value: { entries: [] } }] } };
      },
      onTerminal: () => {
        const current = this.store.getRecord<ProposalSelectionRecord>(key); if (current?.summary.pendingJobId !== jobId) return [];
        const sameBase = this.store.current(workspaceId)?.versionId === baseVersionId && getPreview(this.store, workspaceId, previewId).preview.state === 'ready';
        const { pendingJobId: _pending, ...summary } = pending.summary;
        const restored: ProposalSelectionRecord = isInitial ? { summary: { ...summary, state: 'failed' } } : { ...previous!, summary: { ...previous!.summary, state: sameBase ? 'ready' : 'obsolete', ...(sameBase ? {} : { availableCount: 0 }) } };
        return [{ key, value: restored as unknown as JsonValue }];
      },
    };
  }
  validateFilter(context: SelectionContext, filter: ProposalSelectionFilterDTO): void {
    if (filter.contextId && !context.snapshot.content.contexts.some(row => row.contextId === filter.contextId)) throw new ApiError('INVALID_REQUEST');
  }
  private budget(cancelled?: () => boolean) { return new WorkBudget({ ...(this.limits ? { limits: this.limits } : {}), ...(cancelled ? { cancelled } : {}) }); }
  async scan<T>(rows: readonly T[], visit: (row: T, ordinal: number) => void, cancelled?: () => boolean): Promise<void> {
    const budget = this.budget(cancelled);
    try { for (let n = 0; n < rows.length; n++) { budget.consume('instances'); visit(rows[n]!, n); if ((n & 1023) === 1023) await yieldTurn(); } }
    catch (error) { if (error instanceof WorkLimitError) throw new ApiError('EXPANSION_LIMIT', { reason: error.code }); throw error; }
  }
  fingerprint(context: SelectionContext, value: object): string { return canonicalHash({ workspaceId: context.workspaceId, previewId: context.previewId, selectionId: context.record.summary.id, revision: context.record.summary.revision, state: context.record.summary.state, ...value }); }
  offset(fingerprint: string, cursor: string | undefined, total: number): number {
    if (!cursor) return 0;
    try {
      const [payload, signature, rest] = cursor.split('.'); if (!payload || !signature || rest) throw Error();
      const actual = Buffer.from(signature, 'base64url'), expected = createHmac('sha256', this.secret).update(payload).digest();
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (decoded.fingerprint !== fingerprint || !Number.isSafeInteger(decoded.offset) || decoded.offset <= 0 || decoded.offset >= total) throw Error(); return decoded.offset as number;
    } catch { throw new ApiError('INVALID_CURSOR'); }
  }
  cursor(fingerprint: string, offset: number, total: number): string | null {
    if (offset >= total) return null; const payload = Buffer.from(JSON.stringify({ fingerprint, offset })).toString('base64url');
    return payload + '.' + createHmac('sha256', this.secret).update(payload).digest('base64url');
  }
  async ordinals(context: SelectionContext, cancelled?: () => boolean): Promise<Map<string, number>> {
    const result = new Map<string, number>(); await this.scan(context.bundle.proposals, (row, n) => result.set(row.id, n), cancelled); this.current(context); return result;
  }
  async row(context: SelectionContext, ordinal: number, byId: ReadonlyMap<string, number>, cancelled?: () => boolean): Promise<ProposalSelectionRowDTO> {
    const projection = context.record.projection; if (!projection) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE');
    const row = context.bundle.proposals[ordinal]; if (!row) throw new ApiError('RESOURCE_NOT_FOUND');
    const selected = selectionMaskReader(projection.selected), required = selectionMaskReader(projection.required), cell = row.before?.coordinate;
    const presentation = rulePresentation(context.snapshot.content)(row.variantIds, cell), description = presentation?.description ?? '';
    const c = context.snapshot.content.contexts.find(c => c.contextId === (cell?.contextId ?? row.binding.contextId));
    const before = row.before, origin = before?.sourceLocator ?? cell?.sourceLocator;
    const predecessors = new Set<string>(); let pending = 0;
    await this.scan(row.predecessorIds, id => { if (predecessors.has(id)) return; predecessors.add(id); const n = byId.get(id); if (n === undefined) throw new ApiError('INTERNAL_ERROR'); if (required(n)) pending++; }, cancelled);
    this.current(context);
    const exact = row.exactNominal, after = row.after;
    const rounded = !!exact && !!after && typeof after.normalizedValue === 'object' && 'numerator' in after.normalizedValue && (exact.numerator !== after.normalizedValue.numerator || exact.denominator !== after.normalizedValue.denominator);
    return { id: row.id, code: row.code, state: row.state, target: { contextId: cell?.contextId ?? row.binding.contextId ?? '', tableCode: cell?.tableCode ?? row.binding.tableCode ?? '', sheetCode: cell?.sheetCode ?? row.binding.sheetCode ?? '', rowCode: cell?.rowCode ?? row.binding.rowCode ?? '', columnCode: cell?.columnCode ?? row.binding.columnCode ?? '',
      ...(c ? { contextLabel: `${c.entityId} · ${c.referenceDate} · ${c.framework} · ${c.moduleVersion}`.slice(0, 500) } : {}), ...(presentation?.conceptLabel ? { conceptLabel: presentation.conceptLabel.slice(0, 500) } : {}) },
      description: description.slice(0, 500), descriptionTruncated: description.length > 500,
      ...(before ? { before: { presence: before.presence, ...(before.normalizedValue === undefined ? {} : { normalizedValue: before.normalizedValue }), unit: before.coordinate.unit, decimals: before.coordinate.decimals } } : {}),
      ...(after ? { after } : {}), ...(origin ? { origin: { ...(origin.fileId ? { fileId: origin.fileId } : {}), ...(origin.sheet ? { sheet: origin.sheet } : {}), ...(origin.column && origin.row ? { cell: `${origin.column}${origin.row}` } : {}) } } : {}),
      selected: selected(ordinal), required: required(ordinal), predecessorCount: predecessors.size, requiredPredecessorCount: pending,
      rounded, hasInterval: !!row.derivedInterval && (row.derivedInterval.lo.numerator !== row.derivedInterval.hi.numerator || row.derivedInterval.lo.denominator !== row.derivedInterval.hi.denominator), diagnosticCount: row.diagnostics.length };
  }
  async rows(workspaceId: string, previewId: string, query: ProposalSelectionRowsQueryDTO, cancelled?: () => boolean): Promise<ProposalSelectionPageDTO> {
    const context = this.context(workspaceId, previewId), { record } = context, p = record.projection;
    if (!p) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE'); this.validateFilter(context, query);
    const scope = query.scope ?? 'all', filter: ProposalSelectionFilterDTO = { ...(query.status ? { status: query.status } : {}), ...(query.code ? { code: query.code.toLowerCase() } : {}), ...(query.table ? { table: query.table } : {}), ...(query.contextId ? { contextId: query.contextId } : {}) };
    const fingerprint = this.fingerprint(context, { resource: 'rows', scope, filter }), cacheKey = proposalSelectionCacheKey(workspaceId, previewId);
    const prior = this.store.getRecord<{ entries: readonly CachedQuery[] }>(cacheKey)?.entries ?? [];
    let cached = prior.find(row => row.fingerprint === fingerprint);
    if (!cached) {
      const indices: number[] = [], selected = selectionMaskReader(p.selected), required = selectionMaskReader(p.required), available = selectionMaskReader(p.available); let matched = 0, matchesAvailable = 0, matchesSelected = 0;
      await this.scan(context.bundle.proposals, (row, n) => { if (!proposalMatchesFilter(row, filter)) return; matched++; if (available(n) && !['applied', 'discarded', 'obsolete', 'failed'].includes(record.summary.state)) matchesAvailable++; if (selected(n)) matchesSelected++;
        if (scope === 'all' || scope === 'selected' && selected(n) || scope === 'missing' && required(n)) indices.push(n); }, cancelled);
      this.current(context); cached = { fingerprint, indices, counts: { matched, available: matchesAvailable, selected: matchesSelected, selectedOutsideFilter: p.selectedCount - matchesSelected, selectedOutsidePage: p.selectedCount } };
      const next = immutable({ entries: [...prior.slice(-7), cached] }); this.store.assertTransientCapacity([next]); this.store.putInternalRecord(cacheKey, next);
    }
    const offset = this.offset(fingerprint, query.cursor, cached.indices.length), page = cached.indices.slice(offset, offset + Number(query.limit ?? 50));
    const byId = page.length ? await this.ordinals(context, cancelled) : new Map<string, number>(), items = await Promise.all(page.map(n => this.row(context, n, byId, cancelled))); this.current(context);
    const fileIds = new Set(items.flatMap(row => row.origin?.fileId ? [row.origin.fileId] : []));
    return { selectionId: record.summary.id, previewId, revision: record.summary.revision, state: record.summary.state, scope, items, total: cached.indices.length, nextCursor: this.cursor(fingerprint, offset + items.length, cached.indices.length), summary: record.summary,
      filterCounts: { ...cached.counts, selectedOutsidePage: p.selectedCount - items.filter(row => row.selected).length }, sourceFiles: context.snapshot.content.sources.filter(source => fileIds.has(source.id)) };
  }
  async dependencies(workspaceId: string, previewId: string, proposalId: string, query: { scope?: 'all' | 'missing'; limit?: string; cursor?: string }, cancelled?: () => boolean): Promise<ProposalDependencyPageDTO> {
    const context = this.context(workspaceId, previewId), projection = context.record.projection; if (!projection) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE');
    const byId = await this.ordinals(context, cancelled), ordinal = byId.get(proposalId); if (ordinal === undefined) throw new ApiError('RESOURCE_NOT_FOUND');
    const parent = context.bundle.proposals[ordinal]!, wanted = new Set<string>(), required = selectionMaskReader(projection.required), scope = query.scope ?? 'all', direct: number[] = []; let missing = 0;
    await this.scan(parent.predecessorIds, id => { if (!byId.has(id)) throw new ApiError('INTERNAL_ERROR'); wanted.add(id); }, cancelled);
    await this.scan(context.bundle.proposals, (row, n) => { if (!wanted.has(row.id)) return; if (required(n)) missing++; if (scope === 'all' || required(n)) direct.push(n); }, cancelled);
    const fingerprint = this.fingerprint(context, { resource: 'dependencies', proposalId, scope }), offset = this.offset(fingerprint, query.cursor, direct.length), rows = direct.slice(offset, offset + Number(query.limit ?? 50)); this.current(context);
    return { selectionId: context.record.summary.id, previewId, revision: context.record.summary.revision, state: context.record.summary.state, proposalId, scope, items: await Promise.all(rows.map(n => this.row(context, n, byId, cancelled))), total: direct.length,
      nextCursor: this.cursor(fingerprint, offset + rows.length, direct.length), predecessorCount: wanted.size, requiredPredecessorCount: missing };
  }
}
