import { randomUUID, createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { SourceFile } from '@ce/contracts';
import { changeXml, readZipParts, zipBytes } from './xlsx-fixtures.js';
import type { ZipPart } from './xlsx-fixtures.js';
export const corepFixtureDirectory = path.resolve('.cache/corep-profile-tests');
const created: string[] = [];
export async function cleanupCorepFiles(): Promise<void> {
  for (const file of created.splice(0)) { if (path.dirname(file) !== corepFixtureDirectory) throw new Error('Invalid fixture cleanup target'); await rm(file, { force: true }); }
}
export const corepAmount = (address: string, content: string, type = 'n', style?: number): string => `<c r="${address}"${style === undefined ? '' : ` s="${style}"`} t="${type}">${type === 'inlineStr' ? '<is><t>' + content + '</t></is>' : '<v>' + content + '</v>'}</c>`;
export function corepReplaceCell(xml: string, address: string, replacement: string): string {
  const pattern = new RegExp('<c\\b(?=[^>]*\\br="' + address + '")(?:[^>]*\\/>|[^>]*>[\\s\\S]*?</c>)');
  if (!pattern.test(xml)) {
    const row = new RegExp('(<row\\b[^>]*\\br="' + address.replace(/^[A-Z]+/, '') + '"[^>]*>[\\s\\S]*?)(</row>)');
    if (!row.test(xml)) throw new Error('Missing COREP fixture row ' + address);
    return xml.replace(row, (_match, start: string, end: string) => start + replacement + end);
  }
  return xml.replace(pattern, replacement);
}
export async function corepParts(file = 'assets/templates/corep-ca1.xlsx'): Promise<ZipPart[]> { return readZipParts(path.resolve(file)); }
export function corepChange(parts: readonly ZipPart[], transform: (xml: string) => string, sheet = 'xl/worksheets/sheet1.xml'): ZipPart[] { return changeXml(parts, sheet, transform); }
export async function corepFile(parts: readonly ZipPart[], name = 'corep.xlsx'): Promise<{ path: string; source: SourceFile }> {
  await mkdir(corepFixtureDirectory, { recursive: true }); const id = randomUUID(), location = path.join(corepFixtureDirectory, id + '.xlsx'), bytes = zipBytes(parts);
  await writeFile(location, bytes); created.push(location); return { path: location, source: { id, sha256: createHash('sha256').update(bytes).digest('hex'), displayName: name, kind: 'report', size: bytes.length, importedAt: '2026-11-04T00:00:00.000Z' } };
}
