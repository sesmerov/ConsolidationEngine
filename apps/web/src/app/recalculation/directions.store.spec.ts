import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
import { DirectionsStore } from './directions.store';

describe('confirmation of destination conflict choices', () => {
  const workspaceId = '60000000-0000-4000-8000-000000000001', versionId = '60000000-0000-4000-8000-000000000002';
  const reviewId = '60000000-0000-4000-8000-000000000003', groupId = 'group-one', instanceId = 'candidate-one';
  let store: DirectionsStore, revision: number, api: Record<string, ReturnType<typeof vi.fn>>;
  const summary = () => ({ id: reviewId, workspaceId, currentVersionId: versionId, validationBasisId: versionId, runId: 'run-one', revision,
    state: 'ready', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), conflictGroupCount: revision === 1 ? 1 : 0,
    counts: { pending: 0, conflicted: revision === 1 ? 2 : 0, undetermined: 0, included: revision === 1 ? 0 : 1, omitted: revision === 1 ? 0 : 1 } });
  const group = () => ({ groupId, state: revision === 1 ? 'conflicted' : 'resolved', candidateCount: 2,
    ...(revision > 1 ? { selectedCandidate: { instanceId, code: 'RULE_ONE' } } : {}) });
  beforeEach(async () => {
    revision = 1;
    api = {
      recalculationState: vi.fn(async () => ({ workspaceId, currentVersionId: versionId, validationBasisId: versionId, state: 'pending', compatibleRun: { id: 'run-one' }, review: summary() })),
      directionReviewRows: vi.fn(async () => ({ reviewId, revision, items: [], total: 0, nextCursor: null })),
      directionConflictGroups: vi.fn(async () => ({ reviewId, revision, items: revision === 1 ? [group()] : [], total: revision === 1 ? 1 : 0, nextCursor: null })),
      directionConflictCandidates: vi.fn(async () => ({ reviewId, revision, group: group(), items: [{ instanceId, code: 'RULE_ONE', availability: 'selectable' }], total: 1, nextCursor: null })),
      editDirectionReview: vi.fn(async () => { revision++; return { summary: summary(), appliedRevision: revision }; }),
    };
    const session = { workspace: signal({ id: workspaceId }), versionId: signal(versionId), etag: signal('"etag"'), pending: signal(false), jobActive: signal(false), job: signal(null), refreshWorkspace: vi.fn() };
    TestBed.configureTestingModule({ providers: [{ provide: ApiClient, useValue: api }, { provide: SessionStore, useValue: session }, { provide: WorkspaceViewStore, useValue: { visit: vi.fn() } }] });
    store = TestBed.inject(DirectionsStore); TestBed.tick(); await store.recover(false);
    store.selectCandidate(instanceId); expect(store.hasUnsavedChoice()).toBe(true);
  });
  afterEach(() => TestBed.resetTestingModule());
  it('accepts its own incremented revision without claiming that another edit changed the review', async () => {
    expect(await store.confirmChoice()).toBe(true);
    expect(store.review()?.revision).toBe(2); expect(store.pendingCount()).toBe(0);
    expect(store.editor()).toBeNull(); expect(store.anchoredGroup()?.selectedCandidate?.instanceId).toBe(instanceId);
    expect(store.error()).toBe(''); expect(store.canSimulate()).toBe(true);
  });
  it('clears the editor without a stale warning when replaying the same uncertain confirmation', async () => {
    api['editDirectionReview']!.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 }));
    expect(await store.confirmChoice()).toBe(false); expect(store.uncertain()).toBe(true);
    const original = api['editDirectionReview']!.mock.calls[0]; await store.retry();
    expect(api['editDirectionReview']!.mock.calls[1]).toEqual(original);
    expect(store.review()?.revision).toBe(2); expect(store.editor()).toBeNull(); expect(store.error()).toBe('');
  });
  it('keeps the actual stale-revision error and local choice when a different revision rejects the confirmation', async () => {
    api['editDirectionReview']!.mockRejectedValueOnce(new HttpErrorResponse({ status: 409, error: { error: { message: 'La revisión cambió.' } } }));
    expect(await store.confirmChoice()).toBe(false);
    expect(store.review()?.revision).toBe(1); expect(store.hasUnsavedChoice()).toBe(true); expect(store.error()).toBe('La revisión cambió.');
  });
});
