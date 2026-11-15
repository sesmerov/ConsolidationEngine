import { createHash,randomUUID } from 'node:crypto';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { downloadIntentKey,emptyQuerySchema,exportRequestSchema,importContextInputSchema,importInspectionCommitSchema,uuidSchema,workspaceParamsSchema } from '@ce/contracts';
import type { DownloadIntent,ImportContextInputDTO,ImportInspectionCommitDTO,JsonObject } from '@ce/contracts';
import type { HostedCommandDependencies } from '../hosted/worker-runtime.js';
import type { HostedJobAcceptance } from '../hosted/job-acceptance.js';
import type { HostedJobCoordinator } from '../hosted/job-coordinator.js';
import type { HostedWorkspaceService } from '../hosted/workspace-service.js';
import { HostedUploadBatches } from '../storage/upload-batches.js';
import { HostedExportArtifacts } from '../hosted/export-artifacts.js';
import { prepareImportCommit } from '../hosted/transfer-commands.js';
import { requireHostedSession } from '../plugins/hosted-session.js';
import { requireVersion,requireWorkspace,workspaceEtag } from '../hosted/postgres-repository.js';
import { assertLiveSession,touchMeaningful } from '../hosted/session-service.js';
import { registerUploadBatches } from './upload-batches.js';
import { registerExportTransfers } from './exports.js';
import { hostedDomainRequest,sendHostedAcceptance } from './hosted-domain.js';
import { ApiError } from '../errors.js';
/** The full ETag is checked by admission under lock; its version component only supplies the submitted base. */
export function submittedBase(etag:string):string|undefined {const match=/^"[a-f0-9-]{36}:[0-9]+:([a-f0-9-]{36}|empty)"$/.exec(etag);if(!match)throw new ApiError('PRECONDITION_REQUIRED');return match[1]==='empty'?undefined:match[1];}
export function registerHostedTransfers(app:FastifyInstance,domain:HostedCommandDependencies,services:{acceptance:HostedJobAcceptance;coordinator:HostedJobCoordinator;workspaces:HostedWorkspaceService}){
 const now=()=>new Date(domain.now()),uploads=new HostedUploadBatches(domain.db,domain.objects,domain.quotas,now),exports=new HostedExportArtifacts(domain.db,domain.objects,domain.quotas,now);
 const owner=(req:FastifyRequest,workspaceId:string)=>({sessionId:requireHostedSession(req).id,workspaceId});
 registerUploadBatches(app,{service:uploads,owner,seal:async(req,scope,batchId)=>{
   const request=hostedDomainRequest(req,scope.workspaceId),body=req.body as {baseVersionId:string|null};
   const receipt=await services.acceptance.accept({...request,method:'POST',path:req.url,body,inputRefs:{schemaVersion:1,uploadBatchId:batchId,publication:{resultId:batchId}},kind:'seal-upload',...(body.baseVersionId?{baseVersionId:body.baseVersionId}:{}),meaningful:true},(tx,identity)=>uploads.prepareSeal(tx,scope,batchId,identity.jobId));
   if(receipt.responseStatus===503)throw new ApiError('JOB_DISPATCH_UNCERTAIN',{jobId:receipt.jobId,operationId:receipt.operationId});
   return {status:202,job:await services.coordinator.get({...scope,jobId:receipt.jobId})};
 }});
 registerExportTransfers(app,exports,owner);
 const root='/api/v1/workspaces/:workspaceId',params={type:'object',additionalProperties:false,required:['workspaceId','inspectionId'],properties:{workspaceId:uuidSchema,inspectionId:uuidSchema}};
 app.post<{Params:{workspaceId:string};Body:{uploadBatchId:string;context:ImportContextInputDTO}}>(root+'/import-inspections',{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['uploadBatchId','context'],properties:{uploadBatchId:uuidSchema,context:importContextInputSchema}}}},async(req,reply)=>{
   const request=hostedDomainRequest(req,req.params.workspaceId),baseVersionId=submittedBase(request.expectedBase);
   const receipt=await services.acceptance.accept({...request,method:'POST',path:req.url,body:req.body as unknown as JsonObject,inputRefs:{schemaVersion:1},kind:'inspect-import',...(baseVersionId?{baseVersionId}:{}),meaningful:true},async tx=>{
     const batch=(await tx.query('SELECT state,base_version_id FROM upload_batches WHERE session_id=$1 AND workspace_id=$2 AND id=$3',[request.sessionId,request.workspaceId,req.body.uploadBatchId])).rows[0];
     if(!batch)throw new ApiError('RESOURCE_NOT_FOUND');if(!['sealed','retained'].includes(batch.state)||batch.base_version_id!==(baseVersionId??null))throw new ApiError('TRANSFER_INCOMPLETE');
     if((await tx.query("SELECT id FROM import_inspections WHERE session_id=$1 AND workspace_id=$2 AND state IN ('ready','committing') AND expires_at>$3",[request.sessionId,request.workspaceId,now()])).rowCount)throw new ApiError('IMPORT_INSPECTION_EXISTS');
     const inspectionId=randomUUID();return {inputRefs:{schemaVersion:1,uploadBatchId:req.body.uploadBatchId,context:req.body.context as unknown as JsonObject,publication:{resultId:inspectionId,inspectionId}}};
   });return sendHostedAcceptance(reply,request,receipt,services);
 });
 app.post<{Params:{workspaceId:string;inspectionId:string};Body:ImportInspectionCommitDTO}>(root+'/import-inspections/:inspectionId/commit',{schema:{params,querystring:emptyQuerySchema,body:importInspectionCommitSchema}},async(req,reply)=>{
   const request=hostedDomainRequest(req,req.params.workspaceId),baseVersionId=submittedBase(request.expectedBase);
   const receipt=await services.acceptance.accept({...request,method:'POST',path:req.url,body:req.body as unknown as JsonObject,inputRefs:{schemaVersion:1},kind:'import',...(baseVersionId?{baseVersionId}:{}),meaningful:true},async(tx,identity)=>{
     await prepareImportCommit(tx,request,req.params.inspectionId,req.body,identity.jobId,identity.now);const versionId=randomUUID(),basisId=randomUUID();
     return {inputRefs:{schemaVersion:1,inspectionId:req.params.inspectionId,...req.body,publication:{resultId:versionId,versionId,basisId}}};
   });return sendHostedAcceptance(reply,request,receipt,services);
 });
 const readInspection=async(scope:ReturnType<typeof owner>,id?:string)=>domain.db.transaction(async tx=>{
   await assertLiveSession(tx,scope.sessionId,now());await requireWorkspace(tx,scope);
   const row=(await tx.query(`SELECT * FROM import_inspections WHERE session_id=$1 AND workspace_id=$2 ${id?'AND id=$3':"AND state IN ('ready','committing')"} ORDER BY created_at DESC,id LIMIT 1`,[scope.sessionId,scope.workspaceId,...(id?[id]:[])])).rows[0];
   if(!row){if(id)throw new ApiError('RESOURCE_NOT_FOUND');return null;}
   return {...row.summary,state:row.state==='ready'&&row.expires_at<=now()?'expired':row.state,...(row.commit_job_id?{commitJobId:row.commit_job_id}:{}),...(row.committed_version_id?{committedVersionId:row.committed_version_id}:{})};
 });
 const compactQuery={type:'object',additionalProperties:false,properties:{compact:{const:'true'}}};
 app.get<{Params:{workspaceId:string}}>(root+'/import-inspections',{schema:{params:workspaceParamsSchema,querystring:compactQuery}},async req=>({active:await readInspection(owner(req,req.params.workspaceId))}));
 app.get<{Params:{workspaceId:string;inspectionId:string}}>(root+'/import-inspections/:inspectionId',{schema:{params,querystring:compactQuery}},req=>readInspection(owner(req,req.params.workspaceId),req.params.inspectionId));
 app.get<{Params:{workspaceId:string;inspectionId:string};Querystring:{section:'reports'|'context'|'diagnostics';limit?:string;cursor?:string}}>(root+'/import-inspections/:inspectionId/items',{schema:{params,querystring:{type:'object',additionalProperties:false,required:['section'],properties:{section:{enum:['reports','context','diagnostics']},limit:{type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$'},cursor:{type:'string',maxLength:8192}}}}},req=>domain.queries.page(owner(req,req.params.workspaceId),{type:'inspection',id:req.params.inspectionId,view:req.query.section},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{})},{inspectionId:req.params.inspectionId,section:req.query.section}));
 app.delete<{Params:{workspaceId:string;inspectionId:string}}>(root+'/import-inspections/:inspectionId',{schema:{params,querystring:compactQuery}},async(req,reply)=>{
   const scope=owner(req,req.params.workspaceId);await domain.db.transaction(async tx=>{await assertLiveSession(tx,scope.sessionId,now(),{lock:true});const workspace=await requireWorkspace(tx,scope,true);if(workspaceEtag(workspace)!==req.headers['if-match'])throw new ApiError('STALE_VERSION');
     const args=[scope.sessionId,scope.workspaceId,req.params.inspectionId];
     const prior=(await tx.query('SELECT state FROM import_inspections WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE',args)).rows[0];
     if(!prior||!['ready','discarded'].includes(prior.state))throw new ApiError('IMPORT_INSPECTION_NOT_APPLICABLE');
     if(prior.state==='ready'){await tx.query("UPDATE import_inspections SET state='discarded' WHERE session_id=$1 AND workspace_id=$2 AND id=$3",args);await touchMeaningful(tx,scope.sessionId,now());}});
   reply.header('ETag',(await services.workspaces.metadata(scope)).etag);return readInspection(scope,req.params.inspectionId);
 });
 app.post<{Params:{workspaceId:string};Body:Omit<DownloadIntent,'workspaceId'>}>(root+'/exports',{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema,body:exportRequestSchema}},async(req,reply)=>{
   const request=hostedDomainRequest(req,req.params.workspaceId),baseVersionId=submittedBase(request.expectedBase),intent={...req.body,workspaceId:request.workspaceId} as DownloadIntent;
   const receipt=await services.acceptance.accept({...request,method:'POST',path:req.url,body:req.body as unknown as JsonObject,inputRefs:{schemaVersion:1},kind:'export',...(baseVersionId?{baseVersionId}:{}),meaningful:true},async(tx,identity)=>{
     await requireVersion(tx,request,intent.versionId);const artifactId=randomUUID();await exports.reserve(tx,request,{artifactId,jobId:identity.jobId,intent});
     return {reservation:{kind:'export',intent,intentFingerprint:createHash('sha256').update(downloadIntentKey(intent)).digest('hex'),reservedExportId:artifactId},inputRefs:{schemaVersion:1,intent:intent as unknown as JsonObject,artifactId,publication:{resultId:artifactId,exportId:artifactId}}};
   });return sendHostedAcceptance(reply,request,receipt,services);
 });
 app.get<{Params:{workspaceId:string;artifactId:string}}>(root+'/exports/:artifactId',{schema:{params:{type:'object',additionalProperties:false,required:['workspaceId','artifactId'],properties:{workspaceId:uuidSchema,artifactId:uuidSchema}},querystring:emptyQuerySchema}},req=>exports.summary(owner(req,req.params.workspaceId),req.params.artifactId));
}
