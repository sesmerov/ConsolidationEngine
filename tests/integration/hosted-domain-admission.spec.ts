import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HostedDomainAdmission } from '../../apps/api/src/hosted/domain-admission.js';
import { HostedJobAcceptance } from '../../apps/api/src/hosted/job-acceptance.js';
import { HostedOutbox } from '../../apps/api/src/hosted/outbox.js';
import { QuotaLedger } from '../../apps/api/src/hosted/quota-ledger.js';
import { PostgresRepository } from '../../apps/api/src/hosted/postgres-repository.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';
describe('domain admission uses the locked current basis and recoverable identities',()=>{
 let h:HostedHarness;
 beforeEach(async()=>{h=await createHostedHarness();}); afterEach(async()=>{await h?.close();});
 function service(index=0){const db=h.databases[index]!,quotas=new QuotaLedger(db,h.config);return new HostedDomainAdmission(new HostedJobAcceptance(db,quotas,new HostedOutbox(db,quotas,h.queue,{config:h.config,now:h.clock.now}),{config:h.config,now:h.clock.now}));}
 async function fixture(){const seed=await seedHostedWorkspace(h),run=await seed.validation(),expectedBase=(await new PostgresRepository(h.databases[0],{now:h.clock.now}).workspace(seed.owner)).etag;return {...seed,run,request:{...seed.owner,key:randomUUID(),expectedBase},body:{baseVersionId:seed.snapshot.versionId,validationBasisId:seed.snapshot.validationBasisId!,runId:run.id}};}
 it('ten automatic entries reuse one preparation and do not create versions or renew activity',async()=>{
  const f=await fixture(),a=service(),b=service(1),before=(await h.databases[0].query('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1',[f.owner.sessionId])).rows[0];
  const first=await a.prepare(f.request,f.body);h.clock.advance(20000);
  for(let i=0;i<10;i++)expect((await b.prepare({...f.request,key:randomUUID()},f.body)).jobId).toBe(first.jobId);
  expect((await h.databases[0].query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(1);
  expect((await h.databases[0].query('SELECT count(*)::int n FROM workspace_versions')).rows[0].n).toBe(1);
  expect((await h.databases[0].query('SELECT last_meaningful_activity_at FROM demo_sessions WHERE id=$1',[f.owner.sessionId])).rows[0]).toEqual(before);
  expect(await b.state(f.owner)).toMatchObject({state:'preparation_required',counts:null,review:{state:'preparing',jobId:first.jobId}});
 });
 it('reserves configuration and preview atomically, rejects pending and recovers before stale review',async()=>{
  const f=await fixture(),a=service(),prepared=await a.prepare(f.request,f.body),review=(await h.databases[0].query('SELECT id FROM direction_reviews WHERE preparation_job_id=$1',[prepared.jobId])).rows[0].id;
  const body={...f.body,reviewId:review,expectedRevision:1},request={...f.request,key:randomUUID()};
  await h.databases[0].query("UPDATE direction_reviews SET state='ready',revision=1,counts=$1,config_changed=true WHERE id=$2",[{totalRows:1,included:0,omitted:0,pending:1,conflicted:0,undetermined:0,notConfigurable:0,conflictGroupCount:0},review]);
  await expect(a.recalculate(request,body)).rejects.toMatchObject({code:'DIRECTION_REVIEW_NOT_APPLICABLE'});
  await h.databases[0].query("UPDATE direction_reviews SET counts=$1 WHERE id=$2",[{totalRows:1,included:1,omitted:0,pending:0,conflicted:0,undetermined:0,notConfigurable:0,conflictGroupCount:0},review]);
  const accepted=await a.recalculate(request,body);expect(accepted.reservation).toMatchObject({kind:'recalculation',inputVersionId:f.snapshot.versionId});expect(accepted.reservation.effectiveVersionId).not.toBe(f.snapshot.versionId);
  expect((await h.databases[0].query('SELECT count(*)::int n FROM workspace_versions')).rows[0].n).toBe(1);
  await h.databases[0].query('UPDATE workspaces SET revision=revision+1 WHERE id=$1',[f.owner.workspaceId]);
  expect(await service(1).recalculate(request,body)).toEqual(accepted);
  expect((await h.databases[0].query('SELECT count(*)::int n FROM recalculation_operations')).rows[0].n).toBe(1);
 });
 it('requires a completed owner validation with the exact current basis, and keeps GET read-only',async()=>{
  const f=await fixture(),other=await seedHostedWorkspace(h),a=service();
  await expect(a.prepare(f.request,{...f.body,validationBasisId:other.snapshot.validationBasisId!})).rejects.toMatchObject({code:'INCOMPATIBLE_VALIDATION_BASIS'});
  await h.databases[0].query("UPDATE validation_runs SET summary=jsonb_set(summary,'{complete}','false') WHERE id=$1",[f.run.id]);
  expect(await a.state(f.owner)).toMatchObject({state:'needs_validation',counts:null});
  await expect(a.prepare(f.request,f.body)).rejects.toMatchObject({code:'INCOMPATIBLE_VALIDATION_BASIS'});
  expect((await h.databases[0].query('SELECT count(*)::int n FROM jobs')).rows[0].n).toBe(0);
 });
});
