import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../apps/api/dist/app.js';
import { deterministicZip, replaceVisualCell, trustedZipParts } from './lib/visual-xlsx.mjs';

// Separate API-only measurement: 110 CA1 positions, never the 100000-fact legacy cohort.
const output = path.resolve(process.argv[2] ?? `.cache/benchmark/corep-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(path.dirname(output), { recursive: true }); await mkdir(output);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const officialPath = 'tests/fixtures/eba/official-annexes-4.0.xlsx';
const official = await readFile(officialPath), sources = JSON.parse(await readFile('tests/fixtures/eba/source-manifest.json', 'utf8'));
const source = sources.sources.find(row => row.file === 'official-annexes-4.0.xlsx');
assert.equal(hash(official), source.sha256); assert.equal(official.length, source.bytes);
const manifest = JSON.parse(await readFile('assets/demos/manifest.json', 'utf8'));
async function demo(artifact) {
  const entry = manifest.files.find(row => row.demo === 'corep' && row.kind === artifact), bytes = await readFile(path.join('assets/demos', entry.file));
  assert.equal(hash(bytes), entry.sha256); assert.equal(bytes.length, entry.size); return bytes;
}
const catalog = await demo('catalog'), extract = await demo('report');
const data = JSON.parse(await readFile('assets/demos/source-data.json', 'utf8')), inputs = data.corep.inputs.filter(input => input.value !== null);
assert.equal(data.corep.inputs.length, 110); assert.equal(inputs.length, 15); assert.equal(new Set(inputs.map(input => input.valueCell)).size, 15);
const parts = await trustedZipParts(official), workbook = parts.get('xl/workbook.xml').toString('utf8');
assert.equal([...workbook.matchAll(/<sheet\b/g)].length, 191);
const attr = (tag, name) => new RegExp('\\b' + name + '="([^"]+)"').exec(tag)?.[1];
const sheet = [...workbook.matchAll(/<sheet\b[^>]*>/g)].find(match => attr(match[0], 'name') === 'CA1')?.[0]; assert.ok(sheet);
const relationships = parts.get('xl/_rels/workbook.xml.rels').toString('utf8');
const relation = [...relationships.matchAll(/<Relationship\b[^>]*>/g)].find(match => attr(match[0], 'Id') === attr(sheet, 'r:id'))?.[0]; assert.ok(relation);
const target = attr(relation, 'Target'), sheetPart = target.startsWith('/') ? target.slice(1) : path.posix.normalize('xl/' + target);
let xml = parts.get(sheetPart).toString('utf8');
for (const input of inputs) {
  assert.match(input.value, /^-?\d+(?:\.\d+)?$/);
  const previous = new RegExp('<c\\b(?=[^>]*\\br="' + input.valueCell + '")[^>]*>').exec(xml)?.[0], style = /\bs="([0-9]+)"/.exec(previous ?? '')?.[1];
  xml = replaceVisualCell(xml, input.valueCell, `<c r="${input.valueCell}"${style === undefined ? '' : ` s="${style}"`}><v>${input.value}</v></c>`);
}
const patched = new Map(parts); patched.set(sheetPart, Buffer.from(xml));
for (const [name, bytes] of parts) if (name !== sheetPart) assert.deepEqual(patched.get(name), bytes);
const full = deterministicZip(patched), context = data.corep.context;
const contextInput = { source: 'form', declaration: { entityId: context.entityId, referenceDate: context.referenceDate, submissionDate: context.submissionDate,
  currency: context.unit, scaleExponent: context.scale, displayDecimals: Number(context.decimals), filingIndicators: context.filingIndicators } };
const protocol = { actor: 'Automated API script, not human acceptance or browser rendering', positions: 110, values: 15, blanks: 95, pollMilliseconds: 25,
  freshAppPerCase: true, listenPort: 0, requestHost: '127.0.0.1:0',
  uploadAcceptanceMs: 'HTTP upload request starts until the full 202 response is received; multipart encoding is prepared beforehand',
  inspectionReadyMs: '202 response received until succeeded job and ready inspection are observed',
  commitPublishedMs: 'commit request starts until succeeded job and published workspace are observed',
  totalImportMs: 'upload starts until publication; includes automated inspection verification between stages, no human review time',
  scope: 'Separate COREP load measurement; no claim about the 500-rule/100000-fact validation SLA' };
const reference = { capturedAt: new Date().toISOString(), commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), dirty: execFileSync('git', ['status', '--short'], { encoding: 'utf8' }),
  runtime: { node: process.version, v8: process.versions.v8 }, hardware: { cpu: os.cpus()[0]?.model, logicalProcessors: os.cpus().length, ramBytes: os.totalmem(), platform: os.platform(), architecture: os.arch(), osRelease: os.release() }, protocol,
  inputs: { catalog: { bytes: catalog.length, sha256: hash(catalog) }, extract: { bytes: extract.length, sha256: hash(extract) }, fullSynthetic: { bytes: full.length, sha256: hash(full), modifiedPart: sheetPart, modifiedValueCells: inputs.map(input => input.valueCell) }, original: { file: officialPath, sha256: hash(official), sheets: 191 } } };
await writeFile(path.join(output, 'reference.json'), JSON.stringify(reference, null, 2), { flag: 'wx' });

async function measure(name, bytes, contextBody, exclusions) {
  const app = await createApp({ mode: 'production', apiPort: 0, serveWeb: false }); const result = { case: name, passed: false, milliseconds: {}, counts: {}, errors: [] };
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 }); result.port = new URL(address).port;
    // The socket is the owned ephemeral listener. Host :0 matches this app's test guard,
    // so no pre-existing application or fixed port is contacted.
    const http = (url, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const req = request(new URL(url, address), { method, headers: { host: '127.0.0.1:0', ...headers } }, response => {
        const chunks = []; let size = 0; response.on('error', reject);
        response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) { response.destroy(new Error('Benchmark response limit')); return; } chunks.push(chunk); });
        response.on('end', () => { try { resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); } });
      });
      req.on('error', reject); req.setTimeout(125000, () => req.destroy(new Error('Benchmark HTTP timeout'))); req.end(body);
    });
    const bootstrap = await http('/api/v1/bootstrap'); assert.equal(bootstrap.status, 200); const headers = { 'X-CE-Session': bootstrap.body.sessionToken };
    const created = await http('/api/v1/workspaces', 'POST', { ...headers, 'Content-Type': 'application/json' }, JSON.stringify({ name: `SYNTHETIC COREP ${name}` })); assert.equal(created.status, 201);
    const base = `/api/v1/workspaces/${created.body.id}`, etag = created.headers.etag;
    const waitJob = async id => {
      const deadline = performance.now() + 65000;
      while (performance.now() < deadline) {
        const response = await http(`${base}/jobs/${id}`, 'GET', headers); assert.equal(response.status, 200); const job = response.body;
        if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) { assert.equal(job.status, 'succeeded', JSON.stringify(job.diagnostics)); return job; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Benchmark job exceeded observation deadline');
    };
    const form = new FormData(); form.append('catalog', new Blob([catalog]), 'demo-corep-catalog.xlsx'); form.append('reports', new Blob([bytes]), `${name}-SYNTHETIC.xlsx`); form.append('context', JSON.stringify(contextBody));
    const encoded = new Request('http://127.0.0.1/', { method: 'POST', body: form }), payload = Buffer.from(await encoded.arrayBuffer());
    const uploadStart = performance.now(), accepted = await http(`${base}/import-inspections`, 'POST', { ...headers, 'Content-Type': encoded.headers.get('Content-Type'), 'Content-Length': String(payload.length), 'If-Match': etag, 'Idempotency-Key': randomUUID() }, payload);
    const acceptedAt = performance.now(); assert.equal(accepted.status, 202, JSON.stringify(accepted.body)); result.milliseconds.uploadAcceptanceMs = acceptedAt - uploadStart;
    const inspectedJob = await waitJob(accepted.body.jobId), inspectionResponse = await http(`${base}/import-inspections/${inspectedJob.resultRef.id}`, 'GET', headers), readyAt = performance.now();
    assert.equal(inspectionResponse.status, 200); const inspection = inspectionResponse.body; assert.equal(inspection.state, 'ready');
    result.milliseconds.inspectionReadyMs = readyAt - acceptedAt; result.milliseconds.uploadToReadyMs = readyAt - uploadStart;
    assert.equal(inspection.reports.length, 1); const report = inspection.reports[0]; assert.equal(report.coordinates, 110); assert.equal(report.values, 15); assert.equal(report.coordinates - report.values, 95);
    assert.deepEqual(report.selectedSheets, ['CA1']); assert.equal(report.excludedSheets.length, exclusions); assert.equal(inspection.requiresPartialCoverageAcceptance, exclusions > 0);
    const beforeCommit = await http(base, 'GET', headers); assert.equal(beforeCommit.headers.etag, etag); assert.equal(beforeCommit.body.versionIds.length, 0);
    const commitStart = performance.now(); result.milliseconds.automatedReviewMs = commitStart - readyAt;
    const committed = await http(`${base}/import-inspections/${inspection.id}/commit`, 'POST', { ...headers, 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': randomUUID() }, JSON.stringify({ inspectionHash: inspection.inspectionHash, acceptedExcludedSheets: exclusions > 0 }));
    assert.equal(committed.status, 202, JSON.stringify(committed.body)); const commitJob = await waitJob(committed.body.jobId), published = await http(base, 'GET', headers), publishedAt = performance.now();
    result.milliseconds.commitPublishedMs = publishedAt - commitStart; result.milliseconds.totalImportMs = publishedAt - uploadStart;
    assert.equal(published.status, 200); assert.equal(published.body.currentVersionId, commitJob.newVersionId); assert.equal(published.body.versionIds.length, 1); assert.equal(published.body.counts.coordinates, 110); assert.equal(published.body.counts.facts, 15);
    const snapshot = app.ce.store.snapshot(created.body.id, commitJob.newVersionId); assert.equal(snapshot.content.coordinates.length - snapshot.content.facts.length, 95);
    assert.equal(snapshot.content.catalog.records.length, 16); assert.equal(snapshot.content.reportSourceBindings[0].contextOrigin, contextBody.source); assert.equal(snapshot.content.reportSourceBindings[0].excludedSheets.length, exclusions);
    result.counts = { catalogRules: 16, coordinates: 110, values: 15, blanks: 95, includedSheets: 1, excludedSheets: exclusions }; result.jobTimes = { inspectionStartedAt: inspectedJob.startedAt, inspectionEndedAt: inspectedJob.endedAt, commitStartedAt: commitJob.startedAt, commitEndedAt: commitJob.endedAt }; result.passed = true;
  } catch (error) { result.errors.push(error instanceof Error ? error.message : String(error)); }
  finally { await app.close(); await writeFile(path.join(output, `${name}.json`), JSON.stringify(result, null, 2), { flag: 'wx' }); }
  return result;
}
const results = [];
for (const [name, bytes, input, exclusions] of [['extract', extract, { source: 'workbook' }, 0], ['full', full, contextInput, 190]]) results.push(await measure(name, bytes, input, exclusions));
assert.equal(hash(await readFile(officialPath)), source.sha256);
const summary = { protocol, results, originalUnchanged: true, passed: results.length === 2 && results.every(result => result.passed) };
await writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx' }); console.log(JSON.stringify({ output, ...summary }, null, 2));
if (!summary.passed) process.exitCode = 1;
