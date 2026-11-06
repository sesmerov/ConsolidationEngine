import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders, HttpResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectionReviewRowDTO, DirectionReviewSummaryDTO, JobDTO, ValidationResultsPageDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { WorkspaceViewStore } from '../workspace/workspace-view.store';
import { DirectionsComponent } from './directions.component';

const workspace = { id: 'workspace', name: 'Revisión', state: 'ready' as const, currentVersionId: 'base', versionIds: ['base'], contexts: [], counts: { snapshots: 1, coordinates: 3, facts: 3, sources: 2 }, sessionBytes: 100 };
const page = { items: [], total: 0, nextCursor: null, versionId: 'base', run: { id: 'run', versionId: 'base', status: 'completed', summary: { complete: true } } } as unknown as ValidationResultsPageDTO;
const counts = { totalRows: 5, included: 1, omitted: 0, pending: 1, conflicted: 2, excluded: 1, undetermined: 0 };
const ready: DirectionReviewSummaryDTO = { id: 'review', workspaceId: workspace.id, runId: 'run', baseVersionId: 'base', state: 'ready', revision: 1, expiresAt: '2099-11-01T12:00:00.000Z', counts, conflictGroupCount: 1 };
const single: DirectionReviewRowDTO = { rowId: 'one', instanceId: 'instance-1', code: 'SINGLE', location: 'T · r0010', contextLabel: 'Banco', classification: 'singleRight', state: 'included', selectedSide: 'right', origin: 'automatic', options: [{ side: 'right', label: 'T · r0010' }], reasons: [] };
const both: DirectionReviewRowDTO = { ...single, rowId: 'two', instanceId: 'instance-2', code: 'BOTH', classification: 'both', state: 'pending', options: [{ side: 'left', label: 'T · r0040' }, { side: 'right', label: 'T · r0050' }] };
const excluded: DirectionReviewRowDTO = { rowId: 'excluded', code: 'TEXT', location: 'T', contextLabel: 'Banco', classification: 'none', state: 'excluded', options: [], reasons: [{ code: 'TEXT', message: 'Solo validación de texto' }] };
const group = { ...single, rowId: 'c1', instanceId: 'i3', code: 'v0174_m', location: 'T', options:[{side:'right' as const,label:'T · r0070'}], state: 'conflicted' as const, groupId: 'g', producerCount: 2 };
const rows = [single, both, excluded, group, { ...group, rowId: 'c2', instanceId: 'i4', code: 'DEMO_RANGE' }];
const receipt = { reviewId: ready.id, runId: ready.runId, baseVersionId: 'base', newVersionId: 'new', configVersion: 'config', included: 1 };
const job = (kind: 'prepare-directions'|'commit-directions'): JobDTO => ({ jobId: kind, kind, workspaceId: workspace.id, baseVersionId: 'base', status: 'queued', progress: { completed: 0, total: 1, complete: false }, diagnostics: [], pollAfterMs: 60_000 });
const api = {
  activeDirectionReviews: vi.fn(), directionReview: vi.fn(), directionReviewRows: vi.fn(), prepareDirectionReview: vi.fn(),
  editDirectionReview: vi.fn(), commitDirectionReview: vi.fn(), discardDirectionReview: vi.fn(), job: vi.fn(), workspace: vi.fn(),
};
describe('global destination review', () => {
  let session: SessionStore;
  beforeEach(() => {
    vi.resetAllMocks();
    api.activeDirectionReviews.mockResolvedValue({ active: ready });
    api.directionReview.mockResolvedValue(ready);
    api.directionReviewRows.mockResolvedValue({ reviewId: ready.id, revision: 1, items: rows, total: rows.length, nextCursor: null });
    api.prepareDirectionReview.mockResolvedValue(job('prepare-directions'));
    api.commitDirectionReview.mockResolvedValue(job('commit-directions'));
    TestBed.configureTestingModule({ imports: [DirectionsComponent], providers: [{ provide: ApiClient, useValue: api }] });
    session = TestBed.inject(SessionStore);
    session.workspace.set(workspace); session.etag.set('"base"');
    TestBed.inject(WorkspaceViewStore).reconcile(workspace.id, 'base');
  });
  afterEach(() => TestBed.resetTestingModule());
  async function stable(fixture: ComponentFixture<DirectionsComponent>) {
    fixture.detectChanges();
    // Let the mocked HTTP promises settle, including collection → summary → first page.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    await fixture.whenStable();
    fixture.detectChanges();
  }
  async function render(value = page) {
    const fixture = TestBed.createComponent(DirectionsComponent);
    fixture.componentRef.setInput('page', value);
    await stable(fixture);
    return fixture;
  }
  function button(root: HTMLElement, label: string) {
    const found = [...root.querySelectorAll('button')].find(node => node.textContent?.trim() === label);
    expect(found, label).toBeDefined();
    return found!;
  }
  function row(root: HTMLElement, code: string) {
    const found = [...root.querySelectorAll<HTMLElement>('tr')].find(node => node.querySelector('strong')?.textContent?.trim() === code);
    expect(found, code).toBeDefined(); return found!;
  }
  it('recovers independently of the first result page and prepares only on explicit action', async () => {
    api.activeDirectionReviews.mockResolvedValue({ active: null });
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    expect(api.prepareDirectionReview).not.toHaveBeenCalled();
    button(root, 'Preparar revisión de destinos').click();
    await stable(fixture);
    expect(api.prepareDirectionReview).toHaveBeenCalledTimes(1);
    expect(api.prepareDirectionReview.mock.calls[0]!.slice(0,3)).toEqual([workspace.id, { baseVersionId:'base',runId:'run' }, '"base"']);
    expect(api.commitDirectionReview).not.toHaveBeenCalled();
  });
  it('only gives ambiguous rows a side selector and sends small deltas instead of the displayed results', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    expect(row(root, 'SINGLE').textContent).toContain('Automático');
    expect(row(root, 'SINGLE').querySelector('select')).toBeNull();
    expect(row(root, 'BOTH').querySelector('select')).not.toBeNull();
    expect(root.textContent).toContain('Solo validación de texto');
    api.editDirectionReview.mockResolvedValue({ summary: { ...ready, revision:2 }, appliedRevision:2 });
    api.directionReviewRows.mockResolvedValue({ reviewId:ready.id, revision:2, items:[{ ...single, state:'omitted',origin:'saved' }], total:1, nextCursor:null });
    button(row(root, 'SINGLE'), 'Omitir').click(); await stable(fixture);
    const omitted = api.editDirectionReview.mock.calls[0]!;
    expect(omitted[2]).toEqual({ expectedRevision:1, mutationId:expect.any(String), operations:[{ op:'set',instanceId:single.instanceId,choice:'omit' }] });
    expect(row(root, 'SINGLE').textContent).toContain('Guardado');
    button(row(root, 'SINGLE'),'Usar').click(); await stable(fixture);
    expect(api.editDirectionReview.mock.calls[1]![2].operations).toEqual([{ op:'set',instanceId:single.instanceId,choice:'suggest' }]);
  });
  it('uses the global conflict group and requires acknowledgement of pending rows before commit', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    expect(button(root,'Guardar configuración').disabled).toBe(true);
    const groupPanel = root.querySelector<HTMLElement>('[role=group][aria-label*="r0070"]')!;
    expect(groupPanel).toBeTruthy();
    const updated = { ...ready, revision:2, conflictGroupCount:0, counts:{ ...counts, included:2,omitted:1,conflicted:0 } };
    api.editDirectionReview.mockResolvedValue({ summary:updated, appliedRevision:2 });
    api.directionReviewRows.mockResolvedValue({ reviewId:ready.id, revision:2, items:[single,both], total:2,nextCursor:null });
    button(groupPanel,'Conservar v0174_m').click(); await stable(fixture);
    expect(api.editDirectionReview.mock.calls[0]![2].operations).toEqual([{ op:'resolveGroup',groupId:'g',winnerInstanceId:'i3' }]);
    expect(button(root,'Guardar configuración').disabled).toBe(true);
    root.querySelector<HTMLInputElement>('input[type=checkbox]')!.click(); await stable(fixture);
    button(root,'Guardar configuración').click(); await stable(fixture);
    expect(api.commitDirectionReview.mock.calls[0]!.slice(0,4)).toEqual([workspace.id,ready.id,{expectedRevision:2,acceptPartial:true},'"base"']);
  });
  it('replays the original mutation and CAS after a lost response and reloads the latest revision', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    api.editDirectionReview.mockRejectedValueOnce(new HttpErrorResponse({status:0})).mockResolvedValueOnce({ summary:{...ready,revision:3},appliedRevision:2 });
    button(row(root,'SINGLE'),'Omitir').click(); await stable(fixture);
    const first = api.editDirectionReview.mock.calls[0];
    session.etag.set('"another"');
    api.directionReviewRows.mockResolvedValue({ reviewId:ready.id,revision:3,items:[single],total:1,nextCursor:null });
    button(root,'Reintentar la misma operación').click(); await stable(fixture);
    expect(api.editDirectionReview.mock.calls[1]).toEqual(first);
    expect(row(root,'SINGLE')).toBeTruthy();
  });
  it('allows choosing a producer from another page of a large conflict group', async () => {
    const members = Array.from({ length:51 }, (_,i) => ({ ...group, rowId:'row-'+i, instanceId:'producer-'+i, code:'RULE_'+i, producerCount:51 }));
    api.directionReviewRows.mockImplementation(async (_w, _id, query) => {
      if (!query.groupId) return {reviewId:ready.id,revision:1,items:[members[0]],total:1,nextCursor:null};
      return {reviewId:ready.id,revision:1,items:query.cursor ? members.slice(50) : members.slice(0,50),total:51,nextCursor:query.cursor ? null : 'next'};
    });
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    const first = root.querySelector<HTMLElement>('[role=group][aria-label*="r0070"]')!;
    button(first,'Ver todos los productores').click(); await stable(fixture);
    await fixture.componentInstance.store.loadRows(1); await stable(fixture);
    expect(api.directionReviewRows.mock.lastCall?.[2]).toEqual({groupId:'g',cursor:'next'});
    api.editDirectionReview.mockResolvedValue({summary:{...ready,revision:2},appliedRevision:2});
    button(root,'Conservar RULE_50').click(); await stable(fixture);
    expect(api.editDirectionReview.mock.calls[0]![2].operations).toEqual([{op:'resolveGroup',groupId:'g',winnerInstanceId:'producer-50'}]);
  });
  it('reloads changes from another tab after a stale patch without retrying it as a new mutation', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    api.editDirectionReview.mockRejectedValue(new HttpErrorResponse({status:409,error:{error:{message:'Otra edición modificó esta revisión.'}}}));
    api.activeDirectionReviews.mockResolvedValue({active:{...ready,revision:2}});
    api.directionReviewRows.mockResolvedValue({reviewId:ready.id,revision:2,items:[{...single,state:'omitted',origin:'saved'}],total:1,nextCursor:null});
    button(row(root,'SINGLE'),'Omitir').click(); await stable(fixture);
    expect(api.editDirectionReview).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('Otra edición');
    expect(button(row(root,'SINGLE'),'Usar').disabled).toBe(false);
  });
  it('disallows preparation and editing for a historical result', async () => {
    session.workspace.set({...workspace,currentVersionId:'new',versionIds:['base','new']});
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    expect(root.textContent).toContain('histórica');
    expect(root.querySelector('table')).toBeNull();
    expect(api.prepareDirectionReview).not.toHaveBeenCalled();
  });
  it('recovers a committed version after an uncertain commit without resending changes', async () => {
    const clean = { ...ready, counts:{...counts,pending:0,conflicted:0,included:4},conflictGroupCount:0 };
    api.activeDirectionReviews.mockResolvedValueOnce({ active:clean }).mockResolvedValue({active:null,latestCommit:receipt});
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    api.commitDirectionReview.mockRejectedValue(new HttpErrorResponse({status:0}));
    api.workspace.mockResolvedValue(new HttpResponse({body:{...workspace,currentVersionId:'new',versionIds:['base','new']},headers:new HttpHeaders({ETag:'"new"'})}));
    button(root,'Guardar configuración').click(); await stable(fixture);
    expect(api.commitDirectionReview).toHaveBeenCalledTimes(1);
    expect(root.textContent).toContain('Configuración guardada');
    const view = TestBed.inject(WorkspaceViewStore);
    view.reconcile(workspace.id,'new');
    expect(view.recommended()).toBe('preview');
  });
});
