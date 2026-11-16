import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function absent(path) {
  await assert.rejects(access(path), { code: 'ENOENT' }, `Runtime can access a build/source file: ${path}`);
}

async function cleanStart() {
  const scripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts;
  assert.equal(scripts.start, 'node apps/api/dist/server.js', 'Keep the documented start command and this executable check aligned.');
  const port = 3099, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['apps/api/dist/server.js'], { cwd: root,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let startupError, log = ''; child.once('error', error => { startupError = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log = (log + bytes).slice(-32_000); });
  const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', () => resolve({ code: null, signal: 'spawn-error' })); });
  try {
    let bootstrap; const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (startupError) throw startupError;
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Documented start command failed: ${log}`);
      try { const response = await fetch(base + '/api/v1/bootstrap', { signal: AbortSignal.timeout(1500) });
        if (response.ok) { bootstrap = await response.json(); break; }
      } catch { /* The owned listener is still starting. */ }
      await delay(100);
    }
    assert.equal(typeof bootstrap?.sessionToken, 'string', 'Production server did not return bootstrap.');
    const home = await fetch(base + '/', { headers: { Accept: 'text/html' } }); assert.equal(home.status, 200);
    const html = await home.text(); assert.match(html, /<app-root|<ce-root/); assert.ok(!html.includes('api.example.test'));
    const direct = await fetch(base + '/workspace/download', { headers: { Accept: 'text/html' } });
    assert.equal(direct.status, 200); assert.equal(await direct.text(), html);
    const missing = await fetch(base + '/missing-asset.js', { headers: { Accept: 'text/html' } });
    assert.equal(missing.status, 404); assert.ok(!missing.headers.get('content-type')?.includes('text/html'));
    return { command: scripts.start, documentedCommand: 'npm start', production: true,
      staticHtml: 200, bootstrap: 200, directRoute: 200, missingAsset: 404, sourceCheckoutAvailable: false };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 10_000); timer.unref();
      await exited; clearTimeout(timer);
    }
  }
}

async function demoJourney(createApp, demo, executed) {
  const app = await createApp({ serveWeb: false });
  const headers = { host: '127.0.0.1:3000' };
  let base;
  async function get(path, options = {}) {
    const response = await app.inject({ url: path.startsWith('/api/') ? path : base + path, headers: { ...headers, ...options } });
    assert.equal(response.statusCode, 200, `${path}: ${response.body}`); return response;
  }
  async function workspace() { const response = await get(base); return { ...response.json(), etag: response.headers.etag }; }
  async function post(path, body, additionalHeaders = {}) {
    const current = await workspace();
    const response = await app.inject({ method: 'POST', url: base + path,
      headers: { ...headers, 'if-match': current.etag, 'idempotency-key': randomUUID(), ...additionalHeaders }, payload: body });
    assert.equal(response.statusCode, 202, `${path}: ${response.body}`);
    const id = response.json().jobId; assert.ok(id);
    const deadline = Date.now() + 65_000;
    while (Date.now() < deadline) {
      const job = (await get('/jobs/' + id)).json();
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) {
        assert.equal(job.status, 'succeeded', `${job.kind}: ${JSON.stringify(job.diagnostics)}`);
        assert.equal(job.progress.complete, true); executed.add(job.kind); return job;
      }
      await delay(10);
    }
    throw new Error(`Packaged job did not finish: ${path}`);
  }
  try {
    headers['x-ce-session'] = (await get('/api/v1/bootstrap')).json().sessionToken;
    const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: `SYNTHETIC Linux ${demo}` } });
    assert.equal(created.statusCode, 201, created.body); base = '/api/v1/workspaces/' + created.json().id;
    const inputs = await Promise.all(['catalog', 'report'].map(async role => {
      const name = `demo-${demo}-${role}.xlsx`, bytes = await readFile(join(root, 'apps/api/dist/assets/demos', name));
      return { role, name, bytes, sha256: sha256(bytes) };
    }));
    const reserved = await app.inject({ method: 'POST', url: base + '/upload-batches',
      headers: { ...headers, 'if-match': (await workspace()).etag, 'idempotency-key': randomUUID() },
      payload: { baseVersionId: null, files: inputs.map(file => ({ clientFileId: file.role, role: file.role,
        name: file.name, byteLength: file.bytes.length, sha256: file.sha256 })) } });
    assert.equal(reserved.statusCode, 201, reserved.body); const batch = reserved.json();
    for (const input of inputs) {
      const file = batch.files.find(file => file.role === input.role); assert.ok(file);
      for (let index = 0; index < file.partCount; index++) {
        const bytes = input.bytes.subarray(index * batch.partSize, Math.min((index + 1) * batch.partSize, input.bytes.length));
        const part = await app.inject({ method: 'POST', url: `${base}/upload-batches/${batch.id}/files/${file.id}/parts/${index}`,
          headers: { ...headers, 'content-type': 'application/octet-stream', 'x-ce-part-sha256': sha256(bytes) }, payload: bytes });
        assert.equal(part.statusCode, 200, part.body);
      }
    }
    await post(`/upload-batches/${batch.id}/seal`, { baseVersionId: null });
    assert.equal((await get(`/upload-batches/${batch.id}`)).json().state, 'sealed');
    const inspected = await post('/import-inspections', { uploadBatchId: batch.id, context: { source: 'workbook' } });
    const inspection = (await get('/import-inspections/' + inspected.resultRef.id)).json();
    await post(`/import-inspections/${inspection.id}/commit`, { inspectionHash: inspection.inspectionHash,
      acceptedExcludedSheets: inspection.requiresPartialCoverageAcceptance });
    let current = await workspace();
    const validated = await post('/validations', { baseVersionId: current.currentVersionId });
    const runId = validated.resultRef.id, results = (await get('/runs/' + runId + '/results?limit=50')).json();
    assert.equal(results.run.status, 'completed'); assert.equal(results.run.summary.complete, true);
    assert.equal(results.run.summary.byStatus.error, 0);
    assert.equal(results.run.summary.rows, { corep: 16, types: 8, finrep: 5 }[demo]);
    if (demo === 'types') return { demo, rows: 8, validation: results.run.summary.byStatus, recalculation: 'validation-only' };
    if (demo === 'finrep') { assert.equal(results.run.summary.byStatus.pass, 2); assert.equal(results.run.summary.byStatus.fail, 3); }

    const prepared = await post('/recalculation-reviews', { baseVersionId: current.currentVersionId, validationBasisId: current.validationBasisId, runId });
    let review = (await get('/recalculation-reviews/' + prepared.resultRef.id)).json();
    const groups = (await get(`/recalculation-reviews/${review.id}/groups?limit=50`)).json().items;
    for (const group of groups) {
      const candidates = (await get(`/recalculation-reviews/${review.id}/groups/${group.groupId}/candidates?limit=50`)).json().items;
      const winner = candidates.find(candidate => candidate.code === 'v0174_m');
      const response = await app.inject({ method: 'PATCH', url: `${base}/recalculation-reviews/${review.id}`,
        headers: { ...headers, 'if-match': (await workspace()).etag }, payload: { expectedRevision: review.revision, mutationId: randomUUID(),
          operations: [{ op: 'resolveGroup', groupId: group.groupId, winnerInstanceId: winner?.instanceId ?? null }] } });
      assert.equal(response.statusCode, 200, response.body); review = response.json().summary;
    }
    assert.equal(review.counts.pending, 0); assert.equal(review.conflictGroupCount, 0);
    const operation = await post('/recalculation-operations', { baseVersionId: current.currentVersionId,
      validationBasisId: current.validationBasisId, runId, reviewId: review.id, expectedRevision: review.revision });
    const previewId = operation.resultRef.id; current = await workspace();
    let selection = (await get(`/previews/${previewId}/selection-state`)).json();
    await post(`/previews/${previewId}/selection-state/edits`, { selectionId: selection.id, expectedRevision: selection.revision,
      operations: [{ op: 'selectMatching', filter: {} }] });
    selection = (await get(`/previews/${previewId}/selection-state`)).json();
    assert.ok(selection.complete && selection.selectedCount > 0);
    const applied = await post('/applications', { baseVersionId: current.currentVersionId, previewId,
      selectionRef: { id: selection.id, revision: selection.revision }, closureHash: selection.closureHash });
    const application = (await get('/applications/' + applied.resultRef.id)).json();
    assert.ok(application.changeCount > 0); current = await workspace();
    if (demo === 'finrep') {
      assert.equal(application.changeCount, 2); assert.equal(application.afterSummary.byStatus.pass, 4);
      assert.equal(application.afterSummary.byStatus.fail, 1);
    }
    const downloads = [];
    for (const kind of ['report', 'results']) {
      const exported = await post('/exports', { versionId: current.currentVersionId, kind,
        ...(kind === 'results' ? { runId: application.receipt.validationRunId } : {}) });
      const url = '/exports/' + exported.resultRef.id, metadata = (await get(url, { accept: 'application/json' })).json();
      const download = await get(url);
      assert.equal(download.rawPayload.readUInt32LE(0), 0x04034b50); assert.equal(sha256(download.rawPayload), metadata.sha256);
      assert.equal(download.rawPayload.length, metadata.size); downloads.push({ kind, bytes: metadata.size, sha256: metadata.sha256 });
    }
    // Exercise legacy runtime entry points too: their modules remain supported outside the simplified UI.
    if (demo === 'finrep') {
      const legacy = await post('/direction-reviews', { baseVersionId: current.currentVersionId, runId: application.receipt.validationRunId });
      const legacyReview = (await get('/direction-reviews/' + legacy.resultRef.id)).json();
      await post(`/direction-reviews/${legacyReview.id}/commit`, { expectedRevision: legacyReview.revision, acceptPartial: true });
      current = await workspace(); await post('/previews', { baseVersionId: current.currentVersionId });
    }
    return { demo, rows: results.run.summary.rows, before: results.run.summary.byStatus, after: application.afterSummary.byStatus,
      changedCells: application.changeCount, downloads };
  } finally { await app.close(); }
}

export async function smokePackage({ diagnosticCheckout = false } = {}) {
  if (!diagnosticCheckout) {
    assert.equal(process.platform, 'linux');
    for (const path of ['apps/api/src', 'apps/web/src', 'packages/engine/src', 'packages/contracts/src', '.tools', 'grammar', 'tests', '.git']) await absent(join(root, path));
    await absent('/build');
  }
  const moduleRoot = await realpath(fileURLToPath(import.meta.resolve('@ce/engine')));
  const enginePath = relative(resolve(root), moduleRoot);
  assert.ok(!enginePath.startsWith('..') && !isAbsolute(enginePath), 'Engine resolves outside the isolated runtime.');
  const { JOB_KINDS } = await import('@ce/contracts');
  const { createApp } = await import(new URL('../apps/api/dist/app.js', import.meta.url));
  // Resolve the production hosted module graph inside the same source-free Linux runtime.
  // SQL/queue execution needs transport and remains covered by the separate hosted integration gate.
  const hostedEntry = await import(new URL('../apps/api/dist/hosted-entry.js', import.meta.url));
  const hostedCommands = await import(new URL('../apps/api/dist/hosted/domain-commands.js', import.meta.url));
  const hostedSeal = await import(new URL('../apps/api/dist/workers/seal-upload.worker.js', import.meta.url));
  assert.equal(typeof hostedEntry.createHostedApp, 'function'); assert.equal(typeof hostedCommands.executeHostedCommand, 'function');
  assert.equal(typeof hostedSeal.sealUploadedBatch, 'function');
  const startup = diagnosticCheckout ? null : await cleanStart();
  const executed = new Set(), demos = [];
  for (const demo of ['finrep', 'corep', 'types']) demos.push(await demoJourney(createApp, demo, executed));
  // Sealing is required by this iteration even if a stale contracts output omits it.
  const missingJobKinds = [...new Set([...JOB_KINDS, 'seal-upload'])].filter(kind => !executed.has(kind));
  const evidence = diagnosticCheckout ? {} : JSON.parse(await readFile(join(root, 'package-evidence.json'), 'utf8'));
  return { ...evidence, status: diagnosticCheckout || missingJobKinds.length ? 'incomplete' : 'pass',
    diagnosticCheckout, demos, completedJobKinds: [...executed].sort(), missingJobKinds,
    hostedModuleResolution: ['hosted-entry', 'domain-commands', 'seal-upload.worker'],
    cleanStart: startup,
    scope: 'Compiled runtime and real workers; hosted SQL/queue/provider integration is verified separately.' };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  smokePackage({ diagnosticCheckout: process.argv.includes('--diagnostic-checkout') }).then(result => {
    console.log(JSON.stringify(result)); if (result.status !== 'pass') process.exitCode = 1;
  }).catch(error => { console.error(error instanceof Error ? error.message : 'Package smoke failed.'); process.exitCode = 1; });
}
