import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from './api-client';
import { UploadAttemptStore } from './upload-attempt.store';
import { sha256Bytes } from './verified-transfer';
import { TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
const id='00000000-0000-4000-8000-000000000005',base='/api/v1/workspaces/'+id;
describe('authenticated binary API client',()=>{
 let http:HttpTestingController,api:ApiClient;
 beforeEach(()=>{TestBed.configureTestingModule({providers:[provideHttpClient(),provideHttpClientTesting()]});http=TestBed.inject(HttpTestingController);api=TestBed.inject(ApiClient);api.setSessionToken('bearer');TestBed.inject(UploadAttemptStore).clearAll();});
 afterEach(()=>{try{http.verify();}finally{TestBed.inject(UploadAttemptStore).clearAll();TestBed.resetTestingModule();}});
 async function request(url:string){return vi.waitFor(()=>{const found=http.match(url);expect(found).toHaveLength(1);return found[0]!;});}
 it('checks the complete retained value and keeps session headers on every binary part',async()=>{
  const bytes=new TextEncoder().encode('Texto íntegro'),hash=await sha256Bytes(bytes),pending=api.largeValue<string>(id,{valueRef:id,byteLength:bytes.length,sha256:hash,mediaType:'text/plain'}),part=http.expectOne(base+'/values/'+id+'/parts/0');expect(part.request.headers.get('X-CE-Session')).toBe('bearer');expect(part.request.withCredentials).toBe(false);const buffer=new ArrayBuffer(bytes.length);new Uint8Array(buffer).set(bytes);part.flush(buffer,{headers:{'X-CE-Part-SHA256':hash}});expect(await pending).toBe('Texto íntegro');
 });
 it('checks manifest identity against the accepted version before requesting any ZIP bytes',async()=>{
  const pending=api.downloadExport(id,id,new AbortController().signal,{id,jobId:id,intent:{workspaceId:id,versionId:id,kind:'report'},intentFingerprint:'a'.repeat(64),size:1,sha256:'b'.repeat(64),status:'ready',filename:'report.zip',mimeType:'application/zip'});
  http.expectOne(base+'/exports/'+id+'/manifest').flush({artifactId:id,intent:{workspaceId:id,versionId:id,kind:'results',runId:id},filename:'report.zip',byteLength:1,sha256:'b'.repeat(64),expiresAt:'2099-01-01T00:00:00Z',parts:[{index:0,size:1,sha256:'b'.repeat(64)}]});await expect(pending).rejects.toThrow(/versión solicitada/);http.expectNone(request=>request.url.includes('/parts/'));
 });
 it('aborts pending private transfers when the session is revoked',async()=>{
  const pending=api.largeValue<string>(id,{valueRef:id,byteLength:1,sha256:'a'.repeat(64),mediaType:'text/plain'}),part=http.expectOne(base+'/values/'+id+'/parts/0');api.clearSession();expect(part.cancelled).toBe(true);await expect(pending).rejects.toBeDefined();
 });
 it('uploads only binary parts, seals once, then submits an inspection JSON referencing the batch',async()=>{
  const pending=api.inspectImport(id,'"empty"',new File(['catalog'],'rules.xlsx'),[new File(['report'],'report.xlsx')],{source:'workbook'},crypto.randomUUID(),new AbortController().signal);
  const create=await request(base+'/upload-batches'),body=create.request.body;expect(create.request.headers.get('Idempotency-Key')).toBeTruthy();expect(JSON.stringify(TestBed.inject(UploadAttemptStore).get(id))).not.toContain('rules.xlsx');
  create.flush({id,workspaceId:id,baseVersionId:null,state:'receiving',partSize:TRANSFER_PART_MAX_BYTES,expiresAt:'2099-01-01T00:00:00Z',files:body.files.map((file:any)=>({...file,id:file.clientFileId==='catalog'?id:'00000000-0000-4000-8000-000000000006',partCount:1,parts:[]}))});
  for(const fileId of [id,'00000000-0000-4000-8000-000000000006']){const part=await request(base+'/upload-batches/'+id+'/files/'+fileId+'/parts/0');expect(part.request.headers.get('Content-Type')).toBe('application/octet-stream');expect(part.request.body).toBeInstanceOf(ArrayBuffer);const hash=await sha256Bytes(new Uint8Array(part.request.body));expect(part.request.headers.get('X-CE-Part-SHA256')).toBe(hash);part.flush({index:0,size:part.request.body.byteLength,sha256:hash});}
  const seal=await request(base+'/upload-batches/'+id+'/seal');expect(seal.request.body).toEqual({baseVersionId:null});expect(seal.request.headers.get('If-Match')).toBe('"empty"');seal.flush({jobId:id,workspaceId:id,kind:'seal-upload',status:'succeeded',progress:{completed:1,total:1,complete:true},diagnostics:[],pollAfterMs:5000,resultRef:{type:'upload-batch',id}});
  const inspection=await request(base+'/import-inspections');expect(inspection.request.body).toEqual({uploadBatchId:id,context:{source:'workbook'}});expect(inspection.request.body).not.toBeInstanceOf(FormData);inspection.flush({jobId:id,workspaceId:id,kind:'inspect-import',status:'queued',progress:{completed:0,total:1,complete:false},diagnostics:[],pollAfterMs:5000});expect((await pending).kind).toBe('inspect-import');
 });
});
