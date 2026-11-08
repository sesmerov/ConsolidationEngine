import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ValidationRunDTO } from '@ce/contracts';
import { WorkspaceViewStore } from './workspace-view.store';

const summary = { complete: true, rows: 1, variants: 1, instances: 1, duplicateRows: 0, applicableVariants: 1,
  byStatus: { pass: 1, fail: 0, error: 0, not_applicable: 0, not_evaluable: 0 } };
const completed = (id = 'run', versionId = 'v1', validationBasisId: string | undefined = 'basis'): ValidationRunDTO => ({
  id, versionId, ...(validationBasisId ? { validationBasisId } : {}), profileId: 'profile', status: 'completed',
  startedAt: '2026-11-08T00:00:00.000Z', summary, diagnostics: [], resultIds: [],
});
// Optional invocation lets the first red run assert missing behaviour, not a missing symbol.
function validated(view: WorkspaceViewStore, workspaceId: string, run: ValidationRunDTO): void {
  (view as WorkspaceViewStore & { validated?: (workspaceId: string, run: ValidationRunDTO) => void }).validated?.(workspaceId, run);
}
function reconcile(view: WorkspaceViewStore, workspaceId: string | null, versionId: string | null, basis?: string): void {
  (view.reconcile as (workspaceId: string | null, versionId: string | null, basis?: string) => void)(workspaceId, versionId, basis);
}

describe('confirmed workflow milestones', () => {
  afterEach(() => vi.useRealTimers());
  it('keeps one 4.5-second highlight across rereads and starts a fresh one for another completed validation', () => {
    vi.useFakeTimers(); vi.setSystemTime(10_000);
    const view = new WorkspaceViewStore(); reconcile(view, 'w', 'v1', 'basis');
    validated(view, 'w', completed('first'));
    const first = view.highlight();
    expect(first).toMatchObject({ startedAt: 10_000, endsAt: 14_500 });
    expect(view.claimAnnouncement()).toBe('Recalcular'); expect(view.claimAnnouncement()).toBeNull();
    vi.setSystemTime(13_000); reconcile(view, 'w', 'v1', 'basis'); validated(view, 'w', completed('first'));
    expect(view.highlight()).toEqual(first);
    validated(view, 'w', completed('second'));
    expect(view.highlight()).toMatchObject({ startedAt: 13_000, endsAt: 17_500 });
    expect(view.highlight()?.id).not.toBe(first?.id); expect(view.claimAnnouncement()).toBe('Recalcular');
    view.visit('preview'); expect(view.highlight()).toBeNull();
  });
  it('waits for a published import version, consumes once without changing stage and rejects replay', () => {
    const view = new WorkspaceViewStore(); reconcile(view, 'w', null);
    view.published('w', null, 'v1', 'import-job', 'validation'); expect(view.recommended()).toBeNull();
    reconcile(view, 'w', 'v1', 'basis'); expect(view.recommended()).toBe('validation'); expect(view.stage()).toBe('import');
    view.visit('validation'); expect(view.recommended()).toBeNull();
    view.visit('import'); view.published('w', null, 'v1', 'import-job', 'validation'); expect(view.recommended()).toBeNull();
  });
  it('advances on validation without a new version, keeps it through configuration-only versions and rejects data changes', () => {
    const view = new WorkspaceViewStore(); reconcile(view, 'w', 'v1', 'basis'); view.visit('validation');
    validated(view, 'w', completed()); expect(view.recommended()).toBe('preview');
    const highlight = view.highlight(); reconcile(view, 'w', 'v2', 'basis');
    expect(view.recommended()).toBe('preview'); expect(view.highlight()).toEqual(highlight);
    reconcile(view, 'w', 'v3', 'different-data'); expect(view.recommended()).toBeNull();
    validated(view, 'w', completed('historical')); expect(view.recommended()).toBeNull();
  });
  it('does not turn a saved configuration into a new milestone', () => {
    const view = new WorkspaceViewStore(); reconcile(view, 'w', 'v1', 'basis');
    view.published('w', 'v1', 'v2', 'configuration', 'preview'); reconcile(view, 'w', 'v2', 'basis');
    expect(view.recommended()).toBeNull(); expect(view.highlight()).toBeNull();
  });
  it('rejects incomplete, running, foreign-workspace and incompatible validation results', () => {
    const view = new WorkspaceViewStore(); reconcile(view, 'w', 'v1', 'basis');
    validated(view, 'w', { ...completed(), status: 'incomplete' });
    validated(view, 'w', { ...completed(), status: 'running' });
    validated(view, 'w', { ...completed(), summary: { ...summary, complete: false } });
    validated(view, 'other', completed()); validated(view, 'w', completed('foreign', 'v1', 'other-basis'));
    expect(view.recommended()).toBeNull(); expect(view.highlight()).toBeNull();
  });
  it('allows a complete run of the same input basis even when the configuration version differs', () => {
    const view = new WorkspaceViewStore(); reconcile(view, 'w', 'v2', 'basis');
    validated(view, 'w', completed('compatible', 'v1', 'basis')); expect(view.recommended()).toBe('preview');
  });
  it('requires the exact version when a legacy result has no basis', () => {
    const view = new WorkspaceViewStore(); reconcile(view, 'w', 'v2', 'basis');
    const { validationBasisId: _basis, ...legacy } = completed('legacy', 'v1');
    validated(view, 'w', legacy); expect(view.recommended()).toBeNull();
    validated(view, 'w', { ...legacy, versionId: 'v2' }); expect(view.recommended()).toBe('preview');
  });
  it('does not replay a validation after visiting the recommendation or disturb another workspace', () => {
    const view = new WorkspaceViewStore(); reconcile(view, 'w', 'v1', 'basis');
    validated(view, 'w', completed()); view.visit('preview'); view.visit('validation');
    validated(view, 'w', completed()); expect(view.recommended()).toBeNull();
    reconcile(view, 'other', 'v1', 'basis'); validated(view, 'w', completed('late')); expect(view.recommended()).toBeNull();
  });
  it('accepts late matching application receipts, forgets superseded ones and drops state on workspace change', () => {
    const view = new WorkspaceViewStore(); view.reconcile('w', 'v1'); view.reconcile('w', 'v2');
    view.published('w', 'v1', 'v2', 'application', 'exports', 'receipt'); expect(view.recommended()).toBe('exports');
    view.published('w', null, 'v1', 'late-import', 'validation'); expect(view.recommended()).toBe('exports');
    view.reconcile('w', 'v3'); expect(view.recommended()).toBeNull();
    view.published('w', 'v3', 'v4', 'apply', 'exports', 'receipt'); view.reconcile('other', 'v4');
    view.published('w', 'v3', 'v4', 'apply', 'exports', 'receipt');
    expect(view.recommended()).toBeNull(); expect(view.downloadEntry()).toBeNull();
  });
  it('ignores visits elsewhere, hands off the exact receipt once and clears it on another version', () => {
    const view = new WorkspaceViewStore(); view.reconcile('w', 'old');
    view.published('w', 'old', 'new', 'apply', 'exports', 'receipt'); view.reconcile('w', 'new'); view.visit('validation');
    expect(view.recommended()).toBe('exports'); expect(view.downloadEntry()).toBeNull();
    view.visit('exports'); expect(view.recommended()).toBeNull(); expect(view.downloadEntry()).toMatchObject({ newVersionId: 'new', receiptId: 'receipt' });
    view.reconcile('w', 'next'); expect(view.downloadEntry()).toBeNull();
  });
});
