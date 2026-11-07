import { afterAll, expect, test } from 'vitest';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { inspectReportWorkbook, normalizeInspectedReport } from '../../apps/api/src/import/profiles/registry.js';
import { FINREP_ROWS, FINREP_FORM, finrepParts, finrepFile, finrepValues, cleanupFinrepFiles } from '../helpers/finrep-fixtures.js';
import { changeXml, textCell, readZipParts } from '../helpers/xlsx-fixtures.js';
import { corepReplaceCell } from '../helpers/corep-fixtures.js';
import { inspectWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { visualOperation,visualStaged } from '../helpers/visual-export-harness.js';
afterAll(cleanupFinrepFiles);
test('FINREP official grid yields all 38 identities, distinguishes absence and zero, preserves exact scale', async () => {
 const file=await finrepFile(finrepValues(await finrepParts(true),{'0010':'0','0020':'12345678901234567890.123456789','0096':'1.25'}));
 await preflightXlsx(file.path,{profile:'finrep-f0101'}).catch(e=>{throw new Error(JSON.stringify({code:e.code,details:e.details,locator:e.locator}));});
 const inspected=await inspectReportWorkbook(file.path); expect(inspected.profileId).toBe('eba-finrep-4.0-f0101-v1'); expect(inspected.excludedSheets).toEqual(['Notas']);
 const normalized=normalizeInspectedReport(inspected,file.source,{...FINREP_FORM,scaleExponent:3});
 expect(normalized.report.coordinates.map(c=>c.rowCode)).toEqual(FINREP_ROWS);expect(normalized.report.facts).toHaveLength(3);
 expect(normalized.report.contexts[0]?.contextId).toBe('finrep_'+file.source.id.replaceAll('-',''));
 expect(normalized.report.coordinates.every(c=>c.tableCode==='F_01.01'&&c.columnCode==='0010'&&c.decimals==='-1'&&c.sheetCode==='')).toBe(true);
 expect(normalized.report.facts[0]?.normalizedValue).toEqual({numerator:'0',denominator:'1'});
 expect(normalized.report.facts[1]?.normalizedValue).toEqual({numerator:'12345678901234567890123456789',denominator:'1000000'});
});
test.each([
 ['changed code',(x:string)=>corepReplaceCell(x,'B8',textCell('B8','9999'))],
 ['changed label',(x:string)=>corepReplaceCell(x,'C8',textCell('C8','Altered'))],
 ['formula',(x:string)=>corepReplaceCell(x,'F8','<c r="F8"><f>1+1</f><v>2</v></c>')],
 ['merge',(x:string)=>x.replace('</worksheet>','<mergeCells count="1"><mergeCell ref="F8:F9"/></mergeCells></worksheet>')],
 ['unexpected',(x:string)=>x.replace('</sheetData>','<row r="46">'+textCell('F46','1')+'</row></sheetData>')],
])('rejects FINREP %s before normalization',async(_name,mutate)=>{
 const file=await finrepFile(changeXml(await finrepParts(),'xl/worksheets/sheet1.xml',mutate));await expect(inspectReportWorkbook(file.path)).rejects.toMatchObject({code:'INVALID_WORKBOOK'});
});
test.each(['1,23',' 1','1e3','NULL'])('rejects invalid monetary text %s',async(value)=>{
 const file=await finrepFile(finrepValues(await finrepParts(),{'0010':value}));const inspected=await inspectReportWorkbook(file.path);expect(()=>normalizeInspectedReport(inspected,file.source,FINREP_FORM)).toThrowError('INVALID_WORKBOOK');
});
test('complete official book requires a recognized profile decision',async()=>{
 const code=await inspectReportWorkbook('tests/fixtures/eba/official-annexes-4.0.xlsx').then(()=>null,e=>e.code);expect(code).toBe('REPORT_PROFILE_REQUIRED');
});
test('explicit profile must be recognized and worksheet relationships may be relocated',async()=>{
 const parts=await finrepParts();const moved=parts.map(p=>p.name==='xl/worksheets/sheet1.xml'?{...p,name:'xl/worksheets/moved.xml'}:p);
 const file=await finrepFile(changeXml(changeXml(moved,'xl/_rels/workbook.xml.rels',x=>x.replace('worksheets/sheet1.xml','worksheets/moved.xml')),'[Content_Types].xml',x=>x.replace('/xl/worksheets/sheet1.xml','/xl/worksheets/moved.xml')));
 const result=await inspectReportWorkbook(file.path,{profileId:'eba-finrep-4.0-f0101-v1'});expect(result.preflight.sheets[0]?.part?.name).toBe('xl/worksheets/moved.xml');
 await expect(inspectReportWorkbook(file.path,{profileId:'eba-corep-of-4.0-ca1-v1'})).rejects.toMatchObject({code:'PROFILE_NOT_RECOGNIZED'});
});
test('workbook and form context agree, partial/reserved context and mixed declarations are rejected',async()=>{
 const parts=await readZipParts('assets/templates/finrep-f0101.xlsx'),blank=await finrepFile(parts),inspected=await inspectReportWorkbook(blank.path);
 expect(()=>normalizeInspectedReport(inspected,blank.source)).toThrowError('MISSING_CONTEXT');
 expect(normalizeInspectedReport(inspected,blank.source,FINREP_FORM).binding.contextOrigin).toBe('form');
 const values=['SYNTHETIC','2025-12-31','','EUR','3','2','false'];
 const declared=await finrepFile(changeXml(parts,'xl/worksheets/sheet2.xml',xml=>values.reduce((x,v,i)=>corepReplaceCell(x,'B'+(i+5),textCell('B'+(i+5),v)),xml)));
 const loaded=await inspectReportWorkbook(declared.path),normalized=normalizeInspectedReport(loaded,declared.source);
 expect(normalized.declaration).toMatchObject({framework:'FINREP',moduleVersion:'FINREP_F0101_4.0',scaleExponent:3,displayDecimals:2,filingIndicators:{'F_01.01':false}});
 expect(()=>normalizeInspectedReport(loaded,declared.source,FINREP_FORM)).toThrowError('CONTEXT_MISMATCH');
 for(const [address,value] of [['B5','partial'],['A1','Foreign'],['B2','unknown']]){
  const bad=await finrepFile(changeXml(parts,'xl/worksheets/sheet2.xml',x=>corepReplaceCell(x,address!,textCell(address!,value!))));await expect(inspectReportWorkbook(bad.path)).rejects.toBeInstanceOf(Error);
 }
 expect(()=>normalizeInspectedReport(inspected,blank.source,{...FINREP_FORM,scaleExponent:6,displayDecimals:-18})).toThrowError('INVALID_WORKBOOK');
 expect(normalizeInspectedReport(inspected,blank.source,{...FINREP_FORM,displayDecimals:'INF'}).report.coordinates.every(c=>c.decimals==='INF')).toBe(true);
});
test.each([['b','1'],['e','#VALUE!'],['d','2025-12-31']])('FINREP rejects %s monetary data',async(type,value)=>{
 const file=await finrepFile(changeXml(await finrepParts(),'xl/worksheets/sheet1.xml',x=>corepReplaceCell(x,'F8',`<c r="F8" t="${type}"><v>${value}</v></c>`)));
 const inspected=await inspectReportWorkbook(file.path);expect(()=>normalizeInspectedReport(inspected,file.source,FINREP_FORM)).toThrowError('INVALID_WORKBOOK');
});
test.each([9,14,46])('FINREP rejects monetary format %s',async(format)=>{
 let index=0;const styles=changeXml(await finrepParts(),'xl/styles.xml',x=>{index=Number(/<cellXfs count="(\d+)"/.exec(x)![1]);return x.replace(/<cellXfs count="\d+"/,`<cellXfs count="${index+1}"`).replace('</cellXfs>',`<xf numFmtId="${format}" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>`);});
 const file=await finrepFile(changeXml(styles,'xl/worksheets/sheet1.xml',x=>corepReplaceCell(x,'F8',`<c r="F8" s="${index}"><v>123</v></c>`)));const inspected=await inspectReportWorkbook(file.path);expect(()=>normalizeInspectedReport(inspected,file.source,FINREP_FORM)).toThrowError('INVALID_WORKBOOK');
});
test('FINREP preflight rejects unsafe parts even outside the selected sheet',async()=>{
 const parts=await finrepParts(true);
 for(const name of ['xl/vbaProject.bin','xl/connections.xml','xl/embeddings/object.bin']){const file=await finrepFile([...parts,{name,data:Buffer.from('<unsafe/>')}]);await expect(inspectReportWorkbook(file.path)).rejects.toMatchObject({code:'INVALID_WORKBOOK'});}
 const unsupported=await finrepFile([...parts,{name:'unsafe name.txt',data:Buffer.from('inert')}]);await expect(inspectReportWorkbook(unsupported.path)).rejects.toMatchObject({code:'INVALID_WORKBOOK'});
});
test('source-derived context IDs never permit duplicate business coordinates or incompatible batch entities/dates',async()=>{
 const catalog=await visualStaged('assets/demos/demo-finrep-catalog.xlsx','catalog'),parts=await finrepParts(),a=await finrepFile(parts),b=await finrepFile(parts);
 await expect(inspectWorkspace([catalog,{...a.source,path:a.path},{...b.source,path:b.path}],visualOperation,{source:'form',declaration:FINREP_FORM})).rejects.toMatchObject({code:'INVALID_WORKBOOK',details:{reason:'DUPLICATE_COORDINATE'}});
 const demo=await readZipParts('assets/demos/demo-finrep-report.xlsx'),first=await finrepFile(demo);
 for(const[address,value]of [['B5','OTHER_ENTITY'],['B6','2025-12-30']]){const second=await finrepFile(changeXml(demo,'xl/worksheets/sheet2.xml',x=>corepReplaceCell(x,address!,textCell(address!,value!))));
  await expect(inspectWorkspace([catalog,{...first.source,path:first.path},{...second.source,path:second.path}],visualOperation,{source:'workbook'})).rejects.toMatchObject({code:'INVALID_WORKBOOK',details:{reason:'INCOMPATIBLE_ENTITY_OR_DATE'}});
  const isolated=await inspectWorkspace([catalog,{...second.source,path:second.path}],visualOperation,{source:'workbook'});expect(isolated.content.coordinates).toHaveLength(38);
 }
});
test('numeric XML exponent is exact and declared precision is independent of presentation',async()=>{
 const file=await finrepFile(changeXml(await finrepParts(),'xl/worksheets/sheet1.xml',x=>corepReplaceCell(x,'F8','<c r="F8" t="n"><v>1.234E+2</v></c>'))),inspected=await inspectReportWorkbook(file.path);
 const n=normalizeInspectedReport(inspected,file.source,{...FINREP_FORM,scaleExponent:6,displayDecimals:0});expect(n.report.facts[0]?.normalizedValue).toEqual({numerator:'123400000',denominator:'1'});expect(n.report.coordinates[0]?.decimals).toBe('-6');
});
