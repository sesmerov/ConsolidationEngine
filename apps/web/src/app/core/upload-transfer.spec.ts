import { describe, expect, it, vi } from 'vitest';
import type { UploadAttempt } from './upload-attempt.store';
import { uploadFilesForInspection } from './upload-transfer';
import { sha256Bytes } from './verified-transfer';
import { TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
const id='00000000-0000-4000-8000-000000000005';
function fixture(){let saved:UploadAttempt|null=null;const attempts={get:()=>saved,save:(value:UploadAttempt)=>{saved=value;},clear:()=>{saved=null;}};const files=[new File(['catalog'], 'catalog.xlsx'),new File(['report'], 'report.xlsx')];
 const create=vi.fn(async (declaration:any)=>({id,workspaceId:id,baseVersionId:null,state:'receiving',partSize:TRANSFER_PART_MAX_BYTES,expiresAt:'2099-01-01T00:00:00Z',files:declaration.files.map((file:any)=>({...file,id:crypto.randomUUID(),partCount:1,parts:[]}))}));
 const ports={create,get:vi.fn(),put:vi.fn(async (_batch:any,_file:any,index:number,bytes:Uint8Array<ArrayBuffer>,hash:string)=>({index,size:bytes.length,sha256:hash})),seal:vi.fn(async(_batch:string,_base:string|null,_key:string,_etag:string)=>({jobId:id,workspaceId:id,kind:'seal-upload',status:'succeeded',progress:{completed:1,total:1,complete:true},diagnostics:[],pollAfterMs:5000,resultRef:{type:'upload-batch',id}})),job:vi.fn()};
 return{attempts,files,ports};}
describe('resumable upload preparation',()=>{
 it('persists only identities before the batch mutation and seals the same verified files',async()=>{
  const {attempts,files,ports}=fixture();ports.create.mockImplementationOnce(async declaration=>{const saved=attempts.get();expect(saved?.createKey).toMatch(/^[0-9a-f-]{36}$/);expect(JSON.stringify(saved)).not.toContain('catalog.xlsx');return{id,workspaceId:id,baseVersionId:null,state:'receiving',partSize:TRANSFER_PART_MAX_BYTES,expiresAt:'2099-01-01T00:00:00Z',files:declaration.files.map((file:any)=>({...file,id:crypto.randomUUID(),partCount:1,parts:[]}))};});
  const result=await uploadFilesForInspection(id,null,'"empty"',files[0]!,files.slice(1),attempts,ports as any,new AbortController().signal,0);expect(result).toBe(id);expect(ports.put).toHaveBeenCalledTimes(2);expect(ports.seal.mock.calls[0]?.[2]).toBe(attempts.get()?.sealKey);
 });
 it('reuses the exact create key after a lost response and rejects different files',async()=>{
  const {attempts,files,ports}=fixture();ports.create.mockRejectedValueOnce(new Error('offline'));
  await expect(uploadFilesForInspection(id,null,'"empty"',files[0]!,files.slice(1),attempts,ports as any,new AbortController().signal,0)).rejects.toThrow('offline');const saved=attempts.get();
  await expect(uploadFilesForInspection(id,null,'"empty"',new File(['different'],'catalog.xlsx'),files.slice(1),attempts,ports as any,new AbortController().signal,0)).rejects.toThrow(/mismos archivos/);
  await uploadFilesForInspection(id,null,'"changed"',files[0]!,files.slice(1),attempts,ports as any,new AbortController().signal,0);expect(ports.create.mock.calls[0]?.slice(1)).toEqual(ports.create.mock.calls[1]?.slice(1));expect(attempts.get()?.createKey).toBe(saved?.createKey);
 });
 it('loads a known batch and uploads only parts whose recorded hash has been verified against the reselected file',async()=>{
  const {attempts,files,ports}=fixture();ports.put.mockRejectedValueOnce(new Error('offline'));
  await expect(uploadFilesForInspection(id,null,'"empty"',files[0]!,files.slice(1),attempts,ports as any,new AbortController().signal,0)).rejects.toThrow('offline');
  const batch=await ports.create.mock.results[0]!.value;const catalogHash=await sha256Bytes(new TextEncoder().encode('catalog'));ports.get.mockResolvedValue({...batch,files:batch.files.map((file:any,index:number)=>({...file,parts:index===0?[{index:0,size:7,sha256:catalogHash}]:[]}))});ports.put.mockClear();
  await uploadFilesForInspection(id,null,'"empty"',files[0]!,files.slice(1),attempts,ports as any,new AbortController().signal,0);expect(ports.create).toHaveBeenCalledOnce();expect(ports.put).toHaveBeenCalledOnce();
 });
});
