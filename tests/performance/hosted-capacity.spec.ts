import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Snapshot, SnapshotContent, DirectionDecisionState, JsonObject } from '@ce/contracts';
import { createHostedApp } from '../../apps/api/src/hosted-entry.js';
import { HostedJobCoordinator } from '../../apps/api/src/hosted/job-coordinator.js';
import { HostedPublication } from '../../apps/api/src/hosted/publication.js';
import { HostedExportArtifacts } from '../../apps/api/src/hosted/export-artifacts.js';
import { constructHostedDomain } from '../../apps/api/src/hosted/worker-runtime.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { HostedUploadBatches } from '../../apps/api/src/storage/upload-batches.js';
import { HostedRetainedSources } from '../../apps/api/src/hosted/retained-sources.js';
import { transferPublicationHandlers } from '../../apps/api/src/hosted/transfer-commands.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { createHostedHarness, type HostedHarness } from '../helpers/hosted-harness.js';
import { ControlledFileObjectTransport } from '../helpers/controlled-file-objects.js';
import { iteration005Snapshot } from '../helpers/iteration005-fixtures.js';
import { createMaximumZip, hashBytes, hashFile, MiB, type CapacityFile } from '../helpers/hosted-capacity-fixtures.js';

const evidence = process.env['CAPACITY_EVIDENCE'] ?? path.resolve('outputs/capacity-development');
type FixtureManifest = { batch: CapacityFile[]; expandedPlus: CapacityFile[]; filePlus: CapacityFile };
let fixtures: FixtureManifest;
beforeAll(async () => { if (process.platform !== 'linux' || !process.env['CAPACITY_EVIDENCE']) throw new Error('Use npm run test:capacity:hosted: this gate requires measured Linux 2 GiB / 1 CPU'); fixtures = JSON.parse(await readFile('/inputs/manifest.json', 'utf8')); });
async function record(name: string, value: object) { await writeFile(path.join(evidence, name + '.json'), JSON.stringify({ name, at: new Date().toISOString(), ...value }, null, 2)); }
function configuration(content: SnapshotContent, index: number): SnapshotContent {
  const directionDecisionState: DirectionDecisionState = index % 2 ? { schemaVersion: 1, mode: 'reviewed', source: 'review', originDefault: 'automatic', originExceptions: [], unselectedDefault: 'omitted', unselectedExceptions: [] } : { schemaVersion: 1, mode: 'new' };
  return { ...content, directionDecisionState, configVersion: canonicalHash({ directions: content.directions, directionDecisionState }) };
}

