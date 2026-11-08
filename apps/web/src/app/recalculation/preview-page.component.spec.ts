import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PreviewPageComponent } from './preview-page.component';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
const workspaceId='a4a99ec0-bb65-41f5-90d1-b857f4ebefb2', versionId='bfda41bd-2a55-4a80-9f22-2fc1aa89894c', id='5976e981-9b8d-4e80-af2a-b1ffeced4b55', selectionId='5976e981-9b8d-4e80-af2a-b1ffeced4b56';
const workspace={id:workspaceId,name:'SYNTHETIC',state:'ready' as const,currentVersionId:versionId,versionIds:[versionId],contexts:[],counts:{snapshots:1,coordinates:6,facts:5,sources:2},sessionBytes:100};
const preview={id,baseVersionId:versionId,profileId:'profile',policyId:'half-even-v1',createdAt:'2026-10-31T00:00:00.000Z',state:'ready',graphSummary:{nodes:2,edges:1,conflictCount:0,cycleCount:0,blocked:0},diagnosticCount:0};
const summary=(revision=1,selectedCount=2,requiredCount=0)=>({id:selectionId,workspaceId,previewId:id,baseVersionId:versionId,revision,state:'ready',availableCount:2,selectedCount,requiredCount,complete:requiredCount===0,closureHash:'a'.repeat(64)});
const a={id:'a',code:'SYNTHETIC_A',state:'available',target:{contextId:'demo',tableCode:'T',rowCode:'0010',columnCode:'0010',sheetCode:''},description:'',descriptionTruncated:false,
  before:{presence:'explicit_null',unit:'EUR',decimals:'2'},after:{normalizedValue:{numerator:'33',denominator:'100'},originalText:'0.33',decimals:'2',unit:'EUR'},selected:true,required:false,predecessorCount:0,requiredPredecessorCount:0,rounded:true,hasInterval:false,diagnosticCount:0};
const b={...a,id:'b',code:'SYNTHETIC_B',target:{...a.target,rowCode:'0020'},predecessorCount:1};
const rows=(s=summary(),items=[a,b],total=items.length)=>({selectionId,previewId:id,revision:s.revision,state:s.state,scope:'all',summary:s,items,total,nextCursor:null,sourceFiles:[],
  filterCounts:{matched:total,available:total,selected:items.filter(x=>x.selected).length,selectedOutsideFilter:s.selectedCount-items.filter(x=>x.selected).length,selectedOutsidePage:s.selectedCount-items.filter(x=>x.selected).length}});
