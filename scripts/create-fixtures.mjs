import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import yauzl from 'yauzl';
import sax from 'sax';

const root = fileURLToPath(new URL('../', import.meta.url));
const sourceName = '(from 4.0) EBA_Validation_rules_2025-12-12.xlsx';
const expected = '36636afe42b2ef2247822a31ad710afe1128b5b65a250b657e1f20d5a75bba79';
const bytes = await readFile(path.join(root, sourceName));
const hash = (value) => createHash('sha256').update(value).digest('hex');
if (hash(bytes) !== expected) throw new Error('The reference workbook changed; fixture extraction refused.');
const sheets = await readXlsxFile(bytes, { parseNumber: (text) => text, trim: false });
const sheet = sheets.find((item) => item.sheet === 'EBA_Validation_rules_2025-12-12');
if (!sheet) throw new Error('Reference sheet missing.');
const raw = new Map();
const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, file) => error ? reject(error) : resolve(file)));
await new Promise((resolve, reject) => {
  zip.on('error', reject); zip.on('end', resolve);
  zip.on('entry', async (entry) => {
    try {
      if (entry.fileName !== 'xl/worksheets/sheet1.xml') { zip.readEntry(); return; }
      const stream = await new Promise((ok, fail) => zip.openReadStream(entry, (error, value) => error ? fail(error) : ok(value)));
      const parser = sax.parser(true, { xmlns: true, strictEntities: true });
      let cell; let value = false;
      parser.onopentag = (node) => {
        if (node.local === 'c') { const address = node.attributes.r?.value; cell = /^(?:[A-O])(?:113|169|170)$/.test(address ?? '') ? { address, xmlType: node.attributes.t?.value ?? 'n', style: node.attributes.s?.value ?? null, lexeme: '' } : undefined; }
        if (node.local === 'v') value = true;
      };
      parser.ontext = (text) => { if (cell && value) cell.lexeme += text; };
      parser.onclosetag = (name) => { if (name === 'v') value = false; if (name === 'c' && cell) { raw.set(cell.address, cell); cell = undefined; } };
      parser.onerror = (error) => { throw error; };
      for await (const chunk of stream) parser.write(chunk.toString('utf8')); parser.close(); zip.readEntry();
    } catch (error) { reject(error); zip.close(); }
  }); zip.readEntry();
}); zip.close();
const output = path.join(root, 'tests/fixtures'); const generated = path.join(output, 'generated'); await mkdir(generated, { recursive: true });
const normalize = (value) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
const headers = sheet.data[0];
const cases = [113, 169, 170].map((row) => ({ cell: 'G' + row, row, code: sheet.data[row - 1][0],
  values: Object.fromEntries(headers.map((header, column) => [header, normalize(sheet.data[row - 1][column] ?? null)])),
  raw: Array.from({ length: 15 }, (_, column) => raw.get(String.fromCharCode(65 + column) + row) ?? null),
}));
await writeFile(path.join(output, 'source-manifest.json'), JSON.stringify({ sourceName, sha256: expected, sheet: sheet.sheet, cases,
  grammarHashes: { lexer: 'dda7b8de2c8e1430448cad7a342c712d52ba1b5bd533730b4eafede02bb5805a', parser: '30fd37bddfdd356294801e53c7cf4864547a71d0ed13d1b884a3d9c6b6d884b4' } }, null, 2) + '\n');
