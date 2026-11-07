import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiError } from '../../errors.js';
import { immutable } from '../../session/canonical-state.js';
import type { PreflightWorkbook } from '../xlsx-preflight.js';
export const FINREP_PROFILE_ID = 'eba-finrep-4.0-f0101-v1' as const;
export const FINREP_LANGUAGE_PROFILE_ID = 'ce-dpmxl-0.9-closed-v2' as const;
export const FINREP_MODULE = 'FINREP_F0101_4.0';
interface MappingCell { readonly rowCode:string;readonly columnCode:string;readonly tableCode:string;readonly sheetCode:string;readonly sheet:string;readonly codeCell:string;readonly labelCell:string;readonly amountCell:string;readonly label:string }
const bytes=readFileSync(new URL('./finrep-f0101-mapping.json',import.meta.url));
export const FINREP_MAPPING=immutable(JSON.parse(bytes.toString('utf8')) as { readonly profileId:string;readonly structureSignature:string;readonly structureAnchors:readonly (readonly [string,string])[];readonly expectedMerges:readonly string[];readonly mapping:readonly MappingCell[] });
export const FINREP_MAPPING_SHA256=createHash('sha256').update(bytes).digest('hex');
const signature=(anchors:readonly (readonly [string,string])[])=>createHash('sha256').update(JSON.stringify([...anchors].sort(([a],[b])=>a<b?-1:a>b?1:0))).digest('hex');
if(FINREP_MAPPING.profileId!==FINREP_PROFILE_ID||FINREP_MAPPING.mapping.length!==38||FINREP_MAPPING.structureAnchors.length!==144||signature(FINREP_MAPPING.structureAnchors)!==FINREP_MAPPING.structureSignature)throw new Error('Invalid trusted FINREP mapping asset');
export function recognizeFinrepStructure(workbook:PreflightWorkbook):void {
 const invalid=(reason:string,address?:string):never=>{throw new ApiError('INVALID_WORKBOOK',{reason},{sheet:'1.1',...(address?{column:address.replace(/\d+$/,''),row:Number(address.replace(/^[A-Z]+/,''))}:{})});};
 const sheet=workbook.sheets.find(s=>s.name==='1.1');if(!sheet)invalid('MISSING_FINREP_F0101');
 if(workbook.writerCompatibleParts===false)invalid('FINREP_PART_NAMES');
 if(sheet!.formulaCount||sheet!.mergeRanges?.length)invalid('ALTERED_FINREP_MERGES_OR_FORMULAS');
 const anchors:[string,string][]=[];
 for(const [address,expected] of FINREP_MAPPING.structureAnchors){const cell=sheet!.cells[address];const numericReference=cell?.xmlType==='n'&&address.startsWith('E')&&/^[0-9]+(?:\.[0-9]+)?$/.test(expected);if(!cell||cell.text!==expected||!['s','str','inlineStr'].includes(cell.xmlType)&&!numericReference)invalid('ALTERED_FINREP_ANCHOR',address);anchors.push([address,cell!.text]);}
 if(signature(anchors)!==FINREP_MAPPING.structureSignature)invalid('ALTERED_FINREP_SIGNATURE');
 const allowed=new Set([...FINREP_MAPPING.structureAnchors.map(([a])=>a),...FINREP_MAPPING.mapping.map(m=>m.amountCell)]);
 for(const cell of Object.values(sheet!.cells))if(!allowed.has(cell.address)&&(cell.text!==''||cell.lexeme!==''))invalid('UNEXPECTED_FINREP_CONTENT',cell.address);
 if(!workbook.sheets.some(s=>s.name==='Contexto')&&workbook.sheets.length>=256)invalid('FINREP_CONTEXT_SHEET_LIMIT');
}
