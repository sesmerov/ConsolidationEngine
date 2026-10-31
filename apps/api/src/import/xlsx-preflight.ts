import { stat } from 'node:fs/promises';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import type { Entry, ZipFile } from 'yauzl';
import sax from 'sax';
import type { QualifiedTag } from 'sax';
import { ApiError } from '../errors.js';
import { decodeSpreadsheetText } from './ooxml-text.js';

export interface RawCell { readonly address: string; readonly row: number; readonly column: number; readonly xmlType: string; readonly lexeme: string; readonly text: string; readonly style?: string }
export interface VerifiedSheetPart { readonly name: string; readonly crc32: number; readonly expandedBytes: number }
export interface RawSheet { readonly name: string; readonly cells: Readonly<Record<string, RawCell>>; readonly maxRow: number; readonly maxColumn: number; readonly merged: boolean; readonly part?: VerifiedSheetPart; readonly fragmentedRows?: Readonly<Record<number, number>> }
export interface PreflightWorkbook { readonly date1904: boolean; readonly sheets: readonly RawSheet[]; readonly expandedBytes: number; readonly compressedBytes: number; readonly sharedStrings?: readonly string[]; readonly styleCount?: number }
export const PREFLIGHT_LIMITS = { maxCompressedBytes: 10 * 1024 * 1024, maxEntryBytes: 64 * 1024 * 1024, maxExpandedBytes: 100 * 1024 * 1024,
  maxEntries: 2048, maxSheets: 64, maxSharedStrings: 500_000, maxCellChars: 32_767, maxXmlDepth: 64, maxRows: 200_001, maxColumns: 64 } as const;
