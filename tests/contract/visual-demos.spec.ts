import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const app = await createApp(); apps.push(app); const host = '127.0.0.1:3000';
  const headers = { host, 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host } })).json().sessionToken as string };
  return { app, headers };
}
it.each([['corep', 'catalog'], ['corep', 'report'], ['types', 'catalog'], ['types', 'report'], ['finrep', 'catalog'], ['finrep', 'report']] as const)('downloads the authenticated packaged %s %s workbook with its declared content hash', async (demo, kind) => {
  const { app, headers } = await setup(), url = `/api/v1/templates/demos/${demo}/${kind}`;
  expect((await app.inject({ url, headers: { host: headers.host } })).statusCode).toBe(403);
  expect((await app.inject({ url, headers: { ...headers, origin: 'https://untrusted.example' } })).statusCode).toBe(403);
  const response = await app.inject({ url, headers }); expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(response.headers['content-disposition']).toBe(`attachment; filename="demo-${demo}-${kind}.xlsx"`);
  expect(response.headers['cache-control']).toBe('no-store'); expect(response.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  const manifest = JSON.parse(await readFile(new URL('../../assets/demos/manifest.json', import.meta.url), 'utf8')) as { files: { demo: string; kind: string; file: string; sha256: string; size: number }[] };
  const entry = manifest.files.find(row => row.demo === demo && row.kind === kind)!;
  expect(entry.file).toBe(`demo-${demo}-${kind}.xlsx`); expect(response.rawPayload.length).toBe(entry.size); expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(entry.sha256);
  expect(response.rawPayload).toEqual(await readFile(new URL('../../assets/demos/' + entry.file, import.meta.url)));
  expect((await app.inject({ url: url + '?path=private.xlsx', headers })).statusCode).toBe(400);
});
it('does not expose arbitrary demo names, file paths or write actions', async () => {
  const { app, headers } = await setup();
  for (const url of ['/api/v1/templates/demos/unknown/report', '/api/v1/templates/demos/corep/secrets']) expect((await app.inject({ url, headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/v1/templates/demos/corep/report', headers })).statusCode).toBe(404);
});
it('serves and exports all three visual profiles from the relocated compiled package with source/cache access and network blocked', async () => {
  const scratch = path.resolve(fileURLToPath(new URL('../../.cache/', import.meta.url))); await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, 'packaged-template-'));
  try {
    await cp(fileURLToPath(new URL('../../apps/api/dist/', import.meta.url)), directory, { recursive: true });
    // A child process and its real workers inherit this preload. Source assets remain untouched:
    // attempted fallback reads fail even though the developer checkout still contains those files.
    const guard = path.join(directory, 'offline-guard.mjs'), probe = path.join(directory, 'package-probe.mjs');
    await writeFile(guard, String.raw`
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { threadId } from 'node:worker_threads';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
const runtime = path.resolve(process.env.CE_PACKAGED_RUNTIME), checkout = path.resolve(process.env.CE_PACKAGED_CHECKOUT);
const audit = path.join(runtime, 'guard-audit.jsonl'), append = fs.appendFileSync.bind(fs);
const record = kind => append(audit, JSON.stringify({ kind, threadId }) + '\n');
const within = (root, value) => value === root || value.startsWith(root + path.sep);
const denied = ['assets', 'specs', '.cache', 'tests/fixtures', 'grammar'].map(name => path.resolve(checkout, name));
function allowed(input) {
  const raw = input instanceof URL ? fileURLToPath(input) : Buffer.isBuffer(input) ? input.toString() : input;
  if (typeof raw !== 'string') return;
  const location = path.resolve(raw); if (within(runtime, location)) return;
  if (denied.some(root => within(root, location)) || path.dirname(location) === checkout && location.endsWith('.xlsx')) { record('blocked-source'); throw new Error('SOURCE_ACCESS_DISABLED'); }
}
for (const object of [fs, fsp]) for (const name of ['readFile', 'readFileSync', 'open', 'openSync', 'stat', 'statSync', 'lstat', 'lstatSync', 'access', 'accessSync', 'readdir', 'readdirSync', 'createReadStream']) {
  if (typeof object[name] !== 'function') continue;
  const original = object[name].bind(object); object[name] = (...args) => { allowed(args[0]); return original(...args); };
}
function blockedNetwork() { record('blocked-network'); throw new Error('NETWORK_DISABLED'); }
globalThis.fetch = blockedNetwork;
http.request = http.get = https.request = https.get = blockedNetwork;
net.connect = net.createConnection = net.Socket.prototype.connect = tls.connect = blockedNetwork;
syncBuiltinESMExports(); record('guard-active');
`);
    await writeFile(probe, String.raw`
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import yauzl from 'yauzl';
const root = process.cwd(), hash = bytes => createHash('sha256').update(bytes).digest('hex');
assert.throws(() => https.request('https://example.invalid'), /NETWORK_DISABLED/);
assert.throws(() => fs.readFileSync(path.join(process.env.CE_PACKAGED_CHECKOUT, 'assets/templates/corep-ca1.xlsx')), /SOURCE_ACCESS_DISABLED/);
for (const name of ['specs', '.cache']) await assert.rejects(access(path.join(root, name)), { code: 'ENOENT' });
const { createApp } = await import('./app.js');
const { visualTemplateBytes } = await import('./export/visual-template.js');
const { inspectWorkspace } = await import('./import/import-workspace.js');
const { runValidation } = await import('@ce/engine');
const templates = JSON.parse(await readFile(path.join(root, 'assets/templates/manifest.json'), 'utf8'));
const demos = JSON.parse(await readFile(path.join(root, 'assets/demos/manifest.json'), 'utf8'));
for (const entry of templates.profiles) { const bytes = await visualTemplateBytes(entry.profileId); assert.equal(hash(bytes), entry.sha256); assert.equal(bytes.length, entry.size); }
async function zipEntries(bytes) {
  const zip = await new Promise((resolve, reject) => yauzl.fromBuffer(bytes, { lazyEntries: true, strictFileNames: true }, (error, value) => error ? reject(error) : resolve(value)));
  const entries = new Map();
  try { await new Promise((resolve, reject) => { zip.on('error', reject); zip.on('end', resolve); zip.on('entry', entry => zip.openReadStream(entry, (error, stream) => {
    if (error) return reject(error); const chunks = []; stream.on('error', reject); stream.on('data', chunk => chunks.push(chunk)); stream.on('end', () => { entries.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
  })); zip.readEntry(); }); return entries; } finally { zip.close(); }
}
const setup = path.join(root, 'probe-inputs'); await mkdir(setup);
async function staged(location, kind) { const bytes = await readFile(location); return { id: randomUUID(), path: location, kind, sha256: hash(bytes), size: bytes.length, importedAt: '2026-11-04T00:00:00.000Z', displayName: path.basename(location) }; }
const operation = { cancelled: () => false, progress: () => {} };
function business(content) {
  return { contexts: content.contexts.map(({ filingIndicatorsLocator, contextId, ...context }) => context),
    coordinates: content.coordinates.map(({ sourceLocator, contextId, ...coordinate }) => coordinate).sort((a, b) => a.factKey.localeCompare(b.factKey)),
    facts: content.facts.map(({ sourceLocator, originalText, derivation, contextId, ...fact }) => fact).sort((a, b) => a.factKey.localeCompare(b.factKey)) };
}
const app = await createApp();
try {
  const host = '127.0.0.1:3000', headers = { host, 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host } })).json().sessionToken };
  const response = await app.inject({ url: '/api/v1/templates/corep-ca1', headers }); assert.equal(response.statusCode, 200, response.body);
  assert.equal(hash(response.rawPayload), templates.profiles.find(entry => entry.profileId === 'eba-corep-of-4.0-ca1-v1').sha256);
  for (const entry of demos.files) {
    const response = await app.inject({ url: '/api/v1/templates/demos/' + entry.demo + '/' + entry.kind, headers });
    assert.equal(response.statusCode, 200, response.body); assert.equal(hash(response.rawPayload), entry.sha256); assert.equal(response.rawPayload.length, entry.size);
    await writeFile(path.join(setup, entry.file), response.rawPayload);
  }
  for (const demo of ['corep', 'types', 'finrep']) {
    // Fixture setup imports the actual downloaded workbooks using relocated compiled code.
    const catalog = await staged(path.join(setup, 'demo-' + demo + '-catalog.xlsx'), 'catalog');
    const report = await staged(path.join(setup, 'demo-' + demo + '-report.xlsx'), 'report');
    const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Packaged ' + demo } });
    assert.equal(created.statusCode, 201, created.body); const workspace = created.json();
    if (demo === 'finrep') Object.assign(report, await app.ce.files.write(workspace.id, await readFile(report.path)));
    const candidate = await inspectWorkspace([catalog, report], operation, { source: 'workbook' });
    const snapshot = app.ce.store.publish(workspace.id, undefined, candidate.content), base = '/api/v1/workspaces/' + workspace.id;
    const bundle = runValidation(snapshot, { runId: randomUUID(), startedAt: snapshot.createdAt });
    app.ce.store.putRecords([{ key: 'validation:' + workspace.id + ':' + bundle.run.id, value: bundle }]);
    for (const kind of ['report', 'results']) {
      const accepted = await app.inject({ method: 'POST', url: base + '/exports', headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() },
        payload: { kind, versionId: snapshot.versionId, ...(kind === 'results' ? { runId: bundle.run.id } : {}) } });
      assert.equal(accepted.statusCode, 202, accepted.body);
      const jobId = accepted.json().jobId, deadline = Date.now() + 15000; let job;
      do { job = (await app.inject({ url: base + '/jobs/' + jobId, headers })).json(); if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) break; await new Promise(resolve => setTimeout(resolve, 10)); } while (Date.now() < deadline);
      assert.equal(job.status, 'succeeded', JSON.stringify(job)); await app.ce.jobs.settle(jobId);
      const download = await app.inject({ url: base + '/exports/' + job.resultRef.id, headers }); assert.equal(download.statusCode, 200, download.body);
      const entries = await zipEntries(download.rawPayload), data = JSON.parse(entries.get(kind === 'report' ? 'changes.json' : 'results.json').toString());
      assert.equal(data.versionId, snapshot.versionId); assert.deepEqual(data.reportSourceBindings, snapshot.content.reportSourceBindings);
      if (kind === 'results') { assert.deepEqual(data.results, bundle.results); continue; }
      const name = [...entries.keys()].find(name => name.startsWith('reports/')); assert.ok(name);
      const location = path.join(setup, 'exported-' + demo + '.xlsx'); await writeFile(location, entries.get(name));
      const restored = await inspectWorkspace([await staged(catalog.path, 'catalog'), await staged(location, 'report')], operation, { source: 'workbook' });
      assert.deepEqual(business(restored.content), business(snapshot.content));
      assert.equal(restored.content.coordinates.length, demo === 'corep' ? 110 : demo === 'finrep' ? 38 : 6);
      assert.ok(restored.content.facts.every(fact => !fact.derivation));
    }
    const closed = await app.inject({ method: 'DELETE', url: base, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id) } }); assert.equal(closed.statusCode, 204, closed.body);
  }
} finally { await app.close(); }
const audit = (await readFile(path.join(root, 'guard-audit.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
assert.equal(audit.filter(event => event.kind === 'blocked-network').length, 1);
assert.equal(audit.filter(event => event.kind === 'blocked-source').length, 1);
assert.equal(new Set(audit.filter(event => event.kind === 'guard-active').map(event => event.threadId)).size, 7);
process.stdout.write(JSON.stringify({ templates: templates.profiles.length, demos: demos.files.length, exports: 6, realWorkers: 6, isolatedSources: true, networkBlocked: true }));
`);
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, probe], { cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 40_000,
      env: { ...process.env, CE_PACKAGED_RUNTIME: directory, CE_PACKAGED_CHECKOUT: path.resolve('.') } });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ templates: 3, demos: 6, exports: 6, realWorkers: 6, isolatedSources: true, networkBlocked: true });
  } finally {
    const resolved = path.resolve(directory); if (!resolved.startsWith(scratch + path.sep)) throw new Error('Unexpected test cleanup directory');
    await rm(resolved, { recursive: true, force: true });
  }
}, 45_000);
it('declares typed v2 validation separately from legacy numeric and boolean capabilities', async () => {
  const { app, headers } = await setup(), response = await app.inject({ url: '/api/v1/capabilities', headers }); expect(response.statusCode).toBe(200);
  const capabilities = response.json();
  expect(capabilities.languageProfiles.find((profile: { id: string }) => profile.id === 'ce-dpmxl-0.9-closed-v1').support).toEqual(['number', 'boolean']);
  expect(capabilities.languageProfiles.find((profile: { id: string }) => profile.id === 'ce-dpmxl-0.9-closed-v2').support).toEqual(expect.arrayContaining(['number', 'boolean', 'text', 'date', 'if']));
  expect(capabilities.reportProfiles).toContainEqual(expect.objectContaining({ id: 'ce-demo-types-1', moduleVersion: 'DEMO_TYPES_1', supportedTables: ['DEMO_TYPES'], languageProfileId: 'ce-dpmxl-0.9-closed-v2' }));
});
