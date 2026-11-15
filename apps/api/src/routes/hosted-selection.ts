import type { FastifyInstance,FastifyRequest } from 'fastify';
import { applicationRequestSchema,emptyQuerySchema,proposalSelectionEditSchema,uuidSchema,workspaceParamsSchema } from '@ce/contracts';
import type { ApplicationRequestDTO,JsonObject,ProposalSelectionEditDTO } from '@ce/contracts';
import type { HostedCommandDependencies } from '../hosted/worker-runtime.js';
import type { HostedJobAcceptance } from '../hosted/job-acceptance.js';
import type { HostedJobCoordinator } from '../hosted/job-coordinator.js';
import type { HostedWorkspaceService } from '../hosted/workspace-service.js';
import { HostedSelectionAdmission,publicSelection } from '../hosted/selection-admission.js';
import { requireWorkspace,workspaceEtag } from '../hosted/postgres-repository.js';
import { assertLiveSession,touchMeaningful } from '../hosted/session-service.js';
import { requireHostedSession } from '../plugins/hosted-session.js';
import { hostedDomainRequest,sendHostedAcceptance } from './hosted-domain.js';
import { submittedBase } from './hosted-transfers.js';
import { ApiError } from '../errors.js';
type Params={workspaceId:string;previewId:string;proposalId?:string};
type Query={limit?:string;cursor?:string;scope?:'all'|'selected'|'missing';code?:string;table?:string;contextId?:string;status?:string;section?:string};
const params={type:'object',additionalProperties:false,required:['workspaceId','previewId'],properties:{workspaceId:uuidSchema,previewId:uuidSchema}};
const proposalParams={...params,required:[...params.required,'proposalId'],properties:{...params.properties,proposalId:uuidSchema}};
const paging={limit:{type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$'},cursor:{type:'string',maxLength:8192},compact:{const:'true'}};
const compactQuery={type:'object',additionalProperties:false,properties:{compact:{const:'true'}}};
const rowsQuery={type:'object',additionalProperties:false,properties:{...paging,scope:{enum:['all','selected','missing']},code:{type:'string',maxLength:128},table:{type:'string',maxLength:128},contextId:{type:'string',maxLength:64},status:{enum:['available','blocked','accepted','applied','discarded','obsolete']}}};
export function registerHostedSelection(app:FastifyInstance,d:HostedCommandDependencies,services:{acceptance:HostedJobAcceptance;coordinator:HostedJobCoordinator;workspaces:HostedWorkspaceService}){
 const admission=new HostedSelectionAdmission(services.acceptance),root='/api/v1/workspaces/:workspaceId/previews/:previewId',now=()=>new Date(d.now());
 const owner=(req:FastifyRequest,w:string)=>({sessionId:requireHostedSession(req).id,workspaceId:w});
 const context=(req:FastifyRequest,p:Params)=>d.db.transaction(async tx=>{const scope=owner(req,p.workspaceId);await assertLiveSession(tx,scope.sessionId,now());await requireWorkspace(tx,scope);return admission.read(tx,scope,p.previewId);});
 app.get<{Params:Params}>(root,{schema:{params,querystring:compactQuery}},async req=>{const {preview}=await context(req,req.params);return {...preview.counters,state:preview.state};});
 app.get<{Params:Params}>(root+'/selection-state',{schema:{params,querystring:emptyQuerySchema}},req=>admission.summary(owner(req,req.params.workspaceId),req.params.previewId));
 app.post<{Params:Params;Body:ProposalSelectionEditDTO}>(root+'/selection-state/edits',{schema:{params,querystring:emptyQuerySchema,body:proposalSelectionEditSchema}},async(req,reply)=>{
   const request=hostedDomainRequest(req,req.params.workspaceId),version=submittedBase(request.expectedBase);if(!version)throw new ApiError('STALE_VERSION');return sendHostedAcceptance(reply,request,await admission.edit(request,req.params.previewId,version,req.body),services);
 });
 app.post<{Params:{workspaceId:string};Body:ApplicationRequestDTO}>('/api/v1/workspaces/:workspaceId/applications',{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema,body:applicationRequestSchema.oneOf[1]}},async(req,reply)=>{const request=hostedDomainRequest(req,req.params.workspaceId);return sendHostedAcceptance(reply,request,await admission.apply(request,req.body),services);});
 app.get<{Params:Params;Querystring:Query}>(root+'/selection-state/rows',{schema:{params,querystring:rowsQuery}},async req=>{
   const scope=owner(req,req.params.workspaceId),{selection}=await context(req,req.params),summary=publicSelection(selection),query=req.query;
   const filter={...(query.scope?{scope:query.scope}:{}),...(query.code?{code:query.code}:{}),...(query.table?{table:query.table}:{}),...(query.contextId?{contextId:query.contextId}:{}),...(query.status?{status:query.status}:{})};
   const pageMetadata:JsonObject[]=[];
   const result=await d.queries.page(scope,{type:'selection',id:selection.id,view:'rows'},{limit:Number(query.limit??50),...(query.cursor?{cursor:query.cursor}:{}),filter,byteBudget:960*1024},{selectionId:selection.id,previewId:selection.preview_id,revision:Number(selection.revision),state:summary.state,scope:query.scope??'all',summary:summary as unknown as JsonObject},row=>pageMetadata.push(row.summary));
   const counts=await d.db.transaction(async tx=>{await assertLiveSession(tx,scope.sessionId,now(),{lock:true});await requireWorkspace(tx,scope,true);const current=await admission.read(tx,scope,selection.preview_id);
     if(current.selection.revision!==selection.revision||result.revision!==Number(selection.revision))throw new ApiError('STALE_PROPOSAL_SELECTION');
     const ref=(selection.mask_ref['views'] as JsonObject)['rows'] as JsonObject,args:unknown[]=[scope.sessionId,scope.workspaceId,ref['kind'],ref['indexId']];let clause='session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4';
     const where=(sql:string,value:string)=>{args.push(value);clause+=' AND '+sql.replace('?',`$${args.length}`);};
     if(query.code)where('strpos(lower(rule_code),lower(?))>0',query.code);if(query.status)where('status=?',query.status);if(query.table)where("summary->>'table'=?",query.table);if(query.contextId)where("summary->>'contextId'=?",query.contextId);
     return (await tx.query(`SELECT count(*)::int matched,count(*) FILTER(WHERE status='available')::int available,count(*) FILTER(WHERE summary->>'selected'='true')::int selected FROM projection_rows WHERE ${clause}`,args)).rows[0]!;
   });
   const selectedPage=pageMetadata.filter(row=>row['selected']===true).length;
   const sourceIds=[...new Set(pageMetadata.flatMap(row=>typeof row['originFileId']==='string'?[row['originFileId']]:[]))];
   const sources=await Promise.all(sourceIds.map(id=>d.queries.item(scope,{type:'version',id:selection.version_id,view:'sources'},id)));
   return {...result,filterCounts:{matched:counts['matched'],available:summary.state==='ready'?counts['available']:0,selected:counts['selected'],selectedOutsideFilter:(summary.selectedCount??0)-Number(counts['selected']),selectedOutsidePage:(summary.selectedCount??0)-selectedPage},sourceFiles:sources};
 });
 app.get<{Params:Params;Querystring:Query}>(root+'/selection-state/proposals/:proposalId/dependencies',{schema:{params:proposalParams,querystring:{type:'object',additionalProperties:false,properties:{...paging,scope:{enum:['all','missing']}}}}},async req=>{
   const scope=owner(req,req.params.workspaceId),{selection}=await context(req,req.params),summary=publicSelection(selection),proposalId=req.params.proposalId!;
   const row=await d.queries.metadata(scope,{type:'selection',id:selection.id,view:'rows'},proposalId);
   return d.queries.page(scope,{type:'selection',id:selection.id,view:'dependencies'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:{resultId:proposalId,...(req.query.scope==='missing'?{scope:'missing' as const}:{})}},{selectionId:selection.id,previewId:selection.preview_id,state:summary.state,proposalId,scope:req.query.scope??'all',predecessorCount:row['predecessorCount']!,requiredPredecessorCount:row['requiredPredecessorCount']!});
 });
 app.get<{Params:Params}>(root+'/selection-state/proposals/:proposalId/explanation',{schema:{params:proposalParams,querystring:compactQuery}},async req=>{const scope=owner(req,req.params.workspaceId),{selection}=await context(req,req.params),value=await d.queries.item(scope,{type:'selection',id:selection.id,view:'explanations'},req.params.proposalId!);if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError('INTERNAL_ERROR');return {...value,state:publicSelection(selection).state};});
 app.get<{Params:Params;Querystring:Query}>(root+'/selection-state/proposals/:proposalId/explanation/items',{schema:{params:proposalParams,querystring:{type:'object',additionalProperties:false,required:['section'],properties:{...paging,section:{enum:['operands','origins','diagnostics','descriptions']}}}}},async req=>{const scope=owner(req,req.params.workspaceId),{selection}=await context(req,req.params);return d.queries.page(scope,{type:'selection',id:selection.id,view:'items'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:{resultId:req.params.proposalId!,section:req.query.section!}},{selectionId:selection.id,previewId:selection.preview_id,baseVersionId:selection.version_id,state:publicSelection(selection).state,proposalId:req.params.proposalId!,section:req.query.section!});});
 app.delete<{Params:Params}>(root,{schema:{params,querystring:compactQuery}},async(req,reply)=>{
   const scope=owner(req,req.params.workspaceId);const value=await d.db.transaction(async tx=>{await assertLiveSession(tx,scope.sessionId,now(),{lock:true});const workspace=await requireWorkspace(tx,scope,true);if(workspaceEtag(workspace)!==req.headers['if-match'])throw new ApiError('STALE_VERSION');const {preview,selection}=await admission.read(tx,scope,req.params.previewId,true);
     if(!['ready','discarded'].includes(preview.state)||selection.pending_job_id)throw new ApiError('PREVIEW_NOT_APPLICABLE');await tx.query("UPDATE previews SET state='discarded' WHERE session_id=$1 AND workspace_id=$2 AND id=$3",[scope.sessionId,scope.workspaceId,preview.id]);await tx.query("UPDATE proposal_selections SET state='discarded' WHERE session_id=$1 AND workspace_id=$2 AND id=$3",[scope.sessionId,scope.workspaceId,selection.id]);if(preview.state==='ready')await touchMeaningful(tx,scope.sessionId,now());return {...preview.counters,state:'discarded'};});reply.header('ETag',(await services.workspaces.metadata(scope)).etag);return value;
 });
}
