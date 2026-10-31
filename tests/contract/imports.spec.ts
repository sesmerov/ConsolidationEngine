import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';

const fixtureRoot = path.resolve('tests/fixtures/generated');
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
interface Part { field: string; name: string; bytes: Buffer }
function multipart(parts: Part[], boundary = 'ce-' + randomUUID()) {
  const pieces: Buffer[] = [];
  for (const part of parts) pieces.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.field}"; filename="${part.name}"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`), part.bytes, Buffer.from('\r\n'));
  pieces.push(Buffer.from(`--${boundary}--\r\n`));
  return { bytes: Buffer.concat(pieces), contentType: 'multipart/form-data; boundary=' + boundary };
}
async function changeCatalog(bytes: Buffer, edit: (rows: (string | null)[][]) => void): Promise<Buffer> {
  const sheet = (await readXlsxFile(bytes, { parseNumber: (text) => text, trim: false }))[0]!;
  const rows = sheet.data.map((row) => row.map((value) => value === null ? null : String(value)));
  edit(rows);
  return writeXlsxFile(rows.map((row) => row.map((value) => value === null ? null : { type: String, value })), { sheet: sheet.sheet }).toBuffer();
}
async function setup(uploadLimits: Record<string, number> = {}) {
  const app = await createApp({ mode: 'development', uploadLimits,
    workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
    workerModules: { import: new URL('../../apps/api/dist/workers/import.worker.js', import.meta.url) },
  }); apps.push(app);
  const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:4200', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Importación sintética' } })).json();
  const files: Part[] = [{ field: 'catalog', name: 'catalog.xlsx', bytes: await readFile(path.join(fixtureRoot, 'eba-subset.xlsx')) },
    { field: 'reports', name: 'report.xlsx', bytes: await readFile(path.join(fixtureRoot, 'report-42.xlsx')) }];
  const send = async (parts = files, key = randomUUID(), etag = '"empty"', boundary?: string) => {
    const body = multipart(parts, boundary);
    return app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/imports`, headers: { ...headers, 'content-type': body.contentType, 'idempotency-key': key, 'if-match': etag }, payload: body.bytes });
  };
  const poll = async (jobId: string) => {
    for (let i = 0; i < 400; i++) {
      const response = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers }); const job = response.json();
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('Import job did not finish.');
  };
  return { app, headers, workspace, files, send, poll };
}

describe('XLSX import HTTP contract with a real worker', () => {
  it('downloads an XLSX template and exposes honest profile capabilities and fixed limits', async () => {
    const { app, headers } = await setup();
    const template = await app.inject({ url: '/api/v1/templates/report', headers });
    expect(template.statusCode).toBe(200); expect(template.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(template.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(template.headers['content-disposition']).toContain('ce-report-1.xlsx');
    const capabilities = await app.inject({ url: '/api/v1/capabilities', headers });
    expect(capabilities.statusCode).toBe(200); expect(capabilities.json().profileId).toBe('ce-dpmxl-0.9-closed-v1');
    expect(capabilities.json().knownDifferences.length).toBeGreaterThan(0);
    expect(capabilities.json().limits.receiveTimeoutMs).toBe(120000);
    expect(app.initialConfig.requestTimeout).toBe(120000);
  });
  it('imports atomically as a job and returns paginated source rows anchored to a version', async () => {
    const { app, headers, workspace, send, poll } = await setup();
    const accepted = await send(); expect(accepted.statusCode).toBe(202);
    expect(accepted.json().kind).toBe('import');
    const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded');
    const current = await app.inject({ url: `/api/v1/workspaces/${workspace.id}`, headers });
    expect(current.json().contexts[0].entityId).toBe('SYNTHETIC'); expect(current.json().counts.facts).toBe(5);
    expect(current.json().counts.coordinates).toBe(6); expect(current.headers.etag).toBe('"v-' + job.newVersionId + '"');
    const page = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/rules?versionId=${job.newVersionId}&limit=1`, headers });
    expect(page.statusCode).toBe(200); expect(page.json().total).toBe(3); expect(page.json().items).toHaveLength(1);
    expect(page.json().versionId).toBe(job.newVersionId); expect(page.json().nextCursor).toBeTypeOf('string');
    const next = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/rules?versionId=${job.newVersionId}&limit=1&cursor=${encodeURIComponent(page.json().nextCursor)}`, headers });
    expect(next.statusCode).toBe(200); expect(next.json().items[0].id).not.toBe(page.json().items[0].id);
    const wrongFilter = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/rules?versionId=${job.newVersionId}&limit=1&code=v0190_m&cursor=${encodeURIComponent(page.json().nextCursor)}`, headers });
    expect(wrongFilter.statusCode).toBe(400); expect(wrongFilter.json().error.code).toBe('INVALID_CURSOR');
    expect(JSON.stringify(page.json())).not.toContain('AST'); expect(JSON.stringify(page.json())).not.toContain('ce-session-');
  });
  it('replays bytes and canonical metadata despite a new boundary and cleans redundant staging', async () => {
    const { app, headers, workspace, files, send, poll } = await setup(); const key = randomUUID();
    const first = await send(files, key, '"empty"', 'first-boundary'); expect(first.statusCode).toBe(202);
    expect((await poll(first.json().jobId)).status).toBe('succeeded');
    const before = (await readdir(app.ce.files.workspacePath(workspace.id))).sort();
    const replay = await send(files, key, '"empty"', 'different-boundary');
    expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(first.json().jobId);
    expect((await readdir(app.ce.files.workspacePath(workspace.id))).sort()).toEqual(before);
    const conflict = await send([{ ...files[0]!, name: 'changed-name.xlsx' }, files[1]!], key, '"empty"');
    expect(conflict.statusCode).toBe(409); expect(conflict.json().error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await readdir(app.ce.files.workspacePath(workspace.id))).sort()).toEqual(before);
    const current = await app.inject({ url: `/api/v1/workspaces/${workspace.id}`, headers }); expect(current.json().versionIds).toHaveLength(1);
  });
  it('keeps a rule with a lexical error visible alongside the three imported source rows', async () => {
    const { app, headers, workspace, files, send, poll } = await setup();
    const invalidCatalog = await changeCatalog(files[0]!.bytes, (rows) => {
      const added = [...rows[2]!]; added[0] = 'synthetic_invalid'; added[1] = 'SYNTHETIC_TEST'; added[6] = '1 = 1 @'; rows.push(added);
    });
    const accepted = await send([{ ...files[0]!, bytes: invalidCatalog }, files[1]!]); expect(accepted.statusCode).toBe(202);
    const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded');
    const records = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/rules?versionId=${job.newVersionId}`, headers });
    expect(records.json().total).toBe(4);
    const invalid = records.json().items.find((item: { code: string }) => item.code === 'synthetic_invalid');
    expect(invalid.diagnostics.some((item: { code: string }) => item.code === 'SYNTAX_ERROR')).toBe(true);
    expect(invalid.sourceLocator.fileId).toMatch(/^[0-9a-f-]{36}$/); expect(invalid.sourceLocator.row).toBe(5);
  });
  it('rejects extensions and file counts before starting a worker, with bounded staged bytes', async () => {
    const { app, workspace, files, send } = await setup({ maxFileBytes: 512 });
    const wrongType = await send([{ ...files[0]!, name: 'catalog.xlsm' }, files[1]!]); expect(wrongType.statusCode).toBe(415);
    const tooLarge = await send(); expect(tooLarge.statusCode).toBe(413);
    expect((await readdir(app.ce.files.workspacePath(workspace.id)))).toEqual([]);
  });
  it('rejects duplicate catalog and unexpected fields without publishing', async () => {
    const { app, workspace, files, send } = await setup();
    const duplicate = await send([files[0]!, files[0]!, files[1]!]); expect(duplicate.statusCode).toBe(400);
    const unknown = await send([{ ...files[0]!, field: 'script' }, files[1]!]); expect(unknown.statusCode).toBe(400);
    const tooMany = await send([files[0]!, ...Array.from({ length: 21 }, () => files[1]!)]); expect(tooMany.statusCode).toBe(413);
    expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]);
  });
  it('reports structural workbook errors on the accepted job and keeps the prior snapshot', async () => {
    const { app, headers, workspace, files, send, poll } = await setup();
    const good = await send(); expect(good.statusCode).toBe(202); const first = await poll(good.json().jobId); expect(first.status).toBe('succeeded');
    const invalid = await send([files[0]!, { ...files[1]!, bytes: Buffer.from('PK\x03\x04invalid workbook') }], randomUUID(), '"v-' + first.newVersionId + '"');
    expect(invalid.statusCode).toBe(202); const failed = await poll(invalid.json().jobId);
    expect(failed.status).toBe('failed'); expect(failed.diagnostics[0].code).toBe('INVALID_WORKBOOK');
    const current = await app.inject({ url: `/api/v1/workspaces/${workspace.id}`, headers }); expect(current.json().currentVersionId).toBe(first.newVersionId);
    expect(JSON.stringify(failed)).not.toContain('ce-session-'); expect(JSON.stringify(failed)).not.toContain('stack');
    const badHeaders = await changeCatalog(files[0]!.bytes, (rows) => { rows[0]![7] = 'Precondition'; });
    const rejected = await send([{ ...files[0]!, bytes: badHeaders }, files[1]!], randomUUID(), '"v-' + first.newVersionId + '"');
    expect(rejected.statusCode).toBe(202); expect((await poll(rejected.json().jobId)).diagnostics[0].code).toBe('INVALID_WORKBOOK');
  });
  it('limits stalled multipart reception and cleans the partial upload', async () => {
    const { app, headers, workspace } = await setup({ receiveTimeoutMs: 15 }); const boundary = 'slow-boundary';
    const payload = Readable.from((async function* () {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="catalog"; filename="catalog.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\nPK\x03\x04`);
      await new Promise((resolve) => setTimeout(resolve, 60)); yield Buffer.from(`\r\n--${boundary}--\r\n`);
    })());
    const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/imports`, headers: { ...headers, 'if-match': '"empty"', 'idempotency-key': randomUUID(), 'content-type': 'multipart/form-data; boundary=' + boundary }, payload });
    expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('UPLOAD_LIMIT');
    expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]);
  });
  it('bounds simultaneous reception and closes a workspace while its upload is still active', async () => {
    const { app, headers, workspace, send, files } = await setup(); const boundary = 'closing-boundary';
    let finish!: () => void; const paused = new Promise<void>((resolve) => { finish = resolve; });
    const payload = Readable.from((async function* () {
      yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="catalog"; filename="catalog.xlsx"\r\n\r\nPK\x03\x04`);
      await paused; yield Buffer.from(`\r\n--${boundary}--\r\n`);
    })());
    const pending = app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/imports`, headers: { ...headers, 'if-match': '"empty"', 'idempotency-key': randomUUID(), 'content-type': 'multipart/form-data; boundary=' + boundary }, payload }).then((response) => response);
    const directory = app.ce.files.workspacePath(workspace.id);
    try {
      for (let i = 0; i < 100 && !(await readdir(directory)).length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
      expect((await readdir(directory)).length).toBe(1);
      const extra = await send(); expect(extra.statusCode).toBe(409); expect(extra.json().error.code).toBe('WORKSPACE_BUSY');
      const closed = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}`, headers: { ...headers, 'if-match': '"empty"' } });
      expect(closed.statusCode).toBe(204); expect((await pending).statusCode).toBe(404);
      await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await send()).statusCode).toBe(404);
      expect(await readFile(path.join(fixtureRoot, 'eba-subset.xlsx'))).toEqual(files[0]!.bytes);
    } finally { finish(); await pending; }
  });
  it('aborts reception during server close before removing its owned directory', async () => {
    const { app, headers, workspace } = await setup(); const boundary = 'server-close';
    let finish!: () => void; const paused = new Promise<void>((resolve) => { finish = resolve; });
    const payload = Readable.from((async function* () { yield Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="catalog"; filename="catalog.xlsx"\r\n\r\nPK\x03\x04`); await paused; })());
    const pending = app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/imports`, headers: { ...headers, 'if-match': '"empty"', 'idempotency-key': randomUUID(), 'content-type': 'multipart/form-data; boundary=' + boundary }, payload }).then((response) => response);
    const directory = app.ce.files.workspacePath(workspace.id);
    try {
      for (let i = 0; i < 100 && !(await readdir(directory)).length; i++) await new Promise((resolve) => setTimeout(resolve, 2));
      await app.close(); expect((await pending).statusCode).toBe(404); await expect(readdir(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { finish(); await pending; }
  });
  it('cleans files after cancellation and returns the actual published state if publication already won', async () => {
    const { app, headers, workspace, send } = await setup(); const accepted = await send(); expect(accepted.statusCode).toBe(202);
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${accepted.json().jobId}`, headers });
    expect(['cancelled', 'succeeded']).toContain(cancelled.json().status);
    await app.ce.jobs.settle(accepted.json().jobId);
    expect(await readdir(app.ce.files.workspacePath(workspace.id))).toEqual([]);
    const current = (await app.inject({ url: `/api/v1/workspaces/${workspace.id}`, headers })).json();
    expect(current.versionIds.length).toBe(cancelled.json().status === 'succeeded' ? 1 : 0);
  });
});
