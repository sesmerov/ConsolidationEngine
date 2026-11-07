import { randomUUID,createHash } from 'node:crypto';
import { readFile,readdir,writeFile } from 'node:fs/promises';
import { afterEach,expect,test,vi } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { inspectWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { publicDiagnostic } from '../../apps/api/src/public-diagnostic.js';
import { execute } from '../../apps/api/src/workers/export.worker.js';
import type { WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { ControlledWorker,nextTurn } from '../helpers/foundation.js';
import { visualStaged,visualOperation } from '../helpers/visual-export-harness.js';
import * as boundedFiles from '../../apps/api/src/export/bounded-files.js';
import { FINREP_FORM,finrepParts,finrepValues } from '../helpers/finrep-fixtures.js';
import { changeXml,readZipParts,zipBytes,textCell } from '../helpers/xlsx-fixtures.js';
import { corepReplaceCell } from '../helpers/corep-fixtures.js';
const apps:Awaited<ReturnType<typeof createApp>>[]=[];
afterEach(async()=>{vi.restoreAllMocks();await Promise.all(apps.splice(0).map(app=>app.close()));});
async function setup(maxReportBytes?:number,sentinel=false,maxExpandedBytes?:number){
 const requests:WorkerRequest[]=[],workers:ControlledWorker[]=[];
 const app=await createApp({workerFactory(request){requests.push(structuredClone(request));const worker=new ControlledWorker();workers.push(worker);return worker;},reportExportLimits:{...(maxReportBytes?{maxReportBytes}:{}),...(maxExpandedBytes?{maxExpandedBytes}:{})}});apps.push(app);
 const host='127.0.0.1:3000',headers={host,'x-ce-session':(await app.inject({url:'/api/v1/bootstrap',headers:{host}})).json().sessionToken};
 const workspace=(await app.inject({method:'POST',url:'/api/v1/workspaces',headers,payload:{name:'FINREP export lifecycle'}})).json(),base=`/api/v1/workspaces/${workspace.id}`;
 const bytes=sentinel?zipBytes(finrepValues(await finrepParts(true),{'0010':'90','0380':'105'})):await readFile('assets/demos/demo-finrep-report.xlsx'),stored=await app.ce.files.write(workspace.id,bytes),source={...stored,kind:'report' as const,displayName:'finrep.xlsx',importedAt:'2026-11-07T00:00:00.000Z'};
 const catalog=await visualStaged('assets/demos/demo-finrep-catalog.xlsx','catalog'),candidate=await inspectWorkspace([catalog,source],visualOperation,sentinel?{source:'form',declaration:FINREP_FORM}:{source:'workbook'}),snapshot=app.ce.store.publish(workspace.id,undefined,candidate.content);
 const start=()=>app.inject({method:'POST',url:base+'/exports',headers:{...headers,'if-match':app.ce.store.etag(workspace.id),'idempotency-key':randomUUID()},payload:{kind:'report',versionId:snapshot.versionId}});
 const finish=async()=>{const request=requests.at(-1)!;try{workers.at(-1)!.complete(await execute(request.input,{job:request.job,cancelled:()=>false,progress:()=>{}}));}catch(error){workers.at(-1)!.emit('message',{type:'failure',diagnostic:publicDiagnostic(error)});}await nextTurn();};
 return {app,headers,workspace,base,source,snapshot,start,finish,requests,workers};
}
test.each(['changed','missing','quota','expanded-quota','cancelled'] as const)('FINREP %s export never publishes a partial download and releases output files',async(kind)=>{
 const s=await setup(kind==='quota'?512:undefined,false,kind==='expanded-quota'?100000:undefined),accepted=await s.start();expect(accepted.statusCode,accepted.body).toBe(202);await nextTurn();
 if(kind==='changed')await writeFile(s.source.path,Buffer.from('changed source'));
 if(kind==='missing')await s.app.ce.files.removeFiles(s.workspace.id,[s.source.id]);
 if(kind==='cancelled'){await s.app.inject({method:'DELETE',url:`${s.base}/jobs/${accepted.json().jobId}`,headers:s.headers});}
 else await s.finish();
 await vi.waitFor(()=>expect(['failed','cancelled']).toContain(s.app.ce.store.job(s.workspace.id,accepted.json().jobId).status));await s.app.ce.jobs.settle(accepted.json().jobId);
 expect(s.app.ce.store.listRecords('export:')).toEqual([]);expect(s.app.ce.store.current(s.workspace.id)).toBe(s.snapshot);expect(s.app.ce.files.usage(s.workspace.id).reservedBytes).toBe(0);
 expect(await readdir(s.app.ce.files.workspacePath(s.workspace.id))).toEqual(kind==='missing'?[]:[s.source.id]);
});
test.each(['truncated','crc','wrong-cell','excluded-sheet'] as const)('post-write verification rejects %s corruption before publishing',async(kind)=>{
 const s=await setup(undefined,true),write=boundedFiles.writeIncrementalParts;
 vi.spyOn(boundedFiles,'writeIncrementalParts').mockImplementation(async(...args)=>{
  const output=await write(...args),file=args[0];
  if(kind==='truncated'){const bytes=await readFile(file);await writeFile(file,bytes.subarray(0,bytes.length-20));}
  else if(kind==='crc'){const bytes=await readFile(file),at=bytes.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));bytes.writeUInt32LE(bytes.readUInt32LE(at+16)^1,at+16);await writeFile(file,bytes);}
  else {const parts=await readZipParts(file),changed=kind==='wrong-cell'?changeXml(parts,'xl/worksheets/sheet1.xml',x=>corepReplaceCell(x,'F8',textCell('F8','999'))):changeXml(parts,'xl/worksheets/sheet2.xml',x=>x.replace('EXCLUDED_SENTINEL','ALTERED_SENTINEL'));await writeFile(file,zipBytes(changed));}
  return output;
 });
 const accepted=await s.start();expect(accepted.statusCode).toBe(202);await nextTurn();await s.finish();
 await vi.waitFor(()=>expect(s.app.ce.store.job(s.workspace.id,accepted.json().jobId).status).toBe('failed'));await s.app.ce.jobs.settle(accepted.json().jobId);
 expect(s.app.ce.store.listRecords('export:')).toEqual([]);expect(await readdir(s.app.ce.files.workspacePath(s.workspace.id))).toEqual([s.source.id]);expect(s.app.ce.files.usage(s.workspace.id).reservedBytes).toBe(0);
});
test('FINREP exports the retained original and rejects a source owned by another workspace',async()=>{
 const s=await setup(),accepted=await s.start();expect(accepted.statusCode).toBe(202);await nextTurn();await s.finish();
 await vi.waitFor(()=>expect(s.app.ce.store.job(s.workspace.id,accepted.json().jobId).status).toBe('succeeded'));
 const job=s.app.ce.store.job(s.workspace.id,accepted.json().jobId);await s.app.ce.jobs.settle(job.jobId);const download=await s.app.inject({url:`${s.base}/exports/${job.resultRef!.id}`,headers:s.headers});expect(download.statusCode).toBe(200);
 expect(createHash('sha256').update(await readFile(s.source.path)).digest('hex')).toBe(s.source.sha256);
 const other=await setup();const foreign=other.app.ce.store.publish(other.workspace.id,other.snapshot.versionId,s.snapshot.content);
 const denied=await other.app.inject({method:'POST',url:other.base+'/exports',headers:{...other.headers,'if-match':other.app.ce.store.etag(other.workspace.id),'idempotency-key':randomUUID()},payload:{kind:'report',versionId:foreign.versionId}});
 expect(denied.statusCode).toBe(409);expect(denied.json().error.code).toBe('EXPORT_NOT_AVAILABLE');expect(await readdir(other.app.ce.files.workspacePath(other.workspace.id))).toEqual([other.source.id]);
});
