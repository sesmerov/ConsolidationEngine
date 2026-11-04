import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { controlledFactory } from '../helpers/foundation.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { inspectionHarness } from '../helpers/inspection-lifecycle-harness.js';
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
const harnesses: Awaited<ReturnType<typeof inspectionHarness>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); await Promise.all(harnesses.splice(0).map(h => h.close())); });
async function setup() {
  const app = await createApp({ workerFactory: controlledFactory().factory }); apps.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Inspection contract' } })).json();
  return { app, headers, workspace, url: `/api/v1/workspaces/${workspace.id}/import-inspections` };
}
function multipart(parts: readonly { name: string; value: string | Buffer; filename?: string }[], boundary = randomUUID()) {
  const chunks: Buffer[] = [];
  for (const part of parts) chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ''}\r\n\r\n`), Buffer.from(part.value), Buffer.from('\r\n'));
  chunks.push(Buffer.from(`--${boundary}--\r\n`)); return { payload: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}
// Transport tests stop before parsing: these are ZIP-signature sentinels, not valid report fixtures.
const zip = Buffer.from([0x50, 0x4b, 3, 4, 0]);
const fileParts = [{ name: 'catalog', filename: 'rules.xlsx', value: zip }, { name: 'reports', filename: 'report.xlsx', value: zip }];
const contextPart = { name: 'context', value: JSON.stringify({ source: 'workbook' }) };
async function post(f: Awaited<ReturnType<typeof setup>>, parts = [...fileParts, contextPart], key = randomUUID(), boundary?: string) {
  const body = multipart(parts, boundary); return f.app.inject({ method: 'POST', url: f.url, headers: { ...f.headers, 'if-match': '"empty"', 'idempotency-key': key, 'content-type': body.contentType }, payload: body.payload });
}
describe('import inspection HTTP surface', () => {
  it('exposes a recoverable active resource without changing empty workspace state', async () => {
    const f = await setup(), response = await f.app.inject({ url: f.url, headers: f.headers });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ active: null });
    expect(f.app.ce.store.etag(f.workspace.id)).toBe('"empty"'); expect(f.app.ce.store.get(f.workspace.id).versionIds).toEqual([]);
  });
  it('publishes bounded inspection capabilities without claiming typed language support', async () => {
    const f = await setup(), response = await f.app.inject({ url: '/api/v1/capabilities', headers: f.headers });
    expect(response.statusCode).toBe(200); expect(response.json().importInspection).toEqual({ ttlSeconds: 900, maxActive: 1 });
    expect(response.json().reportProfiles).toContainEqual(expect.objectContaining({ id: 'eba-corep-of-4.0-ca1-v1', supportedTables: ['C_01.00'] }));
  });
  it('keeps tokens, origins and unknown query fields guarded on inspection reads', async () => {
    const f = await setup();
    expect((await f.app.inject({ url: f.url, headers: { host: f.headers.host } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: f.url, headers: { ...f.headers, origin: 'https://untrusted.example' } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: f.url, headers: { ...f.headers, host: 'untrusted.example' } })).statusCode).toBe(403);
    expect((await f.app.inject({ url: f.url + '?candidate=true', headers: f.headers })).statusCode).toBe(400);
  });
  it.each([20, 21])('enforces the %i-report transport boundary before accepting work', async count => {
    const f = await setup(), parts = [fileParts[0]!, ...Array.from({ length: count }, (_, i) => ({ ...fileParts[1]!, filename: `report-${i}.xlsx` })), contextPart];
    const response = await post(f, parts); expect(response.statusCode, response.body).toBe(count === 20 ? 202 : 413);
    if (count === 21) expect(f.app.ce.files.usage(f.workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 });
  });
  it('requires If-Match before accepting inspection and cleans its received input on rejection', async () => {
    const f = await setup(), body = multipart([...fileParts, contextPart]);
    const response = await f.app.inject({ method: 'POST', url: f.url, headers: { ...f.headers, 'idempotency-key': randomUUID(), 'content-type': body.contentType }, payload: body.payload });
    expect(response.statusCode).toBe(428); expect(f.app.ce.store.get(f.workspace.id).activeJobId).toBeUndefined();
    expect(f.app.ce.files.usage(f.workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 });
  });
  it.each([
    ['missing context', fileParts], ['duplicate context', [...fileParts, contextPart, contextPart]],
    ['unknown part', [...fileParts, { name: 'mapping', value: '{}' }]],
    ['malformed JSON', [...fileParts, { name: 'context', value: '{' }]],
    ['free profile', [...fileParts, { name: 'context', value: JSON.stringify({ source: 'workbook', profileId: 'ce-dpmxl-0.9-closed-v1' }) }]],
    ['oversized UTF8 field', [...fileParts, { name: 'context', value: 'é'.repeat(8193) }]],
    ['missing report', [fileParts[0]!, contextPart]], ['duplicate catalog', [fileParts[0]!, ...fileParts, contextPart]],
  ])('rejects %s and cleans all staged files before any Job', async (_name, parts) => {
    const f = await setup(), response = await post(f, parts as typeof fileParts);
    expect(response.statusCode, response.body).toBe(400); expect(f.app.ce.store.get(f.workspace.id).activeJobId).toBeUndefined();
    expect(f.app.ce.files.usage(f.workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 }); expect(await readdir(f.app.ce.files.workspacePath(f.workspace.id))).toEqual([]);
  });
  it('hashes report order and canonical context, ignoring only the transport boundary', async () => {
    const f = await setup(), key = randomUUID(), parts = [...fileParts, { name: 'reports', filename: 'second.xlsx', value: zip }, contextPart];
    const first = await post(f, parts, key, 'first-boundary'); expect(first.statusCode).toBe(202);
    const replay = await post(f, parts, key, 'second-boundary'); expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(first.json().jobId);
    const reordered = [parts[0]!, parts[2]!, parts[1]!, parts[3]!]; expect((await post(f, reordered, key)).statusCode).toBe(409);
    const changedContext = [...parts.slice(0, 3), { name: 'context', value: JSON.stringify({ source: 'form', declaration: { entityId: 'Different', referenceDate: '2025-12-31', filingIndicators: { 'C_01.00': true } } }) }];
    expect((await post(f, changedContext, key)).statusCode).toBe(409);
  });
  it('keeps commit bodies closed and reports missing or foreign resources without disclosure', async () => {
    const f = await setup(), nonexistent = randomUUID(), url = f.url + '/' + nonexistent;
    expect((await f.app.inject({ url, headers: f.headers })).statusCode).toBe(404);
    const headers = { ...f.headers, 'if-match': '"empty"', 'idempotency-key': randomUUID() };
    expect((await f.app.inject({ method: 'POST', url: url + '/commit', headers, payload: { inspectionHash: 'a'.repeat(64), acceptedExcludedSheets: false, candidate: {} } })).statusCode).toBe(400);
    expect((await f.app.inject({ method: 'POST', url: url + '/commit', headers, payload: { inspectionHash: 'a'.repeat(64), acceptedExcludedSheets: false } })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'DELETE', url, headers, payload: { accepted: true } })).statusCode).toBe(400);
  });
  it('projects a real COREP inspection as closed summaries with no snapshot, AST or private paths', async () => {
    const h = await inspectionHarness({ empty: true }); harnesses.push(h); const view = await h.ready();
    const response = await h.get(view.id), dto = response.json(); expect(dto.context[0].origin).toBe('form'); expect(dto.context[0].locators).toBeUndefined();
    expect(dto.reports[0]).toMatchObject({ profileId: 'eba-corep-of-4.0-ca1-v1', coordinates: 110, selectedSheets: ['CA1'] }); expect(dto.reports[0].excludedSheets).toHaveLength(190);
    expect(Object.keys(dto).sort()).toEqual(['id', 'workspaceId', 'state', 'createdAt', 'expiresAt', 'inspectionHash', 'profiles', 'context', 'reports', 'diagnostics', 'requiresPartialCoverageAcceptance'].sort());
    expect(response.body).not.toMatch(/"(?:candidate|ast|path|facts|normalizedValue)":/); expect(h.app.ce.store.current(h.workspace.id)).toBeUndefined();
    expect((await h.app.inject({ url: `/api/v1/workspaces/${randomUUID()}/import-inspections/${view.id}`, headers: h.headers })).statusCode).toBe(404);
    expect((await h.commit(view)).statusCode).toBe(202);
    const whileCommitting = await h.start(); expect(whileCommitting.statusCode).toBe(409); expect(whileCommitting.json().error.code).toBe('IMPORT_INSPECTION_EXISTS');
  });
  it('prevents using the legacy import endpoint to bypass visual inspection', async () => {
    const h = await inspectionHarness({ realWorker: true, workerModules: { import: new URL('../../apps/api/dist/workers/import.worker.js', import.meta.url) } }); harnesses.push(h);
    const [catalog, report] = await Promise.all([readFile(new URL('../fixtures/generated/eba-subset.xlsx', import.meta.url)), readFile(new URL('../../assets/templates/corep-ca1.xlsx', import.meta.url))]);
    const files = [{ name: 'catalog', filename: 'rules.xlsx', value: catalog }, { name: 'reports', filename: 'corep.xlsx', value: report }];
    const request = async (parts: Parameters<typeof multipart>[0]) => { const body = multipart(parts); return h.app.inject({ method: 'POST', url: `/api/v1/workspaces/${h.workspace.id}/imports`, headers: { ...h.headers, 'if-match': h.originalETag, 'idempotency-key': randomUUID(), 'content-type': body.contentType }, payload: body.payload }); };
    expect((await request([...files, contextPart])).statusCode).toBe(400);
    const response = await request(files); expect(response.statusCode, response.body).toBe(202);
    const job = await h.settle(response.json().jobId); expect(job.status).toBe('failed'); expect(job.diagnostics[0]?.code).toBe('INVALID_WORKBOOK');
    await h.clean(); expect((await h.active()).json()).toEqual({ active: null });
  });
  it('serves the sanitized template only through the authenticated API', async () => {
    const f = await setup(), url = '/api/v1/templates/corep-ca1'; expect((await f.app.inject({ url, headers: { host: f.headers.host } })).statusCode).toBe(403);
    const response = await f.app.inject({ url, headers: f.headers }); expect(response.statusCode).toBe(200);
    expect(response.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4])); expect(response.headers['content-disposition']).toContain('corep-ca1.xlsx');
  });
});
