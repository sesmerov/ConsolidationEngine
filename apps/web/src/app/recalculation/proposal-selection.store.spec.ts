import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { PreviewStore } from './preview.store';
import { ApplyStore } from './apply.store';

const workspaceId = '60000000-0000-4000-8000-000000000001';
const baseVersionId = '60000000-0000-4000-8000-000000000002';
const previewId = '60000000-0000-4000-8000-000000000003';
const selectionId = '60000000-0000-4000-8000-000000000004';
const proposalId = '60000000-0000-4000-8000-000000000005';
const summary = (revision = 1, selectedCount = 5) => ({ id: selectionId, workspaceId, baseVersionId, previewId, revision,
  state: 'ready', availableCount: 5, selectedCount, requiredCount: 0, complete: true, closureHash: 'a'.repeat(64) });
const row = { id: proposalId, code: 'FIRST', state: 'available', target: { contextId: 'demo', tableCode: 'T', sheetCode: '', rowCode: '0010', columnCode: '0010' },
  description: '', descriptionTruncated: false, selected: true, required: false, predecessorCount: 0, requiredPredecessorCount: 0,
  rounded: false, hasInterval: false, diagnosticCount: 0 };
const page = (revision = 1, selectedCount = 5, items: typeof row[] = Array.from({length:5}, (_, index) => ({...row, id: index ? '60000000-0000-4000-8000-' + String(index + 10).padStart(12,'0') : proposalId, selected: index < selectedCount}))) => ({ selectionId, previewId, revision, state: 'ready', scope: 'all',
  items, total: 5, nextCursor: null, summary: summary(revision, selectedCount), sourceFiles: [],
  filterCounts: { matched: 5, available: 5, selected: selectedCount, selectedOutsideFilter: 0, selectedOutsidePage: selectedCount - items.filter(x => x.selected).length } });

