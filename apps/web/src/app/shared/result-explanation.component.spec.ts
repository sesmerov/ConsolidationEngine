import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompactRuleResultDTO } from '@ce/contracts';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { ResultExplanationComponent } from './result-explanation.component';
import { ResultValueComponent } from './result-value.component';

const large={valueRef:'opaque-value',byteLength:200_000,sha256:'a'.repeat(64),mediaType:'application/json' as const};
const row:CompactRuleResultDTO={id:'result',runId:'run',versionId:'version',profileId:'profile',coverageOnly:false,code:'SYNTHETIC',status:'fail',severity:'error',severityOriginal:'Error',location:'F_01.01 · r0010 · c0010',
 expression:'1/3=0',values:{left:{kind:'number',nominal:{numerator:'1',denominator:'3'},interval:{lo:{numerator:'1',denominator:'3'},hi:{numerator:'1',denominator:'3'}},unit:'EUR'},right:{kind:'number',nominal:{numerator:'0',denominator:'1'},interval:{lo:{numerator:'0',denominator:'1'},hi:{numerator:'0',denominator:'1'}},unit:'EUR'}},counts:{operands:2,reads:3,metadataReads:0,origins:1,diagnostics:0,descriptions:1}};
const page=(items:unknown[],total=items.length,nextCursor:string|null=null)=>({workspaceId:'workspace',versionId:'version',runId:'run',resultId:'result',section:'origins',items,total,nextCursor});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>resolve=done);return{promise,resolve};}
describe('compact retained result explanation',()=>{
 const workspace=signal<{id:string}|null>({id:'workspace'});let api:{resultExplanation:ReturnType<typeof vi.fn>;resultExplanationItems:ReturnType<typeof vi.fn>;largeValue:ReturnType<typeof vi.fn>};
 beforeEach(()=>{workspace.set({id:'workspace'});api={resultExplanation:vi.fn().mockResolvedValue({...row,workspaceId:'workspace'}),resultExplanationItems:vi.fn(),largeValue:vi.fn()};TestBed.configureTestingModule({imports:[ResultExplanationComponent,ResultValueComponent],providers:[{provide:ApiClient,useValue:api},{provide:SessionStore,useValue:{workspace}}]});});
 afterEach(()=>TestBed.resetTestingModule());
 async function render(){const fixture=TestBed.createComponent(ResultExplanationComponent);fixture.componentRef.setInput('result',row);fixture.detectChanges();await fixture.whenStable();fixture.detectChanges();return{fixture,root:fixture.nativeElement as HTMLElement};}
 it('keeps exact values and fetches only the evidence section explicitly requested',async()=>{
  const {fixture,root}=await render();expect(root.textContent).toContain('1/3');expect(root.textContent).toContain('0 EUR');expect(root.textContent).not.toContain('0.33333');expect(root.textContent).not.toContain('Indicadores utilizados');expect(api.resultExplanationItems).not.toHaveBeenCalled();
  const origin=(n:number)=>({itemId:String(n),section:'origins',value:{fileName:'informe.xlsx',locator:{sheet:'1.1',row:n,column:'E'}}});
  api.resultExplanationItems.mockResolvedValueOnce(page([origin(1),origin(2)],3,'next')).mockResolvedValueOnce(page([origin(3)],3));
  await fixture.componentInstance.loadSection('origins');fixture.detectChanges();expect(root.textContent).toContain('informe.xlsx');expect(root.textContent).toContain('1–2 de 3');
  await fixture.componentInstance.loadSection('origins',1);fixture.detectChanges();expect(root.textContent).toContain('3–3 de 3');expect(root.textContent).not.toContain('E1');expect(api.largeValue).not.toHaveBeenCalled();
 });
 it('does not apply stale explanation pages after the result or owner changes',async()=>{
  const {fixture,root}=await render(),pending=deferred<ReturnType<typeof page>>();api.resultExplanationItems.mockReturnValue(pending.promise);
  const loading=fixture.componentInstance.loadSection('origins');workspace.set({id:'other'});api.resultExplanation.mockResolvedValue({...row,id:'new',code:'NEW',workspaceId:'other'});fixture.componentRef.setInput('result',{...row,id:'new',code:'NEW'});fixture.detectChanges();
  pending.resolve(page([{itemId:'old',section:'origins',value:{fileName:'OLD PRIVATE FILE',locator:{}}}]));await loading;await fixture.whenStable();fixture.detectChanges();expect(root.textContent).not.toContain('OLD PRIVATE FILE');expect(root.textContent).toContain('NEW');
 });
 it('requires an explicit action for a large value and renders verified content as literal text',async()=>{
  const fixture=TestBed.createComponent(ResultValueComponent);fixture.componentRef.setInput('value',{...large,mediaType:'text/plain'});fixture.detectChanges();expect(api.largeValue).not.toHaveBeenCalled();
  api.largeValue.mockResolvedValue('<img src=x onerror=alert(1)>');await fixture.componentInstance.load();fixture.detectChanges();expect(fixture.nativeElement.textContent).toContain('<img src=x onerror=alert(1)>');expect(fixture.nativeElement.querySelector('img')).toBeNull();
 });
 it('aborts a large read on destruction and never displays an unverified or late value',async()=>{
  const fixture=TestBed.createComponent(ResultValueComponent);fixture.componentRef.setInput('value',large);fixture.detectChanges();const pending=deferred<string>();api.largeValue.mockReturnValue(pending.promise);
  const loading=fixture.componentInstance.load(),signal=api.largeValue.mock.calls[0]![2] as AbortSignal;fixture.destroy();expect(signal.aborted).toBe(true);pending.resolve('LATE PRIVATE TEXT');await loading;expect(fixture.componentInstance.resolved()).toBeUndefined();
 });
 it('keeps a failed integrity check visible and does not substitute a partial value',async()=>{
  const fixture=TestBed.createComponent(ResultValueComponent);fixture.componentRef.setInput('value',large);fixture.detectChanges();api.largeValue.mockRejectedValue(new Error('SHA mismatch'));await fixture.componentInstance.load();fixture.detectChanges();expect(fixture.nativeElement.textContent).toContain('No se pudo verificar');expect(fixture.componentInstance.resolved()).toBeUndefined();
 });
  it('preserves the complete expression and precondition of an alternative description',()=>{
    const fixture=TestBed.createComponent(ResultValueComponent),expression='1 + '.repeat(1000)+'1 = 1001';
    fixture.componentRef.setInput('mode','evidence');fixture.componentRef.setInput('value',{itemId:'description',section:'descriptions',value:{description:'Descripción del catálogo',expression,precondition:'{presented}',source:{fileName:'catalog.xlsx',locator:{sheet:'Rules',row:2}}}});fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain(expression);expect(fixture.nativeElement.textContent).toContain('Precondición: {presented}');expect(fixture.nativeElement.textContent).toContain('catalog.xlsx');expect(api.largeValue).not.toHaveBeenCalled();
  });
});
