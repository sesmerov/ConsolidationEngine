import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import { readZipParts, type ZipPart } from './xlsx-fixtures.js';

export const MiB = 1024 ** 2;
export interface CapacityFile { name: string; path: string; role: 'catalog'|'report'; bytes: number; expandedBytes: number; sha256: string; physicalCatalogRows?: number }
export const hashBytes = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
export async function hashFile(filename: string) { const hash = createHash('sha256'); for await (const bytes of createReadStream(filename)) hash.update(bytes); return hash.digest('hex'); }

/** Deterministic ZIP writer with native CRC. Stored filler is explicitly transport-only evidence. */
function encode(parts: readonly ZipPart[]): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name), bytes = part.compress ? deflateRawSync(part.data) : part.data, checksum = crc32(part.data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(part.compress ? 8 : 0, 8); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(part.data.length, 22); header.writeUInt16LE(name.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt16LE(part.compress ? 8 : 0, 10); entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(bytes.length, 20); entry.writeUInt32LE(part.data.length, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42);
    local.push(header, name, bytes); central.push(entry, name); offset += header.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
const expanded = (parts: readonly ZipPart[]) => parts.reduce((sum, part) => sum + part.data.length, 0);
function padded(parts: readonly ZipPart[], size: number) {
  const filler = { name: 'xl/media/capacity.bin', data: Buffer.alloc(0), compress: false }, overhead = encode([...parts, filler]).length;
  if (size < overhead) throw new Error('Capacity fixture compressed input is too large');
  filler.data = Buffer.alloc(size - overhead, 61); return { bytes: encode([...parts, filler]), expandedBytes: expanded(parts) + filler.data.length };
}
async function save(directory: string, name: string, role: 'catalog'|'report', value: { bytes: Buffer; expandedBytes: number }, rows?: number): Promise<CapacityFile> {
  const filename = path.join(directory, name); await writeFile(filename, value.bytes);
  return { name, path: filename, role, bytes: value.bytes.length, expandedBytes: value.expandedBytes, sha256: hashBytes(value.bytes), ...(rows ? { physicalCatalogRows: rows } : {}) };
}
/** A genuine catalogue: every row has a distinct code and an evaluable expression. */
function catalogSheet(original: Buffer, rows: number, extraText: number) {
  const xml = original.toString(), start = xml.indexOf('<sheetData>') + '<sheetData>'.length, headerEnd = xml.indexOf('</row>', start) + '</row>'.length;
  const template = xml.slice(headerEnd, xml.indexOf('</row>', headerEnd) + '</row>'.length);
  const output = [xml.slice(0, headerEnd)];
  for (let row = 2; row < rows + 2; row++) {
    let generated = template.replace(/r="([A-Z]*)(\d+)"/g, (_all, column) => `r="${column}${row}"`).replace('FIN_TOTAL_CASH', 'CAPACITY_' + String(row - 1).padStart(6, '0'));
    generated = generated.replace(/(<c r="I\d+"[^>]*><is><t[^>]*>)[\s\S]*?(<\/t>)/, (_all, before, after) => before + 'Synthetic capacity rule ' + (row - 1) + '. ' + 'x'.repeat(extraText) + after);
    output.push(generated);
  }
  output.push('</sheetData></worksheet>'); return Buffer.from(output.join(''));
}

/** Generates exact boundaries plus a dense catalogue; no source fixture or oracle is rewritten. */
export async function createCapacityFixtures(directory: string) {
  await mkdir(directory, { recursive: true });
  const reportParts = await readZipParts('tests/fixtures/generated/demo-finrep-report.xlsx'), catalogParts = await readZipParts('tests/fixtures/generated/demo-finrep-catalog.xlsx');
  const reports: CapacityFile[] = [];
  for (let index = 0; index < 4; index++) {
    const parts = reportParts.map(part => ({ ...part, data: /\.xml$/.test(part.name) ? Buffer.from(part.data.toString().replaceAll('SYNTHETIC', 'SYNTHETIC_CAP_' + index)) : part.data }));
    reports.push(await save(directory, `report-${index}.xlsx`, 'report', padded(parts, 10 * MiB)));
  }
  const targetExpanded = 100 * MiB - reports.reduce((sum, file) => sum + file.expandedBytes, 0), sheetName = 'xl/worksheets/sheet1.xml', original = catalogParts.find(part => part.name === sheetName)!.data;
  // 24k genuine rows are deliberately retained: large descriptions do not stand in for row/ANTLR cost.
  const rows = 24_000; let extraText = 500, sheet = catalogSheet(original, rows, extraText), value: ReturnType<typeof padded>;
  for (;;) {
    value = padded(catalogParts.map(part => part.name === sheetName ? { ...part, data: sheet } : part), 10 * MiB);
    const difference = targetExpanded - value.expandedBytes;
    if (Math.abs(difference) < rows) break;
    extraText += Math.trunc(difference / rows); if (extraText < 0 || extraText > 30_000) throw new Error('Cannot produce capacity catalogue within valid cell limits');
    sheet = catalogSheet(original, rows, extraText);
  }
  // Add an inert stored entry and compensate the worksheet by exactly its ZIP header cost.
  // The remaining byte precision is XML whitespace, never an invalid trailing ZIP suffix.
  for (let attempt = 0; attempt < 12; attempt++) {
    value = padded(catalogParts.map(part => part.name === sheetName ? { ...part, data: sheet } : part), 10 * MiB);
    const difference = targetExpanded - value.expandedBytes; if (!difference) break;
    if (difference < 0) {
      const text = sheet.toString(), at = text.indexOf('x'.repeat(100)); if (at < 0 || -difference > extraText) { extraText--; sheet = catalogSheet(original, rows, extraText); continue; }
      sheet = Buffer.from(text.slice(0, at) + text.slice(at - difference));
    } else sheet = Buffer.concat([sheet.subarray(0, sheet.length - 12), Buffer.alloc(difference, 32), sheet.subarray(sheet.length - 12)]);
  }
  value = padded(catalogParts.map(part => part.name === sheetName ? { ...part, data: sheet } : part), 10 * MiB);
  if (value.expandedBytes !== targetExpanded) throw new Error(`Exact expanded fixture failed: ${value.expandedBytes} != ${targetExpanded}`);
  const catalog = await save(directory, 'catalog-max.xlsx', 'catalog', value, rows);
  const plusParts = catalogParts.map(part => part.name === sheetName ? { ...part, data: Buffer.concat([sheet, Buffer.from(' ')]) } : part);
  // A separate compact ZIP crosses the expanded-byte boundary while staying below 10 MiB compressed.
  const exactExpandedPlus = expanded(plusParts);
  const plusPadding = targetExpanded + 1 - exactExpandedPlus;
  const maxExpandedPlus = encode([...plusParts, { name: 'xl/media/expanded.bin', data: Buffer.alloc(plusPadding, 61), compress: true }]);
  const overExpanded = await save(directory, 'catalog-expanded-plus-one.xlsx', 'catalog', { bytes: maxExpandedPlus, expandedBytes: targetExpanded + 1 }, rows);
  const filePlusPath = path.join(directory, 'file-plus-one.xlsx'); await writeFile(filePlusPath, value.bytes); const file = await open(filePlusPath, 'a'); await file.write(Buffer.from('x')); await file.close();
  const filePlus: CapacityFile = { ...catalog, name: 'file-plus-one.xlsx', path: filePlusPath, bytes: 10 * MiB + 1, sha256: await hashFile(filePlusPath) };
  const manifest = { schemaVersion: 1, generator: 'hosted-capacity-fixtures-v1', batch: [catalog, ...reports], expandedPlus: [overExpanded, ...reports], filePlus,
    scope: 'Transport/preflight boundary only: ZIP/expanded boundaries include an inert stored binary member and 24000 physical catalogue rows, above the 500-rule domain limit. This fixture is not used to claim admitted domain calculation capacity. A separate 500-rule/100000-fact fixture measures that workload.' };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2)); return manifest;
}

