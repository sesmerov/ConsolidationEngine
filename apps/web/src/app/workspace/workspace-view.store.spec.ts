import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceViewStore } from './workspace-view.store';

describe('siguiente etapa de una publicación comprobada', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps one 4.5-second highlight identity across rereads, but starts a new one for another publication', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const view = new WorkspaceViewStore(); view.reconcile('w', 'v1');
    view.published('w', 'v1', 'v2', 'first', 'preview'); view.reconcile('w', 'v2');
    const presentation = view as WorkspaceViewStore & { highlight?: () => { id: string; startedAt: number; endsAt: number } | null; claimAnnouncement?: () => string | null };
    const first = presentation.highlight?.();
    expect(first).toMatchObject({ startedAt: 10_000, endsAt: 14_500 });
    expect(presentation.claimAnnouncement?.()).toBe('Recalcular');
    expect(presentation.claimAnnouncement?.()).toBeNull();
    vi.setSystemTime(13_000); view.reconcile('w', 'v2'); view.published('w', 'v1', 'v2', 'first', 'preview');
    expect(presentation.highlight?.()).toEqual(first);
    view.published('w', 'v2', 'v3', 'second', 'preview'); view.reconcile('w', 'v3');
    expect(presentation.highlight?.()).toMatchObject({ startedAt: 13_000, endsAt: 17_500 });
    expect(presentation.highlight?.()?.id).not.toBe(first?.id);
    expect(presentation.claimAnnouncement?.()).toBe('Recalcular');
    view.visit('preview'); expect(presentation.highlight?.()).toBeNull();
  });
  it('waits for its version, consumes once without changing stage and rejects replay', () => {
    const view = new WorkspaceViewStore();
    view.reconcile('w', null);
    view.published('w', null, 'v1', 'import-job', 'validation');
    expect(view.recommended()).toBeNull();
    view.reconcile('w', 'v1');
    expect(view.recommended()).toBe('validation'); expect(view.stage()).toBe('import');
    view.visit('validation'); expect(view.recommended()).toBeNull();
    view.visit('import'); view.published('w', null, 'v1', 'import-job', 'validation');
    expect(view.recommended()).toBeNull();
  });
  it('accepts late matching receipts, forgets a superseded operation and drops all data on workspace change', () => {
    const view = new WorkspaceViewStore();
    view.reconcile('w', 'v1'); view.reconcile('w', 'v2');
    view.published('w', 'v1', 'v2', 'review', 'preview');
    expect(view.recommended()).toBe('preview');
    view.published('w', null, 'v1', 'late-import', 'validation');
    expect(view.recommended()).toBe('preview');
    view.reconcile('w', 'v3'); expect(view.recommended()).toBeNull();
    view.published('w', 'v3', 'v4', 'apply', 'exports', 'receipt');
    view.reconcile('other', 'v4');
    view.published('w', 'v3', 'v4', 'apply', 'exports', 'receipt');
    expect(view.recommended()).toBeNull(); expect(view.downloadEntry()).toBeNull();
  });
  it('ignores visits to other stages, hands off the exact receipt and clears it on the next version', () => {
    const view = new WorkspaceViewStore(); view.reconcile('w', 'old');
    view.published('w', 'old', 'new', 'apply', 'exports', 'receipt');
    view.reconcile('w', 'new'); view.visit('validation');
    expect(view.recommended()).toBe('exports'); expect(view.downloadEntry()).toBeNull();
    view.visit('exports');
    expect(view.recommended()).toBeNull(); expect(view.downloadEntry()).toMatchObject({ newVersionId: 'new', receiptId: 'receipt' });
    view.reconcile('w', 'next'); expect(view.downloadEntry()).toBeNull();
  });
});
