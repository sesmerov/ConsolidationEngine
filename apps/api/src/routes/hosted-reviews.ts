import type { FastifyInstance,FastifyRequest } from 'fastify';
import { directionReviewPatchSchema,emptyQuerySchema,uuidSchema,workspaceParamsSchema } from '@ce/contracts';
import type { DirectionReviewPatchDTO } from '@ce/contracts';
import type { HostedCommandDependencies } from '../hosted/worker-runtime.js';
import { HostedReviewMutations } from '../hosted/review-mutations.js';
import { publicReview,requireWorkspace,workspaceEtag,type ReviewRow } from '../hosted/postgres-repository.js';
import { assertLiveSession } from '../hosted/session-service.js';
import { requireHostedSession } from '../plugins/hosted-session.js';
import { ApiError } from '../errors.js';
export function registerHostedReviews(app:FastifyInstance,d:HostedCommandDependencies){
 const root='/api/v1/workspaces/:workspaceId/recalculation-reviews',now=()=>new Date(d.now()),mutations=new HostedReviewMutations(d.db,d.quotas,{now:d.now});
 const owner=(req:FastifyRequest,w:string)=>({sessionId:requireHostedSession(req).id,workspaceId:w});
 const params={type:'object',additionalProperties:false,required:['workspaceId','reviewId'],properties:{workspaceId:uuidSchema,reviewId:uuidSchema}};
 app.get<{Params:{workspaceId:string}}>(root,{schema:{params:workspaceParamsSchema,querystring:emptyQuerySchema}},req=>d.db.transaction(async tx=>{
   const scope=owner(req,req.params.workspaceId);await assertLiveSession(tx,scope.sessionId,now());const workspace=await requireWorkspace(tx,scope);
   const active=(await tx.query<ReviewRow>("SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND base_version_id=$3 AND state IN ('preparing','ready','committing') AND expires_at>$4 ORDER BY created_at DESC,id LIMIT 1",[scope.sessionId,scope.workspaceId,workspace.current_version_id,now()])).rows[0];
   const latest=(await tx.query<ReviewRow>("SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND state='committed' AND receipt->>'newVersionId'=$3 ORDER BY created_at DESC,id LIMIT 1",[scope.sessionId,scope.workspaceId,workspace.current_version_id])).rows[0];
   return {active:active?publicReview(active):null,...(latest?.receipt?{latestCommit:latest.receipt}:{})};
 }));
 app.patch<{Params:{workspaceId:string;reviewId:string};Body:DirectionReviewPatchDTO}>(root+'/:reviewId',{schema:{params,querystring:emptyQuerySchema,body:directionReviewPatchSchema}},async(req,reply)=>{
   const expected=req.headers['if-match'];if(typeof expected!=='string'||!expected)throw new ApiError('PRECONDITION_REQUIRED');
   const result=await mutations.patch(owner(req,req.params.workspaceId),req.params.reviewId,req.body,expected);reply.header('ETag',expected);return result;
 });
 app.delete<{Params:{workspaceId:string;reviewId:string}}>(root+'/:reviewId',{schema:{params,querystring:emptyQuerySchema}},async(req,reply)=>{
   const expected=req.headers['if-match'];if(typeof expected!=='string'||!expected)throw new ApiError('PRECONDITION_REQUIRED');if(req.body!==undefined)throw new ApiError('INVALID_REQUEST');
   const scope=owner(req,req.params.workspaceId),result=await d.db.transaction(async tx=>{
     await assertLiveSession(tx,scope.sessionId,now(),{lock:true});const workspace=await requireWorkspace(tx,scope,true);if(workspaceEtag(workspace)!==expected)throw new ApiError('STALE_VERSION');
     const review=(await tx.query<ReviewRow>('SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND id=$3 FOR UPDATE',[scope.sessionId,scope.workspaceId,req.params.reviewId])).rows[0];if(!review)throw new ApiError('RESOURCE_NOT_FOUND');
     if(!['ready','discarded','expired'].includes(review.state)||review.pending_job_id)throw new ApiError('DIRECTION_REVIEW_NOT_APPLICABLE');
     const updated=(await tx.query<ReviewRow>("UPDATE direction_reviews SET state='discarded' WHERE session_id=$1 AND workspace_id=$2 AND id=$3 RETURNING *",[scope.sessionId,scope.workspaceId,review.id])).rows[0]!;return publicReview(updated);
   });reply.header('ETag',expected);return result;
 });
}
