import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JOB_DEADLINE_MS, MAX_SNAPSHOTS, SESSION_LIMIT_BYTES } from '@ce/contracts';
import { PARSER_LIMITS } from '@ce/engine';
import { createApp } from '../../apps/api/src/app.js';
import { registerJobRoute } from '../../apps/api/src/routes/jobs.js';
import { UPLOAD_LIMITS } from '../../apps/api/src/import/multipart-staging.js';
import { PREFLIGHT_LIMITS } from '../../apps/api/src/import/xlsx-preflight.js';
import { EXPORT_LIMITS } from '../../apps/api/src/export/results-export.js';
import { REPORT_EXPORT_LIMITS } from '../../apps/api/src/export/recalculated-report.js';
import { FILE_SESSION_LIMIT } from '../../apps/api/src/storage/session-files.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [], roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close()));
  for (const root of roots.splice(0)) { const relative = path.relative(path.resolve('.cache'), root); if (!relative.startsWith('local-surface-') || relative.includes(path.sep)) throw new Error('Unsafe cleanup'); await rm(root, { recursive: true, force: true }); }
});
async function setup() {
  const app = await createApp(); apps.push(app); const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken; return { app, headers };
}
const safe = (body: string, secrets: readonly string[]) => { for (const secret of secrets) expect(body.includes(secret)).toBe(false); expect(body).not.toMatch(/"stack"|"validation"|ce-session-/); };

