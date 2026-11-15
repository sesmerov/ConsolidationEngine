import { randomUUID } from 'node:crypto';
import type { JsonValue, Snapshot } from '@ce/contracts';
import { compileDirectionConfiguration, WorkBudget } from '@ce/engine';
import { afterEach,beforeEach,describe,expect,it } from 'vitest';
import { HostedReviewMutations } from '../../apps/api/src/hosted/review-mutations.js';
import { prepareHostedReview } from '../../apps/api/src/hosted/review-commands.js';
import { restoreReviewChoices } from '../../apps/api/src/hosted/review-choices.js';
import { HostedJobAcceptance } from '../../apps/api/src/hosted/job-acceptance.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { HostedOutbox } from '../../apps/api/src/hosted/outbox.js';
import { HostedPublication } from '../../apps/api/src/hosted/publication.js';
import { constructHostedDomain } from '../../apps/api/src/hosted/worker-runtime.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { createHostedHarness,type HostedHarness } from '../helpers/hosted-harness.js';
import { seedHostedWorkspace } from '../helpers/hosted-seed.js';
import { collidingTargetsSnapshot,iteration005Snapshot,validate005 } from '../helpers/iteration005-fixtures.js';
import type { CanonicalRef } from '../../apps/api/src/hosted/canonical-codec.js';
import type { DirectionReviewProjection } from '@ce/engine';

