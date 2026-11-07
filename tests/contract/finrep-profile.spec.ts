import Fastify from 'fastify';
import { expect,test } from 'vitest';
import { importContextInputSchema,diagnosticSchema } from '@ce/contracts';
import { publicDiagnostic,receivedDiagnostic } from '../../apps/api/src/public-diagnostic.js';
import { ApiError } from '../../apps/api/src/errors.js';
import { createApp } from '../../apps/api/src/app.js';
import { ControlledWorker,nextTurn } from '../helpers/foundation.js';
import { randomUUID,createHash } from 'node:crypto';
import { readFile,readdir } from 'node:fs/promises';
import { execute } from '../../apps/api/src/workers/inspect-import.worker.js';
import type { WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { FINREP_FORM } from '../helpers/finrep-fixtures.js';
const choice={reportIndex:0,sha256:'a'.repeat(64),profileId:'eba-finrep-4.0-f0101-v1'};
test('inspection profile choice is bounded, closed and admitted in both context branches',async()=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});app.post('/',{schema:{body:importContextInputSchema}},async()=>({ok:true}));
 const post=async(body:unknown)=>(await app.inject({method:'POST',url:'/',payload:body})).statusCode;
 try{
 expect(await post({source:'workbook',reportProfiles:[choice]})).toBe(200);
 expect(await post({source:'form',declaration:{entityId:'SYNTHETIC',referenceDate:'2025-12-31',filingIndicators:{'F_01.01':true}},reportProfiles:[choice]})).toBe(200);
 for(const bad of [{...choice,reportIndex:20},{...choice,reportIndex:-1},{...choice,sha256:'A'.repeat(64)},{...choice,profileId:'other'},{...choice,path:'private'}])expect(await post({source:'workbook',reportProfiles:[bad]})).toBe(400);
 expect(await post({source:'workbook',reportProfiles:[choice,choice]})).toBe(400);
 }finally{await app.close();}
});
test('ambiguous FINREP inspection publishes no version, exposes curated choices and retries with content-keyed selection',async()=>{
 const requests:WorkerRequest[]=[],workers:ControlledWorker[]=[],app=await createApp({workerFactory(request){requests.push(structuredClone(request));const w=new ControlledWorker();workers.push(w);return w;}});
 try{
 const host='127.0.0.1:3000',headers={host,'x-ce-session':(await app.inject({url:'/api/v1/bootstrap',headers:{host}})).json().sessionToken};const workspace=(await app.inject({method:'POST',url:'/api/v1/workspaces',headers,payload:{name:'FINREP profile decisions'}})).json(),base=`/api/v1/workspaces/${workspace.id}`;
 const catalog=await readFile('assets/demos/demo-finrep-catalog.xlsx'),report=await readFile('tests/fixtures/eba/official-annexes-4.0.xlsx'),sha256=createHash('sha256').update(report).digest('hex');
 const post=async(context:unknown,key=randomUUID())=>{const boundary=randomUUID(),parts:Buffer[]=[];for(const[name,value,file]of [['catalog',catalog,'catalog.xlsx'],['reports',report,'report.xlsx'],['context',Buffer.from(JSON.stringify(context)),undefined]] as const){parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"${file?`; filename="${file}"`:''}\r\n\r\n`),value,Buffer.from('\r\n'));}parts.push(Buffer.from(`--${boundary}--\r\n`));return app.inject({method:'POST',url:base+'/import-inspections',headers:{...headers,'if-match':'"empty"','idempotency-key':key,'content-type':'multipart/form-data; boundary='+boundary},payload:Buffer.concat(parts)});};
 const finish=async()=>{await nextTurn();const i=requests.length-1,r=requests[i]!;try{workers[i]!.complete(await execute(r.input,{job:r.job,cancelled:()=>false,progress:()=>{}}));}catch(e){workers[i]!.emit('message',{type:'failure',diagnostic:publicDiagnostic(e)});}await nextTurn();await app.ce.jobs.settle(r.job.jobId);return app.ce.store.job(workspace.id,r.job.jobId);};
 const context={source:'form',declaration:FINREP_FORM},key=randomUUID(),accepted=await post(context,key);expect(accepted.statusCode).toBe(202);const failed=await finish();expect(failed.status).toBe('failed');expect(failed.diagnostics[0]?.profileChoice).toMatchObject({reportIndex:0,sha256,candidates:[{profileId:'eba-corep-of-4.0-ca1-v1'},{profileId:'eba-finrep-4.0-f0101-v1'}]});expect(app.ce.store.get(workspace.id).versionIds).toEqual([]);expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]);
 const chosen={...context,reportProfiles:[{reportIndex:0,sha256,profileId:'eba-finrep-4.0-f0101-v1'}]};expect((await post(chosen,key)).statusCode).toBe(409);
 for(const reportProfiles of [[{...choice,sha256:'0'.repeat(64)}],[{...choice,sha256,reportIndex:1}],[{...choice,sha256},{...choice,sha256,profileId:'eba-corep-of-4.0-ca1-v1'}]])expect((await post({...context,reportProfiles})).statusCode).toBe(400);
 const retryKey=randomUUID(),retry=await post(chosen,retryKey);expect(retry.statusCode).toBe(202);expect((await post(chosen,retryKey)).json().jobId).toBe(retry.json().jobId);const succeeded=await finish();expect(succeeded.status).toBe('succeeded');
 const inspection=(await app.inject({url:base+'/import-inspections/'+succeeded.resultRef!.id,headers})).json();expect(inspection.reports[0]).toMatchObject({profileId:'eba-finrep-4.0-f0101-v1',coordinates:38,values:0,selectedSheets:['1.1']});expect(inspection.reports[0].excludedSheets).toHaveLength(190);expect(inspection.requiresPartialCoverageAcceptance).toBe(true);expect(app.ce.store.get(workspace.id).versionIds).toEqual([]);
 }finally{await app.close();}
},20000);
test('profile candidates survive both worker filters with registry-owned labels only',async()=>{
 const candidate={profileId:choice.profileId,label:'<script>untrusted</script>',tableCode:'wrong'};
 const diagnostic=publicDiagnostic(new ApiError('REPORT_PROFILE_REQUIRED',{profileChoice:{reportIndex:0,sha256:choice.sha256,candidates:[candidate]}}));
 expect(diagnostic.profileChoice?.candidates[0]).toEqual({profileId:choice.profileId,label:'FINREP · F 01.01 · plantilla 4.0',tableCode:'F_01.01'});
 expect(receivedDiagnostic(diagnostic)).toEqual(diagnostic);
 expect(receivedDiagnostic({...diagnostic,profileChoice:{...diagnostic.profileChoice,candidates:Array(4).fill(candidate)}})).not.toHaveProperty('profileChoice');
 const app=Fastify();app.get('/',{schema:{response:{200:diagnosticSchema}}},async()=>diagnostic);
 try{expect((await app.inject('/')).json().profileChoice).toEqual(diagnostic.profileChoice);}finally{await app.close();}
});
