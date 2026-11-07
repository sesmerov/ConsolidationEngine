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
  const set = demo === 'corep' ? data.corep : demo === 'finrep' ? data.finrep : data.typed;
  const rows = set.rules.map(rule => {
    if (!rule.source && (typeof rule.description !== 'string' || !rule.description)) throw new Error('Missing readable demo description: ' + rule.code);
    const fields = rule.source?.fields ?? { 'VR Code': rule.code, Source: 'SYNTHETIC · demostración propia', Framework: set.context.framework, Modules: set.context.moduleVersion, 'Cross module': 'No', Tables: demo === 'corep' ? 'C_01.00' : demo==='finrep'?'F_01.01':'DEMO_TYPES', Expression: rule.expression, Precondtion: rule.precondition ?? '', Description: rule.description, IsActive: 'Active', FromReferenceDate: '2025-01-01', ToReferenceDate: '', Severity: 'error', FromSubmissionDate: '', 'Implemented in XBRL': 'No' };
    return headers.map(header => fields[header] ?? '');
  });
  const provenance = [['Código', 'Procedencia', 'Archivo fuente', 'SHA-256', 'Hoja fuente', 'Fila fuente'], ...set.rules.map(rule => [rule.code, rule.origin === 'official_catalog' ? 'Catálogo publicado EBA; Source se conserva literalmente' : 'Regla sintética propia', rule.source?.sourceName ?? '', rule.source?.sourceSha256 ?? '', rule.source?.sourceSheet ?? '', rule.source ? String(rule.source.row) : ''])];
  return deterministicZip(workbookParts([{ name: 'Reglas', rows: [headers, ...rows], widths: headers.map(header => header === 'Expression' || header === 'Description' ? 110 : 26) }, { name: 'Procedencia', rows: provenance, widths: [25, 65, 70, 70, 50, 15] },
    { name: 'Instrucciones', widths: [110], rows: [['Demostración · datos sintéticos'], [demo === 'corep' ? '16 reglas: cinco del catálogo publicado EBA y once sintéticas. Los cinco campos Source oficiales se conservan como user_defined.' : demo==='finrep'?'Cinco reglas propias sobre F 01.01. Dos igualdades recalculables y tres comprobaciones de solo validación. FINREP_F0101_4.0 es un alias local de presentación, no un módulo XBRL oficial.':'Ocho reglas sintéticas de texto, fechas y condicionales. Solo validación; no se ofrecen recálculos.'], ['Los fallos de mayúsculas/espacios o desigualdad son intencionados y no significan un error del motor.']] }]));
}
await save('corep', 'catalog', catalog('corep')); await save('types', 'catalog', catalog('types'));
await save('finrep','catalog',catalog('finrep'));
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
corep.set('xl/worksheets/sheet3.xml', sheetXml([
  ['Demostración COREP 4.0 · C_01.00 · importes sintéticos'],
  ['Extracto derivado para trabajo local, no fichero oficial de remisión. Las reglas incluyen cinco del catálogo publicado EBA y once sintéticas.'],
  ['Resultado inicial esperado: 7 pasan, 8 fallan y 1 no aplica. La desigualdad negativa falla intencionadamente.'],
  ['Prepara la revisión de destinos. En r0070 elige v0174_m y confirma la elección. En r0200 elige No recalcular esta celda. Puedes cambiar ambas decisiones.'],
  ['Guarda la configuración con 5 incluidas, 4 omitidas y 7 excluidas. Simula los cinco productores oficiales: r0070 5 → 60,00; r0030 100 → 185,00; r0150 10 → 50,00; r0130 20 → 100,00; r0020 1000 → 285,00.'],
  ['Las cinco propuestas empiezan seleccionadas. Desmarcar un antecedente bloquea la aplicación hasta completar la selección; no se restaura automáticamente.'],
  ['Las dependencias son v0174_m → v0173_m → v0172_m y v0176_m → v0175_m → v0172_m.'],
  ['Aplica las cinco propuestas tras revisarlas: 14 pasan, 1 falla y 1 no aplica. Los dos condicionales también se revalidan.'],
  ['Los condicionales solo validan. La etapa Descargar se destaca tras aplicar los cambios.'],
  ['95 posiciones están vacías: no son cero. r0200 contiene un cero informado. EUR, escala 0, precisión 2.'],
], [115]));
await save('corep', 'report', deterministicZip(corep)); await save('types', 'report', typedWorkbook(typedMapping, data.typed.context, data.typed.fields));
const finrepMapping=JSON.parse(await readFile(path.join(root,'apps/api/src/import/profiles/finrep-f0101-mapping.json'),'utf8'));
const finrepBytes=await readFile(path.join(root,'assets/templates/finrep-f0101.xlsx')),finrepTemplate=templateManifest.profiles.find(p=>p.profileId==='eba-finrep-4.0-f0101-v1');
if(!finrepTemplate||finrepTemplate.size!==finrepBytes.length||finrepTemplate.sha256!==hash(finrepBytes))throw new Error('Trusted FINREP template hash mismatch');
const finrep=await trustedZipParts(finrepBytes);let finrepXml=finrep.get('xl/worksheets/sheet1.xml').toString('utf8');
for(const m of finrepMapping.mapping){const value=data.finrep.values[m.rowCode]??'0';if(!/^-?\d+(?:\.\d+)?$/.test(value))throw new Error('Invalid FINREP amount');const cell=new RegExp('<c\\b(?=[^>]*\\br="'+m.amountCell+'")[^>]*>').exec(finrepXml)?.[0],style=/\bs="([0-9]+)"/.exec(cell??'')?.[1];finrepXml=replaceVisualCell(finrepXml,m.amountCell,`<c r="${m.amountCell}"${style===undefined?'':` s="${style}"`}><v>${value}</v></c>`);}
finrep.set('xl/worksheets/sheet1.xml',finrepXml);const fc=data.finrep.context;
finrep.set('xl/worksheets/sheet2.xml',sheetXml([['Campo','Valor'],['Perfil','eba-finrep-4.0-f0101-v1'],['Framework',fc.framework],['Módulo',fc.moduleVersion],['Entidad',fc.entityId],['Fecha de referencia',fc.referenceDate],['Fecha de envío',fc.submissionDate],['Divisa',fc.unit],['Escala',String(fc.scale)],['Decimales del importe',fc.decimals],['Tabla presentada',String(fc.filingIndicators['F_01.01'])]]));
finrep.set('xl/worksheets/sheet3.xml',sheetXml([['FINREP F 01.01 · demostración propia con datos sintéticos'],['Cuadrícula derivada del anexo oficial 4.0; perfil local de presentación, no fichero oficial de remisión.'],['Carga ambos archivos y valida: 2 pasan y 3 fallan.'],['Guarda los dos destinos automáticos y simula: efectivo 90 → 100; total simplificado 105 → 120.'],['Las dos propuestas empiezan seleccionadas. Revisa los cambios y acepta antes de aplicar.'],['Después: 4 pasan y 1 falla intencionadamente. Desigualdades y condicional solo validan.'],['Descarga la versión aplicada y vuelve a cargarla en otro conjunto para comprobar los mismos datos.']], [115]));
await save('finrep','report',deterministicZip(finrep));
await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({ version: 1, files }, null, 2) + '\n');
if (process.argv.includes('--package')) {
  const target = path.join(root, 'apps/api/dist/assets/demos'); await mkdir(target, { recursive: true });
  for (const name of ['manifest.json', ...files.map(file => file.file)]) await copyFile(path.join(directory, name), path.join(target, name));
}
if (hash(await readFile(path.join(root, data.sourceName))) !== data.sourceSha256) throw new Error('Original catalogue changed during generation');
process.stdout.write('Visual demos: 29 rules, 110 COREP positions, 38 FINREP positions and six typed fields; original EBA SHA-256 verified.\n');
