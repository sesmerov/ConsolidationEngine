import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { OperationAttemptStore } from '../core/operation-attempt.store';
import { DirectionsStore } from './directions.store';
import { PreviewStore } from './preview.store';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const body={baseVersionId:id(2),validationBasisId:id(3),runId:id(4),reviewId:id(5),expectedRevision:2};
const api={previews:vi.fn(),recalculate:vi.fn(),operation:vi.fn(),operationReceipt:vi.fn(),job:vi.fn()};
const directions={busy:signal(false),canSimulate:signal(true),simulationInput:()=>body,operationLocked:signal(false),review:signal({id:id(5),revision:2}),hasUnsavedChoice:signal(false),recover:vi.fn().mockResolvedValue(undefined)};
describe('durable compound simulation client',()=>{
 let session:SessionStore,store:PreviewStore,attempts:OperationAttemptStore;
 beforeEach(()=>{vi.resetAllMocks();sessionStorage.clear();api.previews.mockResolvedValue({items:[],total:0,nextCursor:null});api.operationReceipt.mockRejectedValue(new HttpErrorResponse({status:404}));
 TestBed.configureTestingModule({providers:[{provide:ApiClient,useValue:api},{provide:DirectionsStore,useValue:directions}]});session=TestBed.inject(SessionStore);session.workspace.set({id:id(1),name:'Demo',state:'ready',currentVersionId:id(2),versionIds:[id(2)],contexts:[],counts:{snapshots:1,coordinates:0,facts:0,sources:0},sessionBytes:0});session.etag.set('"base"');attempts=TestBed.inject(OperationAttemptStore);store=TestBed.inject(PreviewStore);TestBed.tick(); });
 afterEach(()=>{TestBed.resetTestingModule();sessionStorage.clear();});
 it('persists before sending and retries the exact body/key/ETag after uncertain acceptance',async()=>{
 api.recalculate.mockImplementation(async()=>{expect(attempts.get('recalculation',id(1))).not.toBeNull();throw new HttpErrorResponse({status:0});});
 await store.execute();const original=api.recalculate.mock.calls[0];expect(store.operationUncertain()).toBe(true);session.etag.set('"new"');await store.retryOperation();expect(api.recalculate.mock.calls[1]).toEqual(original);expect(store.canSimulate()).toBe(false);
 });
 it('reserved IDs do not appear as a completed preview and acceptance is recovered by receipt',async()=>{
 api.recalculate.mockResolvedValue({operationId:id(7),jobId:id(7),inputVersionId:id(2),effectiveVersionId:id(8),reservedPreviewId:id(9)});
 api.job.mockResolvedValue({jobId:id(7),workspaceId:id(1),kind:'recalculation-operation',status:'queued',baseVersionId:id(2),progress:{completed:0,total:1,complete:false},diagnostics:[],pollAfterMs:60000});
 await store.execute();expect(store.preview()).toBeNull();expect(attempts.get('recalculation',id(1))?.operationId).toBe(id(7));expect(session.job()?.jobId).toBe(id(7));
 });
 it('does not adopt a receipt belonging to a different workspace',async()=>{
 api.recalculate.mockRejectedValue(new HttpErrorResponse({status:0}));api.operationReceipt.mockResolvedValue({operationId:id(7),jobId:id(7),workspaceId:id(99),phase:'queued',responseStatus:202});
 await store.execute();expect(store.operationUncertain()).toBe(true);expect(api.job).not.toHaveBeenCalled();expect(session.job()).toBeNull();
 });
 it('recovers acceptance after a reload by key without resending the command',async()=>{
   attempts.save({operation:'recalculation',workspaceId:id(1),...body,key:id(6),etag:'"original"'});
   const workspace=session.workspace();TestBed.resetTestingModule();
   api.operationReceipt.mockResolvedValue({operationId:id(7),jobId:id(7),workspaceId:id(1),phase:'queued',responseStatus:202,reservation:{kind:'recalculation',inputVersionId:id(2),effectiveVersionId:id(8),reservedPreviewId:id(9)}});
   api.job.mockResolvedValue({jobId:id(7),workspaceId:id(1),kind:'recalculation-operation',status:'queued',baseVersionId:id(2),progress:{completed:0,total:1,complete:false},diagnostics:[],pollAfterMs:60000});
   TestBed.configureTestingModule({providers:[{provide:ApiClient,useValue:api},{provide:DirectionsStore,useValue:directions}]});
   const reloadedSession=TestBed.inject(SessionStore);reloadedSession.workspace.set(workspace);reloadedSession.etag.set('"later"');
   const reloaded=TestBed.inject(PreviewStore);TestBed.tick();await new Promise(r=>setTimeout(r,0));
   expect(api.operationReceipt).toHaveBeenCalledWith(id(6));expect(api.recalculate).not.toHaveBeenCalled();expect(reloadedSession.job()?.jobId).toBe(id(7));expect(reloaded.preview()).toBeNull();expect(reloaded.operationUncertain()).toBe(false);
 });
 it.each(['failed','cancelled','timed_out'] as const)('clears a terminal %s attempt and allows a genuinely new explicit simulation',async status=>{
   api.recalculate.mockResolvedValue({operationId:id(7),jobId:id(7),inputVersionId:id(2),effectiveVersionId:id(8),reservedPreviewId:id(9)});
   api.job.mockResolvedValue({jobId:id(7),workspaceId:id(1),kind:'recalculation-operation',status,baseVersionId:id(2),progress:{completed:0,total:1,complete:false},diagnostics:[],pollAfterMs:60000});
   api.operation.mockResolvedValue({operationId:id(7),jobId:id(7),workspaceId:id(1),phase:status,responseStatus:202,reservation:{kind:'recalculation',inputVersionId:id(2),effectiveVersionId:id(8),reservedPreviewId:id(9)}});
   await store.execute();expect(attempts.get('recalculation',id(1))).toBeNull();expect(session.versionId()).toBe(id(2));expect(store.preview()).toBeNull();
   const key=api.recalculate.mock.calls[0]?.[3];await store.execute();expect(api.recalculate.mock.calls[1]?.[3]).not.toBe(key);
 });
});
