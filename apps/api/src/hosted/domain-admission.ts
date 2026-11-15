import { randomUUID } from 'node:crypto';
import type { JsonObject, OperationReceiptDTO, RecalculationOperationDTO, RecalculationReviewPrepareDTO, RecalculationStateDTO } from '@ce/contracts';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { HostedJobAcceptance } from './job-acceptance.js';
import type { DatabaseTransaction } from './database.js';
import { publicReview, requireVersion, requireWorkspace, type ReviewRow, type ValidationRow } from './postgres-repository.js';
import { assertLiveSession } from './session-service.js';
import { canonicalHash } from '../session/canonical-state.js';
import { ApiError } from '../errors.js';
export interface DomainRequest extends WorkspaceOwner { key:string; expectedBase:string }
/** Admission reads only compact SQL authority; hydration and calculation run in the isolated worker. */
export class HostedDomainAdmission {
  constructor(readonly acceptance:HostedJobAcceptance) {}
  private now(){return new Date((this.acceptance.options.now??Date.now)());}
  private request(request:DomainRequest,body:object,kind:'validate'|'prepare-directions'|'recalculation-operation',path:string,baseVersionId:string,meaningful:boolean){
    return {...request,method:'POST' as const,path:`/api/v1/workspaces/${request.workspaceId}/${path}`,body:body as JsonObject,kind,baseVersionId,inputRefs:{schemaVersion:1},meaningful};
  }
  private async compatible(tx:DatabaseTransaction,owner:WorkspaceOwner,body:RecalculationReviewPrepareDTO){
    const version=await requireVersion(tx,owner,body.baseVersionId);
    const run=(await tx.query<ValidationRow>('SELECT * FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND id=$3',[owner.sessionId,owner.workspaceId,body.runId])).rows[0];
    if(version.basis_id!==body.validationBasisId||!run||run.basis_id!==body.validationBasisId||run.status!=='completed'||!run.summary.complete)throw new ApiError('INCOMPATIBLE_VALIDATION_BASIS');
    return {version,run};
  }
  async validate(request:DomainRequest,body:{baseVersionId:string}):Promise<OperationReceiptDTO>{
    return this.acceptance.accept(this.request(request,body,'validate','validations',body.baseVersionId,true),async tx=>{
      await requireVersion(tx,request,body.baseVersionId);const runId=randomUUID();
      return {inputRefs:{schemaVersion:1,command:{versionId:body.baseVersionId,runId},publication:{resultId:runId,runIds:[runId]}}};
    });
  }
  async prepare(request:DomainRequest,body:RecalculationReviewPrepareDTO):Promise<OperationReceiptDTO>{
    return this.acceptance.accept(this.request(request,body,'prepare-directions','recalculation-reviews',body.baseVersionId,false),async(tx,identity)=>{
      const {version}=await this.compatible(tx,request,body),reviewId=randomUUID();
      await tx.query(`INSERT INTO direction_reviews(session_id,workspace_id,id,basis_id,source_run_id,base_version_id,revision,state,base_config_version,preparation_job_id,expires_at,created_at)
        VALUES($1,$2,$3,$4,$5,$6,0,'preparing',$7,$8,$9,$10)`,[request.sessionId,request.workspaceId,reviewId,body.validationBasisId,body.runId,body.baseVersionId,version.config_version,identity.jobId,new Date(identity.now.getTime()+15*60000),identity.now]);
      return {inputRefs:{schemaVersion:1,command:{versionId:body.baseVersionId,validationBasisId:body.validationBasisId,runId:body.runId,reviewId},publication:{resultId:reviewId,reviewId}}};
    },async tx=>{
      await this.compatible(tx,request,body);
      const reusable=(await tx.query<ReviewRow>(`SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND basis_id=$3 AND base_version_id=$4
        AND state IN ('preparing','ready') AND expires_at>$5 ORDER BY created_at DESC,id LIMIT 1`,[request.sessionId,request.workspaceId,body.validationBasisId,body.baseVersionId,this.now()])).rows[0];
      return reusable?.preparation_job_id??undefined;
    });
  }
  async recalculate(request:DomainRequest,body:RecalculationOperationDTO):Promise<OperationReceiptDTO>{
    return this.acceptance.accept({...this.request(request,body,'recalculation-operation','recalculation-operations',body.baseVersionId,true),expectedRevision:body.expectedRevision},async(tx,identity)=>{
      await this.compatible(tx,request,body);
      const review=(await tx.query<ReviewRow>('SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE',[request.sessionId,request.workspaceId,body.reviewId])).rows[0];
      if(!review)throw new ApiError('RESOURCE_NOT_FOUND');
      if(review.expires_at<=identity.now)throw new ApiError('DIRECTION_REVIEW_EXPIRED');
      if(Number(review.revision)!==body.expectedRevision||review.basis_id!==body.validationBasisId||review.base_version_id!==body.baseVersionId||review.source_run_id!==body.runId)throw new ApiError('STALE_DIRECTION_REVIEW');
      if(review.state!=='ready'||!('totalRows' in review.counts)||review.counts.pending||review.counts.conflicted||review.counts.undetermined||review.counts.conflictGroupCount)throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
      const effectiveVersionId=review.config_changed?randomUUID():body.baseVersionId,previewId=randomUUID(),selectionId=randomUUID();
      await tx.query(`INSERT INTO recalculation_operations(session_id,workspace_id,id,request_fingerprint,input_version_id,basis_id,run_id,review_id,review_revision,reserved_effective_version_id,config_changed,reserved_preview_id,reserved_selection_id,job_id,phase,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$3,'dispatch_pending',$14)`,[request.sessionId,request.workspaceId,identity.jobId,canonicalHash(body),body.baseVersionId,body.validationBasisId,body.runId,body.reviewId,body.expectedRevision,effectiveVersionId,review.config_changed,previewId,selectionId,identity.now]);
      await tx.query("UPDATE direction_reviews SET state='committing',pending_job_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3",[request.sessionId,request.workspaceId,body.reviewId,identity.jobId]);
      return {reservation:{kind:'recalculation',inputVersionId:body.baseVersionId,effectiveVersionId,reservedPreviewId:previewId},inputRefs:{schemaVersion:1,
        command:{versionId:body.baseVersionId,validationBasisId:body.validationBasisId,runId:body.runId,reviewId:body.reviewId,reviewRevision:body.expectedRevision,effectiveVersionId,previewId,selectionId,configChanged:review.config_changed},
        publication:{resultId:previewId,previewId,selectionId,reviewId:body.reviewId,...(review.config_changed?{versionId:effectiveVersionId}:{})}}};
    });
  }
  async state(owner:WorkspaceOwner):Promise<RecalculationStateDTO>{
    return this.acceptance.database.transaction(async tx=>{
      await assertLiveSession(tx,owner.sessionId,this.now());const workspace=await requireWorkspace(tx,owner);
      if(!workspace.current_version_id)throw new ApiError('RESOURCE_NOT_FOUND');
      const version=await requireVersion(tx,owner,workspace.current_version_id);
      const review=(await tx.query<ReviewRow>(`SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND basis_id=$3
        AND ((base_version_id=$4 AND state IN ('preparing','ready','committing') AND expires_at>$5)
          OR (state='committed' AND receipt->>'newVersionId'=$4::text AND receipt->>'configVersion'=$6))
        ORDER BY (state='committed') ASC,created_at DESC,id LIMIT 1`,[owner.sessionId,owner.workspaceId,version.basis_id,version.id,this.now(),version.config_version])).rows[0];
      const run=(await tx.query<ValidationRow>(`SELECT * FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND basis_id=$3 AND status='completed' AND summary->>'complete'='true'
        ${review?'AND id=$4':''} ORDER BY created_at DESC,id LIMIT 1`,[owner.sessionId,owner.workspaceId,version.basis_id,...(review?[review.source_run_id]:[])])).rows[0];
      const summary=review?publicReview(review):undefined,counts=summary?.counts??null;
      return {workspaceId:owner.workspaceId,currentVersionId:version.id,validationBasisId:version.basis_id,configuration:{configVersion:version.config_version??'',directionCount:Number(version.summary['directionCount']??0)},
        ...(run?{compatibleRun:{id:run.id,versionId:run.version_id,validationBasisId:run.basis_id,...(run.completed_at?{endedAt:run.completed_at.toISOString()}:{})}}:{}),...(summary?{review:summary}:{}),counts,
        state:!run?'needs_validation':!counts?'preparation_required':counts.pending||counts.conflicted||counts.undetermined?'pending':counts.included||counts.omitted?'ready':'no_candidates'};
    });
  }
}
