import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveDirection, runValidation, simulate } from '@ce/engine';
import type { JsonValue, Snapshot, SnapshotContent } from '@ce/contracts';
import { createApp, type AppOptions } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import type { StagedFile } from '../../apps/api/src/import/multipart-staging.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import { ApiError } from '../../apps/api/src/errors.js';
import { readZipParts } from '../helpers/xlsx-fixtures.js';

const applications: Awaited<ReturnType<typeof createApp>>[] = [], directories: string[] = [];
const date = '2026-10-31T00:00:00.000Z', mib = 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const operation = { cancelled: () => false, progress: () => {} } as unknown as OperationContext;
const exactOriginal = '123456789012345678901234567890.123456789';
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(applications.splice(0).map(app => app.close()));
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve('.cache'), path.resolve(directory));
    if (!relative.startsWith('application-export-') || relative.includes(path.sep)) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
async function staged(location: string, kind: 'catalog' | 'report'): Promise<StagedFile> {
  const bytes = await readFile(location); return { path: location, id: randomUUID(), kind, sha256: hash(bytes), size: bytes.length, displayName: path.basename(location), importedAt: date };
}
/** Originals are real XLSX files; previews and validations are produced by the real engine. */
async function setup(options: AppOptions = {}) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
    workerModules: { apply: new URL('../../apps/api/dist/workers/apply.worker.js', import.meta.url), export: new URL('../../apps/api/dist/workers/export.worker.js', import.meta.url) }, ...options }); applications.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Apply/export SYNTHETIC' } })).json();
  const directory = await mkdtemp(path.resolve('.cache/application-export-')); directories.push(directory);
  const source = (await readXlsxFile(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), { parseNumber: text => text, trim: false }))[0]!;
  const original = source.data.map(row => row.map(value => value === null ? null : String(value)));
  const definitions = [
    ['synthetic_A', 'with {interval:true}: {tC_01.00,r0300,c0010}=1/3'],
    ['synthetic_D', 'with {interval:true}: {tC_01.00,r0310,c0010}={tC_01.00,r0300,c0010}*3'],
    ['synthetic_boolean', '{tC_01.00,r0320,c0010}=true'],
    ['synthetic_implicit', '{tC_01.00,r0330,c0010}=2'],
  ];
  const rows = [original[0]!, ...definitions.map(([code, expression]) => { const row = [...original[2]!]; row[0] = code!; row[1] = 'SYNTHETIC_APPLICATION'; row[6] = expression!; row[7] = ''; return row; })];
  const catalog = path.join(directory, 'synthetic-catalog.xlsx');
  await writeXlsxFile(rows.map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: source.sheet }).toFile(catalog);
  const sheets = (await readXlsxFile(path.resolve('tests/fixtures/generated/report-42.xlsx'), { parseNumber: text => text, trim: false }))
    .map(sheet => ({ sheet: sheet.sheet, data: sheet.data.map(row => row.map(value => value === null ? null : String(value))) }));
  const contexts = sheets.find(sheet => sheet.sheet === 'Contexts')!, coordinates = sheets.find(sheet => sheet.sheet === 'Coordinates')!, facts = sheets.find(sheet => sheet.sheet === 'Facts')!;
  contexts.data[1]![7] = JSON.stringify({ 'C_01.00': true, 'C_05.01': true, C_ABSENT: false });
  for (const row of ['0300', '0310', '0330']) coordinates.data.push(['demo', 'C_01.00', '', row, '0010', 'number', 'EUR', '2', '{}']);
  coordinates.data.push(['demo', 'C_01.00', '', '0320', '0010', 'boolean', '', '', '{}']);
  facts.data.push(['demo', 'C_01.00', '', '0300', '0010', 'value', '10.00'], ['demo', 'C_01.00', '', '0310', '0010', 'value', '30.00'], ['demo', 'C_01.00', '', '0320', '0010', 'value', 'false']);
  const firstReport = path.join(directory, 'original-amounts.xlsx'), emptyReport = path.join(directory, 'original-context-only.xlsx');
  const asCells = (input: typeof sheets) => input.map(sheet => ({ ...sheet, data: sheet.data.map(row => row.map(value => value === null ? null : { type: String, value })) }));
  await writeXlsxFile(asCells(sheets)).toFile(firstReport);
  const alias = [...contexts.data[1]!]; alias[1] = 'empty_alias';
  const emptySheets = sheets.map(sheet => ({ ...sheet, data: sheet.sheet === 'Contexts' ? [sheet.data[0]!, alias] : sheet.sheet === 'Instructions' ? sheet.data : [sheet.data[0]!] }));
  await writeXlsxFile(asCells(emptySheets)).toFile(emptyReport);
  const files = await Promise.all([staged(catalog, 'catalog'), staged(firstReport, 'report'), staged(emptyReport, 'report')]);
  const imported = await importWorkspace(files, operation), initial = app.ce.store.publish(workspace.id, undefined, imported);
  const recordRun = (base: Snapshot) => {
    const bundle = runValidation(base, { runId: randomUUID(), startedAt: date, now: () => Date.parse(date) });
    app.ce.store.putRecords([{ key: validationKey(workspace.id, bundle.run.id), value: bundle as unknown as JsonValue }]); return bundle;
  };
  const validation = recordRun(initial);
  const directions = definitions.map(([code]) => {
    const result = validation.results.find(row => row.code === code && row.instanceId)!;
    if (!result?.instanceId || !result.binding) throw new Error('Missing real fixture instance');
    const resolved = resolveDirection(initial, { instanceId: result.instanceId, variantIds: result.variantIds, binding: result.binding, targetSide: 'left' }).resolved;
    if (!resolved) throw new Error('Unresolved fixture direction'); return resolved.direction;
  });
  const snapshot = app.ce.store.publish(workspace.id, initial.versionId, { ...initial.content, configVersion: 'application-fixture', directions });
  const addPreview = (base = app.ce.store.current(workspace.id)!) => {
    const bundle = simulate(base, { previewId: randomUUID(), now: () => Date.parse(date) });
    app.ce.store.putRecords([{ key: `preview:${workspace.id}:${bundle.preview.id}`, value: bundle as unknown as JsonValue }]); return bundle;
  };
  const preview = addPreview(snapshot);
  const select = (selectedIds: string[], id = preview.preview.id) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/previews/${id}/selection`, headers, payload: { selectedIds } });
  const request = (body: unknown, key = randomUUID(), match: string | null = app.ce.store.etag(workspace.id)) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/applications`,
    headers: { ...headers, 'idempotency-key': key, ...(match === null ? {} : { 'if-match': match }) }, payload: body });
  const poll = async (jobId: string) => { for (let i = 0; i < 500; i++) {
    const response = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers }); expect(response.statusCode).toBe(200); const job = response.json();
    if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10));
  } throw new Error('Application/export worker did not finish'); };
  const body = async (selectedIds = preview.proposals.map(proposal => proposal.id), bundle = preview) => {
    const selection = await select(selectedIds, bundle.preview.id); expect(selection.statusCode).toBe(200);
    return { baseVersionId: bundle.preview.baseVersionId, previewId: bundle.preview.id, selectedIds, closureHash: selection.json().closureHash };
  };
  const apply = async (selectedIds?: string[], bundle = preview) => {
    const payload = await body(selectedIds ?? bundle.proposals.map(proposal => proposal.id), bundle), accepted = await request(payload); expect(accepted.statusCode).toBe(202);
    const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded'); expect(job.resultRef.type).toBe('application'); return job;
  };
  const receipt = (id: string) => app.inject({ url: `/api/v1/workspaces/${workspace.id}/applications/${id}`, headers });
  const exportReport = async (versionId: string, match = app.ce.store.etag(workspace.id)) => {
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': match, 'idempotency-key': randomUUID() }, payload: { kind: 'report', versionId } });
    expect(accepted.statusCode).toBe(202); const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded');
    const download = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/exports/${job.resultRef.id}`, headers });
    expect(download.statusCode).toBe(200); expect(download.headers['content-type']).toBe('application/zip'); expect(download.headers['content-disposition']).toBe('attachment; filename="report.zip"');
    const location = path.join(directory, randomUUID() + '.zip'); await writeFile(location, download.rawPayload);
    return { download, entries: await readZipParts(location) };
  };
  return { app, headers, workspace, directory, files, initial, snapshot, preview, recordRun, addPreview, select, body, request, poll, apply, receipt, exportReport };
}

function business(content: SnapshotContent) {
  return {
    contexts: content.contexts.map(({ filingIndicatorsLocator: _locator, ...context }) => context).sort((a, b) => a.contextId.localeCompare(b.contextId)),
    coordinates: content.coordinates.map(({ sourceLocator: _locator, ...coordinate }) => coordinate).sort((a, b) => a.factKey.localeCompare(b.factKey)),
    // Reimport creates fresh provenance; session receipt IDs remain in changes.json, never in Facts cells.
    facts: content.facts.map(({ sourceLocator: _locator, derivation: _derivation, ...fact }) => fact).sort((a, b) => a.factKey.localeCompare(b.factKey)),
  };
}
async function roundtrip(fixture: Awaited<ReturnType<typeof setup>>, target: Snapshot) {
  const { entries, download } = await fixture.exportReport(target.versionId);
  expect(entries.map(entry => entry.name).sort()).toEqual(['changes.json', 'changes.xlsx', 'reports/report-001.xlsx', 'reports/report-002.xlsx']);
  expect(download.rawPayload.length).toBeLessThanOrEqual(100 * mib); expect(entries.reduce((sum, entry) => sum + entry.data.length, 0)).toBeLessThanOrEqual(100 * mib);
  const json = entries.find(entry => entry.name === 'changes.json')!; expect(json.data.length).toBeLessThanOrEqual(64 * mib);
  const log = JSON.parse(json.data.toString('utf8'));
  expect(log).toMatchObject({ versionId: target.versionId, contentHash: target.contentHash, profileId: target.content.profileId, policyId: 'half-even-v1', synthetic: true });
  expect(log.reports).toHaveLength(2); expect(log.receipts).toBeInstanceOf(Array); expect(log.changes).toBeInstanceOf(Array);
  expect(json.data.toString('utf8')).not.toMatch(/"ast"|"stack"|"path"|ce-session-/i);
  const reports: StagedFile[] = [];
  let compressed = fixture.files.find(file => file.kind === 'catalog')!.size;
  let expanded = (target.content.sources.find(file => file.kind === 'catalog') as unknown as { expandedBytes: number }).expandedBytes;
  expect(Number.isSafeInteger(expanded)).toBe(true);
  for (const manifest of log.reports) {
    expect(manifest.entryName).toMatch(/^reports\/report-00[12]\.xlsx$/);
    const entry = entries.find(item => item.name === manifest.entryName)!; expect(entry).toBeDefined(); expect(entry.data.length).toBeLessThanOrEqual(10 * mib);
    const source = target.content.sources.find(item => item.id === manifest.sourceFileId); expect(source?.kind).toBe('report');
    expect([...manifest.contextIds].sort()).toEqual(target.content.contexts.filter(context => context.filingIndicatorsLocator?.fileId === source!.id).map(context => context.contextId).sort());
    expect(manifest.size).toBe(entry.data.length); expect(manifest.sha256).toBe(hash(entry.data));
    const location = path.join(fixture.directory, randomUUID() + '.xlsx'); await writeFile(location, entry.data);
    const preflight = await preflightXlsx(location); expect(manifest.expandedBytes).toBe(preflight.expandedBytes);
    compressed += entry.data.length; expanded += preflight.expandedBytes; reports.push(await staged(location, 'report'));
    for (const part of await readZipParts(location)) if (/\.xml$/.test(part.name)) expect(part.data.toString('utf8')).not.toMatch(/<(?:\w+:)?f(?:\s|>)|<(?:\w+:)?hyperlink(?:\s|>)/);
  }
  expect(compressed).toBeLessThanOrEqual(50 * mib); expect(expanded).toBeLessThanOrEqual(100 * mib);
  const changeWorkbook = entries.find(entry => entry.name === 'changes.xlsx')!; expect(changeWorkbook.data.length).toBeLessThanOrEqual(64 * mib);
  const changesLocation = path.join(fixture.directory, randomUUID() + '.xlsx'); await writeFile(changesLocation, changeWorkbook.data);
  for (const part of await readZipParts(changesLocation)) if (/\.xml$/.test(part.name)) expect(part.data.toString('utf8')).not.toMatch(/<(?:\w+:)?f(?:\s|>)|<(?:\w+:)?hyperlink(?:\s|>)/);
  const literalSheets = await readXlsxFile(changesLocation, { trim: false });
  for (const sheet of literalSheets) for (const row of sheet.data) for (const value of row) if (value !== null) expect(typeof value).toBe('string');
  const imported = await importWorkspace([await staged(fixture.files.find(file => file.kind === 'catalog')!.path, 'catalog'), ...reports], operation);
  expect(business(imported)).toEqual(business(target.content));
  return { log, imported };
}

describe('explicit application contracts', () => {
  it('keeps selection read-only and publishes exactly the explicitly confirmed closed set', async () => {
    const fixture = await setup(), { app, workspace, snapshot, preview, select, apply, receipt } = fixture;
    const selected = preview.proposals.filter(proposal => ['synthetic_A', 'synthetic_D'].includes(proposal.code)); expect(selected).toHaveLength(2);
    const selection = await select(selected.map(proposal => proposal.id)); expect(selection.json().complete).toBe(true); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
    const job = await apply(selected.map(proposal => proposal.id)), current = app.ce.store.current(workspace.id)!;
    expect(current.versionId).not.toBe(snapshot.versionId); expect(current.parentVersionId).toBe(snapshot.versionId); expect(job.newVersionId).toBe(current.versionId);
    const response = await receipt(job.resultRef.id); expect(response.statusCode).toBe(200);
    expect(response.json().receipt).toMatchObject({ id: job.resultRef.id, previewId: preview.preview.id, baseVersionId: snapshot.versionId, newVersionId: current.versionId, closureHash: selection.json().closureHash });
    expect(response.json().receipt.acceptedIds.slice().sort()).toEqual(selected.map(proposal => proposal.id).sort()); expect(response.json().changeCount).toBe(2);
    for (const proposal of preview.proposals) {
      const updated = current.content.facts.find(fact => fact.factKey === proposal.targetKey), previous = snapshot.content.facts.find(fact => fact.factKey === proposal.targetKey);
      if (selected.some(item => item.id === proposal.id)) expect(updated?.normalizedValue).toEqual(proposal.after!.normalizedValue); else expect(updated).toEqual(previous);
    }
    expect(current.content.contexts).toEqual(snapshot.content.contexts); expect(current.content.coordinates).toEqual(snapshot.content.coordinates);
  });
  it('requires token, current If-Match and closed confirmation bodies', async () => {
    const { app, headers, workspace, snapshot, body, request } = await setup(); const payload = await body();
    expect((await request(payload, randomUUID(), null)).statusCode).toBe(428); expect((await request(payload, randomUUID(), '"old"')).statusCode).toBe(412);
    expect((await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/applications`, headers: { host: headers.host, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload })).statusCode).toBe(403);
    for (const extra of [{ acceptAncestors: true }, { expression: '1=1' }, { proposals: [] }, { path: 'outside.xlsx' }]) expect((await request({ ...payload, ...extra })).statusCode).toBe(400);
    expect((await request({ ...payload, selectedIds: [] })).statusCode).toBe(400); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
  });
  it('rejects missing ancestors and a forged closure hash without silently adding proposals', async () => {
    const { app, workspace, snapshot, preview, body, request } = await setup(); const consumer = preview.proposals.find(proposal => proposal.code === 'synthetic_D')!;
    const incomplete = await body([consumer.id]), response = await request(incomplete);
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('SELECTION_NOT_CLOSED');
    const forged = await request({ ...await body(), closureHash: '0'.repeat(64) }); expect(forged.statusCode).toBe(409); expect(forged.json().error.code).toBe('SELECTION_NOT_CLOSED');
    expect((await request({ ...await body(), selectedIds: [randomUUID()] })).statusCode).toBe(400);
    expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.listRecords('job:')).toEqual([]);
  });
  it('replays a completed application after its old If-Match becomes stale and rejects a changed body for that key', async () => {
    const { app, workspace, preview, body, request, poll, receipt } = await setup();
    const payload = await body(), key = randomUUID(), etag = app.ce.store.etag(workspace.id), accepted = await request(payload, key, etag); expect(accepted.statusCode).toBe(202);
    const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded'); const current = app.ce.store.current(workspace.id)!, versions = app.ce.store.get(workspace.id).versionIds;
    const replay = await request(payload, key, etag); expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(job.jobId); expect(replay.json().resultRef).toEqual(job.resultRef);
    expect(app.ce.store.current(workspace.id)).toBe(current); expect(app.ce.store.get(workspace.id).versionIds).toEqual(versions);
    const changed = await request({ ...payload, selectedIds: [preview.proposals.find(proposal => proposal.code === 'synthetic_A')!.id] }, key, etag);
    expect(changed.statusCode).toBe(409); expect(changed.json().error.code).toBe('IDEMPOTENCY_CONFLICT'); expect((await receipt(job.resultRef.id)).statusCode).toBe(200);
  });
});

