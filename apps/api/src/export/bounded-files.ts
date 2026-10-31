import { open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { crc32, createDeflateRaw } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { JsonValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { jsonChunks } from './bounded-json.js';
import { encodeSpreadsheetText, validXmlText } from '../import/ooxml-text.js';

export interface WrittenFile { readonly size: number; readonly crc: number; readonly sha256: string }
export interface StoredZipEntry extends Pick<WrittenFile, 'size' | 'crc'> { readonly name: string; readonly path: string }
/** Own pre-created files only. Every write is bounded before IO and cancellation remains observable. */
export async function writeChunks(location: string, chunks: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, maximum: number, check: () => void): Promise<WrittenFile> {
  const handle = await open(location, 'r+'), hash = createHash('sha256'); let size = 0, crc = 0;
  try {
    check(); await handle.truncate(0);
    for await (const chunk of chunks) {
      check(); if (size + chunk.byteLength > maximum) throw new ApiError('EXPORT_LIMIT');
      size += chunk.byteLength; crc = crc32(chunk, crc); hash.update(chunk); await handle.writeFile(chunk);
    }
    check();
  } finally { await handle.close(); }
  return { size, crc, sha256: hash.digest('hex') };
}
export function* jsonBuffers(data: JsonValue): Generator<Buffer> {
  let buffer: string[] = [], bytes = 0;
  for (const chunk of jsonChunks(data)) {
    const size = Buffer.byteLength(chunk); if (bytes + size > 64 * 1024 && bytes) { yield Buffer.from(buffer.join('')); buffer = []; bytes = 0; }
    buffer.push(chunk); bytes += size;
  }
  if (bytes) yield Buffer.from(buffer.join(''));
}
/** ZIP STORED avoids recompressing XLSX and keeps the outer package memory independent of its size. */
async function* storedZipParts(entries: readonly StoredZipEntry[]): AsyncGenerator<Uint8Array> {
  if (!entries.length || entries.length > 0xffff || new Set(entries.map(entry => entry.name)).size !== entries.length) throw new ApiError('INTERNAL_ERROR');
  const central: Buffer[] = []; let offset = 0;
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffffffff || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.[A-Za-z0-9]+$/.test(entry.name)) throw new ApiError('INTERNAL_ERROR');
    const filename = Buffer.from(entry.name), local = Buffer.alloc(30), directory = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt32LE(entry.crc, 14); local.writeUInt32LE(entry.size, 18); local.writeUInt32LE(entry.size, 22); local.writeUInt16LE(filename.length, 26);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt32LE(entry.crc, 16); directory.writeUInt32LE(entry.size, 20); directory.writeUInt32LE(entry.size, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); yield local; yield filename;
    let read = 0;
    for await (const chunk of createReadStream(entry.path)) { const bytes = chunk as Buffer; read += bytes.length; if (read > entry.size) throw new ApiError('INTERNAL_ERROR'); yield bytes; }
    if (read !== entry.size) throw new ApiError('INTERNAL_ERROR'); offset += local.length + filename.length + entry.size;
  }
  const end = Buffer.alloc(22), size = central.reduce((sum, part) => sum + part.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  for (const chunk of central) yield chunk; yield end;
}
export function writeStoredZip(location: string, entries: readonly StoredZipEntry[], maximum: number, check: () => void): Promise<WrittenFile> {
  return writeChunks(location, storedZipParts(entries), maximum, check);
}

export interface LiteralSheet { readonly name: string; readonly rows: Iterable<readonly string[]> }
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function escaped(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function columnName(index: number): string { let result = ''; for (let value = index + 1; value; value = Math.floor((value - 1) / 26)) result = String.fromCharCode(65 + (value - 1) % 26) + result; return result; }
function* worksheetRows(sheet: LiteralSheet, check: () => void): Generator<Buffer> {
  yield Buffer.from(XML + `<worksheet xmlns="${MAIN}"><sheetData>`);
  let rowIndex = 0, chunks: string[] = [], bytes = 0;
  for (const row of sheet.rows) {
    check(); if (++rowIndex > 1_048_576 || row.length > 64) throw new ApiError('EXPORT_LIMIT');
    const cells: string[] = [];
    for (const [index, text] of row.entries()) {
      if (text.length > 32_767) throw new ApiError('EXPORT_LIMIT');
      if (!validXmlText(text)) throw new ApiError('EXPORT_NOT_AVAILABLE', { reason: 'INVALID_REPORT_SOURCE' });
      if (!text) continue;
      const space = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
      cells.push(`<c r="${columnName(index)}${rowIndex}" t="inlineStr"><is><t${space}>${escaped(encodeSpreadsheetText(text))}</t></is></c>`);
    }
    const xml = `<row r="${rowIndex}">${cells.join('')}</row>`, size = Buffer.byteLength(xml);
    if (bytes && bytes + size > 64 * 1024) { yield Buffer.from(chunks.join('')); chunks = []; bytes = 0; }
    chunks.push(xml); bytes += size;
  }
  if (bytes) yield Buffer.from(chunks.join(''));
  yield Buffer.from('</sheetData></worksheet>');
}
/** Small metadata only is materialized; worksheet rows and DEFLATE output have backpressure. */
function workbookParts(sheets: readonly LiteralSheet[], check: () => void): { name: string; chunks: Iterable<Buffer> }[] {
  if (!sheets.length || sheets.length > 64 || new Set(sheets.map(sheet => sheet.name)).size !== sheets.length
    || sheets.some(sheet => !/^[A-Za-z][A-Za-z0-9_ ]{0,30}$/.test(sheet.name))) throw new ApiError('INTERNAL_ERROR');
  const content = XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + sheets.map((_sheet, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>';
  const workbook = XML + `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr date1904="0"/><sheets>`
    + sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') + '</sheets></workbook>';
  const relations = XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + sheets.map((_sheet, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('') + '</Relationships>';
  return [
    { name: '[Content_Types].xml', chunks: [Buffer.from(content)] },
    { name: '_rels/.rels', chunks: [Buffer.from(XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)] },
    { name: 'xl/workbook.xml', chunks: [Buffer.from(workbook)] }, { name: 'xl/_rels/workbook.xml.rels', chunks: [Buffer.from(relations)] },
    ...sheets.map((sheet, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, chunks: worksheetRows(sheet, check) })),
  ];
}
async function* deflatedWorkbook(sheets: readonly LiteralSheet[], budget: { expandedBytes: number }, maximum: number, check: () => void): AsyncGenerator<Buffer> {
  const central: Buffer[] = []; let offset = 0; const parts = workbookParts(sheets, check);
  for (const part of parts) {
    check(); const filename = Buffer.from(part.name), local = Buffer.alloc(30); let expanded = 0, compressed = 0, checksum = 0;
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x808, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(filename.length, 26);
    yield local; yield filename;
    function* measured(): Generator<Buffer> {
      for (const chunk of part.chunks) {
        check(); if (expanded + chunk.length > 64 * 1024 * 1024 || budget.expandedBytes + chunk.length > maximum) throw new ApiError('EXPORT_LIMIT');
        expanded += chunk.length; budget.expandedBytes += chunk.length; checksum = crc32(chunk, checksum); yield chunk;
      }
    }
    const source = Readable.from(measured(), { objectMode: false, highWaterMark: 64 * 1024 }), compressor = createDeflateRaw({ level: 6 });
    const completion = pipeline(source, compressor); void completion.catch(() => {});
    try { for await (const chunk of compressor) { check(); const bytes = chunk as Buffer; compressed += bytes.length; yield bytes; } await completion; }
    finally { source.destroy(); compressor.destroy(); await completion.catch(() => {}); }
    const descriptor = Buffer.alloc(16), directory = Buffer.alloc(46);
    descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(compressed, 8); descriptor.writeUInt32LE(expanded, 12); yield descriptor;
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x808, 8); directory.writeUInt16LE(8, 10);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(compressed, 20); directory.writeUInt32LE(expanded, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename); offset += local.length + filename.length + compressed + descriptor.length;
  }
  const end = Buffer.alloc(22), size = central.reduce((sum, part) => sum + part.length, 0);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(size, 12); end.writeUInt32LE(offset, 16);
  for (const chunk of central) yield chunk; yield end;
}
export async function writeIncrementalWorkbook(location: string, sheets: readonly LiteralSheet[], maximum: number, budget: { expandedBytes: number }, maxExpandedBytes: number, check: () => void): Promise<WrittenFile & { expandedBytes: number }> {
  const initial = budget.expandedBytes;
  const output = await writeChunks(location, deflatedWorkbook(sheets, budget, maxExpandedBytes, check), maximum, check);
  return { ...output, expandedBytes: budget.expandedBytes - initial };
}
