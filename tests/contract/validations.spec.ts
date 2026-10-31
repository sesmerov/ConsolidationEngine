import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import type { JobManagerOptions } from '../../apps/api/src/jobs/job-manager.js';
import { controlledFactory, nextTurn } from '../helpers/foundation.js';
import type { JsonValue, ValidationBundle } from '@ce/contracts';

const applications: Awaited<ReturnType<typeof createApp>>[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) { if (!path.relative(path.resolve('.cache'), directory).startsWith('validation-contract-')) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); }
});
async function setup(options: JobManagerOptions = {}, mixed = false) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
    workerModules: { validate: new URL('../../apps/api/dist/workers/validate.worker.js', import.meta.url) }, ...options }); applications.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Validación SYNTHETIC' } })).json();
  let catalog = path.resolve('tests/fixtures/generated/eba-subset.xlsx');
  if (mixed) {
    const directory = await mkdtemp(path.resolve('.cache/validation-contract-')); directories.push(directory);
    const sheet = (await readXlsxFile(catalog, { parseNumber: (value) => value, trim: false }))[0]!;
    const rows = sheet.data.map((row) => row.map((value) => value === null ? null : String(value)));
    for (const [code, expression, precondition] of [
      ['synthetic_fail', '1=2', ''], ['synthetic_division', '1/0=1', ''], ['synthetic_syntax', '1=1 @', ''],
      ['synthetic_unsupported', 'abs(1)=1', ''], ['synthetic_precondition_false', '1/0=1', 'false'],
      ['synthetic_null', '{tC_01.00,r0260,c0010}=1', ''], ['synthetic_unknown', 'true', '{v_MISSING}'],
    ]) { const row = [...rows[2]!]; row[0] = code!; row[6] = expression!; row[7] = precondition!; row[12] = 'Error'; rows.push(row); }
    rows.push([...rows[2]!]); catalog = path.join(directory, 'mixed.xlsx');
    await writeXlsxFile(rows.map((row) => row.map((value) => value === null ? null : { type: String, value })), { sheet: sheet.sheet }).toFile(catalog);
  }
  const staged = async (location: string, kind: 'catalog' | 'report') => { const bytes = await readFile(location); return { id: randomUUID(), path: location, displayName: path.basename(location), kind, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: '2026-10-31T00:00:00.000Z' }; };
  const content = await importWorkspace([await staged(catalog, 'catalog'), await staged(path.resolve('tests/fixtures/generated/report-42.xlsx'), 'report')], { cancelled: () => false, progress: () => {} } as unknown as OperationContext);
  const snapshot = app.ce.store.publish(workspace.id, undefined, content); const etag = app.ce.store.etag(workspace.id);
  const validate = (body: unknown = { baseVersionId: snapshot.versionId }, key = randomUUID(), match: string | undefined = etag) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/validations`,
    headers: { ...headers, 'idempotency-key': key, ...(match === undefined ? {} : { 'if-match': match }) }, payload: body });
  const poll = async (jobId: string) => {
    for (let i = 0; i < 500; i++) { const job = (await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers })).json();
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); }
    throw new Error('Validation worker did not finish');
  };
  const results = (runId: string, query = '') => app.inject({ url: `/api/v1/workspaces/${workspace.id}/runs/${runId}/results${query}`, headers });
  return { app, headers, workspace, snapshot, etag, validate, poll, results };
}

describe('validation jobs and versioned result contract', () => {
  it('keeps business failure/error separate from job completion, and reconciles every imported row', async () => {
    const { app, workspace, snapshot, validate, poll, results } = await setup({}, true);
    const accepted = await validate(); expect(accepted.statusCode).toBe(202); expect(accepted.json().kind).toBe('validate');
    const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded'); expect(job.resultRef.type).toBe('validation'); expect(job.newVersionId).toBeUndefined();
    const response = await results(job.resultRef.id, '?limit=200'); expect(response.statusCode).toBe(200);
    const page = response.json(); expect(page.versionId).toBe(snapshot.versionId); expect(page.run.status).toBe('completed'); expect(page.run.summary.complete).toBe(true);
    expect(page.run.summary.rows).toBe(11); expect(page.run.summary.duplicateRows).toBe(1);
    expect(Object.values(page.run.summary.byStatus).reduce((sum: number, value) => sum + Number(value), 0)).toBe(page.total);
    const find = (code: string) => page.items.find((row: { code: string }) => row.code === code);
    expect(find('synthetic_fail').status).toBe('fail'); expect(find('synthetic_division').status).toBe('error'); expect(find('synthetic_division').diagnostics).toContainEqual(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
    expect(find('synthetic_syntax').status).toBe('error'); expect(find('synthetic_unsupported').status).toBe('not_evaluable');
    expect(find('synthetic_precondition_false').status).toBe('not_applicable');
    expect(find('synthetic_precondition_false').diagnostics).not.toContainEqual(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
    expect(find('synthetic_null').status).toBe('not_evaluable'); expect(find('synthetic_null').values.left.presence).toBe('explicit_null');
    expect(find('synthetic_unknown').status).toBe('not_evaluable'); expect(find('synthetic_unknown').diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_FILING_INDICATOR' }));
    const valid = page.items.filter((row: { code: string; status: string }) => row.code === 'v0190_m' && row.status === 'pass'); expect(valid).toHaveLength(1);
    expect(valid[0].severity).toBe('warning'); expect(valid[0].values.left.nominal).toEqual({ numerator: '10', denominator: '1' });
    expect(valid[0].values.left.interval).toEqual({ lo: { numerator: '1999', denominator: '200' }, hi: { numerator: '2001', denominator: '200' } });
    expect(valid[0].expression).toContain('interval: true'); expect(valid[0].precondition).toContain('{v_C_01.00}');
    expect(valid[0].metadataReads).toContainEqual(expect.objectContaining({ code: 'C_01.00', presence: 'declared', value: true }));
    expect(valid[0].sources).toContainEqual(expect.objectContaining({ sheet: 'Facts', row: 2, column: 'G' }));
    expect(response.body).not.toMatch(/"ast"|ce-session-|"stack"/i); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
  });
  it('authenticates and validates closed bodies before accepting jobs; requires matching version', async () => {
    const { app, workspace, headers, snapshot, etag, validate } = await setup();
    const anonymous = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/validations`, headers: { host: headers.host, 'if-match': etag, 'idempotency-key': randomUUID() }, payload: { baseVersionId: snapshot.versionId } });
    expect(anonymous.statusCode).toBe(403);
    expect((await validate({ baseVersionId: snapshot.versionId, schema: { type: 'object' } })).statusCode).toBe(400);
    expect((await validate({ baseVersionId: randomUUID() })).statusCode).toBe(412);
    const absent = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/validations`, headers: { ...headers, 'idempotency-key': randomUUID() }, payload: { baseVersionId: snapshot.versionId } });
    expect(absent.statusCode).toBe(428); expect(app.ce.store.get(workspace.id).activeJobId).toBeUndefined();
  });
  it('paginates stable results, filters status/code/table and keeps historical runs after a new snapshot', async () => {
    const { app, workspace, snapshot, validate, poll, results } = await setup({}, true);
    const accepted = await validate(); expect(accepted.statusCode).toBe(202); const job = await poll(accepted.json().jobId);
    const runId = job.resultRef.id; const first = (await results(runId, '?limit=1')).json(); expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTypeOf('string');
    const cursor = encodeURIComponent(first.nextCursor); const second = (await results(runId, '?limit=1&cursor=' + cursor)).json(); expect(second.items[0].id).not.toBe(first.items[0].id);
    expect((await results(runId, '?limit=1&status=fail&cursor=' + cursor)).statusCode).toBe(400);
    expect((await results(runId, '?limit=201')).statusCode).toBe(400);
    const failures = (await results(runId, '?status=fail&code=synthetic_fail')).json(); expect(failures.total).toBe(1); expect(failures.items[0].status).toBe('fail');
    const table = (await results(runId, '?status=pass&table=C_05.01')).json(); expect(table.items.map((row: { code: string }) => row.code)).toEqual(['v0190_m']);
    app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'new-configuration' });
    const historical = (await results(runId, '?limit=1&cursor=' + cursor)).json(); expect(historical.versionId).toBe(snapshot.versionId); expect(historical.items).toEqual(second.items);
  });
  it('replays an accepted validation with an old ETag and never creates another run', async () => {
    const { app, workspace, snapshot, etag, validate, poll } = await setup(); const key = randomUUID();
    const accepted = await validate(undefined, key); expect(accepted.statusCode).toBe(202); const job = await poll(accepted.json().jobId);
    app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'new-configuration' });
    const replay = await validate({ baseVersionId: snapshot.versionId }, key, etag); expect(replay.statusCode).toBe(202); expect(replay.json().resultRef).toEqual(job.resultRef); expect(replay.json().jobId).toBe(job.jobId);
    expect((await validate({ baseVersionId: app.ce.store.current(workspace.id)!.versionId }, key, etag)).statusCode).toBe(409);
  });
  it('marks a cancelled run incomplete and keeps its reference without fabricated partial results', async () => {
    const control = controlledFactory(); const { app, headers, workspace, snapshot, validate, results } = await setup({ workerFactory: control.factory });
    const accepted = await validate(); expect(accepted.statusCode).toBe(202); expect(accepted.json().resultRef.type).toBe('validation'); await nextTurn();
    const busy = await validate(); expect(busy.statusCode).toBe(409);
    const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${accepted.json().jobId}`, headers });
    expect(cancelled.json().status).toBe('cancelled'); expect(control.workers[0]!.terminated).toBe(true);
    const page = (await results(accepted.json().resultRef.id)).json(); expect(page.run.status).toBe('incomplete'); expect(page.run.summary.complete).toBe(false); expect(page.items).toEqual([]);
    expect(app.ce.store.current(workspace.id)).toBe(snapshot);
  });
  it('accepts a simultaneous identical request only once while asynchronous acceptance yields', async () => {
    const control = controlledFactory(); const { validate } = await setup({ workerFactory: control.factory }); const key = randomUUID();
    const [first, second] = await Promise.all([validate(undefined, key), validate(undefined, key)]);
    expect(first.statusCode).toBe(202); expect(second.statusCode).toBe(202); expect(second.json().jobId).toBe(first.json().jobId); expect(second.json().resultRef).toEqual(first.json().resultRef);
    await nextTurn(); expect(control.workers).toHaveLength(1);
  });
  it('paginates tied coverage rows semantically rather than by generated result IDs', async () => {
    const { app, workspace, validate, poll, results } = await setup(); const accepted = await validate(), job = await poll(accepted.json().jobId);
    const original = app.ce.store.getRecord<ValidationBundle>(`validation:${workspace.id}:${job.resultRef.id}`)!;
    const { instanceId: _instance, binding: _binding, ...row } = original.results[0]!;
    const ids = [randomUUID(), randomUUID()];
    for (const [index, id] of ids.entries()) {
      // Explicit projection fixtures force opposite opaque-ID order while semantic context identity stays fixed.
      const rows = ['context-A', 'context-B'].map((contextId, position) => ({ ...row, runId: id, contextId, coverageOnly: true, id: index === position ? 'z' : 'a' }));
      app.ce.store.putRecords([{ key: `validation:${workspace.id}:${id}`, value: { run: { ...original.run, id, resultIds: rows.map(row => row.id) }, results: rows } as unknown as JsonValue }]);
      const first = (await results(id, '?limit=1')).json(); expect(first.items[0].contextId).toBe('context-A');
      const second = (await results(id, '?limit=1&cursor=' + encodeURIComponent(first.nextCursor))).json(); expect(second.items[0].contextId).toBe('context-B'); expect(second.nextCursor).toBeNull();
    }
  });
});
