import { crc32 } from 'node:zlib';
import type { Readable } from 'node:stream';
import yauzl from 'yauzl';
import sax from 'sax';
import type { QualifiedTag } from 'sax';
import { ApiError } from '../errors.js';
import { decodeSpreadsheetText } from './ooxml-text.js';
import { PREFLIGHT_LIMITS, type PreflightWorkbook, type RawCell } from './xlsx-preflight.js';
export interface RawSheetRow { readonly row: number; readonly cells: readonly RawCell[] }
/** Second pass over an already CRC/relationship-verified sheet. Buffers at most one decoded chunk plus fragmented rows. */
export async function* readSheetRows(filePath: string, preflight: PreflightWorkbook, name: string, options: { check?: () => void } = {}): AsyncGenerator<RawSheetRow> {
  const invalid = (): never => { throw new ApiError('INVALID_WORKBOOK'); };
  const limits = preflight.limits ?? PREFLIGHT_LIMITS;
  const sheet = preflight.sheets.find(item => item.name === name); if (!sheet?.part) invalid();
  if (preflight.profile === 'corep-ca1' && !['CA1', 'Contexto', 'Instrucciones'].includes(name)) invalid();
  options.check?.();
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.open(filePath, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true, autoClose: false }, (error, file) => error ? reject(error) : resolve(file)));
  let active: Readable | undefined;
  try {
    const entry = await new Promise<yauzl.Entry>((resolve, reject) => {
      zip.on('error', reject); zip.on('end', () => reject(new ApiError('INVALID_WORKBOOK')));
      zip.on('entry', (item: yauzl.Entry) => { if (item.fileName === sheet!.part!.name) resolve(item); else zip.readEntry(); }); zip.readEntry();
    });
    if (entry.crc32 !== sheet!.part!.crc32 || entry.uncompressedSize !== sheet!.part!.expandedBytes) invalid();
    active = await new Promise<Readable>((resolve, reject) => zip.openReadStream(entry, (error, stream) => error ? reject(error) : resolve(stream)));
    const xmlOptions = { xmlns: true, strictEntities: true, trim: false, normalize: false };
    const parser = sax.parser(true, xmlOptions);
    const stack: QualifiedTag[] = []; let pending: RawSheetRow[] = []; let row = 0; let cells: RawCell[] = [];
    let cell: { address: string; row: number; column: number; xmlType: string; lexeme: string; text: string; style?: string } | undefined;
    const fragments = new Map<number, { seen: number; cells: RawCell[] }>();
    const attribute = (node: QualifiedTag, key: string) => node.attributes[key]?.value;
    parser.onerror = invalid; parser.ondoctype = invalid; parser.onsgmldeclaration = invalid;
    parser.onprocessinginstruction = instruction => { if (instruction.name.toLowerCase() !== 'xml') invalid(); };
    parser.onopentag = element => {
      const node = element as QualifiedTag; stack.push(node); if (stack.length > limits.maxXmlDepth || node.local === 'f') invalid();
      if (node.local === 'row') { row = Number(attribute(node, 'r')); if (!Number.isSafeInteger(row) || row < 1 || row > limits.maxRows) invalid(); cells = []; }
      if (node.local === 'c') {
        const address = attribute(node, 'r') ?? '', match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/.exec(address); if (!match || cell) invalid();
        let column = 0; for (const letter of match![1]!) column = column * 26 + letter.charCodeAt(0) - 64;
        const position = Number(match![2]); if (position !== row || column > limits.maxColumns) invalid();
        const xmlType = attribute(node, 't') ?? 'n', style = attribute(node, 's');
        if (!['n', 'b', 's', 'inlineStr', 'str', 'e', 'd'].includes(xmlType) || style !== undefined && (!/^(0|[1-9][0-9]*)$/.test(style) || Number(style) >= (preflight.styleCount ?? 0))) invalid();
        cell = { address, row, column, xmlType, lexeme: '', text: '', ...(style !== undefined ? { style } : {}) };
      }
    };
    const text = (value: string) => {
      if (!cell) return;
      if (stack.at(-1)?.local === 'v') cell.lexeme += value;
      if (stack.at(-1)?.local === 't' && !stack.some(tag => tag.local === 'rPh')) cell.text += value;
      if (cell.lexeme.length > limits.maxCellChars * 7 || cell.text.length > limits.maxCellChars * 7) throw new ApiError('EXPANSION_LIMIT');
    };
    parser.ontext = text; parser.oncdata = text;
    parser.onclosetag = () => {
      const node = stack.pop();
      if (node?.local === 'c') {
        if (!cell) invalid(); const current = cell!;
        if (current.xmlType !== 'inlineStr') current.text = current.lexeme; else current.lexeme = current.text;
        if (current.xmlType === 'inlineStr' || current.xmlType === 'str') current.text = decodeSpreadsheetText(current.text);
        if (current.xmlType === 's') { if (!/^(0|[1-9][0-9]{0,8})$/.test(current.lexeme)) invalid(); const value = preflight.sharedStrings?.[Number(current.lexeme)]; if (value === undefined) invalid(); current.text = value!; }
        if (current.text.length > limits.maxCellChars) throw new ApiError('EXPANSION_LIMIT');
        cells.push(current); cell = undefined;
      }
      if (node?.local === 'row') {
        const count = sheet!.fragmentedRows?.[row];
        if (count) { const fragment = fragments.get(row) ?? { seen: 0, cells: [] }; fragment.cells.push(...cells); fragment.seen++;
          if (fragment.seen === count) { pending.push({ row, cells: fragment.cells }); fragments.delete(row); } else fragments.set(row, fragment);
        } else pending.push({ row, cells });
        cells = []; row = 0;
      }
    };
    let decoder: TextDecoder | undefined, prefix = Buffer.alloc(0), actual = 0, checksum = 0;
    for await (const chunk of active) {
      options.check?.(); const bytes: Buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      actual += bytes.length; if (actual > sheet!.part!.expandedBytes) invalid(); checksum = crc32(bytes, checksum); let input = bytes;
      if (!decoder) { prefix = Buffer.concat([prefix, bytes]); if (prefix.length < 2) continue;
        decoder = new TextDecoder(prefix[0] === 0xff && prefix[1] === 0xfe ? 'utf-16le' : prefix[0] === 0xfe && prefix[1] === 0xff ? 'utf-16be' : 'utf-8', { fatal: true }); input = prefix; prefix = Buffer.alloc(0); }
      parser.write(decoder.decode(input, { stream: true }));
      for (const item of pending) { options.check?.(); yield item; } pending = [];
    }
    if (actual !== sheet!.part!.expandedBytes || checksum !== sheet!.part!.crc32) invalid();
    parser.write(decoder ? decoder.decode() : new TextDecoder('utf-8', { fatal: true }).decode(prefix)).close();
    if (stack.length || fragments.size) invalid(); for (const item of pending) { options.check?.(); yield item; }
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('INVALID_WORKBOOK'); }
  finally { active?.destroy(); zip.close(); }
}
