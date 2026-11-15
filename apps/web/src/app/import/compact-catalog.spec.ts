import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { ImportStore } from './import.store';
const id='00000000-0000-4000-8000-000000000005',descriptor={valueRef:id,byteLength:40000,sha256:'a'.repeat(64),mediaType:'application/json'};
const record={id,code:'RULE',fileName:'catalog.xlsx',sourceLocator:{fileId:id,sheet:'Validations',row:2},expression:'1=1'+' + 1'.repeat(5000),diagnostics:[],syntaxStatus:'valid',supportStatus:'supported'};
describe('compact catalog consumer',()=>{
 afterEach(()=>TestBed.resetTestingModule());
 it('loads only requested retained catalog rows and keeps their original file label',async()=>{
  const api={capabilities:vi.fn().mockResolvedValue({}),activeImportInspection:vi.fn().mockResolvedValue({active:null}),compactRules:vi.fn().mockResolvedValue({workspaceId:id,versionId:id,items:[descriptor],total:2,nextCursor:'next',coverage:{},dataSummary:{}}),largeValue:vi.fn().mockResolvedValue(record)};
  TestBed.configureTestingModule({providers:[{provide:ApiClient,useValue:api}]});const session=TestBed.inject(SessionStore);session.workspace.set({id,name:'Demo',state:'ready',currentVersionId:id,versionIds:[id],contexts:[],counts:{snapshots:1,coordinates:1,facts:1,sources:2},sessionBytes:100});const store=TestBed.inject(ImportStore);TestBed.tick();await vi.waitFor(()=>expect(store.page()?.items[0]?.fileName).toBe('catalog.xlsx'));
  expect(api.largeValue).toHaveBeenCalledOnce();expect(store.page()?.items[0]?.expression).toBe(record.expression);expect(api.compactRules).toHaveBeenCalledWith(id,id,{});
  api.compactRules.mockResolvedValueOnce({workspaceId:id,versionId:id,items:[{...record,id:'second',code:'SECOND'}],total:2,nextCursor:null,coverage:{},dataSummary:{}});store.loadMoreRules();await vi.waitFor(()=>expect(store.page()?.items).toHaveLength(2));expect(api.compactRules.mock.lastCall?.[2]).toEqual({cursor:'next'});expect(api.largeValue).toHaveBeenCalledOnce();
 });
});
