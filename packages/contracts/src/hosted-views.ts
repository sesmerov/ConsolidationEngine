import type { Diagnostic, SourceLocator, UUID, WorkspaceDTO } from './common.js';
import { uuidSchema } from './common.schemas.js';
import type { ReportContext } from './report.js';
import { reportContextSchema } from './report.js';
import type { RecalculationPolicyDTO } from './profiles.js';
import { recalculationPolicySchema } from './profiles.js';
import type { FactReadDTO, MetadataReadDTO, ValidationStatus, ValidationValueDTO } from './validation.js';
import { validationValueSchema } from './validation.js';
import type { Severity, RuleRowDTO, RulesPageDTO } from './catalog.js';
import { diagnosticSchema, rawRuleRecordSchema } from './catalog.js';
import { factReadSchema, metadataReadsSchema } from './recalculation.js';
import { sourceLocatorSchema } from './common.schemas.js';
import type { CompactPageDTO, CompactValidationRunDTO, LargeValueDescriptorDTO } from './compact.js';
import { compactPageSchema, compactValidationRunSchema, largeValueDescriptorSchema } from './compact.js';
import type { CompactApplyReceiptDTO } from './application.js';
import { compactApplyReceiptSchema, completedValidationSummarySchema } from './application.js';
import type { ValidationSummary } from './validation.js';

/** Value parts use a smaller bound than uploads/exports; hashes cover original UTF-8 bytes. */
export const PUBLIC_VALUE_PART_BYTES = 128 * 1024;
export type PublicValue<T> = T | LargeValueDescriptorDTO;
export type CompactWorkspaceDTO = Omit<WorkspaceDTO, 'contexts'> & { readonly contextCount: number };
export type CompactContextsPageDTO = CompactPageDTO<PublicValue<ReportContext>>;
export type CompactRuleRowDTO = Omit<RuleRowDTO,'originalFields'> & {readonly fileName:string};
export interface CompactRulesPageDTO extends CompactPageDTO<PublicValue<CompactRuleRowDTO>> {readonly coverage:RulesPageDTO['coverage'];readonly dataSummary:RulesPageDTO['dataSummary']}
export interface ResultEvidenceCountsDTO {
 readonly operands:number; readonly reads:number; readonly metadataReads:number;
 readonly origins:number; readonly diagnostics:number; readonly descriptions:number;
}
/** Display projection only. Complete reads and origins are authorized, paginated sections. */
export interface CompactRuleResultDTO {
 readonly id:string; readonly runId:UUID; readonly versionId:UUID; readonly profileId:string;
 readonly instanceId?:string; readonly coverageOnly:boolean; readonly contextId?:string;
 readonly code:string; readonly status:ValidationStatus; readonly severity:Severity; readonly severityOriginal:string;
 readonly location:string;
 readonly presentation?:{readonly description?:PublicValue<string>;readonly conceptLabel?:PublicValue<string>};
 readonly expression:PublicValue<string>; readonly precondition?:PublicValue<string>;
 readonly preconditionResult?:PublicValue<ValidationValueDTO>;
 readonly values:{readonly left?:PublicValue<ValidationValueDTO>;readonly right?:PublicValue<ValidationValueDTO>;readonly result?:PublicValue<ValidationValueDTO>};
 readonly recalculationPolicy?:RecalculationPolicyDTO; readonly counts:ResultEvidenceCountsDTO;
}
export interface CompactResultsPageDTO extends CompactPageDTO<PublicValue<CompactRuleResultDTO>> { readonly run:CompactValidationRunDTO }
export interface ResultExplanationDTO extends CompactRuleResultDTO { readonly workspaceId:UUID }
export type ResultExplanationSection = 'operands'|'reads'|'metadata'|'origins'|'diagnostics'|'descriptions';
export interface ResultOriginDTO { readonly locator:SourceLocator; readonly fileName:string }
export interface ResultDescriptionDTO { readonly description:string; readonly expression?:string; readonly precondition?:string; readonly source:ResultOriginDTO }
export type ResultExplanationItemDTO =
 | {readonly itemId:string;readonly section:'operands';readonly label:string;readonly value:PublicValue<ValidationValueDTO>}
 | {readonly itemId:string;readonly section:'reads';readonly value:PublicValue<FactReadDTO>}
 | {readonly itemId:string;readonly section:'metadata';readonly value:PublicValue<MetadataReadDTO>}
 | {readonly itemId:string;readonly section:'origins';readonly value:PublicValue<ResultOriginDTO>}
 | {readonly itemId:string;readonly section:'diagnostics';readonly value:PublicValue<Diagnostic>}
 | {readonly itemId:string;readonly section:'descriptions';readonly value:PublicValue<ResultDescriptionDTO>};
