import { describe, expect, it } from 'vitest';
import { sha256Bytes, readVerifiedExport, readVerifiedValue } from './verified-transfer';
import { PUBLIC_VALUE_PART_BYTES, TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
const id='00000000-0000-4000-8000-000000000005';
const signal=()=>new AbortController().signal;
describe('verified binary transport',()=>{
 it('hashes original bytes with SHA-256',async()=>{expect(await sha256Bytes(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');});
 it('resumes the failed export part without regenerating or refetching verified parts',async()=>{
  const bytes=new Uint8Array(TRANSFER_PART_MAX_BYTES+11).fill(65),first=bytes.slice(0,TRANSFER_PART_MAX_BYTES),last=bytes.slice(TRANSFER_PART_MAX_BYTES);
  const hashes=await Promise.all([first,last,bytes].map(sha256Bytes));const manifest={artifactId:id,intent:{workspaceId:id,versionId:id,kind:'report' as const},filename:'demo.zip',byteLength:bytes.byteLength,sha256:hashes[2]!,expiresAt:'2099-01-01T00:00:00Z',parts:[{index:0,size:first.length,sha256:hashes[0]!},{index:1,size:last.length,sha256:hashes[1]!}]};
  const cache=new Map<number,Uint8Array<ArrayBuffer>>(),calls:number[]=[];let fail=true;
  const fetch=async(index:number)=>{calls.push(index);if(index===1&&fail)throw new Error('offline');return {bytes:index===0?first:last,sha256:hashes[index]!};};
  await expect(readVerifiedExport(manifest,cache,fetch,signal())).rejects.toThrow('offline');expect(cache.size).toBe(1);fail=false;
  const blob=await readVerifiedExport(manifest,cache,fetch,signal());expect(blob.size).toBe(bytes.length);expect(calls).toEqual([0,1,1]);
 });
 it('rejects corrupt parts and never caches them or returns a truncated file',async()=>{
  const bytes=new TextEncoder().encode('original'),hash=await sha256Bytes(bytes);const manifest={artifactId:id,intent:{workspaceId:id,versionId:id,kind:'report' as const},filename:'demo.zip',byteLength:bytes.length,sha256:hash,expiresAt:'2099-01-01T00:00:00Z',parts:[{index:0,size:bytes.length,sha256:hash}]};const cache=new Map<number,Uint8Array<ArrayBuffer>>();
  await expect(readVerifiedExport(manifest,cache,async()=>({bytes:new TextEncoder().encode('modified'),sha256:hash}),signal())).rejects.toThrow(/integridad/);expect(cache.size).toBe(0);
  await expect(readVerifiedExport({...manifest,sha256:'a'.repeat(64)},cache,async()=>({bytes,sha256:hash}),signal())).rejects.toThrow(/integridad/);
 });
 it('restores a complete multibyte retained value across 128KiB boundaries and verifies all hashes',async()=>{
  const text='á😀'.repeat(60000),bytes=new TextEncoder().encode(JSON.stringify({text})),descriptor={valueRef:id,byteLength:bytes.length,sha256:await sha256Bytes(bytes),mediaType:'application/json' as const},indices:number[]=[];
  const value=await readVerifiedValue<{text:string}>(descriptor,async index=>{indices.push(index);const part=bytes.slice(index*PUBLIC_VALUE_PART_BYTES,(index+1)*PUBLIC_VALUE_PART_BYTES);return{bytes:part,sha256:await sha256Bytes(part)};},signal());expect(value).toEqual({text});expect(indices.length).toBe(Math.ceil(bytes.length/PUBLIC_VALUE_PART_BYTES));
 });
 it('does not start any request after cancellation',async()=>{const controller=new AbortController();controller.abort();let calls=0;await expect(readVerifiedValue({valueRef:id,byteLength:1,sha256:'a'.repeat(64),mediaType:'text/plain'},async()=>{calls++;throw new Error();},controller.signal)).rejects.toMatchObject({name:'AbortError'});expect(calls).toBe(0);});
});