export type PreflightLimits = { [K in keyof typeof PREFLIGHT_LIMITS]: number };
export interface PreflightOptions { readonly limits?: Partial<PreflightLimits>; readonly budget?: { expandedBytes: number }; readonly retainCells?: boolean; readonly check?: () => void }
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const STRICT_MAIN = 'http://purl.oclc.org/ooxml/spreadsheetml/main';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const invalid = (): never => { throw new ApiError('INVALID_WORKBOOK'); };
const expansion = (): never => { throw new ApiError('EXPANSION_LIMIT'); };
interface SheetPart { cells: Record<string, RawCell>; maxRow: number; maxColumn: number; merged: boolean; maxStyle: number; maxShared: number; fragmentedRows: Record<number, number> }
interface Relationship { source: string; id: string; type: string; target: string; external: boolean }
function attribute(node: QualifiedTag, name: string): string | undefined { return node.attributes[name]?.value; }
function address(value: string, limits: PreflightLimits): { row: number; column: number } {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(value); if (!match) return invalid();
  let column = 0; for (const letter of match[1]!) column = column * 26 + letter.charCodeAt(0) - 64;
  const row = Number(match[2]); if (row > limits.maxRows || column > limits.maxColumns) return expansion();
  return { row, column };
}
function normalizedName(name: string): string {
  if (!name || name.includes('\\') || name.includes('\0') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) return invalid();
  const stripped = name.endsWith('/') ? name.slice(0, -1) : name;
  if (stripped.split('/').some((part) => !part || part === '.' || part === '..')) return invalid();
  return stripped.normalize('NFC');
}
function relationSource(name: string): string {
  if (name === '_rels/.rels') return '';
  const match = /^(.*\/)?_rels\/([^/]+)\.rels$/.exec(name); if (!match) return invalid();
  return (match[1] ?? '') + match[2];
}
function resolvePart(source: string, target: string): string {
  let decoded: string; try { decoded = decodeURIComponent(target.split('#')[0]!); } catch { return invalid(); }
  if (!decoded || decoded.includes('\\') || decoded.includes('\0') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(decoded) || decoded.includes('?')) return invalid();
  const resolved = path.posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : path.posix.join(path.posix.dirname(source), decoded));
  if (resolved === '..' || resolved.startsWith('../') || resolved.startsWith('/')) return invalid();
  return normalizedName(resolved);
}
export async function preflightXlsx(filePath: string, options: PreflightOptions = {}): Promise<PreflightWorkbook> {
  options.check?.();
  const limits: PreflightLimits = { ...PREFLIGHT_LIMITS, ...options.limits };
  for (const key of Object.keys(limits) as (keyof PreflightLimits)[]) if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > PREFLIGHT_LIMITS[key]) throw new ApiError('INTERNAL_ERROR');
  const compressedBytes = (await stat(filePath)).size; if (compressedBytes > limits.maxCompressedBytes) throw new ApiError('UPLOAD_LIMIT');
  const budget = options.budget ?? { expandedBytes: 0 }; const initialBytes = budget.expandedBytes;
  const names = new Set<string>(); const parts = new Map<string, SheetPart>(); const strings: string[] = [];
  const relationships: Relationship[] = []; const sheets: { name: string; relationId: string }[] = [];
  const contentTypes = new Map<string, string>(), verifiedParts = new Map<string, VerifiedSheetPart>(); let date1904 = false; let workbookPart: string | undefined; let styleCount = 0; let entries = 0;
  let active: Readable | undefined; let zip: ZipFile | undefined;
  function xmlParser(name: string) {
    const xmlOptions = { xmlns: true, strictEntities: true, trim: false, normalize: false };
    const parser = sax.parser(true, xmlOptions); const stack: QualifiedTag[] = [];
    const sheet: SheetPart = { cells: Object.create(null) as Record<string, RawCell>, maxRow: 0, maxColumn: 0, merged: false, maxStyle: -1, maxShared: -1, fragmentedRows: {} };
    let occupied: Uint8Array | undefined; let seenRows: Uint8Array | undefined;
    let kind = ''; let cell: { address: string; row: number; column: number; xmlType: string; lexeme: string; text: string; style?: string } | undefined;
    let shared: string | undefined; let rowIndex = 0;
    parser.onerror = () => invalid(); parser.ondoctype = () => invalid(); parser.onsgmldeclaration = () => invalid();
    parser.onprocessinginstruction = (instruction) => { if (instruction.name.toLowerCase() !== 'xml') invalid(); };
    parser.onopentag = (element) => {
      const node = element as QualifiedTag; stack.push(node); if (stack.length > limits.maxXmlDepth) expansion();
      if (stack.length === 1) {
        kind = node.local;
        if (kind === 'worksheet') { occupied = new Uint8Array(Math.ceil(limits.maxRows * limits.maxColumns / 8)); seenRows = new Uint8Array(Math.ceil(limits.maxRows / 8)); }
        if (['worksheet', 'workbook', 'sst', 'styleSheet'].includes(kind) && node.uri !== MAIN && node.uri !== STRICT_MAIN) invalid();
        if (kind === 'Relationships' && node.uri !== REL) invalid();
      }
      if (kind === 'Relationships' && node.local === 'Relationship') {
        const id = attribute(node, 'Id'), type = attribute(node, 'Type'), target = attribute(node, 'Target'); if (!id || !type || !target) invalid();
        const source = relationSource(name);
        if (relationships.some((item) => item.source === source && item.id === id)) invalid();
        const external = attribute(node, 'TargetMode') === 'External';
        if ((external && !type!.endsWith('/hyperlink')) || /(?:vba|macro|oleObject|activeX|externalLink|queryTable|connections)/i.test(type!)) invalid();
        relationships.push({ source, id: id!, type: type!, target: target!, external });
      }
      if (kind === 'Types' && node.local === 'Override') {
        const part = attribute(node, 'PartName'), type = attribute(node, 'ContentType'); if (!part || !type) invalid();
        if (/(?:macroEnabled|vba|oleObject|activeX|externalLink)/i.test(type!)) invalid();
        const normalized = resolvePart('', part!); if (contentTypes.has(normalized)) invalid(); contentTypes.set(normalized, type!);
      }
      if (kind === 'Types' && node.local === 'Default' && /(?:macroEnabled|vba|oleObject|activeX)/i.test(attribute(node, 'ContentType') ?? '')) invalid();
      if (kind === 'workbook') {
        if (workbookPart && workbookPart !== name) invalid(); workbookPart = name;
        if (node.local === 'workbookPr') { const epoch = attribute(node, 'date1904'); if (epoch && !['0', '1', 'true', 'false'].includes(epoch)) invalid(); date1904 = epoch === '1' || epoch === 'true'; }
        if (node.local === 'sheet') {
          const sheetName = attribute(node, 'name'); const relationId = Object.values(node.attributes).find((item) => item.local === 'id')?.value;
          if (!sheetName || !relationId || sheets.some((item) => item.name === sheetName)) invalid();
          sheets.push({ name: sheetName!, relationId: relationId! }); if (sheets.length > limits.maxSheets) expansion();
        }
      }
      if (kind === 'styleSheet' && node.local === 'xf' && stack.at(-2)?.local === 'cellXfs') styleCount++;
      if (kind === 'sst' && node.local === 'si') { if (shared !== undefined) invalid(); shared = ''; if (strings.length >= limits.maxSharedStrings) expansion(); }
      if (kind === 'worksheet') {
        if (node.local === 'f') invalid();
        if (node.local === 'mergeCell') sheet.merged = true;
        if (node.local === 'dimension') {
          const range = attribute(node, 'ref'); if (!range) invalid(); const pieces = range!.split(':'); if (pieces.length > 2) invalid(); for (const end of pieces) address(end, limits);
        }
        if (node.local === 'row') { const raw = attribute(node, 'r'); if (!raw || !/^[1-9][0-9]*$/.test(raw)) invalid(); rowIndex = Number(raw); if (rowIndex > limits.maxRows) expansion(); sheet.maxRow = Math.max(sheet.maxRow, rowIndex);
          const bit = rowIndex - 1; if (seenRows![bit >>> 3]! & 1 << (bit & 7)) sheet.fragmentedRows[rowIndex] = (sheet.fragmentedRows[rowIndex] ?? 1) + 1;
          seenRows![bit >>> 3] = seenRows![bit >>> 3]! | 1 << (bit & 7);
        }
        if (node.local === 'c') {
          const ref = attribute(node, 'r'); if (!ref || cell) invalid(); const position = address(ref!, limits);
          const bit = (position.row - 1) * limits.maxColumns + position.column - 1;
          if (position.row !== rowIndex || occupied![bit >>> 3]! & 1 << (bit & 7)) invalid();
          occupied![bit >>> 3] = occupied![bit >>> 3]! | 1 << (bit & 7); const type = attribute(node, 't') ?? 'n';
          if (!['n', 'b', 's', 'inlineStr', 'str', 'e', 'd'].includes(type)) invalid();
          const style = attribute(node, 's'); if (style !== undefined && !/^(0|[1-9][0-9]*)$/.test(style)) invalid();
          if (style !== undefined) sheet.maxStyle = Math.max(sheet.maxStyle, Number(style));
          cell = { address: ref!, ...position, xmlType: type, lexeme: '', text: '', ...(style !== undefined ? { style } : {}) };
          sheet.maxColumn = Math.max(sheet.maxColumn, position.column);
        }
      }
    };
    const textValue = (value: string) => {
      const node = stack.at(-1);
      if (shared !== undefined && node?.local === 't' && !stack.some((item) => item.local === 'rPh')) { shared += value; if (shared.length > 7 * limits.maxCellChars) expansion(); }
      if (cell && node?.local === 'v') { cell.lexeme += value; if (cell.lexeme.length > limits.maxCellChars * (cell.xmlType === 'str' ? 7 : 1)) expansion(); }
      if (cell && node?.local === 't' && !stack.some((item) => item.local === 'rPh')) { cell.text += value; if (cell.text.length > 7 * limits.maxCellChars) expansion(); }
    };
    parser.ontext = textValue; parser.oncdata = textValue;
    parser.onclosetag = () => {
      const node = stack.pop();
      if (kind === 'sst' && node?.local === 'si') { if (shared === undefined) invalid(); const value = decodeSpreadsheetText(shared!); if (value.length > limits.maxCellChars) expansion(); strings.push(value); shared = undefined; }
      if (kind === 'worksheet' && node?.local === 'c') {
        if (!cell) invalid(); if (cell!.xmlType !== 'inlineStr') cell!.text = cell!.lexeme;
        if (cell!.xmlType === 'inlineStr') cell!.lexeme = cell!.text;
        if (cell!.xmlType === 'inlineStr' || cell!.xmlType === 'str') cell!.text = decodeSpreadsheetText(cell!.text);
        if (cell!.text.length > limits.maxCellChars) expansion();
        if (cell!.xmlType === 's') { if (!/^(0|[1-9][0-9]{0,8})$/.test(cell!.lexeme)) invalid(); sheet.maxShared = Math.max(sheet.maxShared, Number(cell!.lexeme)); }
        if (options.retainCells !== false || cell!.row === 1) sheet.cells[cell!.address] = cell!; cell = undefined;
      }
      if (node?.local === 'row') rowIndex = 0;
    };
    return { write: (text: string) => { options.check?.(); parser.write(text); }, close: () => {
      parser.close(); if (stack.length) invalid(); if (kind === 'worksheet') parts.set(name, sheet); occupied = undefined; seenRows = undefined;
    } };
  }
  async function consume(entry: Entry): Promise<void> {
    if (++entries > limits.maxEntries) expansion(); const name = normalizedName(entry.fileName);
    if (names.has(name)) invalid(); names.add(name);
    const unixType = (entry.externalFileAttributes >>> 16) & 0xf000;
    if ((entry.generalPurposeBitFlag & (1 | 64)) || (unixType && unixType !== 0x8000 && unixType !== 0x4000) || (entry.externalFileAttributes & 0x400)) invalid();
    if (!['0', '8'].includes(String(entry.compressionMethod))) invalid();
    if (/(?:^|\/)(?:vbaProject\.bin|activeX|embeddings|externalLinks)(?:\/|$)/i.test(name)) invalid();
    if (entry.uncompressedSize > limits.maxEntryBytes || budget.expandedBytes + entry.uncompressedSize > limits.maxExpandedBytes) expansion();
    if (entry.fileName.endsWith('/')) { if (entry.uncompressedSize) invalid(); return; }
    active = await new Promise<Readable>((resolve, reject) => zip!.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
    let actual = 0; let checksum = 0; const isXml = /(?:\.xml|\.rels)$/.test(name);
    const parser = isXml ? xmlParser(name) : undefined; let decoder: TextDecoder | undefined; let prefix = Buffer.alloc(0);
    for await (const chunk of active) {
      options.check?.();
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array); actual += bytes.byteLength; budget.expandedBytes += bytes.byteLength;
      if (actual > limits.maxEntryBytes || budget.expandedBytes > limits.maxExpandedBytes) expansion();
      checksum = crc32(bytes, checksum);
      if (parser) {
        let input = bytes;
        if (!decoder) {
          prefix = Buffer.concat([prefix, bytes]); if (prefix.length < 2) continue;
          const encoding = prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf-16le' : prefix[0] === 0xfe && prefix[1] === 0xff ? 'utf-16be' : 'utf-8';
          decoder = new TextDecoder(encoding, { fatal: true }); input = prefix; prefix = Buffer.alloc(0);
        }
        parser.write(decoder.decode(input, { stream: true }));
      }
    }
    active = undefined; if (actual !== entry.uncompressedSize || checksum !== entry.crc32) invalid();
    if (parser) { parser.write(decoder ? decoder.decode() : new TextDecoder('utf-8', { fatal: true }).decode(prefix)); parser.close(); }
    if (parts.has(name)) verifiedParts.set(name, { name, crc32: checksum, expandedBytes: actual });
  }
  try {
    zip = await new Promise<ZipFile>((resolve, reject) => yauzl.open(filePath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, value) => error ? reject(error) : resolve(value)));
    await new Promise<void>((resolve, reject) => {
      zip!.on('error', reject); zip!.on('end', resolve);
      zip!.on('entry', (entry: Entry) => { void consume(entry).then(() => zip!.readEntry(), reject); }); zip!.readEntry();
    });
    if (!names.has('[Content_Types].xml') || !workbookPart || sheets.length === 0) invalid();
    const main = relationships.filter((item) => item.source === '' && item.type.endsWith('/officeDocument'));
    if (main.length !== 1 || resolvePart('', main[0]!.target) !== workbookPart || main[0]!.external) invalid();
    if (contentTypes.get(workbookPart!) !== 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml') invalid();
    for (const relation of relationships) if (!relation.external && !relation.type.endsWith('/hyperlink') && !names.has(resolvePart(relation.source, relation.target))) invalid();
    const result: RawSheet[] = [];
    for (const declared of sheets) {
      const relation = relationships.find((item) => item.source === workbookPart && item.id === declared.relationId);
      if (!relation || relation.external || !relation.type.endsWith('/worksheet')) invalid();
      const partName = resolvePart(workbookPart!, relation!.target); const part = parts.get(partName); if (!part) invalid();
      if (part!.maxStyle >= styleCount || part!.maxShared >= strings.length) invalid();
      for (const cell of Object.values(part!.cells)) {
        if (cell.style !== undefined && Number(cell.style) >= styleCount) invalid();
        if (cell.xmlType === 's') {
          if (!/^(0|[1-9][0-9]{0,8})$/.test(cell.lexeme)) invalid(); const value = strings[Number(cell.lexeme)]; if (value === undefined) invalid();
          part!.cells[cell.address] = { ...cell, text: value! };
        }
      }
      result.push({ name: declared.name, cells: part!.cells, maxRow: part!.maxRow, maxColumn: part!.maxColumn, merged: part!.merged, part: verifiedParts.get(partName)!,
        ...(Object.keys(part!.fragmentedRows).length ? { fragmentedRows: part!.fragmentedRows } : {}) });
    }
    options.check?.(); return { date1904, sheets: result, expandedBytes: budget.expandedBytes - initialBytes, compressedBytes, sharedStrings: strings, styleCount };
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('INVALID_WORKBOOK'); }
  finally { active?.destroy(); zip?.close(); }
}
