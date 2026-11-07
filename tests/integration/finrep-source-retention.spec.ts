import { randomUUID } from 'node:crypto';
import { access,readdir } from 'node:fs/promises';
import { afterEach,expect,test } from 'vitest';
import { FINREP_FORM } from '../helpers/finrep-fixtures.js';
import { inspectionHarness,inspectionTick,lifecycleContext } from '../helpers/inspection-lifecycle-harness.js';
const harnesses:Awaited<ReturnType<typeof inspectionHarness>>[]=[];
afterEach(async()=>{await Promise.all(harnesses.splice(0).map(h=>h.close()));});
async function ready(){
 const h=await inspectionHarness({empty:true});harnesses.push(h);
 const response=await h.start(randomUUID(),h.originalETag,{source:'form',declaration:FINREP_FORM,reportProfiles:lifecycleContext.reportProfiles.map(c=>({...c,profileId:'eba-finrep-4.0-f0101-v1'}))});
 expect(response.statusCode).toBe(202);await inspectionTick();const job=await h.finish(0);expect(job.status,JSON.stringify(job.diagnostics)).toBe('succeeded');
 const inspection=(await h.get(job.resultRef!.id)).json();return {h,inspection};
}
test('FINREP inspection commit retains its verified original for export and workspace close removes it',async()=>{
 const {h,inspection}=await ready(),commit=await h.commit(inspection);expect(commit.statusCode).toBe(202);await inspectionTick();const committed=await h.finish(1);expect(committed.status).toBe('succeeded');
 await h.app.ce.jobs.settle(committed.jobId);await h.app.ce.inspections.settle(h.workspace.id);
 const snapshot=h.app.ce.store.current(h.workspace.id)!,source=snapshot.content.sources.find(s=>s.kind==='report')!;
 expect(await readdir(h.app.ce.files.workspacePath(h.workspace.id))).toEqual([source.id]);expect(h.app.ce.files.usage(h.workspace.id)).toMatchObject({retainedBytes:source.size,reservedBytes:0});
 await expect(h.app.ce.files.retainedSource(h.workspace.id,source)).resolves.toMatchObject({id:source.id,sha256:source.sha256});
 const response=await h.app.inject({method:'POST',url:`/api/v1/workspaces/${h.workspace.id}/exports`,headers:{...h.headers,'if-match':h.app.ce.store.etag(h.workspace.id),'idempotency-key':randomUUID()},payload:{kind:'report',versionId:snapshot.versionId}});
 expect(response.statusCode,response.body).toBe(202);await inspectionTick();const exported=await h.finish(2);expect(exported.status,JSON.stringify(exported.diagnostics)).toBe('succeeded');await h.app.ce.jobs.settle(exported.jobId);
 const download=await h.app.inject({url:`/api/v1/workspaces/${h.workspace.id}/exports/${exported.resultRef!.id}`,headers:h.headers});expect(download.statusCode).toBe(200);
 const directory=h.app.ce.files.directory;await h.close();await expect(access(directory)).rejects.toMatchObject({code:'ENOENT'});
},20000);
test('uncommitted FINREP inspections still discard all retained files and budget',async()=>{
 const {h,inspection}=await ready();expect((await h.discard(inspection.id)).statusCode).toBe(200);await h.app.ce.inspections.settle(h.workspace.id);await h.clean();
});