/** Valid ZIP exactly at 100 MiB, including every local header, central entry and EOCD byte. */
export async function createMaximumZip(filename: string, plusOne = false) {
  const name = Buffer.from('synthetic-capacity.txt'), total = 100 * MiB + Number(plusOne), payload = total - 30 - 46 - 22 - name.length * 2;
  const chunk = Buffer.alloc(MiB, 83); let checksum = 0; for (let offset = 0; offset < payload; offset += chunk.length) checksum = crc32(chunk.subarray(0, Math.min(chunk.length, payload - offset)), checksum);
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(checksum, 14); header.writeUInt32LE(payload, 18); header.writeUInt32LE(payload, 22); header.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(checksum, 16); central.writeUInt32LE(payload, 20); central.writeUInt32LE(payload, 24); central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + name.length, 12); end.writeUInt32LE(30 + name.length + payload, 16);
  const output = await open(filename, 'w'); try { await output.write(header); await output.write(name); for (let offset = 0; offset < payload; offset += chunk.length) await output.write(chunk.subarray(0, Math.min(chunk.length, payload - offset))); await output.write(central); await output.write(name); await output.write(end); } finally { await output.close(); }
  return { bytes: total, payloadBytes: payload, overheadBytes: total - payload, sha256: await hashFile(filename) };
}

