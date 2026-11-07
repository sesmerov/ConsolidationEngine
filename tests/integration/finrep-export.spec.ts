import { afterAll,expect,test } from 'vitest';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { inspectReportWorkbook,normalizeInspectedReport } from '../../apps/api/src/import/profiles/registry.js';
import { writeFinrepReport } from '../../apps/api/src/export/finrep-report.js';
import { FINREP_FORM,finrepParts,finrepValues,finrepFile,cleanupFinrepFiles } from '../helpers/finrep-fixtures.js';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
afterAll(cleanupFinrepFiles);
test('FINREP export retains excluded parts and exact facts, adds readable context and leaves original unchanged',async()=>{
 const input=await finrepFile(finrepValues(await finrepParts(true),{'0010':'90','0020':'40','0030':'35','0040':'25','0050':'20','0380':'105'}));
 const normalized=normalizeInspectedReport(await inspectReportWorkbook(input.path),input.source,FINREP_FORM), original=await readZipParts(input.path);
 const facts=normalized.report.facts.map(f=>f.rowCode==='0010'?{...f,originalText:'100',normalizedValue:{numerator:'100',denominator:'1'}}:f.rowCode==='0380'?{...f,originalText:'120',normalizedValue:{numerator:'120',denominator:'1'}}:f);
 const output=await finrepFile(await finrepParts());
 const partition={entryName:'reports/report-001.xlsx',sourceFileId:input.source.id,contextIds:normalized.binding.contextIds,...normalized.report,facts,binding:normalized.binding};
 const result=await writeFinrepReport(output.path,partition,{versionId:input.source.id,profileId:'ce-dpmxl-0.9-closed-v2',synthetic:true},{...input.source,path:input.path},10*1024*1024,{expandedBytes:0},100*1024*1024,()=>{});
 expect(result.size).toBe((await readFile(output.path)).length);const written=await readZipParts(output.path);
 for(const part of original.filter(p=>['xl/worksheets/sheet2.xml','xl/sharedStrings.xml','xl/styles.xml','_rels/.rels'].includes(p.name)))expect(written.find(p=>p.name===part.name)?.data.equals(part.data)).toBe(true);
 const restored=normalizeInspectedReport(await inspectReportWorkbook(output.path),output.source);
 expect(restored.report.coordinates).toHaveLength(38);expect(restored.report.facts.find(f=>f.rowCode==='0010')?.normalizedValue).toEqual({numerator:'100',denominator:'1'});expect(restored.report.facts.find(f=>f.rowCode==='0380')?.normalizedValue).toEqual({numerator:'120',denominator:'1'});
 expect(createHash('sha256').update(await readFile(input.path)).digest('hex')).toBe(input.source.sha256);
});
test.each([0,3,6] as const)('FINREP exact text and absence preserve layout at scale %s',async(scale)=>{
 const input=await finrepFile(finrepValues(await finrepParts(),{'0010':'1','0020':'0'})),normalized=normalizeInspectedReport(await inspectReportWorkbook(input.path),input.source,{...FINREP_FORM,scaleExponent:scale,displayDecimals:'INF'});
 const value={numerator:'12345678901234567890123456789',denominator:'1000000000'},facts=normalized.report.facts.filter(f=>f.rowCode!=='0020').map(f=>({...f,normalizedValue:value,originalText:'exact'}));
 const output=await finrepFile(await finrepParts()),partition={entryName:'r.xlsx',sourceFileId:input.source.id,contextIds:normalized.binding.contextIds,...normalized.report,facts,binding:normalized.binding};
 await writeFinrepReport(output.path,partition,{versionId:input.source.id,profileId:'ce-dpmxl-0.9-closed-v2',synthetic:true},{...input.source,path:input.path},10*1024*1024,{expandedBytes:0},100*1024*1024,()=>{});
 const restored=normalizeInspectedReport(await inspectReportWorkbook(output.path),output.source);expect(restored.report.facts).toHaveLength(1);expect(restored.report.facts[0]?.normalizedValue).toEqual(value);expect(restored.report.coordinates.every(c=>c.decimals==='INF')).toBe(true);
 const parts=await readZipParts(output.path),xml=parts.find(p=>p.name==='xl/worksheets/sheet1.xml')!.data.toString();expect(/<c\b[^>]*\br="F8"[^>]*\bt="inlineStr"/.test(xml)).toBe(true);
});
test('FINREP complete original preserves 190 excluded sheets and registered app titles when adding Contexto',async()=>{
 const sourceParts=await readZipParts('tests/fixtures/eba/official-annexes-4.0.xlsx'),input=await finrepFile(sourceParts,'official-copy.xlsx'),inspected=await inspectReportWorkbook(input.path,{profileId:'eba-finrep-4.0-f0101-v1'}),normalized=normalizeInspectedReport(inspected,input.source,FINREP_FORM);
 const output=await finrepFile(await finrepParts()),partition={entryName:'r.xlsx',sourceFileId:input.source.id,contextIds:normalized.binding.contextIds,...normalized.report,binding:normalized.binding};
 await writeFinrepReport(output.path,partition,{versionId:input.source.id,profileId:'ce-dpmxl-0.9-closed-v2',synthetic:true},{...input.source,path:input.path},10*1024*1024,{expandedBytes:0},100*1024*1024,()=>{});
 const restored=await inspectReportWorkbook(output.path);expect(restored.profileId).toBe('eba-finrep-4.0-f0101-v1');expect(restored.excludedSheets).toHaveLength(190);expect(restored.preflight.sheets).toHaveLength(192);
 const written=await readZipParts(output.path),authorized=new Set(['xl/workbook.xml','xl/_rels/workbook.xml.rels','[Content_Types].xml','docProps/app.xml']);
 for(const part of sourceParts)if(!authorized.has(part.name))expect(written.find(p=>p.name===part.name)?.data.equals(part.data),part.name).toBe(true);
});
test.each(['mapping','context','locator','excluded'] as const)('FINREP rejects altered %s binding or ownership',async(kind)=>{
 const input=await finrepFile(finrepValues(await finrepParts(),{'0010':'1'})),n=normalizeInspectedReport(await inspectReportWorkbook(input.path),input.source,FINREP_FORM),output=await finrepFile(await finrepParts());
 const partition={entryName:'r.xlsx',sourceFileId:input.source.id,contextIds:n.binding.contextIds,...n.report,binding:{...n.binding,...(kind==='mapping'?{mappingSha256:'0'.repeat(64)}:kind==='excluded'?{excludedSheets:['Missing']}: {})},...(kind==='context'?{contextIds:['other']}:{}),...(kind==='locator'?{coordinates:n.report.coordinates.map((c,i)=>i?c:{...c,sourceLocator:{...c.sourceLocator,column:'Z'}})}:{})};
 await expect(writeFinrepReport(output.path,partition,{versionId:input.source.id,profileId:'ce-dpmxl-0.9-closed-v2',synthetic:true},{...input.source,path:input.path},10*1024*1024,{expandedBytes:0},100*1024*1024,()=>{})).rejects.toMatchObject({code:'EXPORT_NOT_AVAILABLE'});
});
