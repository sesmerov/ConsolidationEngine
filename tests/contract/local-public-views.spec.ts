import { randomUUID,createHash } from 'node:crypto';
import Fastify from 'fastify';
import { expect,it } from 'vitest';
import type { LargeValueDescriptorDTO } from '@ce/contracts';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { registerResults } from '../../apps/api/src/routes/results.js';
import { registerWorkspaces } from '../../apps/api/src/routes/workspaces.js';
import { registerRules } from '../../apps/api/src/routes/rules.js';
import { LocalPublicViews } from '../../apps/api/src/local/local-public-views.js';
import { uniqueTargetSnapshot,validate005 } from '../helpers/iteration005-fixtures.js';
it('local compact routes page contexts and execution evidence without global arrays and reconstruct a large exact value',async()=>{
 const app=Fastify({ajv:{customOptions:{removeAdditional:false}}}),store=new WorkspaceStore(),workspace=store.create('Synthetic'),source=uniqueTargetSnapshot();
 app.decorate('ce',{store,adapters:{publicViews:new LocalPublicViews(store)}});registerResults(app);registerWorkspaces(app);registerRules(app);
 try{
  const snapshot=store.publish(workspace.id,undefined,{...source.content,contexts:Array.from({length:51},(_,i)=>({...source.content.contexts[0]!,contextId:'context-'+String(i).padStart(3,'0')}))});
  const original=validate005(source),run={...original.run,versionId:snapshot.versionId,validationBasisId:snapshot.validationBasisId},big='á'.repeat(550000),rows=original.results.map((row,i)=>({...row,versionId:snapshot.versionId,...(i===0?{expression:big}:{})}));
  store.putInternalRecord(`validation:${workspace.id}:${run.id}`,{run,results:rows});const base='/api/v1/workspaces/'+workspace.id;
  const rules=await app.inject(base+`/rules?versionId=${snapshot.versionId}&compact=true`);expect(rules.statusCode,rules.body).toBe(200);expect(rules.json()).not.toHaveProperty('sources');expect(rules.json().items[0]).not.toHaveProperty('originalFields');expect(rules.json().items[0].fileName).toBeTruthy();
  const diagnostics=await app.inject(base+`/runs/${run.id}/diagnostics`);expect(diagnostics.statusCode,diagnostics.body).toBe(200);expect(diagnostics.json().total).toBe(run.diagnostics.length);
  const workspaceResponse=await app.inject(base+'?compact=true');expect(workspaceResponse.statusCode,workspaceResponse.body).toBe(200);expect(workspaceResponse.json().contextCount).toBe(51);expect(workspaceResponse.json()).not.toHaveProperty('contexts');
  const first=(await app.inject(base+'/contexts')).json();expect(first.items).toHaveLength(50);expect((await app.inject(base+'/contexts?cursor='+encodeURIComponent(first.nextCursor))).json().items).toHaveLength(1);
  const result=await app.inject(base+`/runs/${run.id}/results?compact=true`);expect(result.statusCode,result.body).toBe(200);const body=result.json();expect(body.run).not.toHaveProperty('resultIds');expect(body.items[0]).not.toHaveProperty('factReads');expect(Buffer.byteLength(result.body)).toBeLessThanOrEqual(1048576);
  const large=body.items.find((row:{expression:unknown})=>typeof row.expression==='object').expression as LargeValueDescriptorDTO,parts:Buffer[]=[];
  for(let i=0;i<Math.ceil(large.byteLength/131072);i++){
   const part=await app.inject(base+`/values/${large.valueRef}/parts/${i}`);expect(part.statusCode).toBe(200);expect(part.rawPayload.length).toBeLessThanOrEqual(131072);expect(createHash('sha256').update(part.rawPayload).digest('hex')).toBe(part.headers['x-ce-part-sha256']);parts.push(part.rawPayload);
  }
  const bytes=Buffer.concat(parts);expect(createHash('sha256').update(bytes).digest('hex')).toBe(large.sha256);expect(JSON.parse(bytes.toString())).toBe(big);
  expect((await app.inject(`/api/v1/workspaces/${randomUUID()}/values/${large.valueRef}/parts/0`)).statusCode).not.toBe(200);
  const item=body.items[0],detail=await app.inject(base+`/runs/${run.id}/results/${item.id}/explanation/items?section=reads`);expect(detail.statusCode,detail.body).toBe(200);expect(detail.json().total).toBe(item.counts.reads);
 }finally{await app.close();}
});