const job=(status='succeeded')=>({jobId:'edit-job',workspaceId,kind:'select-proposals',status,progress:{completed:1,total:1,complete:status==='succeeded'},diagnostics:[],resultRef:{type:'proposal-selection',id:selectionId},pollAfterMs:60000});
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
describe('compact preview, persisted selection and explanation',()=>{
  let http:HttpTestingController,session:SessionStore;
  beforeEach(()=>{TestBed.configureTestingModule({imports:[PreviewPageComponent],providers:[provideHttpClient(),provideHttpClientTesting()]});http=TestBed.inject(HttpTestingController);session=TestBed.inject(SessionStore);TestBed.inject(ApiClient).setSessionToken('memory-only');session.workspace.set(workspace);session.etag.set('"v-'+versionId+'"');});
  afterEach(()=>{http.verify();TestBed.resetTestingModule();});
  function respond(p=preview,s=summary(),page=rows(s)){
    const request=http.expectOne(r=>r.url.endsWith('/previews/'+id));expect(request.request.params.get('compact')).toBe('true');request.flush(p);
    http.expectOne(r=>r.url.endsWith('/selection-state')).flush(s);http.expectOne(r=>r.url.endsWith('/selection-state/rows')).flush(page);
  }
  async function render(state='ready'){
    const f=TestBed.createComponent(PreviewPageComponent);f.detectChanges();http.expectOne(r=>r.url.endsWith('/recalculation-state')).flush({workspaceId,currentVersionId:versionId,validationBasisId:versionId,configuration:{configVersion:'config',directionCount:0},counts:null,state:'needs_validation'});http.expectOne(r=>r.url.endsWith('/previews')).flush({items:[{...preview,state}],total:1,nextCursor:null});await settle();
    respond({...preview,state},{...summary(),state},rows({...summary(),state}));await settle();f.detectChanges();return f;
  }
  const button=(f:Awaited<ReturnType<typeof render>>,text:string)=>Array.from((f.nativeElement as HTMLElement).querySelectorAll('button')).find(x=>x.textContent?.includes(text))!;
  async function finishEdit(promise:Promise<void>,s=summary(2),page=rows(s)){
    const req=http.expectOne(r=>r.url.endsWith('/selection-state/edits'));req.flush(job());await settle();respond(preview,s,page);await promise;TestBed.tick();
  }
  it('shows one retained preview as text and keeps focus when the history selector becomes unnecessary',async()=>{
    const f=await render(),store=f.componentInstance.store,root=f.nativeElement as HTMLElement;
    expect(root.querySelector('#preview-history')).toBeNull();expect(root.querySelector('.history-controls')?.textContent).toContain('Preparada');
    const current=store.history()[0]!;store.history.set([current,{...current,id:'older'}]);f.detectChanges();const select=root.querySelector<HTMLSelectElement>('#preview-history')!;
    expect(select.options).toHaveLength(2);select.focus();store.history.set([current]);f.detectChanges();expect(root.querySelector('#preview-history')).toBeNull();expect(document.activeElement).toBe(root.querySelector('#preview-title'));
  });
  it('starts preselected without acceptance and retains global counts through a filter with no matches',async()=>{
    const f=await render(),store=f.componentInstance.store,element=f.nativeElement as HTMLElement;
    expect(element.querySelectorAll('.proposal-row input:checked')).toHaveLength(2);expect(element.querySelector<HTMLInputElement>('#apply-title ~ mat-checkbox input')?.checked).toBe(false);
    expect(button(f,'Aplicar cambios seleccionados').disabled).toBe(true);expect(element.textContent).toContain('Selección: 2');
    store.code.set('NO_MATCH');const filtering=store.load();respond(preview,summary(),rows(summary(),[],0));await filtering;f.detectChanges();
    expect(store.hiddenSelectedCount()).toBe(2);expect(element.textContent).toContain('2 seleccionadas fuera del filtro');expect(element.querySelector('#apply-title')).not.toBeNull();
    http.expectNone(r=>r.url.endsWith('/selection')||r.url.endsWith('/proposals'));
  });
  it('removes an ancestor explicitly without restoring it and blocks applying an incomplete closure',async()=>{
    const f=await render(),store=f.componentInstance.store;
    const editing=store.toggle('a',false);const req=http.expectOne(r=>r.url.endsWith('/edits'));
    expect(req.request.body).toEqual({selectionId,expectedRevision:1,operations:[{op:'set',proposalId:'a',selected:false}]});expect(req.request.headers.get('If-Match')).toBe('"v-'+versionId+'"');
    req.flush(job());await settle();const s=summary(2,1,1);respond(preview,s,rows(s,[{...a,selected:false,required:true},{...b,requiredPredecessorCount:1}]));await editing;f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('Faltan 1 antecedentes');expect(button(f,'Aplicar cambios seleccionados').disabled).toBe(true);
    http.expectNone(r=>r.method==='POST');
  });
  it('clears globally, hides confirmation and invalidates acknowledgement when the same closure returns',async()=>{
    const f=await render(),store=f.componentInstance.store,element=f.nativeElement as HTMLElement;
    element.querySelector<HTMLInputElement>('ce-apply input[type=checkbox]')!.click();f.detectChanges();expect(button(f,'Aplicar cambios seleccionados').disabled).toBe(false);
    await finishEdit(store.clearAll(),summary(2,0),rows(summary(2,0),[{...a,selected:false},{...b,selected:false}]));f.detectChanges();expect(element.querySelector('#apply-title')).toBeNull();
    await finishEdit(store.selectMatching(),summary(3));f.detectChanges();expect(element.querySelector<HTMLInputElement>('ce-apply input[type=checkbox]')!.checked).toBe(false);
  });
  it('renders null, exact rounding and recorded recalculated operands without exposing technical fields',async()=>{
    const f=await render(),store=f.componentInstance.store,element=f.nativeElement as HTMLElement;
    expect(element.textContent).toContain('Sin dato');expect(element.textContent).toContain('0,33');expect(element.textContent).not.toContain('half-even-v1');
    const opening=store.openDetail('b');http.expectOne(r=>r.url.endsWith('/proposals/b/explanation')).flush({selectionId,previewId:id,baseVersionId:versionId,revision:1,state:'ready',proposalId:'b',code:'SYNTHETIC_B',target:b.target,evidenceState:'recorded',expression:'100+20',exactNominal:{numerator:'120',denominator:'1'},rounded:false,operandCount:2,originCount:2,diagnosticCount:0,descriptionCount:0});await opening;f.detectChanges();
    http.expectOne(r=>r.url.endsWith('/explanation/items')).flush({selectionId,previewId:id,baseVersionId:versionId,revision:1,state:'ready',proposalId:'b',section:'operands',total:2,nextCursor:null,items:[
      {...a.target,itemId:'first',presence:'value',value:{numerator:'100',denominator:'1'},unit:'EUR',decimals:'2',fileName:'informe.xlsx',sheet:'1.1',cell:'F8',originKind:'proposal',fromProposalId:'internal-predecessor',fromProposalCode:'SYNTHETIC_A'},
      {...b.target,itemId:'second',presence:'value',value:{numerator:'20',denominator:'1'},unit:'EUR',decimals:'2',fileName:'informe.xlsx',sheet:'1.1',cell:'F12',originKind:'report'}]});await settle();f.detectChanges();
    expect(element.textContent).toContain('100,00');expect(element.textContent).toContain('20,00');expect(element.textContent).toContain('Valor recalculado por SYNTHETIC_A');
    expect(element.textContent).not.toContain('internal-predecessor');expect(element.querySelector('[data-technical]')).toBeNull();http.expectNone(r=>r.url.endsWith('/proposals/b'));
  });
  it('loads antecedents in one bounded page and rejects responses after the workspace closes',async()=>{
    const f=await render(),store=f.componentInstance.store;const loading=store.openDependencies('b');
    const request=http.expectOne(r=>r.url.endsWith('/proposals/b/dependencies'));expect(request.request.params.has('contextId')).toBe(false);
    request.flush({selectionId,previewId:id,revision:1,state:'ready',proposalId:'b',scope:'all',items:[a],total:1,nextCursor:null,predecessorCount:1,requiredPredecessorCount:0});await loading;
    expect(store.dependencies()?.items[0]?.code).toBe('SYNTHETIC_A');http.expectNone(r=>r.url.endsWith('/proposals/a'));
    const opening=store.openDetail('a'),late=http.expectOne(r=>r.url.endsWith('/proposals/a/explanation'));session.workspace.set(null);TestBed.tick();late.flush({});await opening;
    expect(store.detail()).toBeNull();expect(store.dependencies()).toBeNull();expect(store.selection()).toBeNull();
  });
  it('closes antecedents from the rendered control and returns keyboard focus to the proposal trigger',async()=>{
    const f=await render(),trigger=button(f,'1 antecedente');trigger.focus();trigger.click();
    http.expectOne(r=>r.url.endsWith('/proposals/b/dependencies')).flush({selectionId,previewId:id,revision:1,state:'ready',proposalId:'b',scope:'all',items:[a],total:1,nextCursor:null,predecessorCount:1,requiredPredecessorCount:0});
    await settle();f.detectChanges();const close=button(f,'Cerrar antecedentes');close.focus();close.click();f.detectChanges();
    expect(f.componentInstance.store.dependencies()).toBeNull();expect(document.activeElement).toBe(trigger);
  });
  it('retains obsolete history without editable checkboxes, discard or confirmation',async()=>{
    const f=await render('obsolete'),store=f.componentInstance.store;expect((f.nativeElement as HTMLElement).textContent).toContain('obsoleta');
    expect((f.nativeElement as HTMLElement).querySelectorAll('.proposal-row input[type=checkbox]')).toHaveLength(0);expect((f.nativeElement as HTMLElement).querySelector('#apply-title')).toBeNull();
    expect(store.canDiscard()).toBe(false);await store.discard();await store.toggle('a',false);http.expectNone(r=>r.method==='POST'||r.method==='DELETE');
  });
  it('shows only one return from missing dependencies and restores the normal filtered proposals without changing selection',async()=>{
    const f=await render(),s=summary(2,1,1),items=[{...a,selected:false,required:true},{...b,requiredPredecessorCount:1}],store=f.componentInstance.store;
    store.selection.set(s as any);store.page.set(rows(s,items) as any);f.detectChanges();button(f,'Revisar dependencias pendientes').click();
    respond(preview,s,{...rows(s,[items[0]!]),scope:'missing'} as any);await settle();f.detectChanges();
    const root=f.nativeElement as HTMLElement,back=Array.from(root.querySelectorAll('button')).filter(button=>button.textContent?.trim()==='Volver a las propuestas');expect(back).toHaveLength(1);expect(root.querySelector('#proposal-status')).toBeNull();expect(root.querySelectorAll('.proposal-row')).toHaveLength(1);
    back[0]!.click();respond(preview,s,rows(s,items));await settle();f.detectChanges();expect(store.scope()).toBe('all');expect(root.querySelector('#proposal-status')).not.toBeNull();expect(root.querySelectorAll('.proposal-row')).toHaveLength(2);expect(store.selection()?.selectedCount).toBe(1);expect(store.selection()?.requiredCount).toBe(1);http.expectNone(r=>r.method==='POST');
  });
  it('confirms discard with CAS and retains confirmed rows on a stale rejection',async()=>{
    const f=await render();button(f,'Descartar previsualización').click();f.detectChanges();http.expectNone(r=>r.method==='DELETE');button(f,'Volver').click();f.detectChanges();expect(f.componentInstance.store.confirmDiscard()).toBe(false);expect(f.componentInstance.store.preview()?.state).toBe('ready');http.expectNone(r=>r.method==='DELETE');button(f,'Descartar previsualización').click();f.detectChanges();
    const discard=f.componentInstance.store.discard(),request=http.expectOne(r=>r.method==='DELETE');expect(request.request.headers.get('If-Match')).toBe('"v-'+versionId+'"');expect(request.request.params.get('compact')).toBe('true');
    request.flush({error:{message:'La versión ha cambiado.'}},{status:412,statusText:'Precondition Failed'});await discard;
    expect(f.componentInstance.store.page()?.items).toHaveLength(2);expect(f.componentInstance.store.preview()?.state).toBe('ready');
  });
  it('ignores late history after closing and never fabricates a preview from a cancelled job',async()=>{
    const f=TestBed.createComponent(PreviewPageComponent);f.detectChanges();http.expectOne(r=>r.url.endsWith('/recalculation-state')).flush({workspaceId,currentVersionId:versionId,validationBasisId:versionId,configuration:{configVersion:'config',directionCount:0},counts:null,state:'needs_validation'});const history=http.expectOne(r=>r.url.endsWith('/previews'));session.workspace.set(null);TestBed.tick();history.flush({items:[preview],total:1,nextCursor:null});await settle();expect(f.componentInstance.store.history()).toEqual([]);http.expectNone(r=>r.url.endsWith('/previews/'+id));
    session.workspace.set(workspace);TestBed.tick();http.expectOne(r=>r.url.endsWith('/previews')).flush({items:[],total:0,nextCursor:null});await settle();
    session.job.set({...job('cancelled'),kind:'preview',baseVersionId:versionId} as any);TestBed.tick();expect(f.componentInstance.store.preview()).toBeNull();
  });
  it('pages a compact applied receipt, preserves no-op counts and rejects late comparison replies',async()=>{
    const f=await render(),store=f.componentInstance.store;store.preview.set({...store.preview()!,state:'applied',appliedReceiptId:'receipt'});
    const receipt={id:'receipt',previewId:id,acceptedCount:2,baseVersionId:versionId,newVersionId:'next',beforeValidationRunId:'before',validationRunId:'after',appliedAt:preview.createdAt,closureHash:'hash'};
    const counts={complete:true,rows:2,variants:2,applicableVariants:2,duplicateRows:0,instances:2,byStatus:{pass:0,fail:1,error:1,not_applicable:0,not_evaluable:0}};
    const result={id:'result',code:'SYNTHETIC_REMAINING',severity:'error',status:'fail',values:{},factReads:[],metadataReads:[],sources:[],diagnostics:[],expression:'1=2'};
    const detail={receipt,changeCount:1,beforeSummary:counts,afterSummary:counts};
    const loading=store.loadApplication();const request=http.expectOne(r=>r.url.endsWith('/applications/receipt'));expect(request.request.params.get('includeAcceptedIds')).toBe('false');request.flush(detail);
    http.expectOne(r=>r.url.endsWith('/comparison')).flush({receipt,beforeSummary:counts,afterSummary:counts,items:Array.from({length:50},(_,i)=>({key:String(i),after:result})),total:51,nextCursor:'next-page'});await loading;f.detectChanges();
    for(const r of http.match(r=>r.url.endsWith('/runs')))r.flush({items:[],total:0,nextCursor:null});
    expect((f.nativeElement as HTMLElement).textContent).toContain('Propuestas sin cambio de valor: 1');expect((f.nativeElement as HTMLElement).querySelector('#apply-title')).toBeNull();
    const root=f.nativeElement as HTMLElement;expect(root.querySelectorAll('.proposal-row')).toHaveLength(0);const show=button(f,'Ver propuestas aplicadas');expect(show.getAttribute('aria-expanded')).toBe('false');show.click();f.detectChanges();expect(button(f,'Ocultar propuestas aplicadas').getAttribute('aria-expanded')).toBe('true');expect(root.querySelectorAll('.proposal-row')).toHaveLength(2);expect(root.querySelector('ce-comparison')).not.toBeNull();button(f,'Ocultar propuestas aplicadas').click();f.detectChanges();expect(root.querySelectorAll('.proposal-row')).toHaveLength(0);expect(root.querySelector('ce-comparison')).not.toBeNull();
    const primary=Array.from((f.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('button.ce-primary-action')).filter(button=>!button.disabled);
    expect(primary.some(button=>button.textContent?.includes('Descargar'))).toBe(false);
    const more=store.loadApplication(true);http.expectOne(r=>r.url.endsWith('/applications/receipt')).flush(detail);const tail=http.expectOne(r=>r.url.endsWith('/comparison'));expect(tail.request.params.get('cursor')).toBe('next-page');tail.flush({receipt,beforeSummary:counts,afterSummary:counts,items:[{key:'last',after:result}],total:51,nextCursor:null});await more;expect(store.comparison()?.items).toHaveLength(1);
    const late=store.loadApplication();const one=http.expectOne(r=>r.url.endsWith('/applications/receipt')),two=http.expectOne(r=>r.url.endsWith('/comparison'));session.workspace.set(null);TestBed.tick();one.flush({});two.flush({});await late;expect(store.application()).toBeNull();expect(store.comparison()).toBeNull();http.expectNone(r=>r.method==='POST');
  });
});
