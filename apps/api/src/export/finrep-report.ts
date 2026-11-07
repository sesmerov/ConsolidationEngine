import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { Entry,ZipFile } from 'yauzl';
import { isRationalValue } from '@ce/contracts';
import type { ImportContextFormDTO,SourceFile } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalStringify } from '../session/canonical-state.js';
import { inspectReportWorkbook,normalizeInspectedReport } from '../import/profiles/registry.js';
import { FINREP_MAPPING,FINREP_MAPPING_SHA256,FINREP_PROFILE_ID } from '../import/profiles/finrep-f0101.js';
import { COREP_CONTEXT_FIELDS } from '../import/profiles/context.js';
import { writeIncrementalParts } from './bounded-files.js';
import type { WrittenFile,WorkbookPart } from './bounded-files.js';
import type { ReportExportData } from './recalculated-report.js';
import { rightAlignedStyles } from './corep-report.js';
import { assertVisualCoordinate,invalidVisualReport,literalCell,replaceVisualCell,serializeWorkbookAmount,visualCellStyle,visualFacts,visualPartitionContext } from './visual-report-shared.js';
import type { VisualReportPartition } from './visual-report-shared.js';

export interface RetainedReportSource extends SourceFile { readonly path:string }
const MAIN='http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MAX_PART=64*1024*1024;
async function verifySource(source:RetainedReportSource,check:()=>void):Promise<void>{
 try{check();const stat=await lstat(source.path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==source.size||stat.size>10*1024*1024)return invalidVisualReport();
  let size=0;const hash=createHash('sha256');for await(const chunk of createReadStream(source.path,{highWaterMark:64*1024})){check();size+=chunk.length;if(size>source.size)return invalidVisualReport();hash.update(chunk);}
  if(size!==source.size||hash.digest('hex')!==source.sha256)return invalidVisualReport();
 }catch(error){if(error instanceof ApiError)throw error;return invalidVisualReport();}
}
/** Keeps only ZIP directory entries; each part is consumed with bounded buffers and verified CRC. */
async function openParts(location:string,check:()=>void){
 const zip=await new Promise<ZipFile>((resolve,reject)=>yauzl.open(location,{lazyEntries:true,strictFileNames:true,validateEntrySizes:true,autoClose:false},(error,value)=>error?reject(error):resolve(value)));
 const entries=new Map<string,Entry>();let active:Readable|undefined;
 try{await new Promise<void>((resolve,reject)=>{zip.on('error',reject);zip.on('end',resolve);zip.on('entry',(entry:Entry)=>{try{check();if(entries.has(entry.fileName)||entries.size>=2048||entry.uncompressedSize>MAX_PART||!/^[A-Za-z0-9_.\[\]-]+(?:\/[A-Za-z0-9_.\[\]-]+)*$/.test(entry.fileName))return reject(new ApiError('EXPORT_NOT_AVAILABLE'));entries.set(entry.fileName,entry);zip.readEntry();}catch(e){reject(e);}});zip.readEntry();});}
 catch(e){zip.close();throw e;}
 async function* chunks(name:string):AsyncGenerator<Buffer>{
  check();const entry=entries.get(name);if(!entry)return invalidVisualReport();let size=0,checksum=0;
  active=await new Promise<Readable>((resolve,reject)=>zip.openReadStream(entry,(error,stream)=>error?reject(error):resolve(stream)));
  try{for await(const chunk of active){check();const bytes=chunk as Buffer;size+=bytes.length;if(size>entry.uncompressedSize||size>MAX_PART)return invalidVisualReport();checksum=crc32(bytes,checksum);yield bytes;}if(size!==entry.uncompressedSize||checksum!==entry.crc32)return invalidVisualReport();}
  finally{active?.destroy();active=undefined;}
 }
 return {entries,chunks,async bytes(name:string){const buffers:Buffer[]=[];for await(const chunk of chunks(name))buffers.push(chunk);return Buffer.concat(buffers);},close(){active?.destroy();zip.close();}};
}
function contextXml(values:readonly string[]):Buffer{return Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="${MAIN}"><cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="70" customWidth="1"/></cols><sheetData><row r="1">${literalCell('A1','Campo')}${literalCell('B1','Valor')}</row>`+COREP_CONTEXT_FIELDS.map((label,i)=>`<row r="${i+2}">${literalCell('A'+(i+2),label)}${literalCell('B'+(i+2),values[i]!)}</row>`).join('')+'</sheetData></worksheet>');}
function appendBefore(xml:string,closing:string,content:string):string{const marker='</'+closing+'>';if(!xml.includes(marker))return invalidVisualReport();return xml.replace(marker,content+marker);}
function updateAppTitles(xml:string):string{
 const titles=/<TitlesOfParts\b[^>]*>[\s\S]*?<\/TitlesOfParts>/.exec(xml),headings=/<HeadingPairs\b[^>]*>[\s\S]*?<\/HeadingPairs>/.exec(xml);
 if(!titles)return xml;
 if(!headings)return invalidVisualReport();
 const vector=/<vt:vector\b[^>]*\bsize="(\d+)"[^>]*>/.exec(titles[0]);if(!vector)return invalidVisualReport();
 const replacement=titles[0].replace(vector[0],vector[0].replace(/\bsize="\d+"/,`size="${Number(vector[1])+1}"`)).replace('</vt:vector>','<vt:lpstr>Contexto</vt:lpstr></vt:vector>');
 const heading=headings[0].replace(/(<vt:lpstr>Worksheets<\/vt:lpstr><\/vt:variant><vt:variant><vt:i4>)(\d+)(<\/vt:i4>)/,(_m,a:string,n:string,b:string)=>a+(Number(n)+1)+b);
 if(heading===headings[0])return invalidVisualReport();return xml.replace(titles[0],replacement).replace(headings[0],heading);
}
/** Exports the retained workbook by a narrow patch, then reimports and verifies every part before publication. */
export async function writeFinrepReport(location:string,partition:VisualReportPartition,info:Pick<ReportExportData,'versionId'|'profileId'|'synthetic'>,source:RetainedReportSource,maximum:number,budget:{expandedBytes:number},maxExpandedBytes:number,check:()=>void):Promise<WrittenFile&{expandedBytes:number}>{
 if(!source||source.id!==partition.sourceFileId||source.kind!=='report'||info.profileId!=='ce-dpmxl-0.9-closed-v2')return invalidVisualReport();
 await verifySource(source,check);
 const context=visualPartitionContext(partition,{profileId:FINREP_PROFILE_ID,mappingSha256:FINREP_MAPPING_SHA256,contextId:'finrep_'+source.id.replaceAll('-',''),framework:'FINREP',moduleVersion:'FINREP_F0101_4.0',tableCode:'F_01.01',selectedSheet:'1.1'},check);
 const binding=partition.binding,scale=binding.scaleExponent,precision=binding.displayDecimals,unit=partition.coordinates[0]?.unit;
 if(![0,3,6].includes(scale as number)||precision!=='INF'&&(!Number.isInteger(precision)||precision!<-18||precision!>18)||!unit||!/^[A-Z]{3}$/.test(unit)||partition.coordinates.length!==38)return invalidVisualReport();
 const decimals=precision==='INF'?'INF':String(precision!-scale!);if(decimals!=='INF'&&(Number(decimals)<-18||Number(decimals)>18))return invalidVisualReport();
 const byRow=new Map(partition.coordinates.map(c=>[c.rowCode,c])),coordinates=new Map(partition.coordinates.map(c=>[c.factKey,c]));if(byRow.size!==38||coordinates.size!==38)return invalidVisualReport();
 for(const m of FINREP_MAPPING.mapping){const c=byRow.get(m.rowCode);if(!c)return invalidVisualReport();assertVisualCoordinate(c,context,source.id,{tableCode:m.tableCode,rowCode:m.rowCode,columnCode:m.columnCode,dataType:'number',unit,decimals});if(c.sourceLocator.sheet!=='1.1'||c.sourceLocator.column!=='B'||c.sourceLocator.row!==Number(m.codeCell.slice(1)))return invalidVisualReport();}
 const facts=visualFacts(partition,coordinates,check);for(const m of FINREP_MAPPING.mapping){const f=facts.get(byRow.get(m.rowCode)!.factKey);if(f&&(f.sourceLocator.sheet!=='1.1'||f.sourceLocator.column!=='F'||f.sourceLocator.row!==Number(m.amountCell.slice(1))))return invalidVisualReport();}
 const declaration:ImportContextFormDTO={entityId:context.entityId,referenceDate:context.referenceDate,...(context.submissionDate?{submissionDate:context.submissionDate}:{}),currency:unit,scaleExponent:scale!,displayDecimals:precision!,filingIndicators:context.filingIndicators};
 const inspected=await inspectReportWorkbook(source.path,{profileId:FINREP_PROFILE_ID,check}),original=normalizeInspectedReport(inspected,source,declaration,{check});
 if(canonicalStringify(original.binding.excludedSheets)!==canonicalStringify(binding.excludedSheets))return invalidVisualReport();
 const originalFacts=new Map(original.report.facts.map(f=>[f.factKey,f])),archive=await openParts(source.path,check),patches=new Map<string,Buffer>(),expected=new Map<string,{size:number;sha256:string}>();
 try{
  const selected=inspected.preflight.sheets.find(s=>s.name==='1.1')!,selectedPart=selected.part!.name;
  let sheet=(await archive.bytes(selectedPart)).toString('utf8');const styles=rightAlignedStyles((await archive.bytes('xl/styles.xml')).toString('utf8'));let changed=false;
  for(const m of FINREP_MAPPING.mapping){check();const key=byRow.get(m.rowCode)!.factKey,f=facts.get(key),before=originalFacts.get(key);if(canonicalStringify(f?.normalizedValue??null)===canonicalStringify(before?.normalizedValue??null)&&f?.presence===before?.presence)continue;
   const style=visualCellStyle(sheet,m.amountCell);let cell:string;
   if(!f)cell=`<c r="${m.amountCell}"${style===undefined?'':` s="${style}"`}/>`;
   else {if(f.presence!=='value'||!isRationalValue(f.normalizedValue))return invalidVisualReport();const value=serializeWorkbookAmount(f.normalizedValue,scale!,check);cell=value.type==='number'?`<c r="${m.amountCell}"${style===undefined?'':` s="${style}"`} t="n"><v>${value.text}</v></c>`:literalCell(m.amountCell,value.text,styles.style(style));}
   sheet=replaceVisualCell(sheet,m.amountCell,cell);changed=true;
  }
  if(changed)patches.set(selectedPart,Buffer.from(sheet));
  const oldStyles=await archive.bytes('xl/styles.xml'),newStyles=Buffer.from(styles.xml());if(!oldStyles.equals(newStyles))patches.set('xl/styles.xml',newStyles);
  const values=[FINREP_PROFILE_ID,'FINREP','FINREP_F0101_4.0',context.entityId,context.referenceDate,context.submissionDate??'',unit,String(scale),String(precision),String(context.filingIndicators['F_01.01'])];
  const existingContext=inspected.preflight.sheets.find(s=>s.name==='Contexto');let contextPart=existingContext?.part!.name;
  if(!contextPart){
   let workbook=(await archive.bytes('xl/workbook.xml')).toString('utf8'),relations=(await archive.bytes('xl/_rels/workbook.xml.rels')).toString('utf8'),types=(await archive.bytes('[Content_Types].xml')).toString('utf8');
   const ids=new Set([...relations.matchAll(/\bId="([^"]+)"/g)].map(m=>m[1]));let n=1;while(archive.entries.has(`xl/worksheets/ce-context-${n}.xml`))n++;contextPart=`xl/worksheets/ce-context-${n}.xml`;let rel=1;while(ids.has('ceContext'+rel))rel++;
   const sheetIds=[...workbook.matchAll(/\bsheetId="(\d+)"/g)].map(m=>Number(m[1]));const sheetId=Math.max(0,...sheetIds)+1;
   workbook=appendBefore(workbook,'sheets',`<sheet name="Contexto" sheetId="${sheetId}" r:id="ceContext${rel}"/>`);
   relations=appendBefore(relations,'Relationships',`<Relationship Id="ceContext${rel}" Type="${REL}/worksheet" Target="worksheets/ce-context-${n}.xml"/>`);
   types=appendBefore(types,'Types',`<Override PartName="/${contextPart}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
   patches.set('xl/workbook.xml',Buffer.from(workbook));patches.set('xl/_rels/workbook.xml.rels',Buffer.from(relations));patches.set('[Content_Types].xml',Buffer.from(types));
   if(archive.entries.has('docProps/app.xml')){const xml=(await archive.bytes('docProps/app.xml')).toString('utf8'),next=updateAppTitles(xml);if(xml!==next)patches.set('docProps/app.xml',Buffer.from(next));}
  }
  patches.set(contextPart,contextXml(values));
  const parts:WorkbookPart[]=[];
  for(const name of new Set([...archive.entries.keys(),...patches.keys()])){
   const patch=patches.get(name);
   async function* measured():AsyncGenerator<Buffer>{const hash=createHash('sha256');let size=0;for await(const bytes of patch?[patch]:archive.chunks(name)){check();size+=bytes.length;hash.update(bytes);yield bytes;}expected.set(name,{size,sha256:hash.digest('hex')});}
   parts.push({name,chunks:measured()});
  }
  const output=await writeIncrementalParts(location,parts,maximum,budget,maxExpandedBytes,check);
  await verifySource(source,check);
  await verifyFinrepOutput(location,partition,declaration,expected,check);
  await verifySource({...source,path:location,size:output.size,sha256:output.sha256},check);
  return output;
 }catch(error){if(error instanceof ApiError)throw error;return invalidVisualReport();}finally{archive.close();}
}
/** Separate final-file check: structural, semantic and byte-for-byte part preservation. */
export async function verifyFinrepOutput(location:string,partition:VisualReportPartition,declaration:ImportContextFormDTO,expected:ReadonlyMap<string,{size:number;sha256:string}>,check:()=>void):Promise<void>{
 const inspected=await inspectReportWorkbook(location,{check}),source:SourceFile={id:partition.sourceFileId,displayName:'verification.xlsx',kind:'report',size:1,sha256:'0'.repeat(64),importedAt:'2026-11-07T00:00:00.000Z'};
 if(inspected.profileId!==FINREP_PROFILE_ID)return invalidVisualReport();
 const restored=normalizeInspectedReport(inspected,source,undefined,{check});
 const business=(items:readonly {factKey:string;normalizedValue?:unknown;presence?:string}[])=>items.map(i=>[i.factKey,i.presence??null,i.normalizedValue??null]).sort(([a],[b])=>String(a).localeCompare(String(b)));
 if(canonicalStringify(business(restored.report.facts))!==canonicalStringify(business(partition.facts))||canonicalStringify(restored.report.contexts.map(({filingIndicatorsLocator:_loc,...c})=>c))!==canonicalStringify(partition.contexts.map(({filingIndicatorsLocator:_loc,...c})=>c)))return invalidVisualReport();
 if(restored.declaration.currency!==declaration.currency||restored.declaration.scaleExponent!==declaration.scaleExponent||restored.declaration.displayDecimals!==declaration.displayDecimals)return invalidVisualReport();
 if(restored.report.coordinates.length!==38||restored.report.coordinates.some(c=>!partition.coordinates.some(p=>p.factKey===c.factKey&&p.dataType===c.dataType&&p.unit===c.unit&&p.decimals===c.decimals)))return invalidVisualReport();
 const archive=await openParts(location,check);
 try{if(archive.entries.size!==expected.size)return invalidVisualReport();for(const[name,target]of expected){check();if(!archive.entries.has(name))return invalidVisualReport();let size=0;const hash=createHash('sha256');for await(const bytes of archive.chunks(name)){size+=bytes.length;hash.update(bytes);}if(size!==target.size||hash.digest('hex')!==target.sha256)return invalidVisualReport();}}
 finally{archive.close();}
}
