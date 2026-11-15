import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../core/api-client';
import { SessionStore } from '../core/session.store';
import { ImportStore } from './import.store';
const id='00000000-0000-4000-8000-000000000005';
const summary={id,workspaceId:id,state:'ready',createdAt:'2026-11-08T12:00:00Z',expiresAt:new Date(Date.now()+900000).toISOString(),inspectionHash:'a'.repeat(64),profiles:[],requiresPartialCoverageAcceptance:true,reportCount:1,contextCount:1,diagnosticsCount:51};
const context={sourceFileId:id,origin:'workbook',declaration:{entityId:'SYNTHETIC',contextId:'finrep',referenceDate:'2025-12-31',framework:'FINREP',moduleVersion:'FINREP_4.0',filingIndicators:{'F_01.01':true}}};
const report={sourceFileId:id,displayName:'finrep.xlsx',sha256:'b'.repeat(64),profileId:'eba-finrep-4.0-f0101-v1',tables:['F_01.01'],selectedSheets:['1.1'],excludedSheets:['1.2'],coordinates:38,values:3};
describe('compact import inspection',()=>{
 const api={capabilities:vi.fn(),activeImportInspection:vi.fn(),importInspection:vi.fn(),importInspectionItems:vi.fn(),largeValue:vi.fn(),rules:vi.fn()};let store:ImportStore;
 beforeEach(async()=>{vi.resetAllMocks();api.capabilities.mockResolvedValue({});api.activeImportInspection.mockResolvedValue({active:summary});api.importInspection.mockResolvedValue(summary);api.importInspectionItems.mockImplementation(async(_w,_id,section,query={})=>({workspaceId:id,inspectionId:id,revision:1,section,items:section==='context'?[context]:section==='reports'?[report]:Array.from({length:query.cursor?1:50},(_,index)=>({code:'WARNING',message:'Aviso '+(query.cursor?51:index+1)})),total:section==='diagnostics'?51:1,nextCursor:section==='diagnostics'&&!query.cursor?'next':null}));
  TestBed.configureTestingModule({providers:[{provide:ApiClient,useValue:api}]});const session=TestBed.inject(SessionStore);session.workspace.set({id,name:'Demo',state:'empty',versionIds:[],contexts:[],counts:{snapshots:0,coordinates:0,facts:0,sources:0},sessionBytes:0});session.etag.set('"empty"');store=TestBed.inject(ImportStore);TestBed.tick();await vi.waitFor(()=>expect(store.inspectionPending()).toBe(false));vi.clearAllMocks();
 });
 afterEach(()=>TestBed.resetTestingModule());
 it('loads one requested page per section and retains global acceptance while paging diagnostics',async()=>{
  await store.recoverInspection();expect(api.importInspectionItems).toHaveBeenCalledTimes(3);expect(store.inspectionContexts()).toEqual([context]);expect(store.inspectionReports()).toEqual([report]);expect(store.inspectionDiagnostics()).toHaveLength(50);expect(store.contextProfile()).toBe('finrep');store.acceptedExcludedSheets.set(true);expect(store.canCommit()).toBe(true);
  await store.loadInspectionSection('diagnostics',1);expect(api.importInspectionItems.mock.lastCall?.[3]).toEqual({cursor:'next'});expect(store.inspectionDiagnostics()).toEqual([{code:'WARNING',message:'Aviso 51'}]);expect(store.acceptedExcludedSheets()).toBe(true);expect(store.inspection()?.diagnosticsCount).toBe(51);
 });
 it('does not confirm an inspection when a required section could not be retrieved',async()=>{api.importInspectionItems.mockRejectedValue(new Error('offline'));await store.recoverInspection();store.acceptedExcludedSheets.set(true);expect(store.canCommit()).toBe(false);expect(store.inspectionSectionErrors().reports).toBeTruthy();});
 it('keeps actual offsets when the response budget reduces a page below fifty items',async()=>{
  api.importInspectionItems.mockImplementation(async(_w,_id,section,query={})=>({workspaceId:id,inspectionId:id,revision:1,section,items:section==='context'?[context]:section==='reports'?[report]:Array.from({length:query.cursor?49:2},(_,index)=>({code:'WARNING',message:'Aviso '+index})),total:section==='diagnostics'?51:1,nextCursor:section==='diagnostics'&&!query.cursor?'budget-next':null}));
  await store.recoverInspection();expect(store.inspectionPagination.diagnostics.rangeLabel()).toBe('1–2 de 51');await store.loadInspectionSection('diagnostics',1);expect(store.inspectionPagination.diagnostics.rangeLabel()).toBe('3–51 de 51');expect(store.inspectionDiagnostics()).toHaveLength(49);expect(api.importInspectionItems.mock.lastCall?.[3]).toEqual({cursor:'budget-next'});
 });
 it('retrieves the complete retained section item and ignores a response for a previous inspection',async()=>{
  api.activeImportInspection.mockResolvedValue({active:{...summary,diagnosticsCount:0}});
  const descriptor={valueRef:id,byteLength:1048577,sha256:'c'.repeat(64),mediaType:'application/json'};api.largeValue.mockResolvedValue(report);api.importInspectionItems.mockImplementation(async(_w,_id,section)=>({workspaceId:id,inspectionId:id,revision:1,section,items:section==='reports'?[descriptor]:section==='context'?[context]:[],total:section==='diagnostics'?0:1,nextCursor:null}));
  await store.recoverInspection();expect(api.largeValue).toHaveBeenCalledWith(id,descriptor,expect.any(AbortSignal));expect(store.inspectionReports()).toEqual([report]);
  let resolve!:(value:unknown)=>void;api.importInspectionItems.mockImplementationOnce(()=>new Promise(value=>{resolve=value;}));const pending=store.loadInspectionSection('reports',0);TestBed.inject(SessionStore).workspace.set(null);TestBed.tick();resolve({workspaceId:id,inspectionId:id,revision:1,section:'reports',items:[report],total:1,nextCursor:null});await pending;expect(store.inspectionReports()).toEqual([]);
 });
});