describe('local API surface and published limits', () => {
  it('keeps POST/GET/DELETE available locally and exposes only the declared CORS methods', async () => {
    const { app, headers } = await setup();
    const options = await app.inject({ method: 'OPTIONS', url: '/api/v1/workspaces', headers: { ...headers, 'access-control-request-method': 'POST', 'access-control-request-headers': 'X-CE-Session,If-Match' } });
    expect(options.statusCode).toBe(204); expect(options.headers['access-control-allow-methods']!.split(',')).toEqual(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']); expect(options.headers['access-control-allow-origin']).toBe(headers.origin);
    const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'HTTP lifecycle' } }); expect(created.statusCode).toBe(201);
    const url = `/api/v1/workspaces/${created.json().id}`, read = await app.inject({ url, headers }); expect(read.statusCode).toBe(200); expect(read.headers.etag).toBe('"empty"');
    for (const method of ['PATCH', 'TRACE'] as const) { const rejected = await app.inject({ method, url, headers }); expect(rejected.statusCode).toBe(404); expect(rejected.json().error.code).toBe('RESOURCE_NOT_FOUND'); }
    expect((await app.inject({ url, headers })).statusCode).toBe(200);
    const removed = await app.inject({ method: 'DELETE', url, headers: { ...headers, 'if-match': '"empty"' } }); expect(removed.statusCode).toBe(204);
    expect((await app.inject({ url, headers })).statusCode).toBe(404);
    for (const response of [options, created, read, removed]) expect(response.headers['cache-control']).toBe('no-store');
  });
  it('returns public 413 for JSON above the configured bodyLimit instead of 500, without retaining payload or creating a workspace', async () => {
    const { app, headers } = await setup(), limit = app.initialConfig.bodyLimit;
    expect(limit).toBe(1024 * 1024);
    const marker = 'BODY_CANARY_' + randomUUID(), payload = JSON.stringify({ name: marker + 'x'.repeat(limit) });
    const response = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { ...headers, 'content-type': 'application/json' }, payload });
    expect(response.statusCode).toBe(413); expect(response.json()).toMatchObject({ error: { code: 'UPLOAD_LIMIT', message: 'La carga supera los límites admitidos.', locator: null, details: {} } });
    expect(response.json().error.requestId).toMatch(/^[0-9a-f-]{36}$/); safe(response.body, [marker, headers['x-ce-session']]); expect(app.ce.store.currentWorkspaceId).toBeUndefined(); expect(app.ce.store.listRecords('')).toEqual([]);
    const valid = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'After rejected body' } }); expect(valid.statusCode).toBe(201);
  });
  it('announces actual import, export and session quotas and distinguishes the report writer from XML estimates', async () => {
    const { app, headers } = await setup(), response = await app.inject({ url: '/api/v1/capabilities', headers }); expect(response.statusCode).toBe(200);
    const capabilities = response.json(); expect(capabilities.limits).toMatchObject({ ...UPLOAD_LIMITS, ...PARSER_LIMITS, jobDeadlineMs: JOB_DEADLINE_MS, maxSnapshots: MAX_SNAPSHOTS, sessionBytes: SESSION_LIMIT_BYTES,
      expandedBatchBytes: PREFLIGHT_LIMITS.maxExpandedBytes, entryBytes: PREFLIGHT_LIMITS.maxEntryBytes, exportContentBytes: EXPORT_LIMITS.maxContentBytes, exportTotalBytes: EXPORT_LIMITS.maxTotalBytes, exportXmlWorkloadBytes: REPORT_EXPORT_LIMITS.maxXmlWorkloadBytes, fileSessionBytes: FILE_SESSION_LIMIT });
    expect(capabilities.limits.maxFileBytes).toBe(REPORT_EXPORT_LIMITS.maxReportBytes); expect(capabilities.limits.maxBatchBytes).toBe(REPORT_EXPORT_LIMITS.maxImportBatchBytes);
    const explanation = capabilities.knownDifferences.join(' '); expect(explanation).toContain('results.xlsx'); expect(explanation).toContain('changes.xlsx'); expect(explanation).toContain('ce-report-1');
    safe(response.body, [headers['x-ce-session'], app.ce.files.directory]);
  });
  it('does not trust forwarded Host/Origin headers or token-shaped query strings in production', async () => {
    const { app, headers } = await setup();
    for (const extra of [{ host: 'evil.invalid', 'x-forwarded-host': headers.host, 'x-forwarded-proto': 'http' }, { origin: 'http://127.0.0.1:4200' }, { origin: 'null' }]) {
      const response = await app.inject({ url: '/api/v1/bootstrap', headers: { ...headers, ...extra } }); expect(response.statusCode).toBe(403); safe(response.body, [headers['x-ce-session']]);
    }
    const queryToken = await app.inject({ url: '/api/v1/capabilities?sessionToken=' + encodeURIComponent(headers['x-ce-session']), headers: { host: headers.host } }); expect(queryToken.statusCode).toBe(403); safe(queryToken.body, [headers['x-ce-session']]);
    const malformed = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: { ...headers, 'content-type': 'application/json' }, payload: '{"name":' + headers['x-ce-session'] }); expect(malformed.statusCode).toBe(400); safe(malformed.body, [headers['x-ce-session']]);
  });
  it('starts a new ephemeral session after app restart and refuses old token, workspace and download identities', async () => {
    const first = await setup(), created = await first.app.inject({ method: 'POST', url: '/api/v1/workspaces', headers: first.headers, payload: { name: 'Old session' } }), workspaceId = created.json().id;
    const file = await first.app.ce.files.write(workspaceId, Buffer.from('ephemeral')), oldDirectory = first.app.ce.files.directory;
    await first.app.close(); apps.splice(apps.indexOf(first.app), 1); await expect(access(oldDirectory)).rejects.toThrow();
    const second = await setup(); expect(second.headers['x-ce-session'] === first.headers['x-ce-session']).toBe(false); expect(second.app.ce.files.directory === oldDirectory).toBe(false);
    const bootstrap = await second.app.inject({ url: '/api/v1/bootstrap', headers: second.headers }); expect(bootstrap.json().activeWorkspaceId).toBeUndefined();
    const oldToken = await second.app.inject({ url: '/api/v1/capabilities', headers: first.headers }); expect(oldToken.statusCode).toBe(403);
    for (const url of [`/api/v1/workspaces/${workspaceId}`, `/api/v1/workspaces/${workspaceId}/exports/${file.id}`]) { const response = await second.app.inject({ url, headers: second.headers }); expect(response.statusCode).toBe(404); safe(response.body, [oldDirectory, file.path, first.headers['x-ce-session']]); }
  });
  it('suppresses unexpected error details and real worker stdout/stderr without leaking synthetic canaries into HTTP or parent logs', async () => {
    await mkdir('.cache', { recursive: true }); const directory = await mkdtemp(path.resolve('.cache/local-surface-')); roots.push(directory);
    const secret = 'SYNTHETIC_SECRET_' + randomUUID(), privatePath = 'C:\\private\\' + randomUUID() + '\\report.xlsx', modulePath = path.join(directory, 'failing-worker.mjs');
    await writeFile(modulePath, `export async function execute(input) { console.log(input.secret, input.privatePath); console.error(input.secret, input.privatePath); throw new Error(input.secret+' '+input.privatePath); }`);
    const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { validate: pathToFileURL(modulePath) } }); apps.push(app);
    registerJobRoute(app, { path: '/workspaces/:workspaceId/error-probe', kind: 'validate', bodySchema: { type: 'object', additionalProperties: false }, prepare: () => ({ input: { secret, privatePath } }) });
    app.get('/api/v1/error-probe', async () => { throw new Error(secret + ' ' + privatePath); });
    const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' }; headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
    const created = await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Error visibility' } }), workspaceId = created.json().id;
    const writes: string[] = []; const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true; }), stderr = vi.spyOn(process.stderr, 'write').mockImplementation(chunk => { writes.push(String(chunk)); return true; });
    let bodies: string[] = [];
    try {
      const unexpected = await app.inject({ url: '/api/v1/error-probe', headers }); expect(unexpected.statusCode).toBe(500); expect(unexpected.json().error.code).toBe('INTERNAL_ERROR');
      const accepted = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspaceId}/error-probe`, headers: { ...headers, 'if-match': '"empty"', 'idempotency-key': randomUUID() }, payload: {} }); expect(accepted.statusCode).toBe(202);
      const deadline = Date.now() + 5000; let status;
      do { status = await app.inject({ url: `/api/v1/workspaces/${workspaceId}/jobs/${accepted.json().jobId}`, headers }); if (status.json().status === 'failed') break; if (Date.now() > deadline) throw new Error('Worker fixture did not fail'); await new Promise(resolve => setTimeout(resolve, 10)); } while (true);
      expect(status.json().diagnostics.map((d: { code: string }) => d.code)).toEqual(['INTERNAL_ERROR']); await app.ce.jobs.settle(accepted.json().jobId);
      bodies = [unexpected.body, accepted.body, status.body];
    } finally { stdout.mockRestore(); stderr.mockRestore(); }
    for (const body of [...bodies, writes.join('')]) safe(body, [secret, privatePath, headers['x-ce-session'], app.ce.files.directory]);
    expect(app.ce.store.get(workspaceId).state).toBe('empty'); expect(app.ce.store.listRecords('operation:')).toEqual([]);
  });
});
