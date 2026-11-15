import { randomUUID } from 'node:crypto';
import type { ApplicationRequestDTO,JsonObject,OperationReceiptDTO,ProposalSelectionEditDTO,ProposalSelectionSummaryDTO } from '@ce/contracts';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import type { HostedJobAcceptance } from './job-acceptance.js';
import type { DatabaseTransaction } from './database.js';
import { requireWorkspace,revisionNumber,type SelectionRow } from './postgres-repository.js';
import { assertLiveSession } from './session-service.js';
import type { DomainRequest } from './domain-admission.js';
import { ApiError } from '../errors.js';
export function publicSelection(row:SelectionRow):ProposalSelectionSummaryDTO{
 const c=row.counters;
 return {id:row.id,workspaceId:row.workspace_id,previewId:row.preview_id,baseVersionId:row.version_id,revision:revisionNumber(row.revision),state:row.state==='expired'?'obsolete':row.state,
  ...(row.initialization_job_id?{initializationJobId:row.initialization_job_id}:{}),...(row.pending_job_id?{pendingJobId:row.pending_job_id}:{}),
  availableCount:Number(c['availableCount']??0),selectedCount:Number(c['selectedCount']??0),requiredCount:Number(c['requiredCount']??0),complete:c['complete']===true,closureHash:String(c['closureHash']??row.selection_hash)};
}
export class HostedSelectionAdmission {
 constructor(readonly acceptance:HostedJobAcceptance){}
 private now(){return new Date((this.acceptance.options.now??Date.now)());}
 async read(tx:DatabaseTransaction,owner:WorkspaceOwner,previewId:string,lock=false){
   const preview=(await tx.query(`SELECT * FROM previews WHERE session_id=$1 AND workspace_id=$2 AND id=$3${lock?' FOR UPDATE':''}`,[owner.sessionId,owner.workspaceId,previewId])).rows[0];
   const selection=(await tx.query<SelectionRow>(`SELECT * FROM proposal_selections WHERE session_id=$1 AND workspace_id=$2 AND preview_id=$3${lock?' FOR UPDATE':''}`,[owner.sessionId,owner.workspaceId,previewId])).rows[0];
   if(!preview||!selection)throw new ApiError('RESOURCE_NOT_FOUND');return {preview,selection};
 }
 async summary(owner:WorkspaceOwner,previewId:string){return this.acceptance.database.transaction(async tx=>{await assertLiveSession(tx,owner.sessionId,this.now());await requireWorkspace(tx,owner);const {preview,selection}=await this.read(tx,owner,previewId);return publicSelection({...selection,...(preview.expires_at<=this.now()?{state:'expired' as const}:{})});});}
 private assertReady(preview:Record<string,unknown>,selection:SelectionRow,versionId:string,id:string,revision:number){
  if(selection.id!==id)throw new ApiError('RESOURCE_NOT_FOUND');if(Number(selection.revision)!==revision)throw new ApiError('STALE_PROPOSAL_SELECTION');
  if(selection.version_id!==versionId||preview['version_id']!==versionId)throw new ApiError('STALE_VERSION');
  if(selection.state!=='ready'||preview['state']!=='ready'||(preview['expires_at'] as Date)<=this.now())throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE');
 }
 async edit(request:DomainRequest,previewId:string,versionId:string,body:ProposalSelectionEditDTO):Promise<OperationReceiptDTO>{
  return this.acceptance.accept({...request,method:'POST',path:`/api/v1/workspaces/${request.workspaceId}/previews/${previewId}/selection-state/edits`,body:body as unknown as JsonObject,kind:'select-proposals',baseVersionId:versionId,expectedRevision:body.expectedRevision,inputRefs:{schemaVersion:1},meaningful:true},async(tx,identity)=>{
   const {preview,selection}=await this.read(tx,request,previewId,true);this.assertReady(preview,selection,versionId,body.selectionId,body.expectedRevision);
   await tx.query("UPDATE proposal_selections SET state='updating',pending_job_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3",[request.sessionId,request.workspaceId,selection.id,identity.jobId]);
   return {inputRefs:{schemaVersion:1,command:{versionId,previewId,selectionId:selection.id,expectedRevision:body.expectedRevision,operations:body.operations as unknown as import('@ce/contracts').JsonValue},publication:{resultId:selection.id,selectionId:selection.id}}};
  });
 }
 async apply(request:DomainRequest,body:ApplicationRequestDTO):Promise<OperationReceiptDTO>{
  if(!body.selectionRef)throw new ApiError('INVALID_REQUEST');const ref=body.selectionRef;
  return this.acceptance.accept({...request,method:'POST',path:`/api/v1/workspaces/${request.workspaceId}/applications`,body:body as unknown as JsonObject,kind:'apply',baseVersionId:body.baseVersionId,expectedRevision:ref.revision,inputRefs:{schemaVersion:1},meaningful:true},async(tx,identity)=>{
   const {preview,selection}=await this.read(tx,request,body.previewId,true);this.assertReady(preview,selection,body.baseVersionId,ref.id,ref.revision);
   if(selection.counters['complete']!==true||selection.counters['requiredCount']!==0||selection.counters['closureHash']!==body.closureHash)throw new ApiError('SELECTION_NOT_CLOSED');
   if(!Number(selection.counters['selectedCount']))throw new ApiError('INVALID_REQUEST');
   const applicationId=randomUUID(),newVersionId=randomUUID(),newValidationBasisId=randomUUID(),beforeRunId=randomUUID(),runId=randomUUID();
   await tx.query("UPDATE proposal_selections SET state='applying',pending_job_id=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3",[request.sessionId,request.workspaceId,selection.id,identity.jobId]);
   return {inputRefs:{schemaVersion:1,command:{versionId:body.baseVersionId,previewId:body.previewId,selectionId:selection.id,expectedRevision:ref.revision,closureHash:body.closureHash,applicationId,newVersionId,newValidationBasisId,beforeRunId,runId},publication:{resultId:applicationId,applicationId,versionId:newVersionId,basisId:newValidationBasisId,runIds:[beforeRunId,runId]}}};
  });
 }
}