describe('hosted capacity under enforced Linux limits and real SQL authority', () => {
  let h: HostedHarness, transport: ControlledFileObjectTransport, apps: readonly [FastifyInstance, FastifyInstance], owner: { sessionId: string; workspaceId: string }, headers: Record<string, string>, etag: string, base: string;
  let domain: ReturnType<typeof constructHostedDomain>, coordinator: HostedJobCoordinator;
  beforeEach(async () => {
    h = await createHostedHarness({ now: Date.now() }); await mkdir('/objects', { recursive: true }); transport = await ControlledFileObjectTransport.create('/objects');
    apps = await h.createApis(deps => createHostedApp({ config: deps.config, database: deps.database, objectTransport: transport, dispatcher: deps.queue, now: Date.now, instanceId: deps.instanceId, signatureVerifier: { verify: async () => true }, log: () => {},
      workerOptions: { workerEntry: pathToFileURL(path.resolve('apps/api/dist/workers/hosted-operation-worker.js')), commandModule: pathToFileURL(path.resolve('.tools/capacity/command.mjs')),
        runtime: { config: deps.config, objectTransport: { moduleUrl: pathToFileURL(path.resolve('.tools/capacity/provider.mjs')).href, descriptor: { ...transport.descriptor } } } } }));
    headers = { origin: h.config.allowedOrigins[0]!, 'x-ce-session': randomBytes(32).toString('base64url') };
    const session = await apps[0].inject({ method: 'POST', url: '/api/v1/sessions', headers, payload: { creationNonce: randomBytes(32).toString('base64url') } }); expect(session.statusCode, session.body).toBe(201);
    const workspace = await apps[0].inject({ method: 'POST', url: '/api/v1/workspaces', headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { name: 'Synthetic capacity' } }); expect(workspace.statusCode, workspace.body).toBe(201);
    owner = { sessionId: session.json().id, workspaceId: workspace.json().id }; etag = String(workspace.headers.etag); base = '/api/v1/workspaces/' + owner.workspaceId;
    domain = constructHostedDomain({ config: h.config, db: h.databases[0], transport, now: Date.now }); coordinator = new HostedJobCoordinator(h.databases[0], { config: h.config, instanceId: 'capacity-direct', now: Date.now });
  });
  afterEach(async () => { await h?.close(); await transport?.close(); });
  const declaration = (files: CapacityFile[]) => ({ baseVersionId: null, files: files.map((file, index) => ({ clientFileId: String(index), role: file.role, name: file.name, byteLength: file.bytes, sha256: file.sha256 })) });
  async function upload(files: CapacityFile[]) {
    const response = await apps[0].inject({ method: 'POST', url: base + '/upload-batches', headers: { ...headers, 'if-match': etag, 'idempotency-key': randomUUID() }, payload: declaration(files) }); expect(response.statusCode, response.body).toBe(201); const batch = response.json();
    for (const [position, source] of files.entries()) {
      const file = batch.files[position], input = await open(source.path, 'r');
      try { for (let index = 0; index < file.partCount; index++) { const bytes = Buffer.alloc(Math.min(3 * MiB, source.bytes - index * 3 * MiB)); const read = await input.read(bytes, 0, bytes.length, index * 3 * MiB); expect(read.bytesRead).toBe(bytes.length);
        const written = await apps[index % 2]!.inject({ method: 'POST', url: base + `/upload-batches/${batch.id}/files/${file.id}/parts/${index}`, headers: { ...headers, 'content-type': 'application/octet-stream', 'x-ce-part-sha256': hashBytes(bytes) }, payload: bytes }); expect(written.statusCode, written.body).toBe(200); }
      } finally { await input.close(); }
    } return batch;
  }
  async function post(url: string, payload: object) { const accepted = await apps[0].inject({ method: 'POST', url, headers: { ...headers, 'if-match': etag, 'idempotency-key': randomUUID() }, payload }); expect(accepted.statusCode, accepted.body).toBe(202); return accepted.json(); }
  async function execute(jobId: string, name: string, cancel = false) {
    const queued = h.queue.messages.find(message => message.reference.jobId === jobId); expect(queued).toBeDefined();
    const started = performance.now(); let finished = false, reads = 0, maxReadMs = 0;
    const query = (async () => { while (!finished) { await Promise.all([0,1].map(async index => { const tick = performance.now(), response = await apps[index]!.inject({ url: base + '?compact=true', headers }); expect(response.statusCode, response.body).toBe(200); expect(response.rawPayload.length).toBeLessThanOrEqual(MiB); reads++; maxReadMs = Math.max(maxReadMs, performance.now() - tick); })); await delay(25); } })();
    const callback = apps[0].inject({ method: 'POST', url: '/internal/jobs', headers: { 'content-type': 'application/json', 'upstash-signature': 'controlled' }, payload: JSON.stringify(queued!.reference) });
    if (cancel) { for (let attempt = 0; attempt < 100; attempt++) { const running = (await h.databases[1].query('SELECT status FROM jobs WHERE id=$1', [jobId])).rows[0]; if (running?.status === 'running') break; await delay(10); } await delay(100); await new HostedJobCoordinator(h.databases[1], { config: h.config, instanceId: 'capacity-canceller', now: Date.now }).cancel({ ...owner, jobId }); }
    let response; try { response = await callback; } finally { finished = true; await query; }
    expect(response.statusCode, response.body).toBe(200);
    const result = await apps[1].inject({ url: base + '/jobs/' + jobId, headers }); const terminal = result.json();
    const row = (await h.databases[0].query('SELECT started_at,deadline_at,terminal_at,status FROM jobs WHERE id=$1', [jobId])).rows[0]!;
    const elapsedMs = Number(row.terminal_at) - Number(row.started_at), measure = { status: terminal.status, diagnostics: terminal.diagnostics, elapsedMs, callbackMs: performance.now() - started, deadlineMs: Number(row.deadline_at) - Number(row.started_at), concurrentQueries: reads, maxQueryMs: maxReadMs };
    await record(name, measure); expect(reads).toBeGreaterThan(0); expect(measure.deadlineMs).toBe(60_000); expect(elapsedMs).toBeLessThanOrEqual(60_000);
    return terminal;
  }
  it('enforces exact 10 MiB file / 50 MiB batch / 100 MiB expansion and every maximum + one', async () => {
    expect(fixtures.batch.reduce((sum, file) => sum + file.bytes, 0)).toBe(50 * MiB); expect(fixtures.batch.reduce((sum, file) => sum + file.expandedBytes, 0)).toBe(100 * MiB);
    const stores = new HostedUploadBatches(domain.db, domain.objects, domain.quotas);
    await expect(stores.create(owner, declaration([fixtures.filePlus, fixtures.batch[1]!]), etag, randomUUID())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const plusBatch = declaration([...fixtures.batch, { ...fixtures.batch[1]!, name: 'one.xlsx', bytes: 1, sha256: hashBytes(Buffer.from('x')) }]);
    await expect(stores.create(owner, plusBatch, etag, randomUUID())).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    const batch = await upload(fixtures.batch), accepted = await post(base + `/upload-batches/${batch.id}/seal`, { baseVersionId: null });
    const terminal = await execute(accepted.jobId, 'maximum-input-seal'); expect(terminal, JSON.stringify(terminal)).toMatchObject({ status: 'succeeded' });
    const budget = { expandedBytes: 0 }; let failure: unknown;
    try { for (const file of fixtures.expandedPlus) await preflightXlsx(file.path, { budget, retainCells: false, ...(file.role === 'report' ? { profile: 'visual-report' as const } : {}) }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'EXPANSION_LIMIT' });
    await expect(preflightXlsx(fixtures.filePlus.path)).rejects.toMatchObject({ code: 'UPLOAD_LIMIT' });
    await record('input-boundaries', { fileBytes: 10 * MiB, batchBytes: 50 * MiB, expandedBytes: 100 * MiB, filePlusOne: 'rejected', batchPlusOne: 'rejected', expandedPlusOne: 'rejected', actualExpandedPlusBytes: fixtures.expandedPlus.reduce((sum, file) => sum + file.expandedBytes, 0) });
  });
  it('cancels a maximum input worker while two APIs keep answering queries', async () => {
    const batch = await upload(fixtures.batch), accepted = await post(base + `/upload-batches/${batch.id}/seal`, { baseVersionId: null });
    expect(await execute(accepted.jobId, 'maximum-input-cancellation', true)).toMatchObject({ status: 'cancelled' });
    expect((await apps[1].inject({ url: base + '?compact=true', headers })).json().currentVersionId).toBeUndefined();
    expect((await h.databases[0].query('SELECT id FROM object_manifests WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(0);
  });
  async function claim(kind: string, publication: object, baseVersionId?: string) {
    const jobId = randomUUID(), now = new Date(); await domain.db.query('INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,base_version_id,accepted_at,queue_expires_at,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,\'queued\')', [owner.sessionId, owner.workspaceId, jobId, kind, { publication }, baseVersionId ?? null, now, new Date(+now + 600_000)]);
    const result = await coordinator.claim({ ...owner, jobId }); if (result.state !== 'claimed') throw new Error('Expected capacity claim: ' + JSON.stringify(result)); return result.claim;
  }
  it('retains twenty shared snapshots and streams an exact 100 MiB ZIP as 34 parts including overhead', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => String(index + 1).padStart(4, '0'));
    const original = iteration005Snapshot(rows.map((row, index) => ({ code: 'CAP_' + index, expression: `with {tT,c0010,interval:false}: {r${row}}=${index + 1}` })), rows);
    const basisId = randomUUID(), content = original.content; let prior: string | undefined, firstData: string | undefined; const timings = [], hashes = [];
    const publication = new HostedPublication(domain.db, domain.quotas, domain.objects, { now: Date.now });
    for (let index = 0; index < 20; index++) {
      const snapshot: Snapshot = { ...original, versionId: randomUUID(), validationBasisId: basisId, content: configuration(content, index), ...(prior ? { parentVersionId: prior } : {}), contentHash: '' };
      const complete = { ...snapshot, contentHash: canonicalHash(snapshot.content) }, job = await claim(index ? 'commit-directions' : 'import', { resultId: complete.versionId, versionId: complete.versionId, ...(index ? {} : { basisId }) }, prior), started = performance.now();
      const saved = await domain.snapshots.writeSnapshot(job, complete, index ? 'configuration' : 'import');
      await publication.publish(job, { kind: job.kind, resultRef: { type: index ? 'direction-review' : 'import', id: complete.versionId }, ...saved }); await coordinator.confirmTerminated(job);
      firstData ??= saved.componentRefs.data.resourceId; expect(saved.componentRefs.data.resourceId).toBe(firstData); timings.push(performance.now() - started); hashes.push(complete.contentHash); prior = complete.versionId;
    }
    expect((await domain.db.query('SELECT id FROM workspace_versions WHERE session_id=$1', [owner.sessionId])).rows).toHaveLength(20);
    const state = (await domain.db.query("SELECT sum(byte_length)::text bytes,count(*)::int blocks FROM canonical_blocks WHERE session_id=$1", [owner.sessionId])).rows[0];
    await record('twenty-shared-snapshots', { snapshots: 20, rows: 500, sharedDataResource: firstData, hashes, writeAndPublishMs: timings, canonical: state, scope: 'Actual codec/publication with 500-rule / 500-fact snapshots; the 500-rule / 100000-fact maximum is measured in its own case.' });
    const artifactId = randomUUID(), jobId = randomUUID(), now = new Date(), exports = new HostedExportArtifacts(domain.db, domain.objects, domain.quotas);
    await domain.db.transaction(async tx => { await tx.query("INSERT INTO jobs(session_id,workspace_id,id,kind,input_refs,base_version_id,accepted_at,queue_expires_at,status) VALUES($1,$2,$3,'export',$4,$5,$6,$7,'queued')", [owner.sessionId, owner.workspaceId, jobId, { publication: { resultId: artifactId } }, prior, now, new Date(+now + 600_000)]); await exports.reserve(tx, owner, { artifactId, jobId, intent: { workspaceId: owner.workspaceId, versionId: prior!, kind: 'report' } }); });
    const result = await coordinator.claim({ ...owner, jobId }); if (result.state !== 'claimed') throw new Error('Expected export claim');
    const location = '/tmp/capacity-export.zip', over = '/tmp/capacity-export-plus.zip', maximum = await createMaximumZip(location), tooLarge = await createMaximumZip(over, true);
    await expect(exports.stageFile(result.claim, artifactId, over)).rejects.toMatchObject({ code: 'EXPORT_LIMIT' }); await rm(over);
    const candidate = await exports.stageFile(result.claim, artifactId, location); await domain.db.transaction(tx => exports.publish(tx, result.claim, candidate));
    const manifest = await exports.manifest(owner, artifactId); expect(manifest.parts).toHaveLength(34); expect(manifest.byteLength).toBe(100 * MiB); const hash = createHash('sha256');
    for (const part of manifest.parts) { const bytes = await apps[part.index % 2]!.inject({ url: base + `/exports/${artifactId}/parts/${part.index}`, headers }); expect(bytes.statusCode, bytes.body.slice(0,100)).toBe(200); expect(hashBytes(bytes.rawPayload)).toBe(part.sha256); hash.update(bytes.rawPayload); }
    expect(hash.digest('hex')).toBe(maximum.sha256); expect(manifest.sha256).toBe(maximum.sha256);
    await record('maximum-export', { ...maximum, parts: manifest.parts, plusOneBytes: tooLarge.bytes, plusOne: 'rejected', elapsedSinceClaimMs: Date.now() - Date.parse(result.claim.startedAt), scope: 'Real ZIP writer and durable artifact staging/manifest/download; domain report-generation worst case is separate.' });
    expect(Date.now() - Date.parse(result.claim.startedAt)).toBeLessThanOrEqual(60_000); await rm(location); await coordinator.confirmTerminated(result.claim);
  });
  it('runs the admitted 500-rule / 100000-fact workload with twenty shared maximum snapshots', async () => {
    const rows = Array.from({ length: 100_000 }, (_, index) => String(index + 1).padStart(6, '0'));
    const rules = Array.from({ length: 500 }, (_, index) => ({ code: 'CAPACITY_MAX_' + index,
      expression: `sum({tT,r${rows[index * 200]}-${rows[index * 200 + 199]},c0010})=${index % 2 ? 201 : 200}` }));
    const original = iteration005Snapshot(rules, rows, Object.fromEntries(rows.map(row => [row, '1']))), basisId = randomUUID(), diagnostic = process.env['CAPACITY_DIAGNOSTIC'] === 'validation', snapshotCount = diagnostic ? 1 : 20;
    const publication = new HostedPublication(domain.db, domain.quotas, domain.objects, { now: Date.now }); let prior: string | undefined, firstData: string | undefined;
    const measurements: object[] = []; await record('maximum-domain', { status: 'running', facts: 100_000, coordinates: 100_000, rules: 500, snapshotsRequired: 20, source: 'Deterministic engine fixture using accepted ce-report domain shape; independent of transport padding. Each rule reads 200 distinct facts, 250 pass and 250 fail expected.', contentSha256: canonicalHash(original.content), measurements });
    for (let index = 0; index < snapshotCount; index++) {
      const content = configuration(original.content, index), snapshot: Snapshot = { ...original, content, contentHash: canonicalHash(content), versionId: randomUUID(), validationBasisId: basisId, ...(prior ? { parentVersionId: prior } : {}) };
      const job = await claim(index ? 'commit-directions' : 'import', { resultId: snapshot.versionId, versionId: snapshot.versionId, ...(index ? {} : { basisId }) }, prior);
      const start = performance.now(); let completed = false;
      const reads = (async () => { let count = 0; while (!completed) { const response = await apps[1].inject({ url: base + '?compact=true', headers }); expect(response.statusCode).toBe(200); count++; await delay(100); } return count; })();
      try {
        const saved = await domain.snapshots.writeSnapshot(job, snapshot, index ? 'configuration' : 'import');
        firstData ??= saved.componentRefs.data.resourceId; expect(saved.componentRefs.data.resourceId).toBe(firstData);
        await publication.publish(job, { kind: job.kind, resultRef: { type: index ? 'direction-review' : 'import', id: snapshot.versionId }, ...saved }); await coordinator.confirmTerminated(job); prior = snapshot.versionId;
        measurements.push({ snapshot: index + 1, status: 'succeeded', elapsedMs: performance.now() - start, sha256: snapshot.contentHash });
      } catch (error) { measurements.push({ snapshot: index + 1, status: 'failed', elapsedMs: performance.now() - start, error: error instanceof Error ? error.message : String(error) }); throw error; }
      finally { completed = true; const queryCount = await reads; await record('maximum-domain', { status: prior === snapshot.versionId ? 'running' : 'failed', facts: 100_000, coordinates: 100_000, rules: 500, snapshotsRequired: 20, sharedDataResource: firstData, concurrentQueriesLastSnapshot: queryCount, measurements }); }
      expect(performance.now() - start).toBeLessThanOrEqual(60_000);
    }
    const current = await apps[0].inject({ url: base + '?compact=true', headers }); etag = String(current.headers.etag);
    const accepted = await post(base + '/validations', { baseVersionId: prior });
    try {
      const terminal = await execute(accepted.jobId, 'maximum-domain-validation'); expect(terminal, JSON.stringify(terminal)).toMatchObject({ status: 'succeeded' });
      const results = await apps[1].inject({ url: base + `/runs/${terminal.resultRef.id}/results?compact=true`, headers }); expect(results.statusCode, results.body).toBe(200); expect(results.json().run.summary.byStatus).toMatchObject({ pass: 250, fail: 250 });
    } catch (error) { await record('maximum-domain', { status: 'failed', failedPhase: 'validation', diagnostic, facts: 100_000, coordinates: 100_000, rules: 500, snapshots: snapshotCount, sharedDataResource: firstData, measurements }); throw error; }
    await record('maximum-domain', { status: diagnostic ? 'diagnostic-only' : 'pass', facts: 100_000, coordinates: 100_000, rules: 500, snapshots: snapshotCount, sharedDataResource: firstData, measurements });
  }, 900_000);
  it('runs the actual report exporter from 500 rules and 100000 real workbook facts with retained originals', async () => {
    const input = JSON.parse(await readFile('/inputs/export/manifest.json', 'utf8')) as { files: CapacityFile[] };
    const scope = 'One actual 500-rule/100000-fact ce-report snapshot; real retained originals and export worker. Twenty shared snapshots and SQL-only history traversal are verified separately. Legacy fixture setup is not a claim that the hosted visual import route admits ce-report-1.';
    await record('actual-report-export', { status: 'preparing-fixture', scope, sources: input.files }); const preparation = performance.now();
    for (const file of input.files) expect(await hashFile(file.path)).toBe(file.sha256);
    const batch = await upload(input.files), sourceFiles = input.files.map((file, index) => ({ id: batch.files[index].id, kind: file.role, displayName: file.name, path: file.path, size: file.bytes, sha256: file.sha256, importedAt: new Date().toISOString() }));
    // Generate the seed through the real legacy importer, before any measured export claim.
    const operation: OperationContext = { job: { jobId: randomUUID(), workspaceId: owner.workspaceId, kind: 'import', status: 'running', progress: { completed: 0, total: 0, complete: false }, diagnostics: [], pollAfterMs: 5000 }, cancelled: () => false, progress: () => {} };
    const content = await importWorkspace(sourceFiles, operation);
    expect(content.profileId).toBe('ce-dpmxl-0.9-closed-v1'); expect(content.catalog.variants).toHaveLength(500); expect(content.coordinates).toHaveLength(100_000); expect(content.facts).toHaveLength(100_000);
    expect(content.facts.every(fact => fact.presence === 'value' && fact.originalText === '1' && typeof fact.normalizedValue === 'object' && fact.normalizedValue !== null && 'numerator' in fact.normalizedValue && fact.normalizedValue.numerator === '1' && fact.normalizedValue.denominator === '1')).toBe(true);
    expect(content.coordinates.every((cell, index) => cell.rowCode === String(index + 1).padStart(6, '0') && cell.tableCode === 'T' && cell.columnCode === '0010')).toBe(true);
    for (const source of content.sources) { const file = input.files.find(file => file.role === source.kind)!; expect(source.sha256).toBe(file.sha256); expect(source.size).toBe(file.bytes); expect(source.expandedBytes).toBe(file.expandedBytes); }
    const sources = new HostedRetainedSources(domain.db, domain.objects), uploads = new HostedUploadBatches(domain.db, domain.objects, domain.quotas);
    const publication = new HostedPublication(domain.db, domain.quotas, domain.objects, { now: Date.now, handlers: transferPublicationHandlers(domain), retainSources: (tx, claim, versionId, sourceIds) => sources.promote(tx, claim, versionId, sourceIds) });
    const seal = await claim('seal-upload', { resultId: batch.id }); await domain.db.transaction(tx => uploads.prepareSeal(tx, owner, batch.id, seal.jobId));
    const candidate = { batchId: batch.id, files: batch.files.map((file: { id: string; byteLength: number; sha256: string; partCount: number }) => ({ fileId: file.id, manifestId: randomUUID(), byteLength: file.byteLength, sha256: file.sha256, partCount: file.partCount, expandedBytes: content.sources.find(source => source.id === file.id)!.expandedBytes! })) };
    await publication.publish(seal, { kind: 'seal-upload', resultRef: { type: 'upload-batch', id: batch.id }, canonicalRoots: [], indexes: [], domain: candidate as unknown as JsonObject }); await coordinator.confirmTerminated(seal);
    const snapshot: Snapshot = { versionId: randomUUID(), validationBasisId: randomUUID(), content, contentHash: canonicalHash(content), createdAt: new Date().toISOString() };
    const imported = await claim('import', { resultId: snapshot.versionId, versionId: snapshot.versionId, basisId: snapshot.validationBasisId }), stored = await domain.snapshots.writeSnapshot(imported, snapshot, 'import');
    await publication.publish(imported, { kind: 'import', resultRef: { type: 'import', id: snapshot.versionId }, ...stored }); await coordinator.confirmTerminated(imported);
    const retained = (await domain.db.query('SELECT f.id,f.sha256,f.byte_length,f.retained_ref_count,f.state FROM snapshot_sources s JOIN stored_files f ON f.session_id=s.session_id AND f.workspace_id=s.workspace_id AND f.id=s.source_file_id WHERE s.session_id=$1 AND s.workspace_id=$2 AND s.version_id=$3 ORDER BY f.role', [owner.sessionId, owner.workspaceId, snapshot.versionId])).rows;
    expect(retained).toHaveLength(2); expect(retained.every(file => file.state === 'retained' && file.retained_ref_count === 1)).toBe(true);
    const current = await apps[0].inject({ url: base + '?compact=true', headers }); etag = String(current.headers.etag);
    const prepared = { scope, facts: content.facts.length, coordinates: content.coordinates.length, rules: content.catalog.variants.length, snapshots: 1, contentSha256: snapshot.contentHash, sources: retained, fixturePreparationMs: performance.now() - preparation };
    await record('actual-report-export', { status: 'export-pending', ...prepared });
    const accepted = await post(base + '/exports', { versionId: snapshot.versionId, kind: 'report' });
    try {
      const terminal = await execute(accepted.jobId, 'actual-report-export-job'); expect(terminal, JSON.stringify(terminal)).toMatchObject({ status: 'succeeded' });
      const manifestResponse = await apps[1].inject({ url: base + `/exports/${terminal.resultRef.id}/manifest`, headers }); expect(manifestResponse.statusCode, manifestResponse.body).toBe(200); const manifest = manifestResponse.json();
      const checksum = createHash('sha256'), filename = path.join(evidence, 'actual-report-export.zip'), output = await open(filename, 'w'); let bytes = 0;
      try { for (const part of manifest.parts) { const response = await apps[part.index % 2]!.inject({ url: base + `/exports/${terminal.resultRef.id}/parts/${part.index}`, headers }); expect(response.statusCode).toBe(200); expect(response.rawPayload.length).toBe(part.size); expect(hashBytes(response.rawPayload)).toBe(part.sha256); bytes += response.rawPayload.length; checksum.update(response.rawPayload); await output.writeFile(response.rawPayload); } } finally { await output.close(); }
      expect(bytes).toBe(manifest.byteLength); expect(checksum.digest('hex')).toBe(manifest.sha256); expect(await hashFile(filename)).toBe(manifest.sha256);
      await record('actual-report-export', { status: 'pass', ...prepared, jobId: accepted.jobId, manifest, downloadedBytes: bytes, downloadedSha256: manifest.sha256 });
    } catch (error) { const result = await readFile(path.join(evidence, 'actual-report-export-job.json'), 'utf8').then(value => JSON.parse(value), () => null); await record('actual-report-export', { status: 'failed', ...prepared, jobId: accepted.jobId, result }); throw error; }
  }, 300_000);
});
