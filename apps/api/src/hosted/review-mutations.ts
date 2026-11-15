import type { DirectionReviewMutationResponseDTO, DirectionReviewPatchDTO, JsonObject } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import { publicReview, requireWorkspace, workspaceEtag, type ReviewRow } from './postgres-repository.js';
import type { QuotaLedger } from './quota-ledger.js';
import { sideOf, tokenOf } from './review-choices.js';
import { assertLiveSession } from './session-service.js';

interface ChoiceRow { row_id:string;instance_id:string;classification:string;options:{side:'left'|'right';groupId:string;label:string}[];choice:string;saved_origin:string|null;selected_group:string|null;last_mutation:string|null }
/** All edits use compact indexed authority in one SQL transaction, never report hydration or provider I/O. */
export class HostedReviewMutations {
  constructor(readonly database: HostedDatabase, readonly quotas: QuotaLedger, readonly options: { now?:()=>number }={}) {}
  private now(){return new Date((this.options.now??Date.now)());}
  async patch(owner:WorkspaceOwner,reviewId:string,body:DirectionReviewPatchDTO,expectedBase?:string):Promise<DirectionReviewMutationResponseDTO>{
    return this.database.transaction(async tx=>{
      const now=this.now(),identity=[owner.sessionId,owner.workspaceId,reviewId],fingerprint=canonicalHash({reviewId,body});
      await assertLiveSession(tx,owner.sessionId,now,{lock:true});const workspace=await requireWorkspace(tx,owner,true);
      const review=(await tx.query<ReviewRow>('SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE',identity)).rows[0];
      if(!review)throw new ApiError('RESOURCE_NOT_FOUND');
      const prior=(await tx.query('SELECT * FROM direction_review_mutations WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND mutation_id=$4',[...identity,body.mutationId])).rows[0];
      if(prior){if(prior.request_fingerprint!==fingerprint)throw new ApiError('IDEMPOTENCY_CONFLICT');return {summary:publicReview(review),appliedRevision:Number(prior.applied_revision)};}
      if(expectedBase!==undefined&&expectedBase!==workspaceEtag(workspace))throw new ApiError('STALE_VERSION');
      if(review.expires_at<=now)throw new ApiError('DIRECTION_REVIEW_EXPIRED');
      if(review.state!=='ready'||review.base_version_id!==workspace.current_version_id)throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
      if(Number(review.revision)!==body.expectedRevision)throw new ApiError('STALE_DIRECTION_REVIEW');
      if((await tx.query("SELECT 1 FROM jobs WHERE session_id=$1 AND workspace_id=$2 AND status IN ('dispatch_pending','queued','running') LIMIT 1",identity.slice(0,2))).rowCount)throw new ApiError('WORKSPACE_BUSY');
      if(!body.operations.length||body.operations.length>200||body.operations.some(op=>op.op==='omitAll')&&body.operations.length!==1)throw new ApiError('INVALID_DIRECTION');
      const quota=await this.quotas.reserve(tx,{owner,operationId:body.mutationId,resource:'sql-bytes',units:32768+Number(review.counts.totalRows)*4096,purpose:'public',now});
      const touchedGroups=new Set<string>();
      const reserveGroup=(id:string)=>{if(touchedGroups.has(id))throw new ApiError('INVALID_DIRECTION');touchedGroups.add(id);};
      const write=async(row:ChoiceRow,choice:string)=>{
        if(row.last_mutation===body.mutationId)throw new ApiError('INVALID_DIRECTION');
        const group=row.options.find(option=>option.side===sideOf(choice))?.groupId;
        await tx.query(`UPDATE review_choice_rows SET choice=$5,current_token=$6,selected_group=$7,last_mutation=$4
          WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND row_id=$8`,[...identity,body.mutationId,choice,tokenOf(choice,row.saved_origin??undefined),group??null,row.row_id]);
      };
      for(const operation of body.operations){
        if(operation.op==='omitAll'){
          await tx.query(`UPDATE review_choice_rows SET choice=CASE classification WHEN 'none' THEN 'x' WHEN 'undetermined' THEN 'u' ELSE '-' END,
            current_token=CASE classification WHEN 'none' THEN 'x' WHEN 'undetermined' THEN 'u' ELSE '-' END,selected_group=NULL,last_mutation=$4 WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3`,[...identity,body.mutationId]);
          await tx.query('UPDATE review_choice_groups SET omitted=observed WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3',identity);continue;
        }
        if(operation.op==='set'){
          const row=(await tx.query<ChoiceRow&Record<string,unknown>>('SELECT * FROM review_choice_rows WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND instance_id=$4',[...identity,operation.instanceId])).rows[0];
          if(!row)throw new ApiError('RESOURCE_NOT_FOUND');if(!row.options.length)throw new ApiError('INVALID_DIRECTION');
          const choice=operation.choice==='omit'?'-':operation.choice==='suggest'?row.classification==='singleLeft'?'A':row.classification==='singleRight'?'B':'?':operation.choice==='left'?'L':'R';
          const target=row.options.find(option=>option.side===sideOf(choice));if(sideOf(choice)&&!target)throw new ApiError('INVALID_DIRECTION');
          if(row.selected_group)reserveGroup(row.selected_group);if(target&&target.groupId!==row.selected_group)reserveGroup(target.groupId);
          await write(row,choice);
          await tx.query('UPDATE review_choice_groups SET omitted=false WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND group_id=ANY($4::text[])',[...identity,[row.selected_group,target?.groupId].filter(Boolean)]);
          continue;
        }
        if(operation.op!=='resolveGroup')throw new ApiError('INVALID_DIRECTION');
        const group=(await tx.query('SELECT * FROM review_choice_groups WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND group_id=$4',[...identity,operation.groupId])).rows[0];
        if(!group?.observed)throw new ApiError('RESOURCE_NOT_FOUND');reserveGroup(operation.groupId);
        if((await tx.query('SELECT 1 FROM review_choice_rows WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND selected_group=$4 AND last_mutation=$5 LIMIT 1',[...identity,operation.groupId,body.mutationId])).rowCount)throw new ApiError('INVALID_DIRECTION');
        let winner:ChoiceRow|undefined,choice:string|undefined;
        if(operation.winnerInstanceId!==null){
          winner=(await tx.query<ChoiceRow&Record<string,unknown>>('SELECT * FROM review_choice_rows WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND instance_id=$4',[...identity,operation.winnerInstanceId])).rows[0];
          if(!winner)throw new ApiError('RESOURCE_NOT_FOUND');
          if(winner.selected_group&&winner.selected_group!==operation.groupId)throw new ApiError('GROUP_CANDIDATE_ASSIGNED_ELSEWHERE');
          const option=winner.options.find(option=>option.groupId===operation.groupId&&option.side===sideOf(winner!.choice))??winner.options.find(option=>option.groupId===operation.groupId&&option.side==='left')??winner.options.find(option=>option.groupId===operation.groupId);
          if(!option)throw new ApiError('INVALID_DIRECTION');choice=option.side==='left'?'L':'R';
          if(winner.last_mutation===body.mutationId)throw new ApiError('INVALID_DIRECTION');
        }
        await tx.query(`UPDATE review_choice_rows SET choice='-',current_token='-',selected_group=NULL,last_mutation=$5 WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND selected_group=$4 AND instance_id IS DISTINCT FROM $6`,[...identity,operation.groupId,body.mutationId,winner?.instance_id??null]);
        if(winner&&choice)await write(winner,choice);
        await tx.query('UPDATE review_choice_groups SET omitted=$5 WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND group_id=$4',[...identity,operation.groupId,winner===undefined]);
      }
      await this.refresh(tx,identity,Number(review.revision)+1);
      const updated=(await tx.query<ReviewRow>('SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND id=$3',identity)).rows[0]!,response={summary:publicReview(updated),appliedRevision:Number(updated.revision)};
      await tx.query('INSERT INTO direction_review_mutations(session_id,workspace_id,review_id,mutation_id,request_fingerprint,applied_revision,response,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[...identity,body.mutationId,fingerprint,response.appliedRevision,response,now]);
      await this.quotas.consume(tx,{reservationId:quota.id,now});return response;
    });
  }
  private async refresh(tx:DatabaseTransaction,identity:unknown[],revision:number){
    await tx.query(`UPDATE review_choice_groups g SET active_count=q.n,observed=g.observed OR q.n>1 FROM
      (SELECT g.group_id,count(r.row_id)::integer n FROM review_choice_groups g LEFT JOIN review_choice_rows r ON r.session_id=g.session_id AND r.workspace_id=g.workspace_id AND r.review_id=g.review_id AND r.selected_group=g.group_id
       WHERE g.session_id=$1 AND g.workspace_id=$2 AND g.review_id=$3 GROUP BY g.group_id) q
      WHERE g.session_id=$1 AND g.workspace_id=$2 AND g.review_id=$3 AND g.group_id=q.group_id`,identity);
    await tx.query(`UPDATE review_choice_rows r SET state=CASE WHEN choice='-' THEN 'omitted' WHEN choice='?' THEN 'pending' WHEN choice='x' THEN 'excluded' WHEN choice='u' THEN 'undetermined'
      WHEN (SELECT active_count FROM review_choice_groups g WHERE g.session_id=r.session_id AND g.workspace_id=r.workspace_id AND g.review_id=r.review_id AND g.group_id=r.selected_group)>1 THEN 'conflicted' ELSE 'included' END
      WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3`,identity);
    const counts=(await tx.query(`SELECT count(*)::integer AS "totalRows",count(*)FILTER(WHERE state='included')::integer included,count(*)FILTER(WHERE state='omitted')::integer omitted,
      count(*)FILTER(WHERE state='pending')::integer pending,count(*)FILTER(WHERE state='conflicted')::integer conflicted,count(*)FILTER(WHERE state='excluded')::integer excluded,count(*)FILTER(WHERE state='undetermined')::integer undetermined,
      count(*)FILTER(WHERE current_token<>baseline_token)::integer dirty FROM review_choice_rows WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3`,identity)).rows[0]!;
    const conflicts=Number((await tx.query('SELECT count(*)::integer n FROM review_choice_groups WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 AND active_count>1',identity)).rows[0]!.n),dirty=counts.dirty;delete counts.dirty;
    await tx.query(`UPDATE direction_reviews SET revision=$4,dirty_count=$5,config_changed=baseline_header_dirty OR $5>0,counts=$6,
      choices_ref=jsonb_set(choices_ref,'{views}',(SELECT jsonb_object_agg(key,jsonb_set(value,'{revision}',to_jsonb($4::bigint))) FROM jsonb_each(choices_ref->'views')))
      WHERE session_id=$1 AND workspace_id=$2 AND id=$3`,[...identity,revision,dirty,{...counts,conflictGroupCount:conflicts}]);
    await tx.query(`UPDATE projection_sets SET revision=$4 WHERE session_id=$1 AND workspace_id=$2 AND owner_ref->>'type'='review' AND owner_ref->>'id'=$3::text`,[...identity,revision]);
    await this.refreshRows(tx,identity,revision);
  }
  private async refreshRows(tx:DatabaseTransaction,identity:unknown[],revision:number){
    await tx.query(`UPDATE projection_rows p SET status=r.state,summary=p.summary||jsonb_build_object('groupId',CASE WHEN g.active_count>1 THEN r.selected_group ELSE NULL END),
      overlay=jsonb_build_object('unset',jsonb_build_array('selectedSide','origin','producerCount','groupId'),'set',jsonb_strip_nulls(jsonb_build_object('state',r.state,
        'selectedSide',CASE WHEN r.choice IN ('A','L','l') THEN 'left' WHEN r.choice IN ('B','R','r') THEN 'right' END,
        'origin',CASE WHEN r.choice IN ('A','B') THEN 'automatic' WHEN r.choice IN ('L','R') THEN 'manual' WHEN r.choice IN ('l','r') THEN 'saved' END,
        'producerCount',CASE WHEN r.selected_group IS NOT NULL THEN g.active_count END,'groupId',CASE WHEN g.active_count>1 THEN r.selected_group END)))
      FROM projection_sets s,review_choice_rows r LEFT JOIN review_choice_groups g ON g.session_id=r.session_id AND g.workspace_id=r.workspace_id AND g.review_id=r.review_id AND g.group_id=r.selected_group
      WHERE p.session_id=$1 AND p.workspace_id=$2 AND s.session_id=p.session_id AND s.workspace_id=p.workspace_id AND s.resource_kind=p.resource_kind AND s.resource_id=p.resource_id
        AND s.owner_ref->>'type'='review' AND (s.owner_ref->>'id')::uuid=$3 AND s.owner_ref->>'view'='rows' AND r.session_id=$1 AND r.workspace_id=$2 AND r.review_id=$3 AND r.row_id=p.row_key`,identity);
    await tx.query(`UPDATE projection_rows p SET status=CASE WHEN NOT g.observed THEN 'not-observed' WHEN g.active_count>1 THEN 'conflicted' WHEN g.active_count=1 THEN 'resolved' WHEN g.omitted THEN 'omitted' ELSE 'pending' END,
      overlay=jsonb_build_object('unset',jsonb_build_array('selectedCandidate'),'set',jsonb_strip_nulls(jsonb_build_object('state',CASE WHEN g.active_count>1 THEN 'conflicted' WHEN g.active_count=1 THEN 'resolved' WHEN g.omitted THEN 'omitted' ELSE 'pending' END,'activeCount',g.active_count,
      'selectedCandidate',CASE WHEN g.active_count=1 THEN (SELECT jsonb_build_object('instanceId',r.instance_id,'code',rp.rule_code,'targetSide',CASE WHEN r.choice IN ('A','L','l') THEN 'left' ELSE 'right' END)
        FROM review_choice_rows r JOIN projection_rows rp ON rp.session_id=r.session_id AND rp.workspace_id=r.workspace_id AND rp.row_key=r.row_id JOIN projection_sets rs ON rs.session_id=rp.session_id AND rs.workspace_id=rp.workspace_id AND rs.resource_kind=rp.resource_kind AND rs.resource_id=rp.resource_id
        WHERE r.session_id=$1 AND r.workspace_id=$2 AND r.review_id=$3 AND r.selected_group=g.group_id AND (rs.owner_ref->>'id')::uuid=$3 AND rs.owner_ref->>'view'='rows' LIMIT 1) END)))
      FROM projection_sets s,review_choice_groups g WHERE p.session_id=$1 AND p.workspace_id=$2 AND s.session_id=p.session_id AND s.workspace_id=p.workspace_id AND s.resource_kind=p.resource_kind AND s.resource_id=p.resource_id
        AND s.owner_ref->>'type'='review' AND (s.owner_ref->>'id')::uuid=$3 AND s.owner_ref->>'view'='groups' AND g.session_id=$1 AND g.workspace_id=$2 AND g.review_id=$3 AND g.group_id=p.row_key`,identity);
    await tx.query(`UPDATE projection_rows p SET overlay=jsonb_build_object('nested',CASE WHEN s.owner_ref->>'view'='candidateDetails' THEN 'candidate' ELSE NULL END,
      'unset',jsonb_build_array('assignedTargetLabel'),'set',jsonb_strip_nulls(jsonb_build_object('selected',coalesce(r.selected_group=p.summary->>'groupId',false),
      'availability',CASE WHEN r.selected_group IS NOT NULL AND r.selected_group<>p.summary->>'groupId' THEN 'assignedElsewhere' ELSE 'selectable' END,
      'assignedTargetLabel',CASE WHEN r.selected_group IS NOT NULL AND r.selected_group<>p.summary->>'groupId' THEN (SELECT value->>'label' FROM jsonb_array_elements(r.options) WHERE value->>'groupId'=r.selected_group LIMIT 1) END)), 'revision',$4::integer)
      FROM projection_sets s,review_choice_rows r WHERE p.session_id=$1 AND p.workspace_id=$2 AND s.session_id=p.session_id AND s.workspace_id=p.workspace_id AND s.resource_kind=p.resource_kind AND s.resource_id=p.resource_id
        AND s.owner_ref->>'type'='review' AND (s.owner_ref->>'id')::uuid=$3 AND s.owner_ref->>'view' IN ('candidates','candidateDetails') AND r.session_id=$1 AND r.workspace_id=$2 AND r.review_id=$3 AND r.instance_id=p.summary->>'instanceId'`,[...identity,revision]);
  }
}