export interface ResultExplanationPageDTO extends CompactPageDTO<PublicValue<ResultExplanationItemDTO>> {
 readonly runId:UUID; readonly resultId:string; readonly section:ResultExplanationSection;
}
export interface PublicComparisonRowDTO {readonly key:string;readonly before?:CompactRuleResultDTO;readonly after?:CompactRuleResultDTO}
export interface PublicComparisonPageDTO extends CompactPageDTO<PublicValue<PublicComparisonRowDTO>> {
 readonly receipt:CompactApplyReceiptDTO;readonly beforeSummary:ValidationSummary;readonly afterSummary:ValidationSummary;
}
/** Applied cells are separate from result comparisons: one change may affect several validation rules. */
export interface PublicApplicationChangeDTO {readonly itemId:string;readonly location:string;readonly before:string;readonly after:string;readonly unit:string}
export interface PublicApplicationChangesPageDTO extends CompactPageDTO<PublicValue<PublicApplicationChangeDTO>> {readonly receiptId:UUID}

const text={type:'string'} as const;
const count={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER} as const;
const closed=(properties:Record<string,unknown>,required:readonly string[])=>({type:'object',additionalProperties:false,properties,required});
const retained=(schema:object)=>({anyOf:[schema,largeValueDescriptorSchema]});
const paging={limit:{type:'string',pattern:'^(?:[1-9]|[1-4][0-9]|50)$'},cursor:{type:'string',minLength:1,maxLength:8192}};
/** Local read routes opt into the same projection; hosted routes never expose legacy arrays. */
export const compactWorkspaceQuerySchema=closed({compact:{const:'true'}},[]);
export const compactContextsQuerySchema=closed({...paging,contextId:{type:'string',minLength:1,maxLength:512}},[]);
export const compactResultsQuerySchema=closed({...paging,compact:{const:'true'},code:{type:'string',maxLength:128},table:{type:'string',maxLength:128},status:{enum:['pass','fail','not_applicable','not_evaluable','error']}},[]);
export const compactRulesQuerySchema=closed({...paging,versionId:uuidSchema,compact:{const:'true'},code:{type:'string',maxLength:128},table:{type:'string',maxLength:128},status:{enum:['error','unsupported','supported','applicable','not_applicable','not_evaluable','invalid']}},['versionId']);
export const resultExplanationItemsQuerySchema=closed({...paging,section:{enum:['operands','reads','metadata','origins','diagnostics','descriptions']}},['section']);
const {originalFields:_sourceFields,...recordProperties}=rawRuleRecordSchema.properties;
export const compactRuleRowSchema=closed({...recordProperties,fileName:{type:'string',maxLength:200},expression:text,precondition:text,severity:{enum:['error','warning','unknown']},active:{type:'boolean'},modules:{type:'array',items:text},tables:{type:'array',items:text},syntaxStatus:{enum:['valid','error']},supportStatus:{enum:['supported','unsupported']},applicability:{enum:['applicable','not_applicable','not_evaluable']}},[...rawRuleRecordSchema.required.filter(key=>key!=='originalFields'),'fileName']);
const catalogPage=compactPageSchema(retained(compactRuleRowSchema));
export const compactRulesPageSchema={...catalogPage,properties:{...catalogPage.properties,coverage:closed({rows:count,variants:count,applicableVariants:count,supportedVariants:count,invalidRows:count,duplicateRows:count,conflictingVariants:count},['rows','variants','applicableVariants','supportedVariants','invalidRows','duplicateRows','conflictingVariants']),dataSummary:closed({explicitNulls:count,implicitNulls:count,zeroValues:count},['explicitNulls','implicitNulls','zeroValues'])},required:[...catalogPage.required,'coverage','dataSummary']};
export const compactWorkspaceSchema=closed({id:uuidSchema,name:{...text,minLength:1,maxLength:100},state:{enum:['empty','ready','closed']},currentVersionId:uuidSchema,versionIds:{type:'array',maxItems:20,items:uuidSchema},activeJobId:uuidSchema,validationBasisId:uuidSchema,
 contextCount:count,counts:closed({snapshots:count,coordinates:count,facts:count,sources:count},['snapshots','coordinates','facts','sources']),sessionBytes:count},['id','name','state','versionIds','contextCount','counts','sessionBytes']);
