import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import readXlsxFile from 'read-excel-file/node';
import { CONTEXT_HEADERS, COORDINATE_HEADERS, EBA_HEADERS, FACT_HEADERS } from '@ce/contracts';
import { createApp } from '../../apps/api/dist/app.js';
import { inspectReportWorkbook } from '../../apps/api/dist/import/profiles/registry.js';
import { deterministicZip, replaceVisualCell, trustedZipParts, workbookParts } from '../../scripts/lib/visual-xlsx.mjs';

// Characterization of iteration 002. Build the API first. Each run owns its scratch directory and workspaces.
const root = fileURLToPath(new URL('../../', import.meta.url));
const scratch = path.join(root, '.cache/003-finrep-probe');
await mkdir(scratch, { recursive: true });
const runDirectory = await mkdtemp(path.join(scratch, 'run-'));
const sourcePath = path.join(root, 'tests/fixtures/eba/official-annexes-4.0.xlsx');
const sourceHash = 'f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7';
const source = await readFile(sourcePath);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(hash(source), sourceHash, 'Unexpected reference workbook');

const table = 'F_01.01';
const column = '0010';
const moduleName = 'FINREP_SYNTHETIC';
const referenceDate = '2025-12-31';
const cells = [
  { address: 'F8', row: '0010', value: '100' },
  { address: 'F9', row: '0020', value: '40' },
  { address: 'F10', row: '0030', value: '35' },
  { address: 'F11', row: '0040', value: '25' },
];
const rules = [
  {
    code: 'CUSTOM_FIN_TOTAL',
    expression: 'with {tF_01.01,c0010,interval:false}: {r0010}={r0020}+{r0030}+{r0040}',
    description: '100 = 40 + 35 + 25',
    expected: { status: 'pass', left: '100', right: '100', rows: ['0010', '0020', '0030', '0040'] },
  },
  {
    code: 'CUSTOM_FIN_GREATER',
    expression: 'with {tF_01.01,c0010,interval:false}: {r0020}>{r0010}',
    description: '40 > 100',
    expected: { status: 'fail', left: '40', right: '100', rows: ['0010', '0020'] },
  },
];

const catalog = deterministicZip(workbookParts([{ name: 'Custom rules', rows: [
  EBA_HEADERS,
  ...rules.map(rule => [rule.code, 'SYNTHETIC', 'FINREP', moduleName, 'No', table, rule.expression,
    '', rule.description, 'Active', '2025-01-01', '', 'Error', '', 'No']),
] }]));
const legacy = deterministicZip(workbookParts([
  { name: 'Instructions', rows: [['ce-report-1'], ['Synthetic FINREP compatibility fixture']] },
  { name: 'Contexts', rows: [
    CONTEXT_HEADERS,
    ['ce-report-1', 'finrep', 'SYNTHETIC', referenceDate, referenceDate, 'FINREP', moduleName, JSON.stringify({ [table]: true })],
  ] },
  { name: 'Coordinates', rows: [
    COORDINATE_HEADERS,
    ...cells.map(cell => ['finrep', table, '', cell.row, column, 'number', 'EUR', '2', '{}']),
  ] },
  { name: 'Facts', rows: [
    FACT_HEADERS,
    ...cells.map(cell => ['finrep', table, '', cell.row, column, 'value', cell.value]),
  ] },
]));

