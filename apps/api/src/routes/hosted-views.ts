import { createHash } from 'node:crypto';
import type { FastifyInstance,FastifyRequest } from 'fastify';
import { compactContextsQuerySchema,compactResultsQuerySchema,compactRulesQuerySchema,downloadIntentKey,emptyQuerySchema,resultExplanationItemsQuerySchema,uuidSchema,workspaceParamsSchema } from '@ce/contracts';
import type { DownloadIntent,JsonObject } from '@ce/contracts';
import type { HostedCommandDependencies } from '../hosted/worker-runtime.js';
import { publicValidation,requireVersion,requireWorkspace,type ValidationRow } from '../hosted/postgres-repository.js';
import type { ProjectionFilter } from '../hosted/query-repository.js';
import type { ProjectionResource } from '../hosted/projection-store.js';
import { assertLiveSession } from '../hosted/session-service.js';
import { requireHostedSession } from '../plugins/hosted-session.js';
import { createHostedCursorCodec } from './pagination.js';
import { canonicalHash } from '../session/canonical-state.js';
import { ApiError } from '../errors.js';
type Params=Record<string,string>;
type Query={limit?:string;cursor?:string;compact?:string;code?:string;table?:string;status?:string;contextId?:string;scope?:ProjectionFilter['scope'];section?:string;versionId?:string;kind?:string;runId?:string};
const paging={limit:{type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$'},cursor:{type:'string',maxLength:8192}};
const params=(...keys:string[])=>({type:'object',additionalProperties:false,required:['workspaceId',...keys],properties:{workspaceId:uuidSchema,...Object.fromEntries(keys.map(key=>[key,key.endsWith('Id')&&key!=='resultId'&&key!=='instanceId'&&key!=='groupId'?uuidSchema:{type:'string',minLength:1,maxLength:500}]))}});
export function registerHostedViews(app:FastifyInstance,d:HostedCommandDependencies){
 const root='/api/v1/workspaces/:workspaceId',owner=(req:FastifyRequest,workspaceId:string)=>({sessionId:requireHostedSession(req).id,workspaceId}),now=()=>new Date(d.now());
 const authorize=async<T>(req:FastifyRequest,workspaceId:string,fn:(tx:import('../hosted/database.js').DatabaseTransaction)=>Promise<T>)=>d.db.transaction(async tx=>{const scope=owner(req,workspaceId);await assertLiveSession(tx,scope.sessionId,now(),{lock:true});await requireWorkspace(tx,scope,true);return fn(tx);});
 app.get<{Params:Params;Querystring:Query}>(root+'/contexts',{schema:{params:workspaceParamsSchema,querystring:compactContextsQuerySchema}},async req=>{
   const scope=owner(req,req.params['workspaceId']!),workspace=await d.repository.workspace(scope);if(!workspace.currentVersionId)throw new ApiError('RESOURCE_NOT_FOUND');
   return d.queries.page(scope,{type:'version',id:workspace.currentVersionId,view:'contexts'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:req.query.contextId?{contextId:req.query.contextId}:{}});
 });
 app.get<{Params:Params;Querystring:Query}>(root+'/runs/:runId/results',{schema:{params:params('runId'),querystring:compactResultsQuerySchema}},async req=>{
   const scope=owner(req,req.params['workspaceId']!),runId=req.params['runId']!,run=await d.repository.validation(scope,runId);
   return d.queries.page(scope,{type:'run',id:runId,view:'rows'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:{...(req.query.code?{code:req.query.code}:{}),...(req.query.status?{status:req.query.status}:{}),...(req.query.table?{table:req.query.table}:{})}},{run:run as unknown as JsonObject});
 });
 app.get<{Params:Params;Querystring:Query}>(root+'/runs/:runId/diagnostics',{schema:{params:params('runId'),querystring:{type:'object',additionalProperties:false,properties:paging}}},req=>d.queries.page(owner(req,req.params['workspaceId']!),{type:'run',id:req.params['runId']!,view:'diagnostics'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{})},{runId:req.params['runId']!}));
 app.get<{Params:Params}>(root+'/runs/:runId/results/:resultId/explanation',{schema:{params:params('runId','resultId'),querystring:emptyQuerySchema}},async req=>{
   const workspaceId=req.params['workspaceId']!,value=await d.queries.item(owner(req,workspaceId),{type:'run',id:req.params['runId']!,view:'rows'},req.params['resultId']!);
   if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError('RESOURCE_NOT_FOUND');return {...value,workspaceId};
 });
 app.get<{Params:Params;Querystring:Query}>(root+'/runs/:runId/results/:resultId/explanation/items',{schema:{params:params('runId','resultId'),querystring:resultExplanationItemsQuerySchema}},req=>d.queries.page(owner(req,req.params['workspaceId']!),{type:'run',id:req.params['runId']!,view:'items'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:{resultId:req.params['resultId']!,section:req.query.section!}},{runId:req.params['runId']!,resultId:req.params['resultId']!,section:req.query.section!}));
 app.get<{Params:Params}>(root+'/values/:valueRef/parts/:index',{schema:{params:{...params('valueRef','index'),properties:{...params('valueRef','index').properties,index:{type:'string',pattern:'^(?:0|[1-9][0-9]{0,7})$'}}},querystring:emptyQuerySchema}},async(req,reply)=>{
   const part=await d.queries.valuePart(owner(req,req.params['workspaceId']!),req.params['valueRef']!,Number(req.params['index']));return reply.type('application/octet-stream').header('Content-Length',part.bytes.length).header('X-CE-Part-SHA256',part.sha256).send(Buffer.from(part.bytes));
 });
 app.get<{Params:Params;Querystring:Query}>(root+'/rules',{schema:{params:workspaceParamsSchema,querystring:compactRulesQuerySchema}},async req=>{
   const scope=owner(req,req.params['workspaceId']!),versionId=req.query.versionId!,summary=await authorize(req,scope.workspaceId,async tx=>(await requireVersion(tx,scope,versionId)).summary);
   return d.queries.page(scope,{type:'version',id:versionId,view:'catalog'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:{...(req.query.code?{code:req.query.code}:{}),...(req.query.status?{status:req.query.status}:{}),...(req.query.table?{table:req.query.table}:{})}},{coverage:summary['coverage']!,...(summary['dataSummary']?{dataSummary:summary['dataSummary']!}:{})});
 });
 const cursors=createHostedCursorCodec(d.config.cursorSigningKey);
 for(const resource of ['runs','previews'] as const)app.get<{Params:Params;Querystring:Query}>(root+'/'+resource,{schema:{params:workspaceParamsSchema,querystring:{type:'object',additionalProperties:false,properties:{...paging,status:{type:'string',maxLength:100}}}}},req=>authorize(req,req.params['workspaceId']!,async tx=>{
   const scope=owner(req,req.params['workspaceId']!),table=resource==='runs'?'validation_runs':'previews',status=resource==='runs'?'status':'state';
   const revision=(await tx.query(`SELECT md5(coalesce(string_agg(id::text||':'||${status},',' ORDER BY created_at,id),'')) AS revision FROM ${table} WHERE session_id=$1 AND workspace_id=$2`,[scope.sessionId,scope.workspaceId])).rows[0]!.revision;
   const filter=req.query.status??'',fingerprint=canonicalHash({scope,resource,revision,filter}),after=req.query.cursor?cursors.decode(req.query.cursor,fingerprint):undefined,limit=Number(req.query.limit??50);
   const args:unknown[]=[scope.sessionId,scope.workspaceId,filter];let where=`session_id=$1 AND workspace_id=$2 AND ($3='' OR ${status}=$3)`;
   const total=Number((await tx.query(`SELECT count(*)::text n FROM ${table} WHERE ${where}`,args)).rows[0]!.n);
   if(after){args.push(after.sortKey,after.rowKey);where+=' AND (created_at,id)<($4::timestamptz,$5::uuid)';}args.push(limit+1);
   const rows=(await tx.query(`SELECT * FROM ${table} WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT $${args.length}`,args)).rows,selected=rows.slice(0,limit);
    const items=selected.map(row=>resource==='runs'?(()=>{const run=publicValidation(row as ValidationRow);return {id:run.id,versionId:run.versionId,validationBasisId:run.validationBasisId,profileId:run.profileId,status:run.status,startedAt:run.startedAt,...(run.endedAt?{endedAt:run.endedAt}:{})};})():{id:row.id,baseVersionId:row.version_id,profileId:row.counters?.profileId??'',policyId:row.counters?.policyId??'half-even-v1',state:row.state,createdAt:row.created_at.toISOString()});
   const last=selected.at(-1);return {items,total,revision,nextCursor:rows.length>limit&&last?cursors.encode(fingerprint,{sortKey:last.created_at.toISOString(),rowKey:last.id}):null};
 }));
 app.get<{Params:Params}>(root+'/recalculation-reviews/:reviewId',{schema:{params:params('reviewId'),querystring:emptyQuerySchema}},req=>d.repository.review(owner(req,req.params['workspaceId']!),req.params['reviewId']!));
 const reviewQuery={type:'object',additionalProperties:false,properties:{...paging,compact:{const:'true'},scope:{enum:['pending','resolved','all']},state:{type:'string',maxLength:100},groupId:{type:'string',maxLength:500}}};
 for(const view of ['rows','groups'] as const)app.get<{Params:Params;Querystring:Query&{state?:string;groupId?:string}}>(root+'/recalculation-reviews/:reviewId/'+view,{schema:{params:params('reviewId'),querystring:reviewQuery}},req=>d.queries.page(owner(req,req.params['workspaceId']!),{type:'review',id:req.params['reviewId']!,view},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:{...(req.query.scope?{scope:req.query.scope}:{}),...(req.query.state?{status:req.query.state}:{}),...(req.query.groupId?{groupId:req.query.groupId}:{})}},{reviewId:req.params['reviewId']!}));
 app.get<{Params:Params;Querystring:Query}>(root+'/recalculation-reviews/:reviewId/groups/:groupId/candidates',{schema:{params:params('reviewId','groupId'),querystring:reviewQuery}},async req=>{
   const scope=owner(req,req.params['workspaceId']!),resource={type:'review' as const,id:req.params['reviewId']!};
   const group=await d.queries.page(scope,{...resource,view:'groups'},{limit:1,filter:{rowKey:req.params['groupId']!}});
   if(!group.items[0])throw new ApiError('RESOURCE_NOT_FOUND');
   const page=await d.queries.page(scope,{...resource,view:'candidates'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:{groupId:req.params['groupId']!}},{reviewId:resource.id,group:group.items[0]});
   if(page.revision!==group.revision)throw new ApiError('STALE_DIRECTION_REVIEW');return page;
 });
 app.get<{Params:Params}>(root+'/recalculation-reviews/:reviewId/groups/:groupId/candidates/:instanceId',{schema:{params:params('reviewId','groupId','instanceId'),querystring:{type:'object',additionalProperties:false,properties:{compact:{const:'true'}}}}},async req=>{
   return d.queries.item(owner(req,req.params['workspaceId']!),{type:'review',id:req.params['reviewId']!,view:'candidateDetails'},req.params['groupId']!+':'+req.params['instanceId']!);
 });
 app.get<{Params:Params;Querystring:Query}>(root+'/versions/:versionId/export-summary',{schema:{params:params('versionId'),querystring:{type:'object',additionalProperties:false,properties:{kind:{enum:['report','results']},runId:uuidSchema}}}},async req=>{
   const scope=owner(req,req.params['workspaceId']!),versionId=req.params['versionId']!;if(req.query.kind==='results'&&!req.query.runId||req.query.kind!=='results'&&req.query.runId)throw new ApiError('INVALID_REQUEST');
   const intent:DownloadIntent=req.query.kind==='results'?{workspaceId:scope.workspaceId,versionId,kind:'results',runId:req.query.runId!}:{workspaceId:scope.workspaceId,versionId,kind:'report'};
   if(intent.kind==='results'&&(await d.repository.validation(scope,intent.runId)).versionId!==versionId)throw new ApiError('STALE_VERSION');
   const value=await d.queries.item(scope,{type:'version',id:versionId,view:'exportSummary'},'summary');if(!value||typeof value!=='object'||Array.isArray(value))throw new ApiError('INTERNAL_ERROR');
   return {...value,intent,intentFingerprint:createHash('sha256').update(downloadIntentKey(intent)).digest('hex')};
 });
}
