import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ApiError } from '../../errors.js';
import { immutable } from '../../session/canonical-state.js';
import type { PreflightWorkbook } from '../xlsx-preflight.js';

export interface CorepMappingCell {
  readonly rowCode: string; readonly columnCode: string; readonly tableCode: string; readonly sheetCode: string;
  readonly sheet: string; readonly amountCell: string; readonly labelCell: string; readonly codeCell: string;
  readonly itemId: string; readonly label: string; readonly dataType: 'number'; readonly unitKind: 'currency';
  readonly dpmDataPointId: string; readonly annotationCell: string; readonly annotationTypeMarker: string; readonly annotationLabel: string;
}
interface MappingManifest {
  readonly profileId: 'eba-corep-of-4.0-ca1-v1'; readonly structureSignature: string;
  readonly structureAnchors: readonly (readonly [string, string])[]; readonly expectedMerges: readonly string[];
  readonly expectedFullWorkbookSheetNames: readonly string[]; readonly mapping: readonly CorepMappingCell[];
  readonly official: { readonly sha256: string }; readonly annotated: { readonly sha256: string };
}
const bytes = readFileSync(new URL('./corep-ca1-mapping.json', import.meta.url));
export const COREP_MAPPING = immutable(JSON.parse(bytes.toString('utf8')) as MappingManifest);
export const COREP_MAPPING_SHA256 = createHash('sha256').update(bytes).digest('hex');
export const COREP_PROFILE_ID = 'eba-corep-of-4.0-ca1-v1' as const;
export const COREP_LANGUAGE_PROFILE_ID = 'ce-dpmxl-0.9-closed-v2' as const;
export const COREP_OWN_SHEETS = ['Contexto', 'Instrucciones'] as const;
const signature = (anchors: readonly (readonly [string, string])[]) => createHash('sha256').update(JSON.stringify([...anchors].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))).digest('hex');
if (COREP_MAPPING.profileId !== COREP_PROFILE_ID || COREP_MAPPING.mapping.length !== 110 || COREP_MAPPING.structureAnchors.length !== 335
  || signature(COREP_MAPPING.structureAnchors) !== COREP_MAPPING.structureSignature) throw new Error('Invalid trusted COREP mapping asset');

/** Recognition is mandatory before any COREP-specific XML exception is accepted. Labels are anchors, never identities. */
export function recognizeCorepStructure(workbook: PreflightWorkbook): void {
  const invalid = (reason: string, address?: string): never => { throw new ApiError('INVALID_WORKBOOK', { reason }, { sheet: 'CA1', ...(address ? { column: address.replace(/\d+$/, ''), row: Number(address.replace(/^[A-Z]+/, '')) } : {}) }); };
  const regulatory = workbook.sheets.filter(sheet => !(COREP_OWN_SHEETS as readonly string[]).includes(sheet.name));
  const names = new Set(regulatory.map(sheet => sheet.name));
  if (names.size !== regulatory.length || !(names.size === 1 && names.has('CA1')
    || names.size === COREP_MAPPING.expectedFullWorkbookSheetNames.length && COREP_MAPPING.expectedFullWorkbookSheetNames.every(name => names.has(name)))) invalid('UNRECOGNIZED_COREP_SHEETS');
  const ca1 = workbook.sheets.find(sheet => sheet.name === 'CA1'); if (!ca1) invalid('MISSING_CA1');
  if (ca1!.formulaCount || JSON.stringify([...(ca1!.mergeRanges ?? [])].sort()) !== JSON.stringify([...COREP_MAPPING.expectedMerges].sort())) invalid('ALTERED_CA1_MERGES_OR_FORMULAS');
  const anchors: [string, string][] = [];
  for (const [address, expected] of COREP_MAPPING.structureAnchors) {
    const cell = ca1!.cells[address];
    const textType = cell && ['s', 'inlineStr', 'str'].includes(cell.xmlType);
    const itemNumber = cell?.xmlType === 'n' && address.startsWith('C') && /^[0-9]+(?:\.[0-9]+)?$/.test(expected);
    if (!cell || cell.text !== expected || !textType && !itemNumber) invalid('ALTERED_CA1_ANCHOR', address);
    anchors.push([address, cell!.text]);
  }
  if (signature(anchors) !== COREP_MAPPING.structureSignature) invalid('ALTERED_CA1_SIGNATURE');
  const allowed = new Set([...COREP_MAPPING.structureAnchors.map(([address]) => address), ...COREP_MAPPING.mapping.map(cell => cell.amountCell)]);
  for (const cell of Object.values(ca1!.cells)) if (!allowed.has(cell.address) && (cell.text !== '' || cell.lexeme !== '')) invalid('UNEXPECTED_CA1_CONTENT', cell.address);
}