const textCell = (value) => value === null || value === undefined ? null : { type: String, value: String(value) };
await writeXlsxFile([headers.map(textCell), ...cases.map((record) => headers.map((header) => textCell(record.values[header])))], { sheet: sheet.sheet, stickyRowsCount: 1 }).toFile(path.join(generated, 'eba-subset.xlsx'));
const contextHeaders = ['templateVersion', 'contextId', 'entityId', 'referenceDate', 'submissionDate', 'framework', 'moduleVersion', 'filingIndicators'];
const coordinateHeaders = ['contextId', 'tableCode', 'sheetCode', 'rowCode', 'columnCode', 'dataType', 'unit', 'decimals', 'axes'];
const factHeaders = ['contextId', 'tableCode', 'sheetCode', 'rowCode', 'columnCode', 'presence', 'value'];
for (const scenario of [{ name: 'report-42', date: '2026-06-30', module: 'COREP_OF_4.2' }, { name: 'report-40', date: '2025-12-31', module: 'COREP_OF_4.0' }]) {
  const data = [
    { sheet: 'Instructions', data: [['ce-report-1'], ['Ejemplo SYNTHETIC. Entidad e importes sintéticos; reglas reales conservadas con procedencia.'], ['Los importes y códigos son texto. null explícito usa presence=null y valor vacío. Ausencia sólo se permite en coordenadas declaradas.']] },
    { sheet: 'Contexts', data: [contextHeaders, ['ce-report-1', 'demo', 'SYNTHETIC', scenario.date, scenario.date, 'COREP', scenario.module, JSON.stringify(scenario.name === 'report-42' ? { 'C_01.00': true, 'C_05.01': true } : { 'C_18.00': true })]] },
    { sheet: 'Coordinates', data: [coordinateHeaders, ['demo', 'C_01.00', '', '0230', '0010', 'number', 'EUR', '2', '{}'], ['demo', 'C_05.01', '', '0090', '0060', 'number', 'EUR', '2', '{}'], ['demo', 'C_01.00', '', '0240', '0010', 'number', 'EUR', 'INF', '{}'], ['demo', 'C_01.00', '', '0250', '0010', 'number', 'EUR', '2', '{}'], ['demo', 'C_01.00', '', '0260', '0010', 'number', 'EUR', '2', '{}'], ['demo', 'C_01.00', '', '0270', '0010', 'number', 'EUR', '2', '{}']] },
    { sheet: 'Facts', data: [factHeaders, ['demo', 'C_01.00', '', '0230', '0010', 'value', '10.00'], ['demo', 'C_05.01', '', '0090', '0060', 'value', '10.00'], ['demo', 'C_01.00', '', '0240', '0010', 'value', '123456789012345678901234567890.123456789'], ['demo', 'C_01.00', '', '0250', '0010', 'value', '0'], ['demo', 'C_01.00', '', '0260', '0010', 'null', '']] },
  ];
  if (scenario.name === 'report-40') {
    data[2].data = [coordinateHeaders, ...['001', '002'].flatMap((sheetCode) => ['0011', '0020', '0210'].map((rowCode) => ['demo', 'C_18.00', sheetCode, rowCode, '0060', 'number', 'EUR', '2', '{}']))];
    data[3].data = [factHeaders, ...['001', '002'].flatMap((sheetCode) => [['0011', '12'], ['0020', '5'], ['0210', '7']].map(([rowCode, value]) => ['demo', 'C_18.00', sheetCode, rowCode, '0060', 'value', value]))];
  }
  await writeXlsxFile(data.map((item) => ({ ...item, data: item.data.map((row) => row.map(textCell)), stickyRowsCount: 1 }))).toFile(path.join(generated, scenario.name + '.xlsx'));
}
await writeFile(path.join(output, 'import-cases.json'), JSON.stringify({ syntheticEntity: 'SYNTHETIC', cases: [
  { report: 'report-42.xlsx', referenceDate: '2026-06-30', module: 'COREP_OF_4.2', applicableSourceCells: ['G169'] },
  { report: 'report-40.xlsx', referenceDate: '2025-12-31', module: 'COREP_OF_4.0', applicableSourceCells: ['G113'], inactiveSourceCells: ['G170'], note: 'Inactive rows remain visible and are not evaluated.' },
], expected: { catalogRows: 3, coordinates: 6, facts: 5, explicitNulls: 1, implicitNulls: 1, zeroText: '0', exactText: '123456789012345678901234567890.123456789' },
  expectedByReport: { 'report-42.xlsx': { coordinates: 6, facts: 5, applicableSourceCells: ['G169'] }, 'report-40.xlsx': { coordinates: 6, facts: 6, finiteSheets: ['001', '002'], target: '12', summands: ['5', '7'], applicableSourceCells: ['G113'] } },
}, null, 2) + '\n');
if (hash(await readFile(path.join(root, sourceName))) !== expected) throw new Error('Original changed during fixture creation.');
console.log('Fixtures generated from 3 verified source rows; original SHA-256 unchanged.');
await import('./create-visual-demos.mjs');
