import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api-client';
import { sha256Bytes } from './verified-transfer';
const workspace='workspace',base='/api/v1/workspaces/'+workspace;
describe('retained public pages',()=>{
  let http:HttpTestingController,api:ApiClient;
  beforeEach(()=>{TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting()]});http=TestBed.inject(HttpTestingController);api=TestBed.inject(ApiClient);api.setSessionToken('owner');});
  afterEach(()=>{try{http?.verify();}finally{TestBed.resetTestingModule();}});
  async function value(content:unknown,ref='large'){const bytes=new TextEncoder().encode(JSON.stringify(content));return {bytes,descriptor:{valueRef:ref,byteLength:bytes.length,sha256:await sha256Bytes(bytes),mediaType:'application/json' as const}};}
  async function resolve(entry:Awaited<ReturnType<typeof value>>){const request=await vi.waitFor(()=>http.expectOne(base+'/values/'+entry.descriptor.valueRef+'/parts/0'));expect(request.request.headers.get('X-CE-Session')).toBe('owner');const buffer=new ArrayBuffer(entry.bytes.length);new Uint8Array(buffer).set(entry.bytes);request.flush(buffer,{headers:{'X-CE-Part-SHA256':entry.descriptor.sha256}});}
  it.each(['directions','groups','candidates','selection','dependencies','explanation','comparison','changes'] as const)('resolves only the requested %s page and keeps every retained character',async kind=>{
    const row={id:'row',description:'Texto íntegro '.repeat(1000)},large=await value(row);
    const calls={directions:()=>api.directionReviewRows(workspace,'review',{}),groups:()=>api.directionConflictGroups(workspace,'review'),candidates:()=>api.directionConflictCandidates(workspace,'review','group'),selection:()=>api.selectionRows(workspace,'preview'),dependencies:()=>api.selectionDependencies(workspace,'preview','proposal'),explanation:()=>api.proposalExplanationItems(workspace,'preview','proposal',{section:'descriptions'}),comparison:()=>api.comparisonCompact(workspace,'receipt'),changes:()=>api.applicationChanges(workspace,'receipt')};
    const pending=calls[kind](),request=http.expectOne(req=>!req.url.includes('/values/'));expect(request.request.params.get('limit')).toBe('50');
    request.flush({workspaceId:workspace,items:[large.descriptor],total:51,nextCursor:'next'});await resolve(large);const page=await pending;expect(page.items).toEqual([row]);expect(page.nextCursor).toBe('next');http.expectNone(req=>req.params.get('cursor')==='next');
  });
  it('hydrates a whole explanation only when opened and preserves the authenticated workspace context',async()=>{
    const large=await value({id:'result',expression:'x'.repeat(20000)}),pending=api.resultExplanation(workspace,'run','result');http.expectOne(base+'/runs/run/results/result/explanation').flush({...large.descriptor,workspaceId:workspace});await resolve(large);expect(await pending).toEqual({workspaceId:workspace,id:'result',expression:'x'.repeat(20000)});
  });
  it('hydrates retained candidate fields only for the requested candidate',async()=>{
    const expression=await value('x'.repeat(20000),'expression'),descriptions=await value([{description:'Origen íntegro',sourceLabel:'catalog.xlsx'}],'descriptions');
    const pending=api.directionConflictCandidate(workspace,'review','group','instance');http.expectOne(base+'/recalculation-reviews/review/groups/group/candidates/instance?compact=true').flush({expression:expression.descriptor,descriptions:descriptions.descriptor,candidate:{instanceId:'instance'}});
    await resolve(expression);await resolve(descriptions);expect(await pending).toMatchObject({expression:'x'.repeat(20000),descriptions:[{description:'Origen íntegro'}]});
  });
  it('hydrates the complete conflict group attached to the requested candidates page',async()=>{
    const group={groupId:'group',targetLabel:'Celda íntegra '.repeat(1000),contextLabel:'SYNTHETIC',candidateCount:51,activeCount:2,state:'conflicted'},large=await value(group,'group-detail');
    const pending=api.directionConflictCandidates(workspace,'review','group');
    http.expectOne(req=>req.url.endsWith('/groups/group/candidates')).flush({reviewId:'review',revision:3,group:large.descriptor,items:[{instanceId:'visible-candidate'}],total:51,nextCursor:'next'});
    await resolve(large);expect(await pending).toEqual({reviewId:'review',revision:3,group,items:[{instanceId:'visible-candidate'}],total:51,nextCursor:'next'});
    http.expectNone(req=>req.params.get('cursor')==='next');
  });
  it('retains the download identity when its large summary is stored separately',async()=>{
    const intent={workspaceId:workspace,versionId:'version',kind:'report'},large=await value({files:[{name:'report.xlsx',sheets:Array(500).fill('Datos')}]}),pending=api.exportSummary(workspace,'version');
    http.expectOne(req=>req.url.endsWith('/export-summary')).flush({...large.descriptor,intent,intentFingerprint:'fingerprint'});await resolve(large);expect(await pending).toMatchObject({intent,intentFingerprint:'fingerprint',files:[{name:'report.xlsx',sheets:Array(500).fill('Datos')}]});
  });
  it('does not expose a page after its retained value fails integrity validation',async()=>{
    const large=await value({id:'private-row'}),pending=api.selectionRows(workspace,'preview');http.expectOne(req=>req.url.endsWith('/selection-state/rows')).flush({items:[large.descriptor],total:1,nextCursor:null});
    const checked=expect(pending).rejects.toThrow();const request=await vi.waitFor(()=>http.expectOne(base+'/values/large/parts/0'));const buffer=new ArrayBuffer(5);new Uint8Array(buffer).set([119,114,111,110,103]);request.flush(buffer,{headers:{'X-CE-Part-SHA256':'0'.repeat(64)}});await checked;
  });
});