describe('reimportable report package', () => {
  it('retains each original source expanded size for the reimport budget, including the catalog', async () => {
    const { files, snapshot } = await setup();
    for (const source of snapshot.content.sources) {
      const original = files.find(file => file.id === source.id)!;
      const preflight = await preflightXlsx(original.path);
      expect((source as unknown as { expandedBytes: number }).expandedBytes).toBe(preflight.expandedBytes);
    }
  });
  it('roundtrips exact values, codes, nulls, booleans and filing indicators through source-partitioned literal XLSX files', async () => {
    const fixture = await setup(), { app, workspace, snapshot, preview, files } = fixture;
    expect(preview.proposals.every(proposal => proposal.state === 'available')).toBe(true);
    const job = await fixture.apply(), target = app.ce.store.current(workspace.id)!;
    const { log, imported } = await roundtrip(fixture, target);
    expect(log.receipts.map((receipt: { id: string }) => receipt.id)).toEqual([job.resultRef.id]);
    expect(log.changes.map((change: { proposalId: string }) => change.proposalId).sort()).toEqual(preview.proposals.map(proposal => proposal.id).sort());
    const numeric = log.changes.find((change: { targetKey: string }) => change.targetKey === preview.proposals.find(proposal => proposal.code === 'synthetic_A')!.targetKey);
    expect(numeric).toMatchObject({ receiptId: job.resultRef.id, exactNominal: { numerator: '1', denominator: '3' },
      after: { normalizedValue: { numerator: '33', denominator: '100' }, originalText: '0.33', decimals: '2', unit: 'EUR' }, policyId: 'half-even-v1' });
    expect(numeric.before.coordinate).toBeDefined(); expect(numeric.sources.length).toBeGreaterThan(0); expect(numeric.directionId).toBeTypeOf('string');
    const boolean = log.changes.find((change: { targetKey: string }) => change.targetKey === preview.proposals.find(proposal => proposal.code === 'synthetic_boolean')!.targetKey);
    expect(boolean.after).toEqual({ originalText: 'true', normalizedValue: true }); expect(boolean).not.toHaveProperty('exactNominal'); expect(boolean).not.toHaveProperty('derivedInterval'); expect(boolean).not.toHaveProperty('policyId');
    expect(imported.facts.find(fact => fact.contextId === 'demo' && fact.tableCode === 'C_01.00' && fact.rowCode === '0240' && fact.columnCode === '0010')!.originalText).toBe(exactOriginal);
    expect(imported.facts.some(fact => fact.presence === 'null')).toBe(true); expect(imported.coordinates.some(cell => !imported.facts.some(fact => fact.factKey === cell.factKey))).toBe(true);
    expect(imported.facts.find(fact => fact.rowCode === '0330')!.originalText).toBe('2.00');
    expect(imported.facts.find(fact => fact.rowCode === '0320')!.normalizedValue).toBe(true);
    expect(imported.contexts.find(context => context.contextId === 'empty_alias')).toBeDefined();
    expect(imported.contexts[0]!.filingIndicators).toEqual({ 'C_01.00': true, 'C_05.01': true, C_ABSENT: false }); expect(imported.contexts[0]!.filingIndicators).not.toHaveProperty('MISSING');
    expect(imported.coordinates.some(cell => cell.columnCode === '0010')).toBe(true); expect(snapshot.content.facts.find(fact => fact.rowCode === '0320')!.normalizedValue).toBe(false);
    for (const original of files) expect(hash(await readFile(original.path))).toBe(original.sha256);
    expect(app.ce.store.current(workspace.id)).toBe(target);
  });
  it('exports a historical original with current CAS, empty changes and no later recalculated facts', async () => {
    const fixture = await setup(); await fixture.apply(); const current = fixture.app.ce.store.current(fixture.workspace.id)!;
    const stale = await fixture.app.inject({ method: 'POST', url: `/api/v1/workspaces/${fixture.workspace.id}/exports`, headers: { ...fixture.headers, 'if-match': '"v-' + fixture.snapshot.versionId + '"', 'idempotency-key': randomUUID() }, payload: { kind: 'report', versionId: fixture.initial.versionId } });
    expect(stale.statusCode).toBe(412);
    const { log, imported } = await roundtrip(fixture, fixture.initial); expect(log.receipts).toEqual([]); expect(log.changes).toEqual([]);
    expect(imported.facts.find(fact => fact.rowCode === '0300')!.originalText).toBe('10.00'); expect(imported.facts.find(fact => fact.rowCode === '0320')!.normalizedValue).toBe(false);
    expect(fixture.app.ce.store.current(fixture.workspace.id)).toBe(current);
  });
  it('accumulates only ancestor applications and resets the exported change log after a real replacement import', async () => {
    const fixture = await setup(), { app, workspace, preview, files } = fixture;
    const a = preview.proposals.find(proposal => proposal.code === 'synthetic_A')!, first = await fixture.apply([a.id]), firstVersion = app.ce.store.current(workspace.id)!;
    const nextPreview = fixture.addPreview(), boolean = nextPreview.proposals.find(proposal => proposal.code === 'synthetic_boolean')!;
    const second = await fixture.apply([boolean.id], nextPreview), secondVersion = app.ce.store.current(workspace.id)!;
    const historical = await roundtrip(fixture, firstVersion);
    expect(historical.log.receipts.map((receipt: { id: string }) => receipt.id)).toEqual([first.resultRef.id]);
    expect(historical.log.changes.map((change: { proposalId: string }) => change.proposalId)).toEqual([a.id]);
    const latest = await roundtrip(fixture, secondVersion);
    expect(latest.log.receipts.map((receipt: { id: string }) => receipt.id)).toEqual([first.resultRef.id, second.resultRef.id]);
    expect(latest.log.changes.map((change: { proposalId: string }) => change.proposalId).sort()).toEqual([a.id, boolean.id].sort());
    // Real import with fresh staging IDs, matching the normal replacement import boundary.
    const replacementContent = await importWorkspace(await Promise.all(files.map(file => staged(file.path, file.kind))), operation);
    const replacement = app.ce.store.publish(workspace.id, secondVersion.versionId, replacementContent);
    const reset = await roundtrip(fixture, replacement); expect(reset.log.receipts).toEqual([]); expect(reset.log.changes).toEqual([]);
    expect(reset.imported.facts.find(fact => fact.rowCode === '0300')!.originalText).toBe('10.00');
  });
  it('rejects caller paths and filenames and keeps the workspace unchanged on export contract errors', async () => {
    const { app, headers, workspace, snapshot } = await setup();
    for (const extension of [{ path: '../outside.xlsx' }, { filename: 'attacker.zip' }, { changes: [] }]) {
      const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { kind: 'report', versionId: snapshot.versionId, ...extension } });
      expect(response.statusCode).toBe(400);
    }
    expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.listRecords('job:')).toEqual([]);
  });
  it.each(['missing import statistics', 'invalid report source', 'incomplete version history'])('rejects %s instead of exporting an unverifiable package', async defect => {
    const { app, headers, workspace, snapshot, initial, files } = await setup();
    const sources = await Promise.all(snapshot.content.sources.map(async source => ({ ...source,
      expandedBytes: (await preflightXlsx(files.find(file => file.id === source.id)!.path)).expandedBytes })));
    const withoutCatalogStatistics = sources.map(({ expandedBytes, ...source }) => source.kind === 'catalog' ? source : { ...source, expandedBytes });
    const content = { ...snapshot.content, sources: defect === 'missing import statistics' ? withoutCatalogStatistics : sources,
      contexts: defect === 'invalid report source' ? snapshot.content.contexts.map((context, index) => index === 0 ? { ...context, filingIndicatorsLocator: { ...context.filingIndicatorsLocator, fileId: randomUUID() } } : context) : snapshot.content.contexts };
    const target = app.ce.store.publish(workspace.id, snapshot.versionId, content);
    if (defect === 'incomplete version history') {
      // Explicit missing-history storage fixture. The importer, calculations and snapshot contents are real.
      const lookup = app.ce.store.snapshot.bind(app.ce.store);
      vi.spyOn(app.ce.store, 'snapshot').mockImplementation((owner, id) => {
        if (id === initial.versionId) throw new ApiError('RESOURCE_NOT_FOUND'); return lookup(owner, id);
      });
    }
    const bytes = app.ce.store.bytes, disk = app.ce.files.usage(workspace.id);
    const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { kind: 'report', versionId: target.versionId } });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('EXPORT_NOT_AVAILABLE');
    expect(response.body).not.toMatch(/"stack"|ce-session-|[A-Z]:\\\\/);
    expect(app.ce.store.current(workspace.id)).toBe(target); expect(app.ce.store.bytes).toBe(bytes); expect(app.ce.files.usage(workspace.id)).toEqual(disk);
    expect(app.ce.store.listRecords('export:')).toEqual([]); expect(app.ce.store.listRecords('job:')).toEqual([]);
  });
});
