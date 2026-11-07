import { randomUUID } from 'node:crypto';
import { afterAll,expect,test } from 'vitest';
import type { ApplicationBundle,Snapshot } from '@ce/contracts';
import { applyCandidate,resolveDirection,runValidation,selectionClosureHash,simulate } from '@ce/engine';
import { inspectWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { prepareReportExportData,REPORT_EXPORT_LIMITS,writeReportExport } from '../../apps/api/src/export/recalculated-report.js';
import { visualStaged,visualOperation,visualSnapshot,visualOutput,reimportVisual,cleanupVisualExports,emptyVisualHistory } from '../helpers/visual-export-harness.js';
afterAll(cleanupVisualExports);
test('FINREP demo validates 2/3, computes two dependent changes, revalidates 4/1 and returns all 38 cells through Excel',async()=>{
 const files=await Promise.all([visualStaged('assets/demos/demo-finrep-catalog.xlsx','catalog'),visualStaged('assets/demos/demo-finrep-report.xlsx','report')]);
 const original=visualSnapshot((await inspectWorkspace(files,visualOperation,{source:'workbook'})).content),before=runValidation(original,{runId:randomUUID(),startedAt:original.createdAt});
 expect(original.content.coordinates).toHaveLength(38);expect(original.content.facts).toHaveLength(38);expect(before.run.summary.byStatus).toMatchObject({pass:2,fail:3,error:0,not_evaluable:0,not_applicable:0});
 const directions=before.results.filter(r=>['FIN_TOTAL_CASH','FIN_TOTAL_ASSETS_DEMO'].includes(r.code)).map(r=>resolveDirection(original,{instanceId:r.instanceId!,variantIds:r.variantIds,binding:r.binding!,targetSide:'left'}).resolved!.direction);
 for(const result of before.results.filter(r=>!r.code.startsWith('FIN_TOTAL_')))expect(resolveDirection(original,{instanceId:result.instanceId!,variantIds:result.variantIds,binding:result.binding!,targetSide:'left'}).resolved).toBeUndefined();
 const configured=visualSnapshot({...original.content,directions,configVersion:canonicalHash(directions)}),preview=simulate(configured,{previewId:randomUUID()});
 expect(preview.proposals).toHaveLength(2);expect(preview.preview.graphSummary).toMatchObject({nodes:2,edges:1});
 const cash=preview.proposals.find(p=>p.code==='FIN_TOTAL_CASH')!,assets=preview.proposals.find(p=>p.code==='FIN_TOTAL_ASSETS_DEMO')!;
 expect(cash.before?.originalText).toBe('90');expect(cash.after?.normalizedValue).toEqual({numerator:'100',denominator:'1'});expect(assets.before?.originalText).toBe('105');expect(assets.after?.normalizedValue).toEqual({numerator:'120',denominator:'1'});expect(assets.predecessorIds).toEqual([cash.id]);
 const selectedIds=preview.proposals.map(p=>p.id),options={receiptId:randomUUID(),newVersionId:randomUUID(),beforeRunId:randomUUID(),runId:randomUUID(),startedAt:original.createdAt,selectedIds,closureHash:selectionClosureHash(preview.preview,selectedIds)};
 const applied=applyCandidate(configured,preview,options),patches=new Map(applied.factPatches.map(f=>[f.factKey,f]));expect(applied.validation.run.summary.byStatus).toMatchObject({pass:4,fail:1,error:0});
 const final={...visualSnapshot({...configured.content,facts:configured.content.facts.map(f=>patches.get(f.factKey)??f)}),versionId:options.newVersionId,parentVersionId:configured.versionId};
 const receipt={id:options.receiptId,previewId:preview.preview.id,acceptedIds:selectedIds,closureHash:options.closureHash,baseVersionId:configured.versionId,newVersionId:final.versionId,beforeValidationRunId:options.beforeRunId,validationRunId:options.runId,appliedAt:original.createdAt};
 const changes=preview.proposals.map(p=>({changed:patches.has(p.targetKey),receiptId:receipt.id,proposalId:p.id,directionId:p.directionId,instanceId:p.instanceId,variantIds:p.variantIds,code:p.code,targetKey:p.targetKey,before:p.before!,after:p.after!,readKeys:p.readKeys,predecessorIds:p.predecessorIds,metadataReads:p.metadataReads,sources:p.sources,exactNominal:p.exactNominal!,derivedInterval:p.derivedInterval!,policyId:preview.preview.policyId}));
 // Receipt packaging is controlled test metadata; evaluation and patches are real engine output.
 const history={applications:[{receipt,changes}] as ApplicationBundle[],snapshot:(id:string)=>{expect(id).toBe(configured.versionId);return configured;}};
 const exported=async(snapshot:Snapshot)=>{const data=prepareReportExportData(snapshot,snapshot===final?history:emptyVisualHistory),paths=await visualOutput();await writeReportExport(data,paths,REPORT_EXPORT_LIMITS,()=>{},()=>{},[files[1]!]);return reimportVisual(files[0]!,paths.reports);};
 const restored=await exported(final);expect(restored.coordinates).toHaveLength(38);expect(restored.contexts[0]?.contextId).not.toBe(final.content.contexts[0]?.contextId);
 const byKey=(facts:typeof restored.facts)=>facts.map(f=>[f.factKey,f.normalizedValue]).sort(([a],[b])=>String(a).localeCompare(String(b)));
 expect(byKey(restored.facts)).toEqual(byKey(final.content.facts));expect(runValidation(visualSnapshot(restored),{runId:randomUUID(),startedAt:original.createdAt}).run.summary.byStatus).toMatchObject({pass:4,fail:1});
 const historical=await exported(original);expect(historical.facts.find(f=>f.rowCode==='0010')?.normalizedValue).toEqual({numerator:'90',denominator:'1'});expect(historical.facts.find(f=>f.rowCode==='0380')?.normalizedValue).toEqual({numerator:'105',denominator:'1'});
});

test('successive FINREP applications export each historical stage against the same retained original',async()=>{
 const files=await Promise.all([visualStaged('assets/demos/demo-finrep-catalog.xlsx','catalog'),visualStaged('assets/demos/demo-finrep-report.xlsx','report')]);
 const original=visualSnapshot((await inspectWorkspace(files,visualOperation,{source:'workbook'})).content),run=runValidation(original,{runId:randomUUID(),startedAt:original.createdAt});
 const directions=run.results.filter(r=>r.code.startsWith('FIN_TOTAL_')).map(r=>resolveDirection(original,{instanceId:r.instanceId!,variantIds:r.variantIds,binding:r.binding!,targetSide:'left'}).resolved!.direction);
 const configured=visualSnapshot({...original.content,directions,configVersion:canonicalHash(directions)}),snapshots=new Map([[configured.versionId,configured]]),applications:ApplicationBundle[]=[];
 const apply=(base:Snapshot,codes:string[])=>{
  const preview=simulate(base,{previewId:randomUUID()}),selectedIds=preview.proposals.filter(p=>codes.includes(p.code)).map(p=>p.id),options={receiptId:randomUUID(),newVersionId:randomUUID(),beforeRunId:randomUUID(),runId:randomUUID(),startedAt:original.createdAt,selectedIds,closureHash:selectionClosureHash(preview.preview,selectedIds)};
  const result=applyCandidate(base,preview,options),patches=new Map(result.factPatches.map(f=>[f.factKey,f]));
  const snapshot={...visualSnapshot({...base.content,facts:base.content.facts.map(f=>patches.get(f.factKey)??f)}),versionId:options.newVersionId,parentVersionId:base.versionId};
  const receipt={id:options.receiptId,previewId:preview.preview.id,acceptedIds:selectedIds,closureHash:options.closureHash,baseVersionId:base.versionId,newVersionId:snapshot.versionId,beforeValidationRunId:options.beforeRunId,validationRunId:options.runId,appliedAt:original.createdAt};
  const changes=preview.proposals.filter(p=>selectedIds.includes(p.id)).map(p=>({changed:patches.has(p.targetKey),receiptId:receipt.id,proposalId:p.id,directionId:p.directionId,instanceId:p.instanceId,variantIds:p.variantIds,code:p.code,targetKey:p.targetKey,before:p.before!,after:p.after!,readKeys:p.readKeys,predecessorIds:p.predecessorIds,metadataReads:p.metadataReads,sources:p.sources,exactNominal:p.exactNominal!,derivedInterval:p.derivedInterval!,policyId:preview.preview.policyId}));
  applications.push({receipt,changes});snapshots.set(snapshot.versionId,snapshot);return snapshot;
 };
 const first=apply(configured,['FIN_TOTAL_CASH']),second=apply(first,['FIN_TOTAL_CASH','FIN_TOTAL_ASSETS_DEMO']);
 expect(applications[0]?.changes.filter(c=>c.changed).map(c=>c.code)).toEqual(['FIN_TOTAL_CASH']);
 expect(applications[1]?.changes.filter(c=>c.changed).map(c=>c.code)).toEqual(['FIN_TOTAL_ASSETS_DEMO']);
 for(const [snapshot,cash,assets,passes,receiptCount] of [[configured,'90','105',2,0],[first,'100','105',3,1],[second,'100','120',4,2]] as const){
  const data=prepareReportExportData(snapshot,{applications,snapshot:id=>snapshots.get(id)!}),paths=await visualOutput();expect(data.receipts).toHaveLength(receiptCount);
  await writeReportExport(data,paths,REPORT_EXPORT_LIMITS,()=>{},()=>{},[files[1]!]);const restored=await reimportVisual(files[0]!,paths.reports);
  expect(restored.coordinates).toHaveLength(38);expect(restored.facts.find(f=>f.rowCode==='0010')?.normalizedValue).toEqual({numerator:cash,denominator:'1'});expect(restored.facts.find(f=>f.rowCode==='0380')?.normalizedValue).toEqual({numerator:assets,denominator:'1'});
  expect(runValidation(visualSnapshot(restored),{runId:randomUUID(),startedAt:original.createdAt}).run.summary.byStatus.pass).toBe(passes);
 }
});
