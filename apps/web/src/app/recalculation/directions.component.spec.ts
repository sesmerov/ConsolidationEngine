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
  directionConflictGroups: vi.fn(), directionConflictCandidates: vi.fn(), directionConflictCandidate: vi.fn(),
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
    api.directionConflictGroups.mockResolvedValue({ reviewId: ready.id, revision: 1, total: 1, nextCursor: null, items: [
      { groupId: 'g', targetLabel: 'T · r0070', contextLabel: 'Banco', candidateCount: 2, activeCount: 2, state: 'conflicted' },
    ] });
    api.directionConflictCandidates.mockResolvedValue({ reviewId: ready.id, revision: 1,
      group: { groupId: 'g', targetLabel: 'T · r0070', contextLabel: 'Banco', candidateCount: 2, activeCount: 2, state: 'conflicted' },
      total: 2, nextCursor: null, items: [
        { instanceId: 'i3', rowId: 'c1', code: 'v0174_m', targetSide: 'right', expressionPreview: '1={tT,r0070,c0010}', descriptionPreview: 'Importe agregado', expressionTruncated: false, descriptionTruncated: false, availability: 'selectable', selected: false },
        { instanceId: 'i4', rowId: 'c2', code: 'DEMO_RANGE', targetSide: 'right', expressionPreview: '2={tT,r0070,c0010}', expressionTruncated: false, descriptionTruncated: false, availability: 'selectable', selected: false },
      ] });
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
  it('edits a conflict locally with radios and sends one PATCH only after explicit confirmation', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    const groupPanel = root.querySelector<HTMLElement>('[role=group][aria-label*="r0070"]')!;
    expect(groupPanel.textContent).not.toContain('Conservar');
    const radio = groupPanel.querySelector<HTMLInputElement>('input[type=radio]');
    expect(radio).not.toBeNull();
    radio!.click(); await stable(fixture);
    expect(api.editDirectionReview).not.toHaveBeenCalled();
    expect(button(root, 'Guardar configuración').disabled).toBe(true);
    expect(root.textContent).toContain('Confirma o cancela la elección pendiente');
    api.editDirectionReview.mockResolvedValue({ summary: { ...ready, revision: 2 }, appliedRevision: 2 });
    button(groupPanel, 'Confirmar elección').click(); await stable(fixture);
    expect(api.editDirectionReview).toHaveBeenCalledTimes(1);
    expect(api.editDirectionReview.mock.calls[0]![2].operations).toEqual([{ op: 'resolveGroup', groupId: 'g', winnerInstanceId: 'i3' }]);
  });
  it('cancels a local omission without a PATCH and keeps controls out of radio labels', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    const groupPanel = root.querySelector<HTMLElement>('[role=group][aria-label*="r0070"]')!;
    const omission = [...groupPanel.querySelectorAll<HTMLElement>('mat-radio-button')].find(r => r.textContent?.includes('No recalcular esta celda'));
    expect(omission).toBeDefined();
    omission!.querySelector<HTMLInputElement>('input')!.click(); await stable(fixture);
    button(groupPanel, 'Cancelar').click(); await stable(fixture);
    expect(api.editDirectionReview).not.toHaveBeenCalled();
    for (const label of groupPanel.querySelectorAll('mat-radio-button label')) expect(label.querySelector('button')).toBeNull();
  });
  it('retains the local choice when a different group, filter, stage or discard is requested', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement, store = fixture.componentInstance.store;
    root.querySelector<HTMLInputElement>('input[type=radio]')!.click(); await stable(fixture);
    expect(store.allowLeaveEditor()).toBe(false);
    await store.filter('omitted'); await store.discard();
    await store.openGroup({ groupId: 'other', targetLabel: 'Otra celda', contextLabel: 'Banco', candidateCount: 2, activeCount: 2, state: 'conflicted' });
    expect(store.editor()?.group.groupId).toBe('g'); expect(store.editor()?.value).toBe('i3');
    expect(store.stateFilter()).toBe(''); expect(api.discardDirectionReview).not.toHaveBeenCalled();
    expect(root.textContent).toContain('Confirma o cancela');
    store.cancelChoice(); expect(store.allowLeaveEditor()).toBe(true);
  });
  it('disables candidates assigned elsewhere and loads original text only on demand', async () => {
    const previous = await api.directionConflictCandidates();
    api.directionConflictCandidates.mockResolvedValue({ ...previous, items: previous.items.map((item: {instanceId: string}) => item.instanceId === 'i3'
      ? { ...item, availability: 'assignedElsewhere', assignedTargetLabel: 'T · r0040' } : item) });
    api.directionConflictCandidate.mockResolvedValue({ reviewId: ready.id, revision: 1, candidate: previous.items[1], expression: '<b>Expresión literal</b>', descriptions: [{description:'Descripción completa',sourceLabel:'catalogo.xlsx · Reglas · fila 3'}] });
    const fixture = await render(), root = fixture.nativeElement as HTMLElement, store = fixture.componentInstance.store;
    expect(root.querySelector<HTMLInputElement>('input[type=radio]')!.disabled).toBe(true);
    expect(root.textContent).toContain('otro destino elegido: T · r0040');
    store.selectCandidate('i3'); expect(store.editor()?.value).toBeUndefined(); expect(api.editDirectionReview).not.toHaveBeenCalled();
    expect(api.directionConflictCandidate).not.toHaveBeenCalled();
    await store.showCandidate('i4'); await stable(fixture);
    expect(root.textContent).toContain('<b>Expresión literal</b>'); expect(root.querySelector('.candidate-detail b')).toBeNull();
    expect(root.textContent).toContain('catalogo.xlsx · Reglas · fila 3');
  });
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
    api.directionConflictGroups.mockResolvedValue({ reviewId: ready.id, revision: 2, total: 1, nextCursor: null, items: [
      { groupId: 'g', targetLabel: 'T · r0070', contextLabel: 'Banco', candidateCount: 2, activeCount: 1, state: 'resolved', selectedCandidate: { instanceId: 'i3', code: 'v0174_m', targetSide: 'right' } },
    ] });
    groupPanel.querySelector<HTMLInputElement>('input[type=radio]')!.click(); await stable(fixture);
    const confirm = button(groupPanel, 'Confirmar elección'); confirm.focus(); confirm.click(); await stable(fixture);
    expect(api.editDirectionReview.mock.calls[0]![2].operations).toEqual([{ op:'resolveGroup',groupId:'g',winnerInstanceId:'i3' }]);
    expect(groupPanel.textContent).toContain('Regla elegida:'); expect(button(groupPanel, 'Cambiar elección')).toBeDefined();
    expect(document.activeElement).toBe(groupPanel.querySelector('[data-group-summary]'));
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
    let revision = 1;
    const target = () => ({ groupId: 'g', targetLabel: 'T · r0070', contextLabel: 'Banco', candidateCount: 51, activeCount: revision === 1 ? 51 : 1, state: revision === 1 ? 'conflicted' : 'resolved',
      ...(revision > 1 ? { selectedCandidate: { instanceId: 'producer-50', code: 'RULE_50', targetSide: 'right' } } : {}) });
    const candidates = Array.from({ length: 51 }, (_, i) => ({ instanceId: 'producer-' + i, rowId: 'row-' + i, code: 'RULE_' + i, targetSide: 'right', expressionPreview: '1=1', descriptionTruncated: false, expressionTruncated: false, availability: 'selectable', selected: false }));
    api.directionConflictGroups.mockImplementation(async () => ({ reviewId: ready.id, revision, items: [target()], total: 1, nextCursor: null }));
    api.directionConflictCandidates.mockImplementation(async (_w, _id, _groupId, query = {}) => ({ reviewId: ready.id, revision, group: target(),
      items: query.cursor ? candidates.slice(50) : candidates.slice(0, 50), total: 51, nextCursor: query.cursor ? null : 'next' }));
    api.directionReviewRows.mockImplementation(async () => ({ reviewId: ready.id, revision, items: rows, total: rows.length, nextCursor: null }));
    api.editDirectionReview.mockImplementation(async () => {
      revision++; return { summary: { ...ready, revision }, appliedRevision: revision };
    });
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    const store = fixture.componentInstance.store;
    await store.loadCandidates(1); await stable(fixture);
    expect(api.directionConflictCandidates.mock.lastCall?.[3]).toEqual({ cursor: 'next' });
    root.querySelector<HTMLInputElement>('input[type=radio]')!.click(); await stable(fixture);
    expect(api.editDirectionReview).not.toHaveBeenCalled();
    await store.loadCandidates(0); await stable(fixture);
    expect(root.textContent).toContain('La regla elegida está en otra página: RULE_50');
    button(root, 'Confirmar elección').click(); await stable(fixture);
    expect(api.editDirectionReview.mock.calls[0]![2].operations).toEqual([{op:'resolveGroup',groupId:'g',winnerInstanceId:'producer-50'}]);
    expect(root.textContent).toContain('Regla elegida: RULE_50');
    button(root, 'Cambiar elección').click(); await stable(fixture);
    expect(store.editor()?.value).toBe('producer-50');
    expect(store.selectedOutsidePage()).toBe(true);
  });
  it('reloads changes from another tab after a stale patch without retrying it as a new mutation', async () => {
    const fixture = await render(), root = fixture.nativeElement as HTMLElement;
    api.editDirectionReview.mockRejectedValue(new HttpErrorResponse({status:409,error:{error:{message:'Otra edición modificó esta revisión.'}}}));
    api.activeDirectionReviews.mockResolvedValue({active:{...ready,revision:2}});
    api.directionReviewRows.mockResolvedValue({reviewId:ready.id,revision:2,items:[{...single,state:'omitted',origin:'saved'}],total:1,nextCursor:null});
    api.directionConflictGroups.mockResolvedValue({ reviewId: ready.id, revision: 2, items: [], total: 0, nextCursor: null });
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
