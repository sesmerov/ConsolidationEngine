import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';
import sax from 'sax';
import { typedWorkbook } from './lib/visual-xlsx.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceManifest = JSON.parse(await readFile(path.join(root, 'tests/fixtures/eba/source-manifest.json'), 'utf8'));
const mappingBytes = await readFile(path.join(root, 'apps/api/src/import/profiles/corep-ca1-mapping.json'));
if (mappingBytes.includes(13) || mappingBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('Trusted mapping must use repository UTF-8/LF bytes without BOM');
const mapping = JSON.parse(mappingBytes.toString('utf8'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const esc = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const decode = value => value.replace(/_x([0-9a-fA-F]{4})_/g, (_match, hex) => String.fromCharCode(parseInt(hex, 16)));
const encode = value => value.replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_').replace(/\r/g, '_x000D_');
function parse(xml, handlers) { const parser = sax.parser(true, { xmlns: true, trim: false, normalize: false, strictEntities: true }); Object.assign(parser, handlers); parser.ondoctype = () => { throw new Error('Unexpected source DTD'); }; parser.write(xml).close(); }
function attr(node, name) { return node.attributes[name]?.value; }
async function zipParts(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  const parts = new Map();
  try { await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve); zip.on('entry', entry => {
      if (entry.uncompressedSize > 64 * 1024 * 1024 || parts.has(entry.fileName)) { reject(new Error('Invalid trusted ZIP')); return; }
      zip.openReadStream(entry, (error, stream) => { if (error) { reject(error); return; } const chunks = [];
        stream.on('error', reject); stream.on('data', bytes => chunks.push(bytes)); stream.on('end', () => { const bytes = Buffer.concat(chunks); if (bytes.length !== entry.uncompressedSize || crc32(bytes) !== entry.crc32) { reject(new Error('Invalid trusted CRC')); return; } parts.set(entry.fileName, bytes); zip.readEntry(); });
      });
    }); zip.readEntry();
  }); return parts; } finally { zip.close(); }
}
function strings(parts) {
  const result = [], stack = []; let current;
  parse(parts.get('xl/sharedStrings.xml').toString('utf8'), { onopentag(node) { stack.push(node.local); if (node.local === 'si') current = ''; },
    ontext(value) { if (current !== undefined && stack.at(-1) === 't' && !stack.includes('rPh')) current += value; },
    onclosetag() { if (stack.pop() === 'si') { result.push(decode(current)); current = undefined; } } });
  return result;
}
function sheetPart(parts, name) {
  let relationId, target;
  parse(parts.get('xl/workbook.xml').toString('utf8'), { onopentag(node) { if (node.local === 'sheet' && attr(node, 'name') === name) relationId = Object.values(node.attributes).find(item => item.local === 'id')?.value; } });
  parse(parts.get('xl/_rels/workbook.xml.rels').toString('utf8'), { onopentag(node) { if (node.local === 'Relationship' && attr(node, 'Id') === relationId) target = attr(node, 'Target'); } });
  if (!target) throw new Error('Missing trusted sheet ' + name);
  return path.posix.normalize(target.startsWith('/') ? target.slice(1) : 'xl/' + target);
}
function cells(xml, shared) {
  const rows = [], values = new Map(), stack = []; let row, cell;
  parse(xml, { onopentag(node) { stack.push(node.local);
    if (node.local === 'row') row = { attributes: Object.fromEntries(Object.values(node.attributes).filter(item => ['r', 's', 'ht', 'customHeight', 'customFormat'].includes(item.local)).map(item => [item.local, item.value])), cells: [] };
    if (node.local === 'f') throw new Error('Formula in trusted selected sheet');
    if (node.local === 'c') cell = { address: attr(node, 'r'), type: attr(node, 't') ?? 'n', style: attr(node, 's'), value: '', inline: '' };
  }, ontext(value) { if (cell && stack.at(-1) === 'v') cell.value += value; if (cell && stack.at(-1) === 't' && !stack.includes('rPh')) cell.inline += value; },
  onclosetag() { const name = stack.pop(); if (name === 'c') { cell.text = cell.type === 's' ? shared[Number(cell.value)] : ['inlineStr', 'str'].includes(cell.type) ? decode(cell.type === 'str' ? cell.value : cell.inline) : cell.value; values.set(cell.address, cell.text); row.cells.push(cell); cell = undefined; } if (name === 'row') { rows.push(row); row = undefined; } } });
  return { rows, values };
}
function literal(address, text, style) { return `<c r="${address}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${esc(encode(text))}</t></is></c>`; }
function ownSheet(rows, widths = '<cols><col min="1" max="1" width="28" customWidth="1"/><col min="2" max="2" width="70" customWidth="1"/></cols>') {
  return XML + `<worksheet xmlns="${MAIN}">${widths}<sheetData>` + rows.map((row, index) => `<row r="${index + 1}">${row.map((value, column) => literal(String.fromCharCode(65 + column) + (index + 1), value)).join('')}</row>`).join('') + '</sheetData></worksheet>';
}
function deterministicZip(parts) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, data] of parts) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data), filename = Buffer.from(name), compressed = deflateRawSync(bytes, { level: 9 }), checksum = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(8, 10); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(compressed.length, 20); directory.writeUInt32LE(bytes.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    chunks.push(local, filename, compressed); central.push(directory, filename); offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.size, 8); end.writeUInt16LE(parts.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
// Source bytes are pinned. This script never takes a user workbook or fetches the network/cache.
const officialBytes = await readFile(path.join(root, 'tests/fixtures/eba/official-annexes-4.0.xlsx'));
const annotatedBytes = await readFile(path.join(root, 'tests/fixtures/eba/annotated-corep-of-4.0.xlsx'));
if (digest(officialBytes) !== mapping.official.sha256 || digest(annotatedBytes) !== mapping.annotated.sha256) throw new Error('EBA source hash mismatch');
const official = await zipParts(officialBytes), annotated = await zipParts(annotatedBytes);
const selectedXml = official.get(sheetPart(official, 'CA1')).toString('utf8'), selected = cells(selectedXml, strings(official));
const metadata = cells(annotated.get(sheetPart(annotated, 'C_01.00')).toString('utf8'), strings(annotated)).values;
for (const [address, expected] of mapping.structureAnchors) if (selected.values.get(address) !== expected) throw new Error('Source anchor mismatch: ' + address);
for (const cell of mapping.mapping) {
  if (selected.values.get(cell.codeCell) !== cell.rowCode) throw new Error('Source code mismatch');
  const annotation = metadata.get(cell.annotationCell.split('!')[1]);
  if (!annotation?.includes(cell.dpmDataPointId) || !annotation?.includes(cell.annotationTypeMarker)) throw new Error('Annotation mismatch: ' + cell.annotationCell);
}
const header = selectedXml.match(/<sheetFormatPr\b[^>]*\/>/)?.[0] ?? '';
const columns = selectedXml.match(/<cols>[\s\S]*?<\/cols>/)?.[0] ?? '';
const ca1 = XML + `<worksheet xmlns="${MAIN}"><dimension ref="A1:J114"/>${header}${columns}<sheetData>` + selected.rows.map(row => `<row ${Object.entries(row.attributes).map(([key, value]) => `${key}="${esc(value)}"`).join(' ')}>` + row.cells.map(cell => {
  // All values are emitted as literal text; the blank amount cells keep their original visual style.
  return cell.text === '' ? `<c r="${cell.address}"${cell.style === undefined ? '' : ` s="${cell.style}"`}/>` : literal(cell.address, cell.text, cell.style);
}).join('') + '</row>').join('') + '</sheetData><mergeCells count="1"><mergeCell ref="B2:E2"/></mergeCells></worksheet>';
const context = ownSheet([['Campo', 'Valor'], ['Perfil', mapping.profileId], ['Framework', 'COREP'], ['Módulo', 'COREP_OF_4.0'], ['Entidad', ''], ['Fecha de referencia', ''], ['Fecha de envío', ''], ['Divisa', ''], ['Escala', ''], ['Decimales del importe', ''], ['Tabla presentada', '']]);
const instructions = ownSheet([['Plantilla COREP 4.0 · C_01.00'], ['Introduce los importes en CA1, columna E, sin mover códigos ni etiquetas.'], ['Declara el contexto en el formulario o completa todas las filas de Contexto.'], ['Fechas civiles: AAAA-MM-DD. Divisa: tres letras mayúsculas.'], ['Escala: 0 (unidades), 3 (miles) o 6 (millones). Precisión: -18 a 18, o INF.'], ['Tabla presentada: true o false; la carga no marca este indicador automáticamente.'], ['Un blanco significa sin dato. El cero es un importe informado.'], ['Solo se admite CA1. La edición compatible no prueba la edición de origen del archivo.'], ['Este archivo permite trabajar en el motor local; no es un fichero oficial de remisión.']], '<cols><col min="1" max="1" width="110" customWidth="1"/></cols>');
const names = ['CA1', 'Contexto', 'Instrucciones'];
const parts = new Map([
  ['[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' + names.map((_name, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
  ['_rels/.rels', XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
  ['xl/workbook.xml', XML + `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr date1904="0"/><sheets>` + names.map((name, index) => `<sheet name="${name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('') + '</sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + names.map((_name, index) => `<Relationship Id="rId${index + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('') + `<Relationship Id="rId4" Type="${REL}/styles" Target="styles.xml"/><Relationship Id="rId5" Type="${REL}/theme" Target="theme/theme1.xml"/></Relationships>`],
  ['xl/styles.xml', official.get('xl/styles.xml')], ['xl/theme/theme1.xml', official.get('xl/theme/theme1.xml')],
  ['xl/worksheets/sheet1.xml', ca1], ['xl/worksheets/sheet2.xml', context], ['xl/worksheets/sheet3.xml', instructions],
]);
const output = deterministicZip(parts), directory = path.join(root, 'assets/templates'); await mkdir(directory, { recursive: true });
await writeFile(path.join(directory, 'corep-ca1.xlsx'), output);
const manifest = { version: 1, profiles: [{ profileId: mapping.profileId, languageProfileId: 'ce-dpmxl-0.9-closed-v2', mappingSha256: digest(mappingBytes), file: 'corep-ca1.xlsx', sha256: digest(output), size: output.length, selectedSheets: ['CA1'], sources: sourceManifest.sources }] };
const typedMappingBytes = await readFile(path.join(root, 'apps/api/src/import/profiles/demo-types-mapping.json'));
if (typedMappingBytes.includes(13) || typedMappingBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('Trusted mapping must use repository UTF-8/LF bytes without BOM');
const typedMapping = JSON.parse(typedMappingBytes.toString('utf8')), typed = typedWorkbook(typedMapping);
await writeFile(path.join(directory, 'demo-types.xlsx'), typed);
manifest.profiles.push({ profileId: typedMapping.profileId, languageProfileId: typedMapping.languageProfileId, mappingSha256: digest(typedMappingBytes), file: 'demo-types.xlsx', sha256: digest(typed), size: typed.length, selectedSheets: ['Datos'], sources: [] });
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (process.argv.includes('--package')) {
  const profileDirectory = path.join(root, 'apps/api/dist/import/profiles'); await mkdir(profileDirectory, { recursive: true }); await copyFile(path.join(root, 'apps/api/src/import/profiles/corep-ca1-mapping.json'), path.join(profileDirectory, 'corep-ca1-mapping.json'));
  await copyFile(path.join(root, 'apps/api/src/import/profiles/demo-types-mapping.json'), path.join(profileDirectory, 'demo-types-mapping.json'));
  const assetsDirectory = path.join(root, 'apps/api/dist/assets/templates'); await mkdir(assetsDirectory, { recursive: true });
  for (const name of ['corep-ca1.xlsx', 'demo-types.xlsx', 'manifest.json']) await copyFile(path.join(directory, name), path.join(assetsDirectory, name));
}
process.stdout.write(`COREP CA1: ${output.length} bytes, SHA-256 ${digest(output)}\n`);
