import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readXlsxFile from 'read-excel-file/node';
import { deterministicZip, replaceVisualCell, sheetXml, trustedZipParts, typedWorkbook, workbookParts } from './lib/visual-xlsx.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), directory = path.join(root, 'assets/demos');
const data = JSON.parse(await readFile(path.join(directory, 'source-data.json'), 'utf8'));
const typedMapping = JSON.parse(await readFile(path.join(root, 'apps/api/src/import/profiles/demo-types-mapping.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const original = await readFile(path.join(root, data.sourceName));
if (hash(original) !== data.sourceSha256) throw new Error('Original EBA catalogue hash mismatch');
const sourceSheets = await readXlsxFile(original, { parseNumber: text => text, trim: false });
const officialRules = data.corep.rules.filter(rule => rule.origin === 'official_catalog');
if (data.corep.rules.length !== 16 || data.typed.rules.length !== 8 || officialRules.length !== 5 || data.corep.inputs.length !== 110 || data.corep.inputs.filter(input => input.value !== null).length !== 15) throw new Error('Invalid product demo inputs');
const headers = Object.keys(officialRules[0].source.fields);
if (headers.length !== 15 || !headers.includes('Precondtion')) throw new Error('Invalid EBA headers');
for (const rule of officialRules) {
  const sheet = sourceSheets.find(sheet => sheet.sheet === rule.source.sourceSheet), row = sheet?.data[rule.source.row - 1];
  if (!row || rule.source.sourceSha256 !== data.sourceSha256 || JSON.stringify(sheet.data[0]) !== JSON.stringify(headers)) throw new Error('Original EBA row or headers mismatch');
  for (const [index, header] of headers.entries()) { const value = row[index] instanceof Date ? row[index].toISOString().slice(0, 10) : row[index] ?? ''; if (value !== rule.source.fields[header]) throw new Error(`Original EBA field mismatch: ${rule.code}/${header}`); }
}
const files = [];
await mkdir(directory, { recursive: true }); await mkdir(path.join(root, 'tests/fixtures/generated'), { recursive: true });
async function save(demo, kind, bytes) {
  const file = `demo-${demo}-${kind}.xlsx`; await writeFile(path.join(directory, file), bytes); await writeFile(path.join(root, 'tests/fixtures/generated', file), bytes);
  files.push({ demo, kind, file, sha256: hash(bytes), size: bytes.length });
}
function catalog(demo) {
  const set = demo === 'corep' ? data.corep : data.typed;
  const rows = set.rules.map(rule => {
    if (!rule.source && (typeof rule.description !== 'string' || !rule.description)) throw new Error('Missing readable demo description: ' + rule.code);
    const fields = rule.source?.fields ?? { 'VR Code': rule.code, Source: 'SYNTHETIC · demostración propia', Framework: set.context.framework, Modules: set.context.moduleVersion, 'Cross module': 'No', Tables: demo === 'corep' ? 'C_01.00' : 'DEMO_TYPES', Expression: rule.expression, Precondtion: rule.precondition ?? '', Description: rule.description, IsActive: 'Active', FromReferenceDate: '2025-01-01', ToReferenceDate: '', Severity: 'error', FromSubmissionDate: '', 'Implemented in XBRL': 'No' };
    return headers.map(header => fields[header] ?? '');
  });
  const provenance = [['Código', 'Procedencia', 'Archivo fuente', 'SHA-256', 'Hoja fuente', 'Fila fuente'], ...set.rules.map(rule => [rule.code, rule.origin === 'official_catalog' ? 'Catálogo publicado EBA; Source se conserva literalmente' : 'Regla sintética propia', rule.source?.sourceName ?? '', rule.source?.sourceSha256 ?? '', rule.source?.sourceSheet ?? '', rule.source ? String(rule.source.row) : ''])];
  return deterministicZip(workbookParts([{ name: 'Reglas', rows: [headers, ...rows], widths: headers.map(header => header === 'Expression' || header === 'Description' ? 110 : 26) }, { name: 'Procedencia', rows: provenance, widths: [25, 65, 70, 70, 50, 15] },
    { name: 'Instrucciones', widths: [110], rows: [['Demostración · datos sintéticos'], [demo === 'corep' ? '16 reglas: cinco del catálogo publicado EBA y once sintéticas. Los cinco campos Source oficiales se conservan como user_defined.' : 'Ocho reglas sintéticas de texto, fechas y condicionales. Solo validación; no se ofrecen recálculos.'], ['Los fallos de mayúsculas/espacios o desigualdad son intencionados y no significan un error del motor.']] }]));
}
await save('corep', 'catalog', catalog('corep')); await save('types', 'catalog', catalog('types'));
const templateManifest = JSON.parse(await readFile(path.join(root, 'assets/templates/manifest.json'), 'utf8'));
const template = templateManifest.profiles.find(profile => profile.profileId === 'eba-corep-of-4.0-ca1-v1' && profile.file === 'corep-ca1.xlsx');
const templateBytes = await readFile(path.join(root, 'assets/templates/corep-ca1.xlsx'));
if (!template || template.size !== templateBytes.length || template.sha256 !== hash(templateBytes)) throw new Error('Trusted COREP template hash mismatch');
const corep = await trustedZipParts(templateBytes);
let xml = corep.get('xl/worksheets/sheet1.xml').toString('utf8');
for (const input of data.corep.inputs) if (input.value !== null) {
  if (!/^-?\d+(?:\.\d+)?$/.test(input.value)) throw new Error('Invalid demo decimal');
  const existing = new RegExp('<c\\b(?=[^>]*\\br="' + input.valueCell + '")[^>]*>').exec(xml)?.[0], style = /\bs="([0-9]+)"/.exec(existing ?? '')?.[1];
  xml = replaceVisualCell(xml, input.valueCell, `<c r="${input.valueCell}"${style === undefined ? '' : ` s="${style}"`}><v>${input.value}</v></c>`);
}
corep.set('xl/worksheets/sheet1.xml', xml);
const context = data.corep.context;
corep.set('xl/worksheets/sheet2.xml', sheetXml([['Campo', 'Valor'], ['Perfil', 'eba-corep-of-4.0-ca1-v1'], ['Framework', context.framework], ['Módulo', context.moduleVersion], ['Entidad', context.entityId], ['Fecha de referencia', context.referenceDate], ['Fecha de envío', context.submissionDate], ['Divisa', context.unit], ['Escala', String(context.scale)], ['Decimales del importe', context.decimals], ['Tabla presentada', String(context.filingIndicators['C_01.00'])]]));
corep.set('xl/worksheets/sheet3.xml', sheetXml([['Demostración COREP 4.0 · C_01.00 · importes sintéticos'], ['Extracto derivado para trabajo local, no fichero oficial de remisión. Las reglas incluyen cinco del catálogo publicado EBA y once sintéticas.'], ['Resultado inicial esperado: 7 pasan, 8 fallan y 1 no aplica. La desigualdad negativa falla intencionadamente.'], ['Configura expresamente Izquierda solo en v0172_m, v0173_m, v0174_m, v0175_m y v0176_m.'], ['Simula: r0070 5 → 60,00; r0030 100 → 185,00; r0150 10 → 50,00; r0130 20 → 100,00; r0020 1000 → 285,00.'], ['Seleccionar v0172_m exige elegir sus cuatro antecedentes; el motor no añade selecciones automáticamente.'], ['Las dependencias son v0174_m → v0173_m → v0172_m y v0176_m → v0175_m → v0172_m.'], ['Aplica las cinco propuestas tras revisarlas: 14 pasan, 1 falla y 1 no aplica. Los dos condicionales también se revalidan.'], ['Los condicionales solo validan. No configures DEMO_RANGE: comparte destino con v0174_m.'], ['95 posiciones están vacías: no son cero. r0200 contiene un cero informado. EUR, escala 0, precisión 2.']], [115]));
await save('corep', 'report', deterministicZip(corep)); await save('types', 'report', typedWorkbook(typedMapping, data.typed.context, data.typed.fields));
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n');
if (process.argv.includes('--package')) {
  const target = path.join(root, 'apps/api/dist/assets/demos'); await mkdir(target, { recursive: true });
  for (const name of ['manifest.json', ...files.map(file => file.file)]) await copyFile(path.join(directory, name), path.join(target, name));
}
if (hash(await readFile(path.join(root, data.sourceName))) !== data.sourceSha256) throw new Error('Original catalogue changed during generation');
process.stdout.write('Visual demos: 24 rules, 110 COREP positions, 15 amounts and six typed fields; original EBA SHA-256 verified.\n');
