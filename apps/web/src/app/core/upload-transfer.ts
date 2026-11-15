import { INPUT_BATCH_MAX_BYTES, INPUT_FILE_MAX_BYTES, INPUT_MAX_REPORTS, isTerminalJob, safeDisplayName, TRANSFER_PART_MAX_BYTES } from '@ce/contracts';
import type { JobDTO, TransferPartDTO, UploadBatchCreateDTO, UploadBatchDTO, UploadFileDeclarationDTO } from '@ce/contracts';
import type { UploadAttemptStore } from './upload-attempt.store';
import { checkTransferCancellation, sha256Bytes } from './verified-transfer';
export interface UploadPorts {
 create(body:UploadBatchCreateDTO,key:string,etag:string):Promise<UploadBatchDTO>;
 get(batchId:string):Promise<UploadBatchDTO>;
 put(batchId:string,fileId:string,index:number,bytes:Uint8Array<ArrayBuffer>,sha256:string):Promise<TransferPartDTO>;
 seal(batchId:string,baseVersionId:string|null,key:string,etag:string):Promise<JobDTO>;
 job(jobId:string):Promise<JobDTO>;
}
export interface UploadProgress {readonly phase:'hashing'|'uploading'|'sealing';readonly completed:number;readonly total:number}
export function readBlobBytes(blob:Blob,signal:AbortSignal):Promise<Uint8Array<ArrayBuffer>>{
 checkTransferCancellation(signal);return new Promise((resolve,reject)=>{
  const reader=new FileReader(),abort=()=>reader.abort();signal.addEventListener('abort',abort,{once:true});
  const done=()=>signal.removeEventListener('abort',abort);
  reader.onload=()=>{done();resolve(new Uint8Array(reader.result as ArrayBuffer));};reader.onerror=()=>{done();reject(new Error('No se pudo leer el archivo seleccionado.'));};reader.onabort=()=>{done();reject(new DOMException('Carga cancelada.','AbortError'));};reader.readAsArrayBuffer(blob);
 });
}
async function delay(ms:number,signal:AbortSignal):Promise<void>{checkTransferCancellation(signal);await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Carga cancelada.','AbortError'));},timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);signal.addEventListener('abort',abort,{once:true});});}
/** At most the current 10MiB input is read; persistent recovery stores only identity and digests. */
export async function uploadFilesForInspection(workspaceId:string,baseVersionId:string|null,etag:string,catalog:File,reports:readonly File[],attempts:Pick<UploadAttemptStore,'get'|'save'|'clear'>,ports:UploadPorts,signal:AbortSignal,pollMinMs:number,onProgress?:(progress:UploadProgress)=>void):Promise<string>{
 checkTransferCancellation(signal);const files=[catalog,...reports],total=files.reduce((sum,file)=>sum+file.size,0);
 if(reports.length<1||reports.length>INPUT_MAX_REPORTS||files.some(file=>file.size<1||file.size>INPUT_FILE_MAX_BYTES)||total>INPUT_BATCH_MAX_BYTES)throw new Error('Selecciona un catálogo y entre 1 y 20 informes, hasta 10MiB por archivo y 50MiB en total.');
 const declarations:UploadFileDeclarationDTO[]=[];let completed=0;
 for(let index=0;index<files.length;index++){const file=files[index]!;onProgress?.({phase:'hashing',completed,total});const bytes=await readBlobBytes(file,signal);declarations.push({clientFileId:index===0?'catalog':'report_'+(index-1),role:index===0?'catalog':'report',name:safeDisplayName(file.name),byteLength:file.size,sha256:await sha256Bytes(bytes)});completed+=file.size;}
 checkTransferCancellation(signal);const body:UploadBatchCreateDTO={baseVersionId,files:declarations},fingerprint=await sha256Bytes(new TextEncoder().encode(JSON.stringify(body)));checkTransferCancellation(signal);
 let attempt=attempts.get(workspaceId);if(attempt&&attempt.baseVersionId!==baseVersionId){attempts.clear(workspaceId);attempt=null;}
 if(attempt&&attempt.fingerprint!==fingerprint)throw new Error('Hay una carga pendiente. Selecciona los mismos archivos o descarta esa carga antes de comenzar otra.');
 if(!attempt){attempt={workspaceId,baseVersionId,etag,fingerprint,createKey:crypto.randomUUID(),sealKey:crypto.randomUUID()};attempts.save(attempt);}
 const batch=attempt.batchId?await ports.get(attempt.batchId):await ports.create(body,attempt.createKey,attempt.etag);checkTransferCancellation(signal);
 if(batch.workspaceId!==workspaceId||batch.baseVersionId!==baseVersionId||batch.partSize!==TRANSFER_PART_MAX_BYTES||batch.files.length!==files.length||Date.parse(batch.expiresAt)<=Date.now())throw new Error('La carga ha caducado o no corresponde a estos archivos. Descártala para volver a empezar.');
 if(!['reserved','receiving','sealing','sealed','retained'].includes(batch.state))throw new Error('Esta carga ya no admite archivos. Descártala para comenzar otra.');
 attempt={...attempt,batchId:batch.id};attempts.save(attempt);completed=0;
 for(let fileIndex=0;fileIndex<files.length;fileIndex++){
  const declaration=declarations[fileIndex]!,file=files[fileIndex]!,stored=batch.files.find(row=>row.clientFileId===declaration.clientFileId);
  if(!stored||stored.name!==declaration.name||stored.sha256!==declaration.sha256||stored.byteLength!==file.size||stored.role!==declaration.role||stored.partCount!==Math.ceil(file.size/TRANSFER_PART_MAX_BYTES))throw new Error('El archivo seleccionado no coincide con la carga pendiente.');
  for(let index=0;index<stored.partCount;index++){
   checkTransferCancellation(signal);const bytes=await readBlobBytes(file.slice(index*TRANSFER_PART_MAX_BYTES,(index+1)*TRANSFER_PART_MAX_BYTES),signal),hash=await sha256Bytes(bytes),existing=stored.parts.find(part=>part.index===index);
   if(existing&&(existing.sha256!==hash||existing.size!==bytes.length))throw new Error('Una parte pendiente no coincide con el archivo seleccionado.');
   checkTransferCancellation(signal);if(!existing){const receipt=await ports.put(batch.id,stored.id,index,bytes,hash);checkTransferCancellation(signal);if(receipt.index!==index||receipt.size!==bytes.length||receipt.sha256!==hash)throw new Error('No se pudo verificar la integridad de la carga.');}
   completed+=bytes.length;onProgress?.({phase:'uploading',completed,total});
  }
 }
 if(batch.state==='sealed'||batch.state==='retained')return batch.id;
 onProgress?.({phase:'sealing',completed:total,total});
 let job=attempt.sealJobId?await ports.job(attempt.sealJobId):await ports.seal(batch.id,baseVersionId,attempt.sealKey,attempt.etag);checkTransferCancellation(signal);
 if(job.workspaceId!==workspaceId||job.kind!=='seal-upload')throw new Error('Respuesta de preparación incompatible.');
 attempts.save({...attempt,sealJobId:job.jobId});
 while(!isTerminalJob(job.status)){await delay(Math.max(pollMinMs,job.pollAfterMs),signal);job=await ports.job(job.jobId);checkTransferCancellation(signal);}
 if(job.status!=='succeeded'||!job.progress.complete||job.resultRef?.type!=='upload-batch'||job.resultRef.id!==batch.id)throw new Error(job.diagnostics[0]?.message??'No se pudo preparar la carga. El conjunto anterior se conserva.');
 return batch.id;
}
