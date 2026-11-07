import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ImportContextFormDTO, SourceFile } from '@ce/contracts';
import { changeXml, readZipParts, textCell, zipBytes } from './xlsx-fixtures.js';
import type { ZipPart } from './xlsx-fixtures.js';
import { corepReplaceCell } from './corep-fixtures.js';

export const FINREP_ROWS = ['0010','0020','0030','0040','0050','0060','0070','0080','0090','0096','0097','0098','0099','0100','0120','0130','0141','0142','0143','0144','0181','0182','0183','0240','0250','0260','0270','0280','0290','0300','0310','0320','0330','0340','0350','0360','0370','0380'] as const;
export const FINREP_FORM: ImportContextFormDTO = { entityId: 'SYNTHETIC', referenceDate: '2025-12-31', currency: 'EUR', scaleExponent: 0, displayDecimals: 2, filingIndicators: { 'F_01.01': true } };
const directory = path.resolve('.cache/finrep-profile-tests'), created: string[] = [];
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
/** Independent fixture: selects the official sheet by workbook relationship, not production mapping. */
export async function finrepParts(sentinel = false): Promise<ZipPart[]> {
  const file = path.resolve('tests/fixtures/eba/official-annexes-4.0.xlsx');
  if (createHash('sha256').update(await readFile(file)).digest('hex') !== 'f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7') throw new Error('Changed FINREP source');
  const original = await readZipParts(file), get = (name: string) => original.find(part => part.name === name)!.data;
  const entry = get('xl/workbook.xml').toString().match(/<sheet\b(?=[^>]*\bname="1\.1")[^>]*>/)![0], id = /\br:id="([^"]+)"/.exec(entry)![1];
  const relationship = get('xl/_rels/workbook.xml.rels').toString().match(new RegExp('<Relationship\\b(?=[^>]*\\bId="' + id + '")[^>]*>'))![0];
  const target = /\bTarget="([^"]+)"/.exec(relationship)![1], source = path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
  const names = sentinel ? ['1.1', 'Notas'] : ['1.1'];
  const parts: ZipPart[] = [
    { name: '[Content_Types].xml', data: Buffer.from('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' + names.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') },
    { name: '_rels/.rels', data: Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: Buffer.from(`<workbook xmlns="${MAIN}" xmlns:r="${REL}"><sheets>` + names.map((name, i) => `<sheet name="${name}" sheetId="${i+1}" r:id="rId${i+1}"/>`).join('') + '</sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((_, i) => `<Relationship Id="rId${i+1}" Type="${REL}/worksheet" Target="worksheets/sheet${i+1}.xml"/>`).join('') + `<Relationship Id="styles" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="strings" Type="${REL}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: get('xl/styles.xml') }, { name: 'xl/sharedStrings.xml', data: get('xl/sharedStrings.xml') }, { name: 'xl/worksheets/sheet1.xml', data: get(source) },
  ];
  if (sentinel) parts.push({ name: 'xl/worksheets/sheet2.xml', data: Buffer.from(`<worksheet xmlns="${MAIN}"><sheetData><row r="1">${textCell('A1', 'EXCLUDED_SENTINEL')}<c r="B1"><f>1+1</f><v>2</v></c></row></sheetData></worksheet>`) });
  return parts.map(part => ({ ...part, compress: true }));
}
export function finrepValues(parts: readonly ZipPart[], values: Readonly<Record<string,string>>): ZipPart[] {
  return changeXml(parts, 'xl/worksheets/sheet1.xml', xml => Object.entries(values).reduce((next,[row,value]) => {
    const index = FINREP_ROWS.indexOf(row as typeof FINREP_ROWS[number]); if(index < 0) throw new Error('Unknown fixture row');
    const address='F'+(index+8); return corepReplaceCell(next,address,value === '' ? `<c r="${address}"/>` : textCell(address,value));
  }, xml));
}
export async function finrepFile(parts: readonly ZipPart[], name = 'finrep.xlsx'): Promise<{path:string;source:SourceFile}> {
  await mkdir(directory,{recursive:true}); const id=randomUUID(), location=path.join(directory,id+'.xlsx'), bytes=zipBytes(parts);
  await writeFile(location,bytes); created.push(location);
  return {path:location,source:{id,sha256:createHash('sha256').update(bytes).digest('hex'),displayName:name,kind:'report',size:bytes.length,importedAt:'2026-11-07T00:00:00.000Z'}};
}
export async function cleanupFinrepFiles(): Promise<void> { for(const file of created.splice(0)){if(path.dirname(file)!==directory)throw new Error('Invalid cleanup path');await rm(file,{force:true});} }
