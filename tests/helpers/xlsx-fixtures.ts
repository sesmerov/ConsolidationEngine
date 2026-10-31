import { deflateRawSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import yauzl from 'yauzl';

/** Test-only ZIP builder: permits intentionally invalid names/flags that normal writers reject. */
export interface ZipPart {
  name: string; data: Buffer; compress?: boolean; flags?: number;
  externalAttributes?: number; declaredSize?: number;
}
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipBytes(parts: readonly ZipPart[]): Buffer {
  const local: Buffer[] = []; const directory: Buffer[] = []; let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name); const compressed = part.compress ? deflateRawSync(part.data) : part.data;
    const size = part.declaredSize ?? part.data.length; const crc = crc32(part.data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt16LE(part.flags ?? 0x800, 6); header.writeUInt16LE(part.compress ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x314, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(part.flags ?? 0x800, 8); central.writeUInt16LE(part.compress ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(size, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(part.externalAttributes ?? 0, 38); central.writeUInt32LE(offset, 42);
    local.push(header, name, compressed); directory.push(central, name); offset += header.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
export async function readZipParts(filePath: string): Promise<ZipPart[]> {
  const bytes = await readFile(filePath);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file)));
  const parts: ZipPart[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      zip.on('error', reject); zip.on('end', resolve);
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (error, stream) => {
          if (error) { reject(error); return; }
          const chunks: Buffer[] = []; stream!.on('error', reject); stream!.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream!.on('end', () => { parts.push({ name: entry.fileName, data: Buffer.concat(chunks), compress: true }); zip.readEntry(); });
        });
      }); zip.readEntry();
    });
    return parts;
  } finally { zip.close(); }
}
export function changeXml(parts: readonly ZipPart[], name: string, transform: (xml: string) => string): ZipPart[] {
  if (!parts.some((part) => part.name === name)) throw new Error('Missing fixture part: ' + name);
  return parts.map((part) => part.name === name ? { ...part, data: Buffer.from(transform(part.data.toString('utf8'))) } : part);
}
export function replaceCell(xml: string, address: string, replacement: string): string {
  const pattern = new RegExp('<c\\b[^>]*\\br="' + address + '"[^>]*>(?:[\\s\\S]*?)<\\/c>');
  if (!pattern.test(xml)) throw new Error('Missing fixture cell: ' + address);
  return xml.replace(pattern, replacement);
}
export function textCell(address: string, text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<c r="' + address + '" t="inlineStr"><is><t xml:space="preserve">' + escaped + '</t></is></c>';
}
