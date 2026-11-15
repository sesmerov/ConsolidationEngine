import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApplyComponent } from './apply.component';
import { ComparisonComponent } from './comparison.component';
import { SessionStore } from '../core/session.store';
import { ApiClient } from '../core/api-client';
const workspaceId='00000000-0000-4000-8000-000000000061',versionId='00000000-0000-4000-8000-000000000062',previewId='00000000-0000-4000-8000-000000000063',nextVersion='00000000-0000-4000-8000-000000000064';
const selectionId='00000000-0000-4000-8000-000000000067';
const workspace={id:workspaceId,name:'SYNTHETIC',state:'ready' as const,currentVersionId:versionId,versionIds:[versionId,nextVersion],contexts:[],counts:{snapshots:1,coordinates:4,facts:4,sources:2},sessionBytes:100};
const preview={id:previewId,baseVersionId:versionId,state:'ready',createdAt:'2026-11-07T00:00:00Z',graphSummary:{nodes:2,edges:1,blocked:0,conflictCount:0,cycleCount:0},diagnosticCount:0};
const selection={id:selectionId,workspaceId,previewId,baseVersionId:versionId,revision:1,state:'ready',availableCount:2,selectedCount:2,requiredCount:0,closureHash:'a'.repeat(64),complete:true};
const a={id:'a',code:'SYNTHETIC_A',state:'available',target:{contextId:'demo',tableCode:'T',rowCode:'0010',columnCode:'0010',sheetCode:''},description:'',descriptionTruncated:false,selected:true,required:false,predecessorCount:0,requiredPredecessorCount:0,rounded:false,hasInterval:false,diagnosticCount:0,
  before:{presence:'value',normalizedValue:{numerator:'11',denominator:'1'},decimals:'2',unit:'EUR'},after:{normalizedValue:{numerator:'12',denominator:'1'},originalText:'12.00',decimals:'2',unit:'EUR'}};
