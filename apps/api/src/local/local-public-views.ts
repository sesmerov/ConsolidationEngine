import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { PUBLIC_JSON_MAX_BYTES, PUBLIC_VALUE_PART_BYTES, isRationalValue } from '@ce/contracts';
import type { CompactValidationRunDTO, ImportInspectionDTO, ImportInspectionSection, LargeValueDescriptorDTO, PublicValue, ResultExplanationSection, Snapshot, ValidationResultsQueryDTO } from '@ce/contracts';
import { resultOrderKey } from '@ce/engine';
import type { WorkspaceStore } from '../session/workspace-store.js';
import { canonicalHash } from '../session/canonical-state.js';
import { getValidation } from '../validation/validation-service.js';
import { createPublicResultProjector } from '../presentation/public-results.js';
import { createHostedCursorCodec } from '../routes/pagination.js';
import { ApiError } from '../errors.js';
import { variantApplicability } from '../import/eba-catalog.js';
import { getApplication } from '../recalculation/application-service.js';
import { resultChanged } from '../presentation/result-change.js';
import { publicApplicationChange } from '../presentation/public-changes.js';
interface Query {limit?:string;cursor?:string}
/** Local authority retains immutable snapshots. Only descriptors, not copies of report bytes, are cached here. */
export class LocalPublicViews {
 private readonly cursors=createHostedCursorCodec(randomBytes(32));
 private readonly values=new Map<string,{workspaceId:string;authorize:()=>void|Promise<void>;value:unknown;descriptor:LargeValueDescriptorDTO}>();
 private readonly hashes=new Map<string,string>();
 constructor(readonly store:WorkspaceStore){}
 close(){this.values.clear();this.hashes.clear();}
 retainValue<T>(workspaceId:string,scopeId:string,authorize:()=>void|Promise<void>,value:T):Promise<PublicValue<T>>{return this.bound(workspaceId,scopeId,authorize)(value);}
 private bound(workspaceId:string,scopeId:string,authorize:()=>void|Promise<void>=()=>{this.store.snapshot(workspaceId,scopeId);}){return async<T>(value:T):Promise<PublicValue<T>>=>{
   const bytes=Buffer.from(JSON.stringify(value));if(bytes.length<=32768)return value;
   const sha256=createHash('sha256').update(bytes).digest('hex'),key=workspaceId+':'+scopeId+':'+sha256,prior=this.hashes.get(key);
   if(prior)return this.values.get(prior)!.descriptor;
   const valueRef=randomUUID(),descriptor:LargeValueDescriptorDTO={valueRef,byteLength:bytes.length,sha256,mediaType:'application/json'};
   this.values.set(valueRef,{workspaceId,authorize,value,descriptor});this.hashes.set(key,valueRef);return descriptor;
 };}
 private async page<T>(workspaceId:string,snapshot:Partial<Pick<Snapshot,'versionId'|'validationBasisId'>>,rows:readonly T[],key:(row:T)=>string,query:Query,scope:object,project:(row:T)=>Promise<unknown>,prefix:object={},authority?:{key:string;check:()=>void|Promise<void>}){
   const limit=Number(query.limit??50);if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new ApiError('INVALID_REQUEST');
   const fingerprint=canonicalHash({workspaceId,versionId:snapshot.versionId??null,...scope}),after=query.cursor?this.cursors.decode(query.cursor,fingerprint):undefined;
   const ordered=[...rows].sort((a,b)=>key(a)<key(b)?-1:key(a)>key(b)?1:0),start=after?ordered.findIndex(row=>key(row)===after.rowKey)+1:0;
   if(after&&!start)throw new ApiError('INVALID_CURSOR');
   const base={workspaceId,...(snapshot.versionId?{versionId:snapshot.versionId}:{}),...(snapshot.validationBasisId?{validationBasisId:snapshot.validationBasisId}:{}),...prefix},items:unknown[]=[];let nextCursor:string|null=null;
   for(const row of ordered.slice(start,start+limit)){
     const item=await this.bound(workspaceId,authority?.key??snapshot.versionId!,authority?.check)(await project(row));
     const cursor=start+items.length+1<ordered.length?this.cursors.encode(fingerprint,{rowKey:key(row),sortKey:key(row)}):null;
     if(Buffer.byteLength(JSON.stringify({...base,items:[...items,item],total:rows.length,nextCursor:cursor}))>PUBLIC_JSON_MAX_BYTES){if(!items.length)throw new ApiError('RESPONSE_LIMIT');break;}
     items.push(item);nextCursor=cursor;
   }
   return {...base,items,total:rows.length,nextCursor};
 }
 async contexts(workspaceId:string,query:Query&{contextId?:string}){
   const snapshot=this.store.current(workspaceId);if(!snapshot)throw new ApiError('RESOURCE_NOT_FOUND');
   return this.page(workspaceId,snapshot,snapshot.content.contexts.filter(row=>!query.contextId||row.contextId===query.contextId),row=>row.contextId,query,{type:'contexts',contextId:query.contextId??''},async row=>row);
 }
 async results(workspaceId:string,runId:string,query:ValidationResultsQueryDTO){
   const bundle=getValidation(this.store,workspaceId,runId),snapshot=this.store.snapshot(workspaceId,bundle.run.versionId),projector=createPublicResultProjector(snapshot,{bound:this.bound(workspaceId,snapshot.versionId)});
   const {run}=bundle;const compact:CompactValidationRunDTO={id:run.id,workspaceId,versionId:run.versionId,validationBasisId:run.validationBasisId??snapshot.validationBasisId??snapshot.versionId,profileId:run.profileId,status:run.status,startedAt:run.startedAt,...(run.endedAt?{endedAt:run.endedAt}:{}),summary:run.summary,diagnosticsCount:run.diagnostics.length};
   return this.page(workspaceId,snapshot,bundle.results.filter(row=>(!query.code||row.code.toLowerCase().includes(query.code.toLowerCase()))&&(!query.status||row.status===query.status)&&(!query.table||row.tables.includes(query.table))),resultOrderKey,query,{type:'results',runId,code:query.code??'',status:query.status??'',table:query.table??''},row=>projector.row(row),{run:compact});
 }
 async runDiagnostics(workspaceId:string,runId:string,query:Query){
   const bundle=getValidation(this.store,workspaceId,runId),snapshot=this.store.snapshot(workspaceId,bundle.run.versionId);
   return this.page(workspaceId,snapshot,bundle.run.diagnostics.map((value,index)=>({key:String(index).padStart(8,'0'),value})),row=>row.key,query,{type:'run-diagnostics',runId},async row=>row.value,{runId});
 }
 async comparison(workspaceId:string,receiptId:string,query:Query&{changedOnly?:string}){
   const bundle=getApplication(this.store,workspaceId,receiptId),before=getValidation(this.store,workspaceId,bundle.receipt.beforeValidationRunId),after=getValidation(this.store,workspaceId,bundle.receipt.validationRunId),snapshot=this.store.snapshot(workspaceId,bundle.receipt.newVersionId);
   const left=createPublicResultProjector(this.store.snapshot(workspaceId,bundle.receipt.baseVersionId),{bound:this.bound(workspaceId,bundle.receipt.baseVersionId)}),right=createPublicResultProjector(snapshot,{bound:this.bound(workspaceId,snapshot.versionId)});
   const rows=new Map<string,{key:string;before?:typeof before.results[number];after?:typeof after.results[number]}>();
   for(const result of before.results){const key=resultOrderKey(result);rows.set(key,{key,before:result});}
   for(const result of after.results){const key=resultOrderKey(result);rows.set(key,{...rows.get(key),key,after:result});}
   const {acceptedIds,...receipt}=bundle.receipt;
   return this.page(workspaceId,snapshot,[...rows.values()].filter(row=>query.changedOnly!=='true'||resultChanged(row.before,row.after)),row=>row.key,query,{type:'comparison',receiptId,changedOnly:query.changedOnly==='true'},async row=>({key:row.key,...(row.before?{before:await left.row(row.before)}:{}),...(row.after?{after:await right.row(row.after)}:{})}),{receipt:{...receipt,acceptedCount:acceptedIds.length},beforeSummary:before.run.summary,afterSummary:after.run.summary});
 }
 async applicationChanges(workspaceId:string,receiptId:string,query:Query){
   const bundle=getApplication(this.store,workspaceId,receiptId),snapshot=this.store.snapshot(workspaceId,bundle.receipt.newVersionId);
   return this.page(workspaceId,snapshot,bundle.changes.filter(row=>row.changed),row=>row.proposalId,query,{type:'application-changes',receiptId},async row=>publicApplicationChange(snapshot,row),{receiptId});
 }
 async rules(workspaceId:string,query:Query&{versionId:string;code?:string;table?:string;status?:string}){
   const snapshot=this.store.snapshot(workspaceId,query.versionId),catalog=snapshot.content.catalog,variants=new Map(catalog.variants.map(row=>[row.variantId,row])),analyses=new Map(catalog.analyses.map(row=>[row.variantId,row])),sources=new Map(snapshot.content.sources.map(row=>[row.id,row.displayName]));
   const rows=catalog.records.map(record=>{
     const {originalFields:_,...compact}=record,variant=record.variantId?variants.get(record.variantId):undefined,analysis=record.variantId?analyses.get(record.variantId):undefined;
     return {...compact,fileName:sources.get(record.sourceLocator.fileId??'')??'Catálogo',...(variant?{expression:variant.expression,...(variant.precondition?{precondition:variant.precondition}:{}),severity:variant.severity,active:variant.active,modules:variant.modules,tables:variant.tables,applicability:variantApplicability(variant,snapshot.content.contexts)}:{}),...(analysis?{syntaxStatus:analysis.syntaxStatus,supportStatus:analysis.supportStatus}:{})};
   }).filter(row=>(!query.code||row.code.toLowerCase().includes(query.code.toLowerCase()))&&(!query.table||row.tables?.includes(query.table))&&(!query.status||row.syntaxStatus===query.status||row.supportStatus===query.status||row.applicability===query.status||query.status==='invalid'&&row.diagnostics.some(issue=>issue.severity==='error')));
   return this.page(workspaceId,snapshot,rows,row=>JSON.stringify([row.code,row.variantId??'',row.sourceLocator.fileId??'',row.sourceLocator.row??0,row.id]),query,{type:'rules',code:query.code??'',table:query.table??'',status:query.status??''},async row=>row,{coverage:catalog.coverage,dataSummary:{explicitNulls:snapshot.content.facts.filter(row=>row.presence==='null').length,implicitNulls:snapshot.content.coordinates.length-snapshot.content.facts.length,zeroValues:snapshot.content.facts.filter(row=>isRationalValue(row.normalizedValue)&&row.normalizedValue.numerator==='0').length}});
 }
 private result(workspaceId:string,runId:string,resultId:string){const bundle=getValidation(this.store,workspaceId,runId),result=bundle.results.find(row=>row.id===resultId);if(!result)throw new ApiError('RESOURCE_NOT_FOUND');const snapshot=this.store.snapshot(workspaceId,bundle.run.versionId);return {result,snapshot,projector:createPublicResultProjector(snapshot,{bound:this.bound(workspaceId,snapshot.versionId)})};}
 async explanation(workspaceId:string,runId:string,resultId:string){const {result,projector}=this.result(workspaceId,runId,resultId);return projector.explanation(workspaceId,result);}
 async explanationItems(workspaceId:string,runId:string,resultId:string,query:Query&{section:ResultExplanationSection}){
   const {result,snapshot,projector}=this.result(workspaceId,runId,resultId),rows=[];for await(const row of projector.items(result,query.section))rows.push(row);
   return this.page(workspaceId,snapshot,rows,row=>row.itemId,query,{type:'explanation',runId,resultId,section:query.section},async row=>row,{runId,resultId,section:query.section});
 }
 async inspectionItems(workspaceId:string,inspection:ImportInspectionDTO,query:Query&{section:ImportInspectionSection},authorize:()=>Promise<void>){
   this.store.get(workspaceId);await authorize();const rows=inspection[query.section].map((value,index)=>({key:String(index).padStart(6,'0'),value}));
   const version=inspection.baseVersionId?this.store.snapshot(workspaceId,inspection.baseVersionId):undefined;
   return this.page(workspaceId,version??{},rows,row=>row.key,query,{type:'inspection',inspectionId:inspection.id,hash:inspection.inspectionHash,section:query.section},async row=>row.value,
     {inspectionId:inspection.id,section:query.section,revision:1},{key:'inspection:'+inspection.id+':'+inspection.inspectionHash,check:authorize});
 }
 async valuePart(workspaceId:string,valueRef:string,index:number){
   this.store.get(workspaceId);const record=this.values.get(valueRef);if(!record||record.workspaceId!==workspaceId)throw new ApiError('RESOURCE_NOT_FOUND');await record.authorize();
   if(!Number.isSafeInteger(index)||index<0||index*PUBLIC_VALUE_PART_BYTES>=record.descriptor.byteLength)throw new ApiError('RESOURCE_NOT_FOUND');
   const part=Buffer.from(JSON.stringify(record.value)).subarray(index*PUBLIC_VALUE_PART_BYTES,(index+1)*PUBLIC_VALUE_PART_BYTES);return {bytes:part,sha256:createHash('sha256').update(part).digest('hex')};
 }
}
