import type { FastifyInstance,FastifyRequest } from 'fastify';
import { emptyQuerySchema,publicApplicationChangesQuerySchema,uuidSchema } from '@ce/contracts';
import type { JsonObject } from '@ce/contracts';
import type { HostedCommandDependencies } from '../hosted/worker-runtime.js';
import { requireVersion,requireWorkspace } from '../hosted/postgres-repository.js';
import { assertLiveSession } from '../hosted/session-service.js';
import { requireHostedSession } from '../plugins/hosted-session.js';
import { ApiError } from '../errors.js';
export function registerHostedApplications(app:FastifyInstance,d:HostedCommandDependencies){
 const root='/api/v1/workspaces/:workspaceId/applications/:receiptId';
 const owner=(req:FastifyRequest,w:string)=>({sessionId:requireHostedSession(req).id,workspaceId:w});
 const params={type:'object',additionalProperties:false,required:['workspaceId','receiptId'],properties:{workspaceId:uuidSchema,receiptId:uuidSchema}};
 const read=(scope:ReturnType<typeof owner>,receiptId:string)=>d.db.transaction(async tx=>{
   await assertLiveSession(tx,scope.sessionId,new Date(d.now()));await requireWorkspace(tx,scope);
   const row=(await tx.query('SELECT * FROM application_receipts WHERE session_id=$1 AND workspace_id=$2 AND id=$3',[scope.sessionId,scope.workspaceId,receiptId])).rows[0];if(!row)throw new ApiError('RESOURCE_NOT_FOUND');
   await requireVersion(tx,scope,row.new_version_id);const summary=row.detail_ref?.summary as JsonObject|undefined;if(!summary)throw new ApiError('INTERNAL_ERROR');return {row,summary};
 });
 app.get<{Params:{workspaceId:string;receiptId:string}}>(root,{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{includeAcceptedIds:{enum:['false','true']}}}}},async req=>(await read(owner(req,req.params.workspaceId),req.params.receiptId)).summary);
 app.get<{Params:{workspaceId:string;receiptId:string};Querystring:{limit?:string;cursor?:string;changedOnly?:string}}>(root+'/comparison',{schema:{params,querystring:{type:'object',additionalProperties:false,properties:{limit:{type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$'},cursor:{type:'string',maxLength:8192},changedOnly:{enum:['true','false']},compact:{const:'true'},includeAcceptedIds:{enum:['false','true']}}}}},async req=>{
   const scope=owner(req,req.params.workspaceId),{summary}=await read(scope,req.params.receiptId);
   return d.queries.page(scope,{type:'application',id:req.params.receiptId,view:'comparison'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{}),filter:req.query.changedOnly==='true'?{status:'changed'}:{}},{receipt:summary['receipt']!,beforeSummary:summary['beforeSummary']!,afterSummary:summary['afterSummary']!});
 });
 app.get<{Params:{workspaceId:string;receiptId:string};Querystring:{limit?:string;cursor?:string}}>(root+'/changes',{schema:{params,querystring:publicApplicationChangesQuerySchema}},req=>d.queries.page(owner(req,req.params.workspaceId),{type:'application',id:req.params.receiptId,view:'changes'},{limit:Number(req.query.limit??50),...(req.query.cursor?{cursor:req.query.cursor}:{})},{receiptId:req.params.receiptId}));
}
