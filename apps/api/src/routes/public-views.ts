import type { FastifyInstance } from 'fastify';
import { compactContextsQuerySchema, compactContextsPageSchema, resultExplanationItemsQuerySchema, resultExplanationSchema, resultExplanationPageSchema, uuidSchema, emptyQuerySchema, workspaceParamsSchema } from '@ce/contracts';
import type { ResultExplanationSection } from '@ce/contracts';
import type { LocalPublicViews } from '../local/local-public-views.js';
export function registerLocalPublicViews(app:FastifyInstance,views:LocalPublicViews){
 const params={type:'object',additionalProperties:false,required:['workspaceId','runId','resultId'],properties:{workspaceId:uuidSchema,runId:uuidSchema,resultId:{type:'string',minLength:1,maxLength:500}}};
 app.get<{Params:{workspaceId:string};Querystring:{limit?:string;cursor?:string;contextId?:string}}>('/api/v1/workspaces/:workspaceId/contexts',{schema:{params:workspaceParamsSchema,querystring:compactContextsQuerySchema,response:{200:compactContextsPageSchema}}},req=>views.contexts(req.params.workspaceId,req.query));
 app.get<{Params:{workspaceId:string;runId:string};Querystring:{limit?:string;cursor?:string}}>('/api/v1/workspaces/:workspaceId/runs/:runId/diagnostics',{schema:{params:{...params,required:['workspaceId','runId'],properties:{workspaceId:uuidSchema,runId:uuidSchema}},querystring:{type:'object',additionalProperties:false,properties:{limit:{type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$'},cursor:{type:'string',maxLength:8192}}}}},req=>views.runDiagnostics(req.params.workspaceId,req.params.runId,req.query));
 app.get<{Params:{workspaceId:string;runId:string;resultId:string}}>('/api/v1/workspaces/:workspaceId/runs/:runId/results/:resultId/explanation',{schema:{params,querystring:emptyQuerySchema,response:{200:resultExplanationSchema}}},req=>views.explanation(req.params.workspaceId,req.params.runId,req.params.resultId));
 app.get<{Params:{workspaceId:string;runId:string;resultId:string};Querystring:{limit?:string;cursor?:string;section:ResultExplanationSection}}>('/api/v1/workspaces/:workspaceId/runs/:runId/results/:resultId/explanation/items',{schema:{params,querystring:resultExplanationItemsQuerySchema,response:{200:resultExplanationPageSchema}}},req=>views.explanationItems(req.params.workspaceId,req.params.runId,req.params.resultId,req.query));
 app.get<{Params:{workspaceId:string;valueRef:string;index:string}}>('/api/v1/workspaces/:workspaceId/values/:valueRef/parts/:index',{schema:{params:{type:'object',additionalProperties:false,required:['workspaceId','valueRef','index'],properties:{workspaceId:uuidSchema,valueRef:uuidSchema,index:{type:'string',pattern:'^(?:0|[1-9][0-9]{0,7})$'}}},querystring:emptyQuerySchema}},async(req,reply)=>{
   const part=await views.valuePart(req.params.workspaceId,req.params.valueRef,Number(req.params.index));return reply.type('application/octet-stream').header('X-CE-Part-SHA256',part.sha256).header('Content-Length',part.bytes.length).send(part.bytes);
 });
 app.addHook('onClose',async()=>views.close());
}