describe('hosted indexed review mutations with real SQL',()=>{
  let h:HostedHarness;
  beforeEach(async()=>{h=await createHostedHarness({now:Date.now()});});afterEach(async()=>{await h?.close();});
  async function prepared(original:Snapshot){
    const seeded=await seedHostedWorkspace(h),db=h.databases[0],content={...original.content,configVersion:canonicalHash({directions:original.content.directions,directionDecisionState:original.content.directionDecisionState})};
    const snapshot={...original,versionId:seeded.snapshot.versionId,validationBasisId:seeded.snapshot.validationBasisId!,content,contentHash:canonicalHash(content)};
    const domain=constructHostedDomain({db,config:h.config,transport:h.objectTransport,now:h.clock.now});
    const acceptance=new HostedJobAcceptance(db,domain.quotas,new HostedOutbox(db,domain.quotas,h.queue,{config:h.config,now:h.clock.now}),{config:h.config,now:h.clock.now});
    const coordinator=new HostedJobCoordinator(db,{config:h.config,instanceId:'review-test',now:h.clock.now}),publication=new HostedPublication(db,domain.quotas,domain.objects,{now:h.clock.now});
    const bundle=validate005(snapshot),reviewId=randomUUID(),workspace=await domain.repository.workspace(seeded.owner);
    await db.query(`INSERT INTO validation_runs(session_id,workspace_id,id,version_id,basis_id,status,summary,result_index_ref,created_at,profile_id)
      VALUES($1,$2,$3,$4,$5,'completed',$6,'{}',$7,$8)`,[seeded.owner.sessionId,seeded.owner.workspaceId,bundle.run.id,snapshot.versionId,snapshot.validationBasisId,bundle.run.summary,h.clock.date(),snapshot.content.profileId]);
    const accepted=await acceptance.accept({...seeded.owner,key:randomUUID(),method:'POST',path:'/test/reviews',body:{},kind:'prepare-directions',expectedBase:workspace.etag,baseVersionId:snapshot.versionId,meaningful:false,
      inputRefs:{command:{versionId:snapshot.versionId,runId:bundle.run.id,validationBasisId:snapshot.validationBasisId,reviewId},publication:{resultId:reviewId,reviewId}}},async(tx,identity)=>{
        await tx.query(`INSERT INTO direction_reviews(session_id,workspace_id,id,basis_id,source_run_id,base_version_id,revision,state,preparation_job_id,expires_at,created_at)
          VALUES($1,$2,$3,$4,$5,$6,0,'preparing',$7,$8,$9)`,[seeded.owner.sessionId,seeded.owner.workspaceId,reviewId,snapshot.validationBasisId,bundle.run.id,snapshot.versionId,identity.jobId,new Date(h.clock.now()+900000),h.clock.date()]);
      });
    const outcome=await coordinator.claim({...seeded.owner,jobId:accepted.jobId});if(outcome.state!=='claimed')throw new Error('claim');
    const claim=outcome.claim,ref=await domain.codec.put(claim,bundle,{operationId:claim.jobId,jobId:claim.jobId,attemptId:claim.attemptId,fence:claim.fence,deadline:claim.deadlineAt});
    await db.query('UPDATE validation_runs SET result_index_ref=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3',[claim.sessionId,claim.workspaceId,bundle.run.id,{bundle:ref}]);
    const envelope=await prepareHostedReview({claim,schema:h.schema,cancellation:new SharedArrayBuffer(4)},()=>false,domain,snapshot,new WorkBudget());
    await publication.publish(claim,envelope);await coordinator.confirmTerminated(claim);
    const mutations=new HostedReviewMutations(db,domain.quotas,{now:h.clock.now});
    return {...seeded,snapshot,domain,reviewId,claim,mutations,envelope};
  }
  it('resolves a producer outside the first 50 and changes it; all omissions are global and receipts replay without mutation',async()=>{
    const p=await prepared(collidingTargetsSnapshot(51)),resource={type:'review' as const,id:p.reviewId,view:'groups'};
    const group=(await p.domain.queries.page(p.owner,resource,{})).items[0] as {groupId:string;activeCount:number};expect(group.activeCount).toBe(51);
    const first=await p.domain.queries.page(p.owner,{...resource,view:'candidates'},{filter:{groupId:group.groupId}});expect(first.items).toHaveLength(50);
    const last=await p.domain.queries.page(p.owner,{...resource,view:'candidates'},{filter:{groupId:group.groupId},cursor:first.nextCursor!});
    const winner=last.items[0] as {instanceId:string},other=first.items[0] as {instanceId:string};
    const body={expectedRevision:1,mutationId:randomUUID(),operations:[{op:'resolveGroup' as const,groupId:group.groupId,winnerInstanceId:winner.instanceId}]};
    const one=await p.mutations.patch(p.owner,p.reviewId,body);expect(one.summary.counts).toMatchObject({included:1,omitted:50,conflicted:0});
    expect((await p.domain.queries.page(p.owner,resource,{filter:{scope:'resolved'}})).items[0]).toMatchObject({state:'resolved',selectedCandidate:{instanceId:winner.instanceId}});
    await expect(p.domain.queries.page(p.owner,{...resource,view:'candidates'},{filter:{groupId:group.groupId},cursor:first.nextCursor!})).rejects.toMatchObject({code:'INVALID_CURSOR'});
    const switched=await p.mutations.patch(p.owner,p.reviewId,{expectedRevision:2,mutationId:randomUUID(),operations:[{op:'resolveGroup',groupId:group.groupId,winnerInstanceId:other.instanceId}]});
    expect(switched.summary.counts).toMatchObject({included:1,omitted:50});
    expect((await p.mutations.patch(p.owner,p.reviewId,body)).appliedRevision).toBe(2);
    const omitted=await p.mutations.patch(p.owner,p.reviewId,{expectedRevision:3,mutationId:randomUUID(),operations:[{op:'omitAll'}]});expect(omitted.summary.counts).toMatchObject({included:0,omitted:51});
    const ready=await p.domain.repository.review(p.owner,p.reviewId);expect(ready.revision).toBe(4);
    const original=await p.domain.codec.get(p.owner,p.envelope.review!.choicesRef!['projection'] as unknown as CanonicalRef) as unknown as DirectionReviewProjection;
    const restored=await restoreReviewChoices(p.domain,p.claim,original);expect(compileDirectionConfiguration(p.snapshot,restored,{requireResolved:true}).directions).toHaveLength(0);
    expect((await p.domain.queries.page(p.owner,resource,{})).items[0]).toMatchObject({state:'omitted',activeCount:0});
  });
  it('keeps cross-target assignments exclusive and rejects stale or overlapping edits atomically',async()=>{
    const original=iteration005Snapshot([{code:'A',expression:'{tT,r0010,c0010}={tT,r0020,c0010}'},{code:'B',expression:'{tT,r0010,c0010}=1'},{code:'C',expression:'{tT,r0020,c0010}=2'}],['0010','0020']);
    const p=await prepared(original),rows=(await p.domain.queries.page(p.owner,{type:'review',id:p.reviewId,view:'rows'},{})).items as {code:string;instanceId:string}[];
    const a=rows.find(row=>row.code==='A')!;
    await p.mutations.patch(p.owner,p.reviewId,{expectedRevision:1,mutationId:randomUUID(),operations:[{op:'set',instanceId:a.instanceId,choice:'left'}]});
    const g1=(await p.domain.queries.page(p.owner,{type:'review',id:p.reviewId,view:'groups'},{})).items[0] as {groupId:string};
    await p.mutations.patch(p.owner,p.reviewId,{expectedRevision:2,mutationId:randomUUID(),operations:[{op:'set',instanceId:a.instanceId,choice:'right'}]});
    const before=await p.domain.repository.review(p.owner,p.reviewId);
    await expect(p.mutations.patch(p.owner,p.reviewId,{expectedRevision:3,mutationId:randomUUID(),operations:[{op:'resolveGroup',groupId:g1.groupId,winnerInstanceId:a.instanceId}]})).rejects.toMatchObject({code:'GROUP_CANDIDATE_ASSIGNED_ELSEWHERE'});
    await expect(p.mutations.patch(p.owner,p.reviewId,{expectedRevision:2,mutationId:randomUUID(),operations:[{op:'omitAll'}]})).rejects.toMatchObject({code:'STALE_DIRECTION_REVIEW'});
    expect(await p.domain.repository.review(p.owner,p.reviewId)).toEqual(before);
  });
});