const d={...a,id:'d',code:'SYNTHETIC_D',before:{...a.before,normalizedValue:{numerator:'22',denominator:'1'}},after:{...a.after,normalizedValue:{numerator:'24',denominator:'1'},originalText:'24.00'}};
const page=(items=[a,d],s=selection)=>({selectionId,previewId,revision:s.revision,state:s.state,scope:'selected',items,total:items.length,nextCursor:null,summary:s,sourceFiles:[],filterCounts:{matched:2,available:2,selected:2,selectedOutsideFilter:0,selectedOutsidePage:0}});
const settle=async()=>{await Promise.resolve();await Promise.resolve();};
describe('revision-bound application acceptance and recovery',()=>{
  let http:HttpTestingController,session:SessionStore;
  beforeEach(()=>{TestBed.configureTestingModule({imports:[ApplyComponent,ComparisonComponent],providers:[provideHttpClient(),provideHttpClientTesting()]});http=TestBed.inject(HttpTestingController);session=TestBed.inject(SessionStore);TestBed.inject(ApiClient).setSessionToken('memory-only');session.workspace.set(workspace);session.etag.set('"v-'+versionId+'"');});
  afterEach(()=>{http.verify();TestBed.resetTestingModule();});
  function render(options:{preview?:object;selection?:object;busy?:boolean}={}){const f=TestBed.createComponent(ApplyComponent);f.componentRef.setInput('preview',options.preview??preview);f.componentRef.setInput('selection',options.selection??selection);f.componentRef.setInput('selectionBusy',options.busy??false);f.detectChanges();TestBed.tick();f.detectChanges();return f;}
  const button=(f:ReturnType<typeof render>,text:string)=>Array.from((f.nativeElement as HTMLElement).querySelectorAll('button')).find(b=>b.textContent?.includes(text));
  function acknowledge(f:ReturnType<typeof render>){(f.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type=checkbox]')!.click();f.detectChanges();}
  async function review(f:ReturnType<typeof render>,data=page()) { const details=(f.nativeElement as HTMLElement).querySelector<HTMLDetailsElement>('details.selection-review')!;details.open=true;details.dispatchEvent(new Event('toggle'));f.detectChanges();const req=http.expectOne(r=>r.url.endsWith('/selection-state/rows'));expect(req.request.params.get('scope')).toBe('selected');expect(req.request.params.has('contextId')).toBe(false);req.flush(data);await settle();f.detectChanges();return details; }
  it('reviews paginated exact changes and requires express consent before posting only an immutable reference',async()=>{
    const f=render(),details=await review(f);for(const text of ['SYNTHETIC_A','SYNTHETIC_D','11,00','12,00','22,00','24,00'])expect(details.textContent).toContain(text);
    expect(details.querySelectorAll('.selected-changes > li')).toHaveLength(2);expect(button(f,'Aplicar cambios seleccionados')!.disabled).toBe(true);http.expectNone(r=>r.method==='POST');
    acknowledge(f);button(f,'Aplicar cambios seleccionados')!.click();const req=http.expectOne(r=>r.url.endsWith('/applications'));
    expect(req.request.body).toEqual({baseVersionId:versionId,previewId,selectionRef:{id:selectionId,revision:1},closureHash:selection.closureHash});expect(req.request.body).not.toHaveProperty('selectedIds');
    expect(req.request.headers.get('If-Match')).toBe('"v-'+versionId+'"');expect(req.request.headers.get('X-CE-Session')).toBe('memory-only');expect(req.request.headers.get('Idempotency-Key')).toMatch(/^[0-9a-f-]{36}$/);
    req.flush({jobId:'accepted',workspaceId,kind:'apply',status:'queued',progress:{completed:0,total:2,complete:false},diagnostics:[],pollAfterMs:60000});await settle();expect(session.job()?.jobId).toBe('accepted');expect(session.versionId()).toBe(versionId);
  });
  it.each([
    {selection:{...selection,selectedCount:1,requiredCount:1,complete:false}},
    {selection:{...selection,selectedCount:0}},
    {selection:{...selection,workspaceId:'another-workspace'}},
    {selection:{...selection,previewId:'another-preview'}},
    {selection:{...selection,baseVersionId:'another-base'}},
    {selection:{...selection,state:'updating'}},
    {preview:{...preview,state:'obsolete'}},
    {preview:{...preview,state:'discarded'}},
    {busy:true},
  ])('never confirms an incomplete, empty, foreign, busy or unavailable selection (%#)',options=>{
    const f=render(options),action=button(f,'Aplicar cambios seleccionados');if(options.preview||('selection'in options&&options.selection.selectedCount===0))expect(action).toBeUndefined();else expect(action?.disabled).toBe(true);http.expectNone(r=>r.method==='POST');
  });
  it('requires another acknowledgement for a later revision even when the closure hash is identical',()=>{
    const f=render();acknowledge(f);expect(button(f,'Aplicar cambios seleccionados')!.disabled).toBe(false);
    f.componentRef.setInput('selection',{...selection,revision:3});f.detectChanges();TestBed.tick();f.detectChanges();expect((f.nativeElement as HTMLElement).querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
  });
  it('explains no-op values without exposing internal provenance',async()=>{
    const f=render({selection:{...selection,selectedCount:1}});const data=page([{...a,before:{...a.before,normalizedValue:{numerator:'12',denominator:'1'}}}],{...selection,selectedCount:1});const details=await review(f,data);
    expect(details.textContent).toContain('Sin cambio de valor');expect(details.textContent).toContain('12,00');expect(details.textContent).not.toContain(selectionId);
  });
  it('blocks acknowledgement while requested changes are missing or their revision is stale',async()=>{
    const f=render();f.componentInstance.store.toggleReview(true);f.detectChanges();expect(button(f,'Aplicar cambios seleccionados')!.disabled).toBe(true);
    http.expectOne(r=>r.url.endsWith('/selection-state/rows')).flush({...page(),revision:2});await settle();f.detectChanges();expect(button(f,'Aplicar cambios seleccionados')!.disabled).toBe(true);expect((f.nativeElement as HTMLElement).textContent).toContain('La selección ha cambiado');
  });
  it('ignores an application acceptance that arrives after the workspace closes',async()=>{
    const f=render();acknowledge(f);button(f,'Aplicar cambios seleccionados')!.click();const req=http.expectOne(r=>r.url.endsWith('/applications'));session.workspace.set(null);TestBed.tick();
    req.flush({jobId:'late',workspaceId,kind:'apply',status:'queued',diagnostics:[],pollAfterMs:60000});await settle();expect(session.job()).toBeNull();
  });
  it('reports stale rejection without publishing and retries uncertainty with the original body, key and CAS',async()=>{
    const f=render();acknowledge(f);button(f,'Aplicar cambios seleccionados')!.click();const first=http.expectOne(r=>r.url.endsWith('/applications'));const body=first.request.body,key=first.request.headers.get('Idempotency-Key');
    first.error(new ProgressEvent('error'));await settle();f.detectChanges();session.workspace.set({...workspace,currentVersionId:nextVersion});session.etag.set('"v-'+nextVersion+'"');f.componentRef.setInput('selection',null);TestBed.tick();f.detectChanges();
    expect((f.nativeElement as HTMLElement).querySelector('#apply-title')).toBeNull();button(f,'Reintentar misma aplicación')!.click();const retry=http.expectOne(r=>r.url.endsWith('/applications'));expect(retry.request.body).toEqual(body);expect(retry.request.headers.get('Idempotency-Key')).toBe(key);expect(retry.request.headers.get('If-Match')).toBe('"v-'+versionId+'"');
    retry.flush({jobId:'same-job',workspaceId,kind:'apply',status:'queued',diagnostics:[],pollAfterMs:60000});await settle();expect(session.job()?.jobId).toBe('same-job');
  });
  it('keeps a failed CAS visible and disables a new application until the selection is refreshed',async()=>{
    const f=render();acknowledge(f);button(f,'Aplicar cambios seleccionados')!.click();http.expectOne(r=>r.url.endsWith('/applications')).flush({error:{code:'STALE_VERSION',message:'La versión ha cambiado.'}},{status:412,statusText:'Precondition Failed'});await settle();f.detectChanges();
    expect((f.nativeElement as HTMLElement).textContent).toContain('La versión ha cambiado.');expect(session.versionId()).toBe(versionId);expect(button(f,'Aplicar cambios seleccionados')!.disabled).toBe(true);
  });
  it('distinguishes remaining failures and arithmetic errors from a completed application without UUIDs',async()=>{
    const f=TestBed.createComponent(ComparisonComponent),counts={complete:true,rows:3,variants:3,applicableVariants:3,duplicateRows:0,instances:3,byStatus:{pass:1,fail:1,error:1,not_applicable:0,not_evaluable:0}};
    const result={id:'result',runId:'before',versionId,code:'SYNTHETIC_WARNING',severity:'warning',status:'fail',values:{},factReads:[],metadataReads:[],sources:[],diagnostics:[],variantIds:[],sourceRecordIds:[],tables:[],coverageOnly:false,expression:'1=1',profileId:'profile',location:'T r0010 c0010',severityOriginal:'Warning',counts:{operands:0,reads:0,metadataReads:0,origins:0,diagnostics:1,descriptions:0}};
    f.componentRef.setInput('page',{items:[{key:'warning',before:result,after:{...result,status:'pass'}},{key:'fail',after:{...result,code:'SYNTHETIC_STILL_FAIL'}},{key:'error',after:{...result,code:'SYNTHETIC_ARITHMETIC',status:'error',diagnostics:[{code:'DIVISION_BY_ZERO',message:'División por cero.'}]}}],total:3,nextCursor:null,receipt:{id:'receipt',baseVersionId:versionId,newVersionId:nextVersion,acceptedCount:2},beforeSummary:counts,afterSummary:counts});f.detectChanges();
    http.expectOne(r=>r.url.endsWith('/applications/receipt/changes')).flush({workspaceId,versionId:nextVersion,receiptId:'receipt',items:[],total:0,nextCursor:null});await settle();f.detectChanges();
    for(const req of http.match(r=>r.url.endsWith('/runs')))req.flush({items:[],total:0,nextCursor:null});const element=f.nativeElement as HTMLElement;
    for(const text of ['SYNTHETIC_WARNING','Advertencia','SYNTHETIC_STILL_FAIL','Falla','SYNTHETIC_ARITHMETIC','Error','Versión 1','Versión 2'])expect(element.textContent).toContain(text);
    expect(element.querySelector('details')).toBeNull();expect(element.querySelector('table[aria-label="Resumen de resultados"]')).not.toBeNull();expect(element.querySelector('table[aria-label="Comparación de resultados"]')).not.toBeNull();
    expect(element.textContent).not.toContain(versionId);expect(element.textContent).not.toContain(nextVersion);expect(element.textContent?.toLowerCase()).not.toMatch(/todo correcto|todas las reglas pasan|validación aprobada/);
    element.querySelector<HTMLButtonElement>('button[aria-label="Ver cálculo y origen de SYNTHETIC_ARITHMETIC"]')!.click();f.detectChanges();http.expectOne(r=>r.url.endsWith('/results/result/explanation')).flush({...result,workspaceId,code:'SYNTHETIC_ARITHMETIC',status:'error'});await vi.waitFor(()=>{f.detectChanges();expect(element.textContent).toContain('Motivos y avisos');});
    Array.from(element.querySelectorAll('button')).find(button=>button.textContent?.includes('Motivos y avisos'))!.click();http.expectOne(r=>r.url.endsWith('/explanation/items')).flush({workspaceId,versionId,runId:'before',resultId:'result',section:'diagnostics',items:[{itemId:'issue',section:'diagnostics',value:{code:'DIVISION_BY_ZERO',message:'División por cero.'}}],total:1,nextCursor:null});await f.whenStable();f.detectChanges();expect(element.textContent).toContain('División por cero.');expect(element.querySelector('[data-technical]')).toBeNull();
  });
});
