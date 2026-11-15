import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { compactWorkspaceSchema, compactContextsPageSchema, compactRuleResultSchema, compactResultsPageSchema,
  resultExplanationPageSchema, compactRuleRowSchema, compactRulesPageSchema, publicComparisonPageSchema, publicApplicationChangesPageSchema, PUBLIC_VALUE_PART_BYTES } from '../../packages/contracts/src/hosted-views.js';

const id='00000000-0000-4000-8000-000000000005';
const descriptor={valueRef:id,byteLength:1048577,sha256:'a'.repeat(64),mediaType:'application/json'};
const counts={operands:2,reads:100000,metadataReads:0,origins:100002,diagnostics:0,descriptions:1};
const row={id:'result-hash',runId:id,versionId:id,profileId:'ce-dpmxl-0.9-closed-v2',coverageOnly:false,code:'RULE',status:'fail',severity:'error',severityOriginal:'Error',location:'F_01.01 r0010 c0010',expression:'1=2',values:{left:{kind:'boolean',value:true}},counts};
const run={id,workspaceId:id,versionId:id,validationBasisId:id,profileId:'ce-dpmxl-0.9-closed-v2',status:'completed',startedAt:'2026-11-08T12:00:00Z',summary:{complete:true,rows:1,variants:1,applicableVariants:1,instances:1,duplicateRows:0,byStatus:{pass:0,fail:1,not_applicable:0,not_evaluable:0,error:0}},diagnosticsCount:0};
async function check(schema:object,work:(post:(value:unknown)=>Promise<number>)=>Promise<void>){
 const app=Fastify({ajv:{customOptions:{removeAdditional:false,coerceTypes:false}}});app.post('/',{schema:{body:schema}},async()=>({ok:true}));
 try{await work(async value=>(await app.inject({method:'POST',url:'/',payload:value as any})).statusCode);}finally{await app.close();}
}
describe('hosted public views',()=>{
 it('compares compact results and pages applied values independently without attributing a shared cell to a rule',async()=>{
  const receipt={id,previewId:id,closureHash:'a'.repeat(64),baseVersionId:id,newVersionId:id,beforeValidationRunId:id,validationRunId:id,appliedAt:'2026-11-08T12:00:00Z',acceptedCount:1};
  await check(publicComparisonPageSchema,async post=>{const page={workspaceId:id,versionId:id,items:[{key:'pair',before:row,after:row}],total:1,nextCursor:null,receipt,beforeSummary:run.summary,afterSummary:run.summary};expect(await post(page)).toBe(200);expect(await post({...page,sourceFiles:[]})).toBe(400);expect(await post({...page,items:[{key:'pair',before:{...row,factReads:[]}}]})).toBe(400);});
  await check(publicApplicationChangesPageSchema,async post=>{const page={workspaceId:id,versionId:id,receiptId:id,items:[{itemId:'change',location:'SYNTHETIC F_01.01 r0010 c0010',before:'1,00',after:'2,00',unit:'EUR'},descriptor],total:2,nextCursor:null};expect(await post(page)).toBe(200);expect(await post({...page,items:Array(51).fill(descriptor)})).toBe(400);expect(await post({...page,storageKey:'private'})).toBe(400);});
 });
 it('keeps a catalog row readable without original field maps or a global source list',async()=>{
  const record={id,code:'RULE',sourceLocator:{fileId:id,sheet:'Rules',row:2},fileName:'catalog.xlsx',diagnostics:[],expression:'1=1'};
  await check(compactRuleRowSchema,async post=>{expect(await post(record)).toBe(200);expect(await post({...record,originalFields:{secret:'not a public map'}})).toBe(400);});
  await check(compactRulesPageSchema,async post=>{const page={workspaceId:id,versionId:id,items:[record,descriptor],total:2,nextCursor:null,coverage:{rows:2,variants:1,applicableVariants:1,supportedVariants:1,invalidRows:0,duplicateRows:1,conflictingVariants:0},dataSummary:{explicitNulls:0,implicitNulls:0,zeroValues:0}};expect(await post(page)).toBe(200);expect(await post({...page,sources:[]})).toBe(400);});
 });
 it('keeps workspace metadata closed and contexts separately paginated',async()=>{
  const workspace={id,name:'Demo',state:'empty',versionIds:[],contextCount:100000,counts:{snapshots:0,coordinates:0,facts:0,sources:0},sessionBytes:0};
  await check(compactWorkspaceSchema,async post=>{expect(await post(workspace)).toBe(200);expect(await post({...workspace,contexts:[]})).toBe(400);expect(await post({...workspace,versionIds:Array(21).fill(id)})).toBe(400);});
  await check(compactContextsPageSchema,async post=>{const page={workspaceId:id,versionId:id,items:[descriptor],total:100000,nextCursor:'signed'};expect(await post(page)).toBe(200);expect(await post({...page,items:Array(51).fill(descriptor)})).toBe(400);});
 });
 it('retains exact values or descriptors without complete read arrays or internal keys',async()=>{
  await check(compactRuleResultSchema,async post=>{expect(await post(row)).toBe(200);expect(await post({...row,expression:descriptor,presentation:{description:descriptor},values:{left:descriptor}})).toBe(200);
   for(const field of ['readKeys','factReads','metadataReads','sources','diagnostics','sourceRecordIds','variantIds','tables','ast'])expect(await post({...row,[field]:[]})).toBe(400);
   expect(await post({...row,expression:{...descriptor,url:'https://provider.example/value'}})).toBe(400);
  });
 });
 it('bounds compact results and carries summary identities without all result IDs',async()=>{
  await check(compactResultsPageSchema,async post=>{const page={workspaceId:id,versionId:id,run,items:[row,descriptor],total:100000,nextCursor:'signed'};expect(await post(page)).toBe(200);expect(await post({...page,items:Array(51).fill(row)})).toBe(400);expect(await post({...page,run:{...run,resultIds:['all']}})).toBe(400);});
 });
 it('requires the selected explanation section and rejects cross-section payloads',async()=>{
  await check(resultExplanationPageSchema,async post=>{const page={workspaceId:id,versionId:id,runId:id,resultId:'result-hash',section:'operands',items:[{section:'operands',itemId:'left',label:'Lado izquierdo',value:{kind:'boolean',value:false}}],total:1,nextCursor:null};
   expect(await post(page)).toBe(200);expect(await post({...page,items:[descriptor]})).toBe(200);expect(await post({...page,items:[{section:'diagnostics',itemId:'d',value:{code:'ERROR',message:'Completo'}}]})).toBe(400);
   expect(await post({...page,items:[{...page.items[0],value:{kind:'boolean',value:false,storageKey:'private'}}]})).toBe(400);
  });
  expect(PUBLIC_VALUE_PART_BYTES).toBe(128*1024);
 });
});