export const compactContextsPageSchema=compactPageSchema(retained(reportContextSchema));
export const resultEvidenceCountsSchema=closed({operands:count,reads:count,metadataReads:count,origins:count,diagnostics:count,descriptions:count},['operands','reads','metadataReads','origins','diagnostics','descriptions']);
export const compactRuleResultSchema=closed({id:text,runId:uuidSchema,versionId:uuidSchema,profileId:text,instanceId:text,coverageOnly:{type:'boolean'},contextId:text,code:text,status:{enum:['pass','fail','not_applicable','not_evaluable','error']},severity:{enum:['error','warning','unknown']},severityOriginal:text,location:text,
 presentation:closed({description:retained(text),conceptLabel:retained(text)},[]),expression:retained(text),precondition:retained(text),preconditionResult:retained(validationValueSchema),values:closed({left:retained(validationValueSchema),right:retained(validationValueSchema),result:retained(validationValueSchema)},[]),recalculationPolicy:recalculationPolicySchema,counts:resultEvidenceCountsSchema},
 ['id','runId','versionId','profileId','coverageOnly','code','status','severity','severityOriginal','location','expression','values','counts']);
const resultPage=compactPageSchema(retained(compactRuleResultSchema));
export const compactResultsPageSchema={...resultPage,properties:{...resultPage.properties,run:compactValidationRunSchema},required:[...resultPage.required,'run']};
export const publicComparisonRowSchema={...closed({key:text,before:compactRuleResultSchema,after:compactRuleResultSchema},['key']),anyOf:[{required:['before']},{required:['after']}]};
const comparisonPage=compactPageSchema(retained(publicComparisonRowSchema));
export const publicComparisonPageSchema={...comparisonPage,properties:{...comparisonPage.properties,receipt:compactApplyReceiptSchema,beforeSummary:completedValidationSummarySchema,afterSummary:completedValidationSummarySchema},required:[...comparisonPage.required,'receipt','beforeSummary','afterSummary']};
export const publicApplicationChangeSchema=closed({itemId:text,location:text,before:text,after:text,unit:text},['itemId','location','before','after','unit']);
const applicationChangesPage=compactPageSchema(retained(publicApplicationChangeSchema));
export const publicApplicationChangesPageSchema={...applicationChangesPage,properties:{...applicationChangesPage.properties,receiptId:uuidSchema},required:[...applicationChangesPage.required,'receiptId']};
export const publicApplicationChangesQuerySchema=closed(paging,[]);
export const resultExplanationSchema={...compactRuleResultSchema,properties:{...compactRuleResultSchema.properties,workspaceId:uuidSchema},required:[...compactRuleResultSchema.required,'workspaceId']};
const originSchema=closed({locator:sourceLocatorSchema,fileName:text},['locator','fileName']);
const descriptionSchema=closed({description:text,expression:text,precondition:text,source:originSchema},['description','source']);
const sectionValues:Record<ResultExplanationSection,object>={operands:validationValueSchema,reads:factReadSchema,metadata:metadataReadsSchema.items,origins:originSchema,diagnostics:diagnosticSchema,descriptions:descriptionSchema};
export const resultExplanationPageSchema={oneOf:Object.entries(sectionValues).map(([section,valueSchema])=>{
 const item=closed({itemId:text,section:{const:section},...(section==='operands'?{label:text}:{}),value:retained(valueSchema)},['itemId','section','value',...(section==='operands'?['label']:[])]);
 const page=compactPageSchema(retained(item));
 return {...page,properties:{...page.properties,runId:uuidSchema,resultId:text,section:{const:section}},required:[...page.required,'runId','resultId','section']};
})};
