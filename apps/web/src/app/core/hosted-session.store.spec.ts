import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_DEMO_LIMITS } from '@ce/contracts';
import { ApiClient } from './api-client';
import { CONNECTION_CONFIG, parseConnectionConfig } from './connection-config';
import { SessionStore } from './session.store';
import { SessionPersistence } from './session-persistence';
const origin='https://api.demo.example',base=origin+'/api/v1',id='00000000-0000-4000-8000-000000000005';
const bootstrap={mode:'hosted',apiVersion:'v1',limits:DEFAULT_DEMO_LIMITS};
const session=()=>({id,state:'active',createdAt:new Date().toISOString(),lastMeaningfulActivityAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600000).toISOString(),absoluteExpiresAt:new Date(Date.now()+86400000).toISOString()});
describe('hosted browser session lifecycle',()=>{
 let http:HttpTestingController,store:SessionStore,persistence:SessionPersistence;
 beforeEach(()=>{TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting(),{provide:CONNECTION_CONFIG,useValue:parseConnectionConfig({apiBaseUrl:origin,deploymentProfile:'demo-public'},'https://web.demo.example')}]});http=TestBed.inject(HttpTestingController);store=TestBed.inject(SessionStore);persistence=TestBed.inject(SessionPersistence);persistence.clear();});
 afterEach(()=>{http.verify();persistence.clear();TestBed.resetTestingModule();vi.useRealTimers();});
 async function probe(){const pending=store.connect();const request=http.expectOne(base+'/bootstrap');expect(request.request.headers.has('X-CE-Session')).toBe(false);request.flush(bootstrap);await pending;}
 async function start(){await probe();const pending=store.startDemo();const request=http.expectOne(base+'/sessions');request.flush(session());await pending;}
 it('does not create or persist a session just by opening the public page',async()=>{await probe();expect(store.hosted()).toBe(true);expect(store.connected()).toBe(false);expect(persistence.load()).toBeNull();http.expectNone(base+'/sessions');});
 it('persists a 32-byte bearer and nonce before POST and replays the exact pair after a lost response',async()=>{
  await probe();const creating=store.startDemo(),saved=persistence.load();expect(saved?.token).toHaveLength(43);expect(saved?.creationNonce).toHaveLength(43);expect(saved?.token).not.toBe(saved?.creationNonce);
  const request=http.expectOne(base+'/sessions');expect(request.request.headers.get('X-CE-Session')).toBe(saved?.token);expect(request.request.body).toEqual({creationNonce:saved?.creationNonce});request.error(new ProgressEvent('network'));await creating;
  expect(persistence.load()).toEqual(saved);const reconnect=store.connect();http.expectOne(base+'/bootstrap').flush(bootstrap);await Promise.resolve();const retry=http.expectOne(base+'/sessions');expect(retry.request.body).toEqual({creationNonce:saved?.creationNonce});expect(retry.request.headers.get('X-CE-Session')).toBe(saved?.token);retry.flush(session());await reconnect;expect(store.connected()).toBe(true);expect(persistence.load()?.sessionId).toBe(id);
 });
 it('recovers known metadata with GET and clears expired credentials without silent replacement',async()=>{
  persistence.save({...persistence.prepare(),sessionId:id});sessionStorage.setItem('another-application','retain');const pending=store.connect();http.expectOne(base+'/bootstrap').flush(bootstrap);await Promise.resolve();http.expectOne(base+'/session').flush({error:{code:'SESSION_EXPIRED',message:'La sesión caducó.'}},{status:410,statusText:'Gone'});await pending;
  expect(persistence.load()).toBeNull();expect(store.connected()).toBe(false);expect(store.error()).toContain('caducó');http.expectNone(base+'/sessions');expect(sessionStorage.getItem('another-application')).toBe('retain');sessionStorage.removeItem('another-application');
 });
 it('persists and retries the same revocation key before any resume after a lost DELETE',async()=>{
  await start();const saved=persistence.load()!,closing=store.close();const request=http.expectOne(base+'/session'),key=request.request.headers.get('Idempotency-Key');expect(key).toBe(persistence.load()?.closeKey);request.error(new ProgressEvent('network'));await closing;expect(persistence.load()?.token).toBe(saved.token);
  const reconnect=store.connect();http.expectOne(base+'/bootstrap').flush(bootstrap);await Promise.resolve();const retry=http.expectOne(base+'/session');expect(retry.request.method).toBe('DELETE');expect(retry.request.headers.get('Idempotency-Key')).toBe(key);retry.flush(null,{status:204,statusText:'No Content'});await reconnect;expect(persistence.load()).toBeNull();expect(store.connected()).toBe(false);
 });
 it('sends a persisted creation key without retaining the workspace name',async()=>{
  await start();const pending=store.create('Nombre del analista');const request=http.expectOne(base+'/workspaces');expect(request.request.headers.get('Idempotency-Key')).toBe(persistence.load()?.workspaceCreateKey);expect(JSON.stringify(persistence.load())).not.toContain('Nombre del analista');request.error(new ProgressEvent('network'));await pending;const key=persistence.load()?.workspaceCreateKey;
  const retry=store.create('Nombre del analista'),repeated=http.expectOne(base+'/workspaces');expect(repeated.request.headers.get('Idempotency-Key')).toBe(key);repeated.error(new ProgressEvent('network'));await retry;
 });
 it('handles revoked sessions from every API consumer and sends no automatic replacement',async()=>{
  await start();const request=TestBed.inject(ApiClient).capabilities();http.expectOne(base+'/capabilities').flush({error:{code:'SESSION_REVOKED',message:'Sesión cerrada.'}},{status:401,statusText:'Unauthorized'});await expect(request).rejects.toBeDefined();expect(store.connected()).toBe(false);expect(persistence.load()).toBeNull();http.expectNone(base+'/sessions');
 });
 it('polls active hosted work no sooner than five seconds and never heartbeats while idle',async()=>{
  vi.useFakeTimers();await start();store.trackJob({jobId:id,workspaceId:id,kind:'validate',status:'running',progress:{completed:0,total:1,complete:false},diagnostics:[],pollAfterMs:1});await vi.advanceTimersByTimeAsync(4999);http.expectNone(base+'/workspaces/'+id+'/jobs/'+id);await vi.advanceTimersByTimeAsync(1);const request=http.expectOne(base+'/workspaces/'+id+'/jobs/'+id);request.error(new ProgressEvent('offline'));await vi.advanceTimersByTimeAsync(9999);http.expectNone(base+'/workspaces/'+id+'/jobs/'+id);await vi.advanceTimersByTimeAsync(1);http.expectOne(base+'/workspaces/'+id+'/jobs/'+id).error(new ProgressEvent('offline'));http.expectNone(base+'/session');
 });
 it('loads one context page at a time and retains only the selected row when moving to the next page',async()=>{
  const context=(contextId:string)=>({contextId,canonicalContextKey:contextId,entityId:'SYNTHETIC',referenceDate:'2025-12-31',framework:'FINREP',moduleVersion:'FINREP_4.0',filingIndicators:{}});
  const pending=store.refreshWorkspace(id);http.expectOne(base+'/workspaces/'+id+'?compact=true').flush({id,name:'Demo',state:'ready',currentVersionId:id,versionIds:[id],contextCount:100000,counts:{snapshots:1,coordinates:100000,facts:0,sources:2},sessionBytes:100},{headers:{ETag:'"v"'}});await Promise.resolve();
  http.expectOne(base+'/workspaces/'+id+'/contexts?limit=50').flush({workspaceId:id,versionId:id,items:[context('one'),context('two')],total:100000,nextCursor:'page-two'});await pending;expect(store.contextCount()).toBe(100000);expect(store.workspace()?.contexts).toHaveLength(2);store.selectContext('two');
  const next=store.loadContexts(true);http.expectOne(base+'/workspaces/'+id+'/contexts?limit=50&cursor=page-two').flush({workspaceId:id,versionId:id,items:[context('three'),context('four')],total:100000,nextCursor:'page-three'});await next;expect(store.workspace()?.contexts.map(row=>row.contextId)).toEqual(['two','three','four']);expect(store.selectedContextId()).toBe('two');http.expectNone(request=>request.url.endsWith('/contexts'));
  expect(store.contextPagination.rangeLabel()).toBe('3–4 de 100000');
  const previous=store.loadContexts(0);http.expectOne(base+'/workspaces/'+id+'/contexts?limit=50').flush({workspaceId:id,versionId:id,items:[context('one'),context('two')],total:100000,nextCursor:'page-two'});await previous;expect(store.contextPagination.rangeLabel()).toBe('1–2 de 100000');expect(store.workspace()?.contexts.map(row=>row.contextId)).toEqual(['one','two']);expect(store.selectedContextId()).toBe('two');
 });
 it('warns near the server deadline without a renewal heartbeat',async()=>{
  vi.useFakeTimers();await start();await vi.advanceTimersByTimeAsync(49*60000);expect(store.expiryWarning()).toBe(false);http.expectNone(base+'/session');await vi.advanceTimersByTimeAsync(60000);expect(store.expiryWarning()).toBe(true);http.expectNone(base+'/session');
 });
});
