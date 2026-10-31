import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { afterEach, describe, expect, it } from 'vitest';
import { runValidation, simulate } from '@ce/engine';
import type { JobDTO, JsonValue } from '@ce/contracts';
import { createApp } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import { previewKey } from '../../apps/api/src/recalculation/preview-store.js';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
const apps: Awaited<ReturnType<typeof createApp>>[] = [], directories: string[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); for (const directory of directories.splice(0)) { if (!path.relative(path.resolve('.cache'), directory).startsWith('comparison-')) throw new Error('Unsafe fixture cleanup'); await rm(directory, { recursive: true, force: true }); } });
const rules = [
  ['SYNTHETIC_A', 'with {interval:false}: {tC_01.00,r0230,c0010}={tC_01.00,r0250,c0010}+{tC_01.00,r0260,c0010}'],
  ['SYNTHETIC_D', 'with {interval:false}: {tC_01.00,r0270,c0010}={tC_01.00,r0230,c0010}*2'],
  ['SYNTHETIC_STILL_FAIL', '{tC_01.00,r0250,c0010}<0'], ['SYNTHETIC_ARITHMETIC', '1/0=1'], ['SYNTHETIC_WARNING', '{tC_01.00,r0230,c0010}=12'],
] as const;
async function setup() {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { apply: new URL('../../apps/api/dist/workers/apply.worker.js', import.meta.url), export: new URL('../../apps/api/dist/workers/export.worker.js', import.meta.url) } }); apps.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' }; headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Comparison SYNTHETIC' } })).json();
  const directory = await mkdtemp(path.resolve('.cache/comparison-')); directories.push(directory);
  const source = (await readXlsxFile(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), { parseNumber: text => text, trim: false }))[0]!;
  const original = source.data.map(row => row.map(value => value === null ? null : String(value))), severityColumn = original[0]!.indexOf('Severity'); if (severityColumn < 0) throw new Error('Fixture requires Severity');
  const rows = [original[0]!, ...rules.map(([code, expression]) => { const row = [...original[2]!]; row[0] = code; row[1] = 'SYNTHETIC_TEST'; row[6] = expression; row[7] = ''; row[severityColumn] = code === 'SYNTHETIC_WARNING' ? 'Warning' : 'Error'; return row; })];
  const catalog = path.join(directory, 'comparison-rules.xlsx'); await writeXlsxFile(rows.map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: source.sheet }).toFile(catalog);
  const sheets = (await readXlsxFile(path.resolve('tests/fixtures/generated/report-42.xlsx'), { parseNumber: text => text, trim: false })).map(sheet => ({ sheet: sheet.sheet, data: sheet.data.map(row => row.map(value => value === null ? null : String(value))) }));
  const facts = sheets.find(sheet => sheet.sheet === 'Facts')!.data;
  for (const [rowCode, value] of Object.entries({ '0230': '11', '0250': '5', '0260': '7', '0270': '22' })) { const row = facts.find(row => row[1] === 'C_01.00' && row[3] === rowCode); if (row) { row[5] = 'value'; row[6] = value; } else facts.push(['demo', 'C_01.00', '', rowCode, '0010', 'value', value]); }
  const report = path.join(directory, 'comparison-data.xlsx'); await writeXlsxFile(sheets.map(sheet => ({ ...sheet, data: sheet.data.map(row => row.map(value => value === null ? null : { type: String, value })) }))).toFile(report);
  const files = await Promise.all([[catalog, 'catalog'], [report, 'report']].map(async ([location, kind]) => { const bytes = await readFile(location!); return { path: location!, id: randomUUID(), kind: kind as 'catalog' | 'report', displayName: path.basename(location!), size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: '2026-10-31T00:00:00.000Z' }; }));
  const content = await importWorkspace(files, { cancelled: () => false, progress: () => {} } as unknown as OperationContext), originalSnapshot = app.ce.store.publish(workspace.id, undefined, content);
  const initial = runValidation(originalSnapshot, { runId: randomUUID(), startedAt: new Date().toISOString() }); expect(initial.run.status).toBe('completed');
  app.ce.store.putRecords([{ key: validationKey(workspace.id, initial.run.id), value: initial as unknown as JsonValue }]);
  const choices = initial.results.filter(result => ['SYNTHETIC_A', 'SYNTHETIC_D'].includes(result.code)).map(result => ({ instanceId: result.instanceId!, targetSide: 'left' }));
  const configured = await app.inject({ method: 'PUT', url: `/api/v1/workspaces/${workspace.id}/directions`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id) }, payload: { directions: choices } }); expect(configured.statusCode).toBe(200);
  const base = app.ce.store.current(workspace.id)!, bundle = simulate(base, { previewId: randomUUID() }); expect(bundle.proposals.every(proposal => proposal.state === 'available')).toBe(true);
  app.ce.store.putRecords([{ key: previewKey(workspace.id, bundle.preview.id), value: bundle as unknown as JsonValue }]);
  const select = async (selectedIds: readonly string[]) => (await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/previews/${bundle.preview.id}/selection`, headers, payload: { selectedIds } })).json();
  const all = await select(bundle.proposals.map(proposal => proposal.id)), body = { baseVersionId: base.versionId, previewId: bundle.preview.id, selectedIds: all.selectedIds, closureHash: all.closureHash }, etag = app.ce.store.etag(workspace.id);
  const apply = (payload = body, key = randomUUID()) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/applications`, headers: { ...headers, 'if-match': etag, 'idempotency-key': key }, payload });
  const poll = async (jobId: string) => { const deadline = Date.now() + 10_000; while (Date.now() < deadline) { const response = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers }); const job = response.json<JobDTO>(); if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('Application did not finish'); };
  const detail = (id: string) => app.inject({ url: `/api/v1/workspaces/${workspace.id}/applications/${id}`, headers });
  const comparison = (id: string, query = '') => app.inject({ url: `/api/v1/workspaces/${workspace.id}/applications/${id}/comparison${query}`, headers });
  return { app, headers, directory, workspace, base, originalSnapshot, initial, bundle, body, apply, select, poll, detail, comparison };
}
describe('complete revalidation and functional application comparison', () => {
  it('uses a real failing chain fixture with an initially valid consumer and unrelated fail/error results', async () => {
    const { base, initial, bundle } = await setup(); expect(initial.results.find(row => row.code === 'SYNTHETIC_A')!.status).toBe('fail'); expect(initial.results.find(row => row.code === 'SYNTHETIC_D')!.status).toBe('pass');
    expect(initial.results.find(row => row.code === 'SYNTHETIC_STILL_FAIL')!.status).toBe('fail'); expect(initial.results.find(row => row.code === 'SYNTHETIC_ARITHMETIC')!.status).toBe('error');
    expect(bundle.proposals.map(row => row.after!.originalText)).toEqual(['12.00', '24.00']); expect(base.content.facts.find(fact => fact.rowCode === '0230')!.originalText).toBe('11');
  });
  it('revalidates both versions and retains remaining fail/error results without treating application as a global approval', async () => {
    const { app, workspace, base, originalSnapshot, bundle, body, apply, poll, detail, comparison } = await setup();
    const accepted = await apply(); expect(accepted.statusCode).toBe(202); const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded'); expect(job.resultRef?.type).toBe('application');
    const response = await detail(job.resultRef!.id); expect(response.statusCode).toBe(200); const result = response.json(); expect(result.changeCount).toBe(2); expect(result.receipt.acceptedIds).toEqual(body.selectedIds); expect(result.receipt.baseVersionId).toBe(base.versionId); expect(result.receipt.newVersionId).toBe(job.newVersionId);
    expect(result.receipt.beforeValidationRunId).toBeTypeOf('string'); expect(result.receipt.validationRunId).toBeTypeOf('string'); expect(result.receipt.beforeValidationRunId).not.toBe(result.receipt.validationRunId);
    const page = (await comparison(job.resultRef!.id, '?limit=200')).json(); expect(page.total).toBe(5); expect(page.receipt).toEqual(result.receipt);
    const find = (code: string) => page.items.find((row: { after: { code: string } }) => row.after.code === code);
    expect(find('SYNTHETIC_A')).toMatchObject({ before: { status: 'fail' }, after: { status: 'pass' } });
    expect(find('SYNTHETIC_WARNING')).toMatchObject({ before: { status: 'fail', severity: 'warning' }, after: { status: 'pass', severity: 'warning' } });
    expect(find('SYNTHETIC_STILL_FAIL')).toMatchObject({ before: { status: 'fail' }, after: { status: 'fail' } }); expect(find('SYNTHETIC_ARITHMETIC')).toMatchObject({ before: { status: 'error' }, after: { status: 'error' } });
    expect(page.afterSummary.complete).toBe(true); expect(page.afterSummary.byStatus).toMatchObject({ pass: 3, fail: 1, error: 1 });
    for (const row of page.items) { expect(row.before.versionId).toBe(base.versionId); expect(row.after.versionId).toBe(job.newVersionId); expect(row.before.instanceId).toBe(row.after.instanceId); }
    const current = app.ce.store.current(workspace.id)!; expect(current.content.facts.find(fact => fact.rowCode === '0230')!.originalText).toBe('12.00'); expect(current.content.facts.find(fact => fact.rowCode === '0270')!.originalText).toBe('24.00');
    expect(app.ce.store.snapshot(workspace.id, base.versionId)).toBe(base); expect(app.ce.store.snapshot(workspace.id, originalSnapshot.versionId)).toBe(originalSnapshot); expect(bundle.preview.state).toBe('ready');
  });
  it('allows an explicitly accepted closed subset while explaining a previously passing consumer that now fails', async () => {
    const { app, workspace, base, bundle, body, select, apply, poll, comparison } = await setup(); const producer = bundle.proposals.find(row => row.code === 'SYNTHETIC_A')!;
    const selected = await select([producer.id]); expect(selected.complete).toBe(true); const accepted = await apply({ ...body, selectedIds: selected.selectedIds, closureHash: selected.closureHash }); expect(accepted.statusCode).toBe(202);
    const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded'); const page = (await comparison(job.resultRef!.id)).json();
    expect(page.receipt.acceptedIds).toEqual([producer.id]); expect(page.items.find((row: { after: { code: string } }) => row.after.code === 'SYNTHETIC_D')).toMatchObject({ before: { status: 'pass' }, after: { status: 'fail' } });
    expect(app.ce.store.current(workspace.id)!.content.facts.find(fact => fact.rowCode === '0270')!.originalText).toBe('22'); expect(base.content.facts.find(fact => fact.rowCode === '0230')!.originalText).toBe('11');
  });
  it('exports the actual complete post-application results including remaining failures and calculated fact provenance', async () => {
    const { app, headers, directory, workspace, apply, poll, detail } = await setup(); const accepted = await apply(); expect(accepted.statusCode).toBe(202);
    const application = await poll(accepted.json().jobId); expect(application.status).toBe('succeeded'); const receipt = (await detail(application.resultRef!.id)).json().receipt, current = app.ce.store.current(workspace.id)!;
    const exportResponse = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/exports`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { kind: 'results', versionId: receipt.newVersionId, runId: receipt.validationRunId } }); expect(exportResponse.statusCode).toBe(202);
    const exported = await poll(exportResponse.json().jobId); expect(exported.status).toBe('succeeded'); const download = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/exports/${exported.resultRef!.id}`, headers }); expect(download.statusCode).toBe(200); expect(download.headers['content-disposition']).toBe('attachment; filename="results.zip"');
    const location = path.join(directory, 'post-application-results.zip'); await writeFile(location, download.rawPayload); const entries = await readZipParts(location), json = JSON.parse(entries.find(entry => entry.name === 'results.json')!.data.toString('utf8'));
    expect(json.run.id).toBe(receipt.validationRunId); expect(json.versionId).toBe(receipt.newVersionId); expect(json.run.summary.byStatus).toMatchObject({ pass: 3, fail: 1, error: 1 });
    expect(json.results.find((row: { code: string }) => row.code === 'SYNTHETIC_A').factReads.some((read: { derivation?: { receiptId: string } }) => read.derivation?.receiptId === receipt.id)).toBe(true);
    expect(app.ce.store.current(workspace.id)).toBe(current);
  });
  it('recovers the same receipt after an ignored response and paginates historical comparisons without another mutation', async () => {
    const { app, workspace, base, body, apply, poll, detail, comparison } = await setup(); const key = randomUUID();
    const first = await apply(body, key); expect(first.statusCode).toBe(202); const job = await poll(first.json().jobId); expect(job.status).toBe('succeeded'); const current = app.ce.store.current(workspace.id)!;
    const replay = await apply(body, key); expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(job.jobId); expect(replay.json().resultRef).toEqual(job.resultRef); expect(app.ce.store.get(workspace.id).versionIds.filter(id => id === job.newVersionId)).toHaveLength(1);
    const receipt = (await detail(job.resultRef!.id)).json().receipt, firstPage = (await comparison(receipt.id, '?limit=1')).json(); expect(firstPage.nextCursor).toBeTypeOf('string'); const cursor = encodeURIComponent(firstPage.nextCursor);
    const second = (await comparison(receipt.id, '?limit=1&cursor=' + cursor)).json(); expect(second.items[0].key).not.toBe(firstPage.items[0].key); const bytes = app.ce.store.bytes;
    expect((await detail(receipt.id)).json().receipt).toEqual(receipt); expect((await comparison(receipt.id, '?limit=1&cursor=' + cursor)).json()).toEqual(second); expect(app.ce.store.bytes).toBe(bytes); expect(app.ce.store.current(workspace.id)).toBe(current); expect(receipt.baseVersionId).toBe(base.versionId);
  });
  it('preserves applied receipt links and discarded history while obsoleting unselected proposals and other ready previews', async () => {
    const { app, workspace, base, bundle, body, select, apply, poll, detail } = await setup();
    const other = simulate(base, { previewId: randomUUID() }), discarded = simulate(base, { previewId: randomUUID() });
    app.ce.store.putRecords([{ key: previewKey(workspace.id, other.preview.id), value: other as unknown as JsonValue },
      { key: previewKey(workspace.id, discarded.preview.id), value: { ...discarded, preview: { ...discarded.preview, state: 'discarded' }, proposals: discarded.proposals.map(proposal => ({ ...proposal, state: 'discarded' })) } as unknown as JsonValue }]);
    const producer = bundle.proposals.find(proposal => proposal.code === 'SYNTHETIC_A')!, selected = await select([producer.id]);
    const response = await apply({ ...body, selectedIds: selected.selectedIds, closureHash: selected.closureHash }); expect(response.statusCode).toBe(202); const job = await poll(response.json().jobId); expect(job.status).toBe('succeeded');
    const record = () => app.ce.store.getRecord<typeof bundle>(previewKey(workspace.id, bundle.preview.id))!;
    expect(record().preview.state).toBe('applied'); expect(record().preview.appliedReceiptId).toBe(job.resultRef!.id);
    expect(record().proposals.find(proposal => proposal.id === producer.id)!.state).toBe('applied'); expect(record().proposals.find(proposal => proposal.id !== producer.id)!.state).toBe('obsolete');
    expect(app.ce.store.getRecord<typeof bundle>(previewKey(workspace.id, other.preview.id))!.preview.state).toBe('obsolete');
    expect(app.ce.store.getRecord<typeof bundle>(previewKey(workspace.id, discarded.preview.id))!.preview.state).toBe('discarded');
    const current = app.ce.store.current(workspace.id)!; app.ce.store.publish(workspace.id, current.versionId, { ...current.content, configVersion: 'later-history-test' });
    expect(record().preview.state).toBe('applied'); expect(record().preview.appliedReceiptId).toBe(job.resultRef!.id); expect((await detail(record().preview.appliedReceiptId!)).statusCode).toBe(200);
    expect(app.ce.store.getRecord<typeof bundle>(previewKey(workspace.id, discarded.preview.id))!.preview.state).toBe('discarded');
  });
});