/** Real legacy ce-report XLSX input at the existing 500-rule / 100000-coordinate / 100000-fact maxima. */
export async function createExportCapacityFixtures(directory: string) {
  await mkdir(directory, { recursive: true });
  const { writeIncrementalWorkbook } = await import(pathToFileURL(path.resolve('apps/api/dist/export/bounded-files.js')).href);
  const { EBA_HEADERS, CONTEXT_HEADERS, COORDINATE_HEADERS, FACT_HEADERS } = await import('@ce/contracts');
  const rowCode = (row: number) => String(row).padStart(6, '0');
  function* catalog() { yield EBA_HEADERS; for (let rule = 0; rule < 500; rule++) yield ['CAPACITY_EXPORT_' + ruleCode(rule), 'SYNTHETIC_CAPACITY', 'COREP', 'COREP_OF_4.2', 'no', 'T', `sum({tT,r${rowCode(rule * 200 + 1)}-${rowCode(rule * 200 + 200)},c0010})=${rule % 2 ? 201 : 200}`, '', 'Synthetic export capacity rule', 'Active', '2025-01-01', '', 'error', '', 'no']; }
  function ruleCode(rule: number) { return String(rule + 1).padStart(3, '0'); }
  function* coordinates() { yield COORDINATE_HEADERS; for (let row = 1; row <= 100_000; row++) yield ['capacity', 'T', '', rowCode(row), '0010', 'number', 'pure', 'INF', '{}']; }
  function* facts() { yield FACT_HEADERS; for (let row = 1; row <= 100_000; row++) yield ['capacity', 'T', '', rowCode(row), '0010', 'value', '1']; }
  const budget = { expandedBytes: 0 }, files: CapacityFile[] = [];
  const definitions = [
    { name: 'catalog-export.xlsx', role: 'catalog' as const, sheets: [{ name: 'Validation rules', rows: catalog() }] },
    { name: 'report-export.xlsx', role: 'report' as const, sheets: [
      { name: 'Instructions', rows: [['Synthetic capacity ce-report-1']] },
      { name: 'Contexts', rows: [CONTEXT_HEADERS, ['ce-report-1', 'capacity', 'SYNTHETIC', '2025-06-30', '2025-07-01', 'COREP', 'COREP_OF_4.2', '{}']] },
      { name: 'Coordinates', rows: coordinates() }, { name: 'Facts', rows: facts() },
    ] },
  ];
  for (const definition of definitions) {
    const filename = path.join(directory, definition.name); await writeFile(filename, Buffer.alloc(0));
    const result = await writeIncrementalWorkbook(filename, definition.sheets, 10 * MiB, budget, 100 * MiB, () => {});
    files.push({ name: definition.name, path: filename, role: definition.role, bytes: result.size, expandedBytes: result.expandedBytes, sha256: result.sha256, ...(definition.role === 'catalog' ? { physicalCatalogRows: 500 } : {}) });
  }
  const manifest = { schemaVersion: 1, generator: 'hosted-capacity-export-v1', rules: 500, coordinates: 100_000, facts: 100_000, files,
    scope: 'Genuine ce-report-1 workbooks for the retained-source export fixture. Legacy importer constructs the snapshot from these exact bytes; this is not a claim that hosted visual-upload admission supports the legacy profile.' };
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2)); return manifest;
}
