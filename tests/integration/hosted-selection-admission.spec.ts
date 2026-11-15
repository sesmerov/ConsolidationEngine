import { randomUUID } from 'node:crypto';
import { afterEach,beforeEach,expect,it } from 'vitest';
import { HostedSelectionAdmission } from '../../apps/api/src/hosted/selection-admission.js';
import { HostedJobAcceptance } from '../../apps/api/src/hosted/job-acceptance.js';
import { HostedOutbox } from '../../apps/api/src/hosted/outbox.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { createHostedHarness,type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';
let h:HostedHarness;
beforeEach(async()=>{h=await createHostedHarness();});afterEach(async()=>{await h?.close();});
function service(index=0){const db=h.databases[index]!,quotas=new QuotaLedger(db,h.config);return new HostedSelectionAdmission(new HostedJobAcceptance(db,quotas,new HostedOutbox(db,quotas,h.queue,{config:h.config,now:h.clock.now}),{config:h.config,now:h.clock.now}));}
async function fixture(){const f=await seedHostedWorkspace(h),run=await f.validation(),previewId=randomUUID(),selectionId=randomUUID(),hash='a'.repeat(64),now=h.clock.date();
 await h.databases[0].query("INSERT INTO previews(session_id,workspace_id,id,version_id,basis_id,source_run_id,manifest_refs,counters,content_hash,state,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,'{}','{}',$7,'ready',$8,$9)",[f.owner.sessionId,f.owner.workspaceId,previewId,f.snapshot.versionId,f.snapshot.validationBasisId,run.id,hash,now,new Date(+now+3600000)]);
 await h.databases[0].query("INSERT INTO proposal_selections(session_id,workspace_id,id,preview_id,version_id,basis_id,mask_ref,counters,selection_hash,state) VALUES($1,$2,$3,$4,$5,$6,'{}',$7,$8,'ready')",[f.owner.sessionId,f.owner.workspaceId,selectionId,previewId,f.snapshot.versionId,f.snapshot.validationBasisId,{availableCount:2,selectedCount:2,requiredCount:0,complete:true,closureHash:hash},hash]);
 return {...f,previewId,selectionId,hash,request:{...f.owner,key:randomUUID(),expectedBase:`"${f.owner.workspaceId}:1:${f.snapshot.versionId}"`},body:{baseVersionId:f.snapshot.versionId,previewId,selectionRef:{id:selectionId,revision:1},closureHash:hash}};
}
it('does not apply an incomplete closure and reserves one new basis without publication on acceptance',async()=>{const f=await fixture(),a=service();
 await expect(a.apply(f.request,{...f.body,closureHash:'b'.repeat(64)})).rejects.toMatchObject({code:'SELECTION_NOT_CLOSED'});
 const accepted=await a.apply(f.request,f.body),job=(await h.databases[0].query('SELECT input_refs FROM jobs WHERE id=$1',[accepted.jobId])).rows[0]!;
 expect(job.input_refs.command.newValidationBasisId).not.toBe(f.snapshot.validationBasisId);expect(job.input_refs.publication.runIds).toHaveLength(2);
 expect((await h.databases[0].query('SELECT count(*)::int n FROM workspace_versions')).rows[0].n).toBe(1);
 expect(await service(1).apply(f.request,f.body)).toEqual(accepted);
 await expect(service(1).edit({...f.request,key:randomUUID()},f.previewId,f.snapshot.versionId,{selectionId:f.selectionId,expectedRevision:1,operations:[{op:'clear'}]})).rejects.toMatchObject({code:'PROPOSAL_SELECTION_NOT_APPLICABLE'});
});
it('serializes selection edits, preserves the old revision until publication and rejects foreign references',async()=>{const f=await fixture(),a=service(),body={selectionId:f.selectionId,expectedRevision:1,operations:[{op:'clear' as const}]};
 const accepted=await a.edit(f.request,f.previewId,f.snapshot.versionId,body);expect(await a.summary(f.owner,f.previewId)).toMatchObject({revision:1,state:'updating',selectedCount:2});
 expect(await service(1).edit(f.request,f.previewId,f.snapshot.versionId,body)).toEqual(accepted);
 const other=await seedHostedWorkspace(h);await expect(a.summary(other.owner,f.previewId)).rejects.toMatchObject({code:'RESOURCE_NOT_FOUND'});
});
