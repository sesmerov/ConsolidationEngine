import { crc32, deflateRawSync } from 'node:zlib';
import yauzl from 'yauzl';

export const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const encode = value => String(value).replace(/_(?=x[0-9a-fA-F]{4}_)/g, '_x005F_').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\r]/g, char => '_x' + char.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase() + '_');
export function literal(address, value, style) { return `<c r="${address}"${style === undefined ? '' : ` s="${style}"`} t="inlineStr"><is><t xml:space="preserve">${escape(encode(value))}</t></is></c>`; }
export function replaceVisualCell(xml, address, replacement) {
  const pattern = new RegExp('<c\\b(?=[^>]*\\br="' + address + '")(?:[^>]*\\/>|[^>]*>[\\s\\S]*?</c>)');
  if (pattern.test(xml)) return xml.replace(pattern, replacement);
  const row = new RegExp('(<row\\b[^>]*\\br="' + address.replace(/^[A-Z]+/, '') + '"[^>]*>[\\s\\S]*?)(</row>)');
  if (!row.test(xml)) throw new Error('Missing trusted row ' + address);
  return xml.replace(row, (_match, start, end) => start + replacement + end);
}
export function sheetXml(rows, widths = [42, 70, 20]) {
  const column = index => { let value = ''; for (index++; index; index = Math.floor((index - 1) / 26)) value = String.fromCharCode(65 + (index - 1) % 26) + value; return value; };
  return XML + `<worksheet xmlns="${MAIN}"><cols>` + widths.map((width, i) => `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`).join('') + '</cols><sheetData>' + rows.map((row, index) => `<row r="${index + 1}">` + row.map((value, i) => literal(column(i) + (index + 1), value)).join('') + '</row>').join('') + '</sheetData></worksheet>';
}
export function workbookParts(sheets) {
  return new Map([
    ['[Content_Types].xml', XML + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' + sheets.map((_sheet, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>'],
    ['_rels/.rels', XML + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', XML + `<workbook xmlns="${MAIN}" xmlns:r="${REL}"><workbookPr date1904="0"/><sheets>` + sheets.map((sheet, i) => `<sheet name="${escape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels', XML + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((_sheet, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + '</Relationships>'],
    ...sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheet.xml ?? sheetXml(sheet.rows, sheet.widths)]),
  ]);
}
export async function trustedZipParts(bytes) {
  if (bytes.length > 10 * 1024 * 1024) throw new Error('Trusted ZIP compressed limit');
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? reject(error) : resolve(value)));
  const parts = new Map(); let expanded = 0;
  try { await new Promise((resolve, reject) => {
    zip.on('error', reject); zip.on('end', resolve); zip.on('entry', entry => {
      if (parts.size >= 2048 || entry.uncompressedSize > 64 * 1024 * 1024 || expanded + entry.uncompressedSize > 100 * 1024 * 1024 || parts.has(entry.fileName)) { reject(new Error('Trusted ZIP expanded limit')); return; }
      zip.openReadStream(entry, (error, stream) => { if (error) { reject(error); return; } const chunks = []; let count = 0;
        stream.on('error', reject); stream.on('data', chunk => { count += chunk.length; if (count > entry.uncompressedSize) { stream.destroy(new Error('Trusted ZIP entry limit')); return; } chunks.push(chunk); });
        stream.on('end', () => { const data = Buffer.concat(chunks); if (data.length !== entry.uncompressedSize || crc32(data) !== entry.crc32) { reject(new Error('Trusted ZIP CRC')); return; } expanded += data.length; parts.set(entry.fileName, data); zip.readEntry(); });
      });
    }); zip.readEntry();
  }); return parts; } finally { zip.close(); }
}
export function deterministicZip(parts) {
  const chunks = [], central = []; let offset = 0;
  for (const [name, data] of parts) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data), filename = Buffer.from(name), compressed = deflateRawSync(bytes, { level: 9 }), checksum = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt32LE(checksum, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(filename.length, 26);
    const entry = Buffer.alloc(46); entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(compressed.length, 20); entry.writeUInt32LE(bytes.length, 24); entry.writeUInt16LE(filename.length, 28); entry.writeUInt32LE(offset, 42);
    chunks.push(local, filename, compressed); central.push(entry, filename); offset += local.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.size, 8); end.writeUInt16LE(parts.size, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}
export function typedWorkbook(mapping, context, values) {
  const declared = context ? [context.entityId, context.referenceDate, context.submissionDate ?? '', 'DEMO', 'DEMO_TYPES_1', mapping.profileId, context.filingIndicators.DEMO_TYPES ? 'Sí' : 'No'] : ['', '', '', 'DEMO', 'DEMO_TYPES_1', mapping.profileId, ''];
  return deterministicZip(workbookParts([
    { name: 'Instrucciones', widths: [110], rows: [[mapping.instructionsTitle], [mapping.profileId], ['Datos sintéticos propios. Este libro no es una plantilla EBA.'], ['Edita solo Valor y Estado en Datos; no muevas las etiquetas ni las cabeceras.'], ['Informado con texto vacío conserva una cadena vacía; Sin dato con valor vacío declara un nulo.'], ['Las fechas informadas deben ser fechas civiles válidas, sin hora; utiliza AAAA-MM-DD.'], ['Este conjunto solo valida. No ofrece destinos ni propuestas de recálculo.'], ['La demo contiene seis reglas que pasan y dos que fallan intencionadamente por mayúsculas o espacios.'], ['Confirma el contexto al cargar. Mantén separados los conjuntos COREP y Tipos.']] },
    { name: 'Datos', rows: [[], [], mapping.headers, ...mapping.fields.map(field => { const input = values?.find(value => value.rowCode === field.rowCode); return [field.label, input?.value ?? '', input?.state ?? 'Sin dato']; })] },
    { name: 'Contexto', rows: [[], [], ['Campo', 'Valor'], ...mapping.contextFields.map((label, i) => [label, declared[i]])] },
  ]));
}