describe('004 persisted proposal selection and explicit consent', () => {
  let api: Record<string, ReturnType<typeof vi.fn>>, session: Record<string, any>, store: PreviewStore, applying: ApplyStore;
  beforeEach(() => {
    const preview = { id: previewId, baseVersionId, state: 'ready', createdAt: '2026-11-07T00:00:00.000Z', graphSummary: { nodes: 5, edges: 0, conflictCount: 0, cycleCount: 0, blocked: 0 }, diagnosticCount: 0 };
    api = {
      previews: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }), previewCompact: vi.fn().mockResolvedValue(preview), preview: vi.fn(),
      proposals: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
      proposalSelectionState: vi.fn().mockResolvedValue(summary()), selectionRows: vi.fn().mockResolvedValue(page()),
      editProposalSelection: vi.fn().mockResolvedValue({ jobId: 'edit', workspaceId, kind: 'select-proposals', status: 'queued' }),
      prepareProposalSelection: vi.fn().mockResolvedValue({ jobId: 'prepare', workspaceId, kind: 'select-proposals', status: 'queued' }), proposal: vi.fn(), previewSelection: vi.fn(),
      proposalExplanation: vi.fn(), selectionDependencies: vi.fn(), job: vi.fn(),
      createPreview: vi.fn().mockResolvedValue({ jobId: 'new-preview', workspaceId, kind: 'preview', status: 'queued' }),
    };
    session = { workspace: signal({ id: workspaceId, contexts: [], versionIds: [baseVersionId] }), versionId: signal(baseVersionId),
      etag: signal('"version"'), pending: signal(false), jobActive: signal(false), job: signal(null), selectedContextId: signal(null),
      trackJob: vi.fn(), refreshWorkspace: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: api }, { provide: SessionStore, useValue: session }] });
    store = TestBed.inject(PreviewStore); applying = TestBed.inject(ApplyStore); TestBed.tick();
  });
  afterEach(() => { TestBed.resetTestingModule(); });
  async function load() { store.selectedPreviewId.set(previewId); await store.load(); TestBed.tick(); }
  const selectionOf = (s: PreviewStore) => s.selection() as unknown as ReturnType<typeof summary> | null;
  const commands = (s: PreviewStore) => s as unknown as { selectMatching(): Promise<void>; clearAll(): Promise<void>; retrySelection(): Promise<void> };

  it('recovers five preselected proposals through compact GETs, without consent or initialization', async () => {
    await load(); expect(selectionOf(store)?.selectedCount).toBe(5); expect(applying.acknowledged()).toBe(false);
    expect(api['proposalSelectionState']).toHaveBeenCalled(); expect(api['prepareProposalSelection']).not.toHaveBeenCalled();
    expect(api['proposals']).not.toHaveBeenCalled(); expect(api['proposal']).not.toHaveBeenCalled();
  });
  it('keeps deselections when a filter has no matches and does not fetch off-page DTOs', async () => {
    await load(); api['selectionRows']!.mockResolvedValue({ ...page(2, 4, []), total: 0, filterCounts: { matched: 0, available: 0, selected: 0, selectedOutsideFilter: 4, selectedOutsidePage: 4 } });
    api['proposalSelectionState']!.mockResolvedValue(summary(2, 4)); store.code.set('NO_MATCH'); await store.load();
    expect(selectionOf(store)?.selectedCount).toBe(4); expect(store.hiddenSelectedCount()).toBe(4);
    expect(api['prepareProposalSelection']).not.toHaveBeenCalled(); expect(api['proposal']).not.toHaveBeenCalled();
  });
  it('invalidates consent immediately and edits only the selected identity at its exact revision', async () => {
    await load(); applying.acknowledged.set(true); await store.toggle(proposalId, false);
    expect(applying.acknowledged()).toBe(false);
    expect(api['editProposalSelection']).toHaveBeenCalledWith(workspaceId, previewId,
      { selectionId, expectedRevision: 1, operations: [{ op: 'set', proposalId, selected: false }] }, '"version"', expect.any(String));
    expect(api['previewSelection']).not.toHaveBeenCalled();
  });
  it('selects the complete filter and clears globally with compact commands', async () => {
    await load(); store.code.set('FIRST'); await commands(store).selectMatching();
    expect(api['editProposalSelection']!.mock.calls[0]![2]).toMatchObject({ operations: [{ op: 'selectMatching', filter: { code: 'FIRST' } }] });
    api['proposalSelectionState']!.mockResolvedValue(summary(2)); api['selectionRows']!.mockResolvedValue(page(2)); await store.load();
    await commands(store).clearAll(); expect(api['editProposalSelection']!.mock.calls.at(-1)![2]).toMatchObject({ operations: [{ op: 'clear' }] });
  });
  it('replays the same uncertain operation and blocks different decisions until its response is known', async () => {
    await load(); api['editProposalSelection']!.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    await store.toggle(proposalId, false); const attempt = api['editProposalSelection']!.mock.calls[0];
    await commands(store).clearAll(); expect(api['editProposalSelection']).toHaveBeenCalledTimes(1);
    await commands(store).retrySelection(); expect(api['editProposalSelection']!.mock.calls[1]).toEqual(attempt);
  });
  it('ignores a late page from a superseded filter', async () => {
    await load(); let release!: (value: ReturnType<typeof page>) => void;
    api['selectionRows']!.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const old = store.load(); store.code.set('new'); api['selectionRows']!.mockResolvedValue(page(2, 4)); api['proposalSelectionState']!.mockResolvedValue(summary(2, 4));
    await store.load(); release(page()); await old; expect(selectionOf(store)?.revision).toBe(2);
  });
  it('does not restore acceptance when a later revision has the same closure hash', async () => {
    await load(); applying.acknowledged.set(true); await store.toggle(proposalId, false);
    api['proposalSelectionState']!.mockResolvedValue(summary(3)); api['selectionRows']!.mockResolvedValue(page(3)); await store.load();
    expect(selectionOf(store)?.closureHash).toBe('a'.repeat(64)); expect(applying.acknowledged()).toBe(false);
  });
  it('blocks simulation and empty initialization while an application response is uncertain', async () => {
    await load(); applying.uncertain.set(true);
    await store.execute(); expect(api['createPreview']).not.toHaveBeenCalled();
    store.selectionMissing.set(true); await store.prepareEmptySelection(); expect(api['prepareProposalSelection']).not.toHaveBeenCalled();
  });
  it('recovers the exact pending worker after a reload without inventing published counters', async () => {
    const preparing = { id: selectionId, workspaceId, baseVersionId, previewId, revision: 0, state: 'preparing', pendingJobId: 'preparing-job' };
    api['proposalSelectionState']!.mockResolvedValue(preparing); api['selectionRows']!.mockRejectedValue(new HttpErrorResponse({status:409}));
    api['job']!.mockResolvedValue({ jobId: 'preparing-job', workspaceId, kind: 'select-proposals', status: 'running' });
    await load(); await Promise.resolve();
    expect(store.selection()?.revision).toBe(0); expect(store.selection()?.selectedCount).toBeUndefined(); expect(store.page()).toBeNull();
    expect(session['trackJob']).toHaveBeenCalledWith(expect.objectContaining({jobId:'preparing-job'}));
    expect(api['prepareProposalSelection']).not.toHaveBeenCalled();
  });
  it('initializes an old current preview only after an explicit empty-selection command', async () => {
    api['proposalSelectionState']!.mockRejectedValue(new HttpErrorResponse({status:404})); api['selectionRows']!.mockRejectedValue(new HttpErrorResponse({status:404}));
    await load(); expect(store.selectionMissing()).toBe(true); expect(api['prepareProposalSelection']).not.toHaveBeenCalled();
    await store.prepareEmptySelection(); expect(api['prepareProposalSelection']).toHaveBeenCalledWith(workspaceId,previewId,baseVersionId,'"version"',expect.any(String));
  });
  it('never edits or initializes historical previews', async () => {
    api['previewCompact']!.mockResolvedValue({ id:previewId,baseVersionId,state:'obsolete',graphSummary:{nodes:5,edges:0,blocked:0,conflictCount:0,cycleCount:0},diagnosticCount:0 });
    api['proposalSelectionState']!.mockResolvedValue({...summary(),state:'obsolete'}); api['selectionRows']!.mockResolvedValue({...page(),state:'obsolete',summary:{...summary(),state:'obsolete'}});
    await load(); await store.toggle(proposalId,false); await store.clearAll(); await store.prepareEmptySelection();
    expect(api['editProposalSelection']).not.toHaveBeenCalled(); expect(api['prepareProposalSelection']).not.toHaveBeenCalled(); expect(store.editable()).toBe(false);
  });
  it('uses the selected context only as query/filter scope and shows missing dependencies globally', async () => {
    await load(); session['selectedContextId'].set('ctx-two'); TestBed.tick(); await Promise.resolve(); await Promise.resolve();
    expect(api['selectionRows']).toHaveBeenLastCalledWith(workspaceId,previewId,expect.objectContaining({contextId:'ctx-two'}));
    store.scope.set('missing'); await store.load(); expect(api['selectionRows']).toHaveBeenLastCalledWith(workspaceId,previewId,{scope:'missing'});
    expect(selectionOf(store)?.selectedCount).toBe(5);
  });
  it('reads recorded proposal evidence with the recalculated predecessor and never hydrates legacy DTOs', async () => {
    await load(); const detail = { selectionId, previewId, baseVersionId, revision:1,state:'ready',proposalId,code:'FIN_TOTAL_ASSETS_DEMO',
      target:row.target,evidenceState:'recorded',expression:'100+20',exactNominal:{numerator:'120',denominator:'1'},operandCount:2,originCount:2,diagnosticCount:0,descriptionCount:0,rounded:false };
    api['proposalExplanation']!.mockResolvedValue(detail); await store.openDetail(proposalId); expect(store.detail()).toEqual(detail);
    expect(api['proposalExplanation']).toHaveBeenCalledWith(workspaceId,previewId,proposalId); expect(api['proposal']).not.toHaveBeenCalled();
    let resolve!: (value: unknown)=>void; api['proposalExplanation']!.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const late=store.openDetail(proposalId); store.closeDetail(); resolve(detail); await late; expect(store.detail()).toBeNull();
  });
  it('discards selection acceptances that arrive after the workspace has closed', async () => {
    await load(); let resolve!: (value: unknown)=>void; api['editProposalSelection']!.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    const editing=store.toggle(proposalId,false); session['workspace'].set(null); TestBed.tick();
    resolve({jobId:'late',workspaceId,kind:'select-proposals',status:'queued'}); await editing;
    expect(store.selection()).toBeNull(); expect(session['trackJob']).not.toHaveBeenCalled();
  });
});
