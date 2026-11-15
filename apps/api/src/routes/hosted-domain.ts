import type { FastifyInstance,FastifyRequest,FastifyReply } from 'fastify';
import { emptyQuerySchema,recalculationOperationSchema,recalculationReviewPrepareSchema,recalculationStateSchema,workspaceParamsSchema,uuidSchema,UUID_PATTERN } from '@ce/contracts';
import type { RecalculationOperationDTO,RecalculationReviewPrepareDTO,OperationReceiptDTO } from '@ce/contracts';
import type { HostedDomainAdmission,DomainRequest } from '../hosted/domain-admission.js';
import type { HostedJobCoordinator } from '../hosted/job-coordinator.js';
import type { HostedWorkspaceService } from '../hosted/workspace-service.js';
import { requireHostedSession } from '../plugins/hosted-session.js';
import { ApiError } from '../errors.js';
export function hostedDomainRequest(request:FastifyRequest,workspaceId:string):DomainRequest{
 const key=request.headers['idempotency-key'],expectedBase=request.headers['if-match'];
 if(typeof key!=='string'||!UUID_PATTERN.test(key))throw new ApiError('INVALID_REQUEST');if(typeof expectedBase!=='string'||!expectedBase)throw new ApiError('PRECONDITION_REQUIRED');
 return {sessionId:requireHostedSession(request).id,workspaceId,key,expectedBase};
}
export async function sendHostedAcceptance(reply:FastifyReply,request:DomainRequest,receipt:OperationReceiptDTO,services:{coordinator:HostedJobCoordinator;workspaces:HostedWorkspaceService},compound=false){
 const metadata=await services.workspaces.metadata(request);reply.header('ETag',metadata.etag);
 if(receipt.responseStatus===503)throw new ApiError('JOB_DISPATCH_UNCERTAIN',{jobId:receipt.jobId,operationId:receipt.operationId});
 if(compound){const r=receipt.reservation;if(r?.kind!=='recalculation')throw new ApiError('INTERNAL_ERROR');return reply.code(202).send({operationId:receipt.operationId,jobId:receipt.jobId,inputVersionId:r.inputVersionId,effectiveVersionId:r.effectiveVersionId,reservedPreviewId:r.reservedPreviewId});}
 return reply.code(202).send(await services.coordinator.get({...request,jobId:receipt.jobId}));
}
export function registerHostedDomain(app:FastifyInstance,services:{admission:HostedDomainAdmission;coordinator:HostedJobCoordinator;workspaces:HostedWorkspaceService}){
 const root='/api/v1/workspaces/:workspaceId';
 app.get<{Params:{workspaceId:string}}>(root+'/recalculation-state',{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema,response:{200:recalculationStateSchema}}},req=>services.admission.state({sessionId:requireHostedSession(req).id,workspaceId:req.params.workspaceId}));
 app.post<{Params:{workspaceId:string};Body:{baseVersionId:string}}>(root+'/validations',{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema,body:{type:'object',additionalProperties:false,required:['baseVersionId'],properties:{baseVersionId:uuidSchema}}}},async(req,reply)=>{const request=hostedDomainRequest(req,req.params.workspaceId);return sendHostedAcceptance(reply,request,await services.admission.validate(request,req.body),services);});
 app.post<{Params:{workspaceId:string};Body:RecalculationReviewPrepareDTO}>(root+'/recalculation-reviews',{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema,body:recalculationReviewPrepareSchema}},async(req,reply)=>{const request=hostedDomainRequest(req,req.params.workspaceId);return sendHostedAcceptance(reply,request,await services.admission.prepare(request,req.body),services);});
 app.post<{Params:{workspaceId:string};Body:RecalculationOperationDTO}>(root+'/recalculation-operations',{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema,body:recalculationOperationSchema}},async(req,reply)=>{const request=hostedDomainRequest(req,req.params.workspaceId);return sendHostedAcceptance(reply,request,await services.admission.recalculate(request,req.body),services,true);});
}