// Use the real sheet from the hash-pinned source. Preserve its labels, grid and styles.
const sourceParts = await trustedZipParts(source);
const sheetName = '1.1';
const sheetPath = 'xl/worksheets/sheet69.xml';
assert.match(sourceParts.get('xl/workbook.xml').toString(), /<sheet\b(?=[^>]*name="1\.1")(?=[^>]*r:id="rId69")[^>]*>/);
assert.match(sourceParts.get('xl/_rels/workbook.xml.rels').toString(), /<Relationship\b(?=[^>]*Id="rId69")(?=[^>]*Target="worksheets\/sheet69\.xml")[^>]*>/);
let sheetXml = sourceParts.get(sheetPath).toString().replace(/<pageSetup\b[^>]*\/>/g, '');
for (const cell of cells) {
  const tag = sheetXml.match(new RegExp('<c\\b(?=[^>]*\\br="' + cell.address + '")[^>]*>'))[0];
  const styleAttribute = tag.match(/ s="[0-9]+"/)?.[0] ?? '';
  const replacement = '<c r="' + cell.address + '"' + styleAttribute + '><v>' + cell.value + '</v></c>';
  sheetXml = replaceVisualCell(sheetXml, cell.address, replacement);
}
const extracted = workbookParts([{ name: sheetName, xml: sheetXml }]);
const dependencies = [
  ['sharedStrings.xml', 'sharedStrings', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml'],
  ['styles.xml', 'styles', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
  ['theme/theme1.xml', 'theme', 'application/vnd.openxmlformats-officedocument.theme+xml'],
];
for (const [index, [target, type, mime]] of dependencies.entries()) {
  const part = 'xl/' + target;
  extracted.set(part, sourceParts.get(part));
  const override = '<Override PartName="/' + part + '" ContentType="' + mime + '"/>';
  extracted.set('[Content_Types].xml', extracted.get('[Content_Types].xml').replace('</Types>', override + '</Types>'));
  const relationType = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/' + type;
  const relationship = '<Relationship Id="rId' + (index + 2) + '" Type="' + relationType + '" Target="' + target + '"/>';
  const relationshipPart = 'xl/_rels/workbook.xml.rels';
  extracted.set(relationshipPart, extracted.get(relationshipPart).replace('</Relationships>', relationship + '</Relationships>'));
}
const visual = deterministicZip(extracted);
const extractedSheets = await readXlsxFile(visual, { trim: false, parseNumber: text => text });
assert.deepEqual(extractedSheets.map(sheet => sheet.sheet), [sheetName]);
const grid = extractedSheets[0].data;
assert.equal(grid[2][1], '1.1 Assets');
assert.equal(grid[6][5], column);
for (const cell of cells) {
  const rowIndex = Number(cell.address.slice(1)) - 1;
  assert.equal(grid[rowIndex][1], cell.row);
  assert.equal(grid[rowIndex][5], cell.value);
}
const catalogName = 'catalog-custom.xlsx';
const visualName = 'finrep-1.1.xlsx';
const legacyName = 'finrep-ce-report-1.xlsx';
const visualPath = path.join(runDirectory, visualName);
await writeFile(visualPath, visual);
await writeFile(path.join(runDirectory, legacyName), legacy);
await writeFile(path.join(runDirectory, catalogName), catalog);

async function waitForJob(app, base, headers, jobId) {
  const deadline = Date.now() + 65_000;
  while (Date.now() < deadline) {
    const response = await app.inject({ url: base + '/jobs/' + jobId, headers });
    assert.equal(response.statusCode, 200, response.body);
    const job = response.json();
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job;
    await delay(40);
  }
  throw new Error('Job observation deadline exceeded');
}

async function probe(profile) {
  const isVisual = profile === 'visual';
  const app = await createApp({ mode: 'production', apiPort: 0, serveWeb: false });
  try {
    const host = '127.0.0.1:0';
    const bootstrap = await app.inject({ url: '/api/v1/bootstrap', headers: { host } });
    assert.equal(bootstrap.statusCode, 200);
    const headers = { host, 'x-ce-session': bootstrap.json().sessionToken };
    const created = await app.inject({
      method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'FINREP compatibility probe' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const base = '/api/v1/workspaces/' + created.json().id;
    const form = new FormData();
    form.append('catalog', new Blob([catalog]), catalogName);
    form.append('reports', new Blob([isVisual ? visual : legacy]), isVisual ? visualName : legacyName);
    if (isVisual) {
      form.append('context', JSON.stringify({
        source: 'form',
        declaration: {
          entityId: 'SYNTHETIC', referenceDate, submissionDate: referenceDate,
          currency: 'EUR', scaleExponent: 0, displayDecimals: 2, filingIndicators: { [table]: true },
        },
      }));
    }
    const multipart = new Request('http://127.0.0.1', { method: 'POST', body: form });
    const accepted = await app.inject({
      method: 'POST', url: base + (isVisual ? '/import-inspections' : '/imports'),
      headers: {
        ...headers, 'if-match': created.headers.etag, 'idempotency-key': randomUUID(),
        'content-type': multipart.headers.get('content-type'),
      },
      payload: Buffer.from(await multipart.arrayBuffer()),
    });
    assert.equal(accepted.statusCode, 202, accepted.body);
    const job = await waitForJob(app, base, headers, accepted.json().jobId);
    const workspaceResponse = await app.inject({ url: base, headers });
    assert.equal(workspaceResponse.statusCode, 200);
    const workspace = workspaceResponse.json();
    const outcome = {
      http: accepted.statusCode, job: job.status,
      diagnostics: job.diagnostics.map(({ code, message, fileName }) => ({ code, message, fileName })),
      versions: workspace.versionIds.length,
    };

    if (isVisual) return outcome;
    assert.equal(job.status, 'succeeded', JSON.stringify(job.diagnostics));
    assert.equal(workspace.currentVersionId, job.newVersionId);
    const validation = await app.inject({
      method: 'POST', url: base + '/validations',
      headers: { ...headers, 'if-match': workspaceResponse.headers.etag, 'idempotency-key': randomUUID() },
      payload: { baseVersionId: job.newVersionId },
    });
    assert.equal(validation.statusCode, 202, validation.body);
    const runJob = await waitForJob(app, base, headers, validation.json().jobId);
    assert.equal(runJob.status, 'succeeded', JSON.stringify(runJob.diagnostics));
    const response = await app.inject({ url: base + '/runs/' + runJob.resultRef.id + '/results?limit=50', headers });
    assert.equal(response.statusCode, 200);
    const page = response.json();
    assert.equal(page.versionId, job.newVersionId);
    return {
      ...outcome, counts: workspace.counts, runStatus: page.run.status,
      complete: page.run.summary.complete, byStatus: page.run.summary.byStatus,
      items: page.items.map(result => ({
        code: result.code, status: result.status, expression: result.expression,
        left: result.values.left?.nominal, right: result.values.right?.nominal,
        reads: result.factReads.map(read => ({
          table: read.coordinate.tableCode, row: read.coordinate.rowCode, column: read.coordinate.columnCode,
          type: read.coordinate.dataType, originalText: read.originalText, unit: read.coordinate.unit,
        })).sort((a,b) => a.row.localeCompare(b.row)),
      })),
    };
  } finally {
    await app.close();
  }
}

// Public inspection and diagnostic detail are measured independently using the same bytes.
let recognition;
try {
  const inspected = await inspectReportWorkbook(visualPath);
  recognition = { profileId: inspected.profileId };
} catch (error) {
  recognition = { code: error.code, reason: error.details?.reason };
}

const evidence = {
  outputDirectory: path.relative(root, runDirectory).split(path.sep).join('/'),
  nodeVersion: process.version, gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  source: { sourceSha256: sourceHash, sheet: sheetName, sheetPath, table, column, contextModule: moduleName, referenceDate, cells },
  fixtureHashes: { catalog: hash(catalog), visual: hash(visual), legacy: hash(legacy) },
  expected: Object.fromEntries(rules.map(rule => [rule.code, rule.expected])),
  recognition, visual: await probe('visual'), legacy: await probe('legacy'),
  sourceUnchanged: hash(await readFile(sourcePath)) === sourceHash,
};
const resultPath = path.join(runDirectory, 'result.json');
await writeFile(resultPath, JSON.stringify(evidence, null, 2) + '\n');
console.log('Evidence saved in', path.relative(root, resultPath));

// These assertions describe the current boundary. Review a new visual acceptance as a product change.
assert.deepEqual(evidence.recognition, { code: 'INVALID_WORKBOOK', reason: 'UNRECOGNIZED_COREP_SHEETS' });
assert.deepEqual(evidence.visual, {
  http: 202, job: 'failed', versions: 0,
  diagnostics: [{ code: 'INVALID_WORKBOOK', message: 'El libro contiene datos no válidos.', fileName: visualName }],
});

// The positive path requires complete evaluation and exact operands and source values for each rule.
assert.equal(evidence.sourceUnchanged, true);
assert.equal(evidence.legacy.versions, 1);
assert.equal(evidence.legacy.counts.coordinates, 4);
assert.equal(evidence.legacy.counts.facts, 4);
assert.equal(evidence.legacy.items.length, 2);
assert.equal(evidence.legacy.runStatus, 'completed');
assert.equal(evidence.legacy.complete, true);
assert.deepEqual(evidence.legacy.byStatus, { pass: 1, fail: 1, not_applicable: 0, not_evaluable: 0, error: 0 });
for (const rule of rules) {
  const observed = evidence.legacy.items.find(item => item.code === rule.code);
  assert.ok(observed, 'Missing rule ' + rule.code);
  assert.equal(observed.expression, rule.expression);
  assert.equal(observed.status, rule.expected.status);
  assert.deepEqual(observed.left, { numerator: rule.expected.left, denominator: '1' });
  assert.deepEqual(observed.right, { numerator: rule.expected.right, denominator: '1' });
  const expectedReads = rule.expected.rows.map(row => ({
    table, row, column, type: 'number', originalText: cells.find(cell => cell.row === row).value, unit: 'EUR',
  }));
  assert.deepEqual(observed.reads, expectedReads);
}
console.log('Visual rejection characterized; legacy FINREP produced the two expected results.');
