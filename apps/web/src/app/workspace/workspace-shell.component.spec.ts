import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppComponent } from '../app.component';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { By } from '@angular/platform-browser';
import { HttpErrorResponse } from '@angular/common/http';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatButtonHarness } from '@angular/material/button/testing';
import { WorkspaceShellComponent } from './workspace-shell.component';
import { WorkspaceViewStore } from './workspace-view.store';
import { ImportStore } from '../import/import.store';
import { ResultsStore } from '../validation/results.store';
import { PreviewStore } from '../recalculation/preview.store';
import { DirectionsStore } from '../recalculation/directions.store';
import { ApplyStore } from '../recalculation/apply.store';
import { ExportStore } from '../recalculation/export.store';
import { OperationAttemptStore } from '../core/operation-attempt.store';
import type { CompactPreviewDTO, JobDTO, ProposalSelectionSummaryDTO, ReportContext, CompactResultsPageDTO } from '@ce/contracts';

const workspace = { id: 'workspace', name: 'Cierre de prueba', state: 'ready' as const, currentVersionId: 'v1', versionIds: ['v0', 'v1'], contexts: [], counts: { snapshots: 1, coordinates: 2, facts: 2, sources: 2 }, sessionBytes: 1 };
const domesticContext: ReportContext = {
  contextId: 'nacional', canonicalContextKey: 'scope-1', entityId: 'Banco de prueba',
  referenceDate: '2025-12-31', framework: 'COREP', moduleVersion: 'COREP_OF_4.0', filingIndicators: {},
};
const consolidatedContext: ReportContext = { ...domesticContext, contextId: 'consolidado', canonicalContextKey: 'scope-2' };
const summary = { complete: true, rows: 0, variants: 0, instances: 0, duplicateRows: 0, applicableVariants: 0, byStatus: { pass: 0, fail: 0, error: 0, not_applicable: 0, not_evaluable: 0 } };
const page:CompactResultsPageDTO = { workspaceId:workspace.id,items: [], total: 0, nextCursor: null, versionId: 'v1', run: { workspaceId:workspace.id,id: 'run', versionId: 'v1',validationBasisId:'basis', profileId: 'profile', status: 'completed', startedAt: '2026-11-04', diagnosticsCount:0, summary } };
const preview = { id: 'preview', baseVersionId: 'v1', state: 'ready', createdAt: '2026-11-04', diagnosticCount: 0, graphSummary: { nodes: 0, edges: 0, blocked: 0, cycleCount: 0, conflictCount: 0 } } as CompactPreviewDTO;
const selection: ProposalSelectionSummaryDTO = { id: 'selection', workspaceId: workspace.id, previewId: preview.id, baseVersionId: 'v1', revision: 1, state: 'ready', availableCount: 1, selectedCount: 1, requiredCount: 0, complete: true, closureHash: 'one' };
describe('workspace navigation keeps one active stage', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({ deferBlockBehavior: DeferBlockBehavior.Playthrough, imports: [AppComponent], providers: [{ provide: OperationAttemptStore, useValue: { get: vi.fn().mockReturnValue(null), save: vi.fn(), clear: vi.fn(), clearAll: vi.fn() } }, { provide: ApiClient, useValue: {
      capabilities: vi.fn().mockResolvedValue({ knownDifferences: [] }),
      activeImportInspection: vi.fn().mockResolvedValue({ active: null }),
      activeDirectionReviews: vi.fn().mockResolvedValue({ active: null }),
      recalculationState: vi.fn().mockResolvedValue({workspaceId:workspace.id,currentVersionId:'v1',validationBasisId:'basis',configuration:{configVersion:'config',directionCount:0},counts:null,state:'needs_validation'}),
      rules: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null, sources: [], coverage: {}, dataSummary: {} }),
      runs: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
      previews: vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null }),
      closeWorkspace: vi.fn().mockResolvedValue(undefined),
      exportReport: vi.fn(),
      operationReceipt: vi.fn().mockRejectedValue(new HttpErrorResponse({ status: 404 })),
      exportSummary: vi.fn().mockImplementation((workspaceId,versionId,kind='report',runId) => Promise.resolve({versionId,profileId:'profile',createdAt:'2026-11-08T00:00:00Z',reports:[],intent:{workspaceId,versionId,kind,...(runId?{runId}:{})},intentFingerprint:'a'.repeat(64)})),
    } }] });
    const session = TestBed.inject(SessionStore); vi.spyOn(session, 'connect').mockResolvedValue(); session.connected.set(true); session.workspace.set(workspace); session.etag.set('"v-v1"');
  });
  afterEach(() => TestBed.resetTestingModule());
  it('does not expose internal session/version IDs or technical controls in the rendered workspace', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('[data-testid=current-version-id]')).toBeNull();
    expect(element.textContent).not.toContain('Información de la sesión');
    expect(element.textContent).not.toContain('Información técnica');
    expect(element.querySelector('.workspace-context')?.textContent).toContain('Versión 2');
  });
  it('hides successful progress only after the matching result is rendered, retaining later failures and incomplete work', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable();
    const injector = fixture.debugElement.query(By.directive(WorkspaceShellComponent)).injector;
    const view = injector.get(WorkspaceViewStore), results = injector.get(ResultsStore), session = TestBed.inject(SessionStore);
    const job: JobDTO = { jobId: 'validation-job', workspaceId: workspace.id, baseVersionId: 'v1', kind: 'validate', status: 'succeeded',
      progress: { completed: 1, total: 1, complete: true }, diagnostics: [], resultRef: { type: 'validation', id: 'run' }, pollAfterMs: 500 };
    session.job.set(job); results.page.set(page); fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.job-progress')).not.toBeNull();
    view.visit('validation'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.job-progress')).toBeNull();
    session.job.set({ ...job, jobId: 'later', resultRef: { type: 'validation', id: 'later-run' } }); fixture.detectChanges(); await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.job-progress')).not.toBeNull();
    session.job.set({ ...job, status: 'failed', diagnostics: [{ code: 'FAILED', message: 'Revisa el archivo.' }] }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.job-progress')?.textContent).toContain('Revisa el archivo.');
    session.job.set({ ...job, progress: { completed: 0, total: 1, complete: false } }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.job-progress')?.textContent).toContain('Progreso incompleto');
  });
  it('retires direction preparation only after its current review is presented in Recalcular', async () => {
    const fixture=TestBed.createComponent(AppComponent);fixture.detectChanges();await fixture.whenStable();
    const injector=fixture.debugElement.query(By.directive(WorkspaceShellComponent)).injector;
    const view=injector.get(WorkspaceViewStore),directions=injector.get(DirectionsStore),session=TestBed.inject(SessionStore),api=TestBed.inject(ApiClient);
    const counts={totalRows:0,included:0,omitted:0,pending:0,conflicted:0,excluded:0,undetermined:0};
    const review={id:'review',workspaceId:workspace.id,baseVersionId:'v1',validationBasisId:'basis',runId:'run',state:'ready' as const,revision:1,expiresAt:'2099-01-01T00:00:00Z',counts,conflictGroupCount:0};
    vi.mocked(api.recalculationState).mockResolvedValue({workspaceId:workspace.id,currentVersionId:'v1',validationBasisId:'basis',compatibleRun:{id:'run',versionId:'v1',validationBasisId:'basis'},configuration:{configVersion:'config',directionCount:0},review,counts,state:'no_candidates'});
    Object.assign(api,{directionReviewRows:vi.fn().mockResolvedValue({reviewId:'review',revision:1,items:[],total:0,nextCursor:null}),directionConflictGroups:vi.fn().mockResolvedValue({reviewId:'review',revision:1,items:[],total:0,nextCursor:null})});
    const prepared:JobDTO={jobId:'prepared',workspaceId:workspace.id,baseVersionId:'v1',kind:'prepare-directions',status:'succeeded',progress:{completed:1,total:1,complete:true},diagnostics:[],resultRef:{type:'direction-review',id:'review'},pollAfterMs:500};
    session.job.set(prepared);view.visit('validation');fixture.detectChanges();await fixture.whenStable();expect(fixture.nativeElement.querySelector('.job-progress')).not.toBeNull();
    view.visit('preview');fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();
    expect(directions.review()?.id).toBe('review');expect(fixture.nativeElement.querySelector('.job-progress')).toBeNull();
    session.job.set({...prepared,jobId:'other',resultRef:{type:'direction-review',id:'other-review'}});fixture.detectChanges();await fixture.whenStable();expect(fixture.nativeElement.querySelector('.job-progress')).not.toBeNull();
    session.job.set({...prepared,jobId:'failed',status:'failed',diagnostics:[{code:'FAILED',message:'No se prepararon las decisiones.'}]});fixture.detectChanges();expect(fixture.nativeElement.querySelector('.job-progress')?.textContent).toContain('No se prepararon');
  });
  it('retires export progress only when its matching artifact is presented and never hides a newer export or failure', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable();
    const injector = fixture.debugElement.query(By.directive(WorkspaceShellComponent)).injector, view = injector.get(WorkspaceViewStore), exports = injector.get(ExportStore), session = TestBed.inject(SessionStore);
    TestBed.tick(); await fixture.whenStable();
    const exported: JobDTO = { jobId: 'export-job', workspaceId: workspace.id, baseVersionId: 'v1', kind: 'export', status: 'succeeded', progress: { completed: 1, total: 1, complete: true }, diagnostics: [], resultRef: { type: 'export', id: 'artifact' }, pollAfterMs: 500 };
    vi.spyOn(exports,'ready').mockReturnValue({ id: 'artifact', jobId: exported.jobId, intent: { workspaceId: workspace.id, versionId: 'v0', kind: 'report' }, intentFingerprint:'a'.repeat(64), filename:'report.zip', mimeType:'application/zip', size:3, sha256:'b'.repeat(64), status:'ready' });
    vi.spyOn(exports,'resultPresentation').mockImplementation(() => session.job()?.jobId === exported.jobId ? {jobId:exported.jobId,workspaceId:workspace.id,versionId:'v1'} : null); session.job.set(exported);
    fixture.detectChanges(); await fixture.whenStable(); expect(fixture.nativeElement.querySelector('.job-progress')).not.toBeNull();
    view.visit('exports'); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Archivo preparado: report.zip'); expect(fixture.nativeElement.querySelector('.job-progress')).toBeNull();
    session.job.set({ ...exported, jobId: 'new-export', resultRef: { type: 'export', id: 'new-artifact' } }); fixture.detectChanges(); await fixture.whenStable(); expect(fixture.nativeElement.querySelector('.job-progress')).not.toBeNull();
    session.job.set({ ...exported, status: 'failed', diagnostics: [{ code: 'FAILED', message: 'Vuelve a preparar la descarga.' }] }); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.job-progress')?.textContent).toContain('Vuelve a preparar');
  });
  it('shows one context as entity, civil date and module once and removes those values when the context list empties', async () => {
    const session = TestBed.inject(SessionStore);
    session.workspace.set({ ...workspace, contexts: [domesticContext] });
    session.selectContext(domesticContext.contextId);
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const header = fixture.nativeElement.querySelector('.workspace-context') as HTMLElement;
    expect(header.querySelector('select')).toBeNull();
    for (const value of ['Banco de prueba', '31/12/2025', 'COREP_OF_4.0']) {
      expect(header.textContent!.split(value)).toHaveLength(2);
    }

    session.workspace.set(workspace);
    fixture.detectChanges();
    expect(header.querySelector('select')).toBeNull();
    for (const value of ['Banco de prueba', '31/12/2025', 'COREP_OF_4.0']) expect(header.textContent).not.toContain(value);
  });
  it('distinguishes contexts with matching business labels, keeps the selected ID across stages and restores focus when the choice disappears', async () => {
    const session = TestBed.inject(SessionStore);
    session.workspace.set({ ...workspace, contexts: [domesticContext, consolidatedContext] });
    session.selectContext(domesticContext.contextId);
    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const header = fixture.nativeElement.querySelector('.workspace-context') as HTMLElement;
    const select = header.querySelector('select')!;
    expect(header.querySelectorAll('select')).toHaveLength(1);
    expect(new Set(Array.from(select.options, option => option.text)).size).toBe(2);
    select.focus();
    select.selectedIndex = 1;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(session.selectedContextId()).toBe(consolidatedContext.contextId);

    const navigation = TestbedHarnessEnvironment.loader(fixture);
    await (await navigation.getHarness(MatButtonHarness.with({ text: '2. Validar' }))).click();
    expect(select.value).toBe(consolidatedContext.contextId);
    select.focus();
    expect(document.activeElement).toBe(select);
    session.workspace.set({ ...workspace, contexts: [consolidatedContext] });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(header.querySelector('select')).toBeNull();
    expect(document.activeElement).toBe(header.querySelector('h1'));
  });
  it('renders only Cargar initially, with explicit controls for the four stages', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('ce-import-page')).not.toBeNull();
    expect(element.querySelector('ce-validation-page')).toBeNull();
    expect(element.querySelector('ce-preview-page')).toBeNull();
    expect(element.querySelector('ce-exports')).toBeNull();
    expect([...element.querySelectorAll('nav button')].map(button => button.textContent?.trim())).toEqual(['1. Cargar', '2. Validar', '3. Recalcular', '4. Descargar']);
  });
  it('changes the active stage without submitting a business operation', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    const button = [...element.querySelectorAll<HTMLButtonElement>('nav button')].find(row => row.textContent?.trim() === '2. Validar');
    expect(button).toBeDefined(); button!.click(); fixture.detectChanges(); await fixture.whenStable(); fixture.detectChanges();
    expect(element.querySelector('ce-import-page')).toBeNull(); expect(element.querySelector('ce-validation-page')).not.toBeNull();
    expect(TestBed.inject(SessionStore).versionId()).toBe('v1');
  });
  it('focuses the explicit close confirmation and returns focus to its Material trigger on Volver', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable(); const loader = TestbedHarnessEnvironment.loader(fixture);
    const trigger = await loader.getHarness(MatButtonHarness.with({ text: 'Cerrar conjunto' })); await trigger.click();
    const confirmation = await loader.getHarness(MatButtonHarness.with({ text: 'Cerrar y descartar' })); expect(await confirmation.isFocused()).toBe(true);
    await (await loader.getHarness(MatButtonHarness.with({ text: 'Volver' }))).click(); expect(await trigger.isFocused()).toBe(true);
    expect(TestBed.inject(SessionStore).workspace()?.id).toBe(workspace.id); expect(TestBed.inject(ApiClient).closeWorkspace).not.toHaveBeenCalled();
  });
  it('keeps files, filters, the direction review scope, selection and historical download across Material navigation', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable();
    const injector = fixture.debugElement.query(By.directive(WorkspaceShellComponent)).injector;
    const imports = injector.get(ImportStore), results = injector.get(ResultsStore), proposals = injector.get(PreviewStore), directions = injector.get(DirectionsStore);
    TestBed.tick(); await fixture.whenStable();
    const currentState={workspaceId:workspace.id,currentVersionId:'v1',validationBasisId:'basis',compatibleRun:{id:'server-current-run',versionId:'v1',validationBasisId:'basis'},configuration:{configVersion:'config',directionCount:0},counts:null,state:'needs_validation' as const};
    vi.mocked(TestBed.inject(ApiClient).recalculationState).mockResolvedValue(currentState); directions.state.set(currentState); directions.stateFilter.set('omitted');
    const catalog = new File(['x'], 'catalog.xlsx'); imports.catalog.set(catalog); imports.reports.set([new File(['x'], 'report.xlsx')]);
    results.code.set('ABC'); results.selectedRunId.set('remembered-run'); proposals.selection.set(selection); proposals.code.set('DEF');
    TestBed.inject(SessionStore).selectExportVersion('v0');
    const loader = TestbedHarnessEnvironment.loader(fixture);
    for (const text of ['2. Validar', '3. Recalcular', '4. Descargar', '1. Cargar']) { await (await loader.getHarness(MatButtonHarness.with({ text }))).click(); }
    expect(imports.catalog()).toBe(catalog); expect(imports.reports()[0]?.name).toBe('report.xlsx');
    expect(results.code()).toBe('ABC'); expect(results.selectedRunId()).toBe('remembered-run'); expect(proposals.selection()).toEqual(selection); expect(proposals.code()).toBe('DEF');
    expect(directions.run()?.id).toBe('server-current-run'); expect(directions.stateFilter()).toBe('omitted'); expect(TestBed.inject(SessionStore).exportVersionId()).toBe('v0');
    expect((fixture.nativeElement as HTMLElement).querySelectorAll('ce-import-page,ce-validation-page,ce-preview-page,ce-exports')).toHaveLength(1);
  });
  it('preserves an uncertain export attempt across navigation and uses its original key, body and CAS on retry', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable(); const loader = TestbedHarnessEnvironment.loader(fixture);
    await (await loader.getHarness(MatButtonHarness.with({ text: '4. Descargar' }))).click();
    const injector = fixture.debugElement.query(By.directive(WorkspaceShellComponent)).injector, exports = injector.get(ExportStore), api = TestBed.inject(ApiClient);
    const post = vi.mocked(api.exportReport); post.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 })); TestBed.inject(SessionStore).selectExportVersion('v0'); await exports.start();
    const initial = [...post.mock.calls[0]!]; expect(exports.uncertain()).toBe(true);
    await (await loader.getHarness(MatButtonHarness.with({ text: '2. Validar' }))).click(); await (await loader.getHarness(MatButtonHarness.with({ text: '4. Descargar' }))).click();
    TestBed.inject(SessionStore).etag.set('new-cas'); post.mockRejectedValueOnce(new HttpErrorResponse({ status: 0 })); await exports.retry();
    expect(post.mock.calls[1]).toEqual(initial); expect(exports.uncertain()).toBe(true); expect(TestBed.inject(SessionStore).exportVersionId()).toBe('v0');
  });
  it('invalidates acknowledgement on selection/base changes while stage changes leave it intact', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable(); const injector = fixture.debugElement.query(By.directive(WorkspaceShellComponent)).injector;
    const apply = injector.get(ApplyStore); TestBed.tick(); apply.preview.set(preview); apply.selection.set(selection); TestBed.tick(); apply.acknowledged.set(true);
    const loader = TestbedHarnessEnvironment.loader(fixture); await (await loader.getHarness(MatButtonHarness.with({ text: '4. Descargar' }))).click(); expect(apply.acknowledged()).toBe(true);
    apply.selection.set({ ...selection, revision: 2, closureHash: 'two' }); TestBed.tick(); expect(apply.acknowledged()).toBe(false);
    apply.acknowledged.set(true); TestBed.inject(SessionStore).workspace.set({ ...workspace, currentVersionId: 'v2', versionIds: ['v0', 'v1', 'v2'] }); TestBed.tick(); expect(apply.acknowledged()).toBe(false);
  });
  it('releases local files on close and rejects history that arrives after the workspace has gone', async () => {
    const fixture = TestBed.createComponent(AppComponent); fixture.detectChanges(); await fixture.whenStable(); const injector = fixture.debugElement.query(By.directive(WorkspaceShellComponent)).injector;
    const imports = injector.get(ImportStore); imports.catalog.set(new File(['x'], 'private.xlsx'));
    let resolve!: (page: { items: CompactPreviewDTO[]; total: number; nextCursor: null; revision: string }) => void;
    vi.mocked(TestBed.inject(ApiClient).previews).mockReturnValueOnce(new Promise(done => { resolve = done; })); const proposals = injector.get(PreviewStore); TestBed.tick();
    await TestBed.inject(SessionStore).close(); fixture.detectChanges(); resolve({ items: [preview], total: 1, nextCursor: null, revision: 'old' }); await Promise.resolve();
    expect(imports.catalog()).toBeNull(); expect(proposals.history()).toEqual([]); expect((fixture.nativeElement as HTMLElement).querySelector('ce-workspace-shell')).toBeNull();
  });
});
