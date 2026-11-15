import { isCompleteTransferManifest, PUBLIC_VALUE_PART_BYTES } from '@ce/contracts';
import type { ExportManifestDTO, LargeValueDescriptorDTO } from '@ce/contracts';

export interface BinaryPart { readonly bytes:Uint8Array<ArrayBuffer>; readonly sha256:string|null }
export type PartReader=(index:number)=>Promise<BinaryPart>;
export class ArtifactExpiredError extends Error{constructor(){super('El archivo de descarga ha caducado. Pulsa Descargar para prepararlo de nuevo.');this.name='ArtifactExpiredError';}}
export function checkTransferCancellation(signal?:AbortSignal):void{if(signal?.aborted)throw new DOMException('Transferencia cancelada.','AbortError');}
export async function sha256Bytes(bytes:Uint8Array<ArrayBuffer>):Promise<string>{
 const digest=await crypto.subtle.digest('SHA-256',bytes);return [...new Uint8Array(digest)].map(value=>value.toString(16).padStart(2,'0')).join('');
}
function join(parts:readonly Uint8Array<ArrayBuffer>[],length:number):Uint8Array<ArrayBuffer>{
 const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.length;}return bytes;
}
async function verify(part:BinaryPart,size:number,expected:string):Promise<void>{
 if(part.bytes.byteLength!==size||part.sha256!==expected||await sha256Bytes(part.bytes)!==expected)throw new Error('No se pudo verificar la integridad de una parte. Vuelve a intentarlo.');
}
/** Cache only verified bytes of this exact immutable manifest; callers invalidate on identity changes. */
export async function readVerifiedExport(manifest:ExportManifestDTO,cache:Map<number,Uint8Array<ArrayBuffer>>,read:PartReader,signal:AbortSignal,onProgress?:(completed:number,total:number)=>void):Promise<Blob>{
 checkTransferCancellation(signal);
 if(!isCompleteTransferManifest(manifest))throw new Error('El manifiesto de descarga está incompleto.');
 if(Date.parse(manifest.expiresAt)<=Date.now())throw new ArtifactExpiredError();
 let completed=0;
 for(const part of manifest.parts){checkTransferCancellation(signal);if(!cache.has(part.index)){const reply=await read(part.index);checkTransferCancellation(signal);await verify(reply,part.size,part.sha256);cache.set(part.index,reply.bytes);}
  completed+=part.size;onProgress?.(completed,manifest.byteLength);
 }
 checkTransferCancellation(signal);const bytes=join(manifest.parts.map(part=>cache.get(part.index)!),manifest.byteLength);
 if(await sha256Bytes(bytes)!==manifest.sha256){cache.clear();throw new Error('No se pudo verificar la integridad del archivo completo.');}
 checkTransferCancellation(signal);return new Blob([bytes],{type:'application/zip'});
}
/** Reconstruct text/JSON from original UTF-8 bytes, never a preview, provider object or executable expression. */
export async function readVerifiedValue<T>(descriptor:LargeValueDescriptorDTO,read:PartReader,signal:AbortSignal):Promise<T>{
 checkTransferCancellation(signal);if(!Number.isSafeInteger(descriptor.byteLength)||descriptor.byteLength<0)throw new Error('Referencia de valor inválida.');
 const parts:Uint8Array<ArrayBuffer>[]=[];
 for(let index=0;index<Math.ceil(descriptor.byteLength/PUBLIC_VALUE_PART_BYTES);index++){
  checkTransferCancellation(signal);const reply=await read(index);checkTransferCancellation(signal);
  await verify(reply,Math.min(PUBLIC_VALUE_PART_BYTES,descriptor.byteLength-index*PUBLIC_VALUE_PART_BYTES),reply.sha256??'');parts.push(reply.bytes);
 }
 const bytes=join(parts,descriptor.byteLength);if(await sha256Bytes(bytes)!==descriptor.sha256)throw new Error('No se pudo verificar la integridad del valor completo.');
 checkTransferCancellation(signal);const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
 if(descriptor.mediaType==='application/json')return JSON.parse(text) as T;
 if(descriptor.mediaType==='text/plain'||descriptor.mediaType==='text/plain; charset=utf-8')return text as T;
 throw new Error('El formato del valor no se puede mostrar como texto.');
}
