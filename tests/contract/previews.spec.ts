import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { afterEach, describe, expect, it } from 'vitest';
import { runValidation, WorkBudget } from '@ce/engine';
import type { JsonValue, PreviewBundle, Snapshot } from '@ce/contracts';
import { selectPreview } from '../../apps/api/src/recalculation/preview-store.js';
import { createApp } from '../../apps/api/src/app.js';
import type { AppOptions } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { controlledFactory, nextTurn } from '../helpers/foundation.js';

const applications: Awaited<ReturnType<typeof createApp>>[] = [], directories: string[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map((app) => app.close()));
  for (const directory of directories.splice(0)) {
    if (!path.relative(path.resolve('.cache'), directory).startsWith('preview-contract-')) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
const expressions = [
  ['synthetic_A', '{tC_01.00,r0230,c0010}=1', ''],
  ['synthetic_D', '{tC_05.01,r0090,c0060}={tC_01.00,r0230,c0010}+1', ''],
  ['synthetic_condition', '{tC_01.00,r0250,c0010}=3', '{tC_01.00,r0230,c0010}=1'],
  ['synthetic_implicit', '{tC_01.00,r0270,c0010}=4', ''],
  ['synthetic_right', '2={tC_01.00,r0260,c0010}', ''],
  ['synthetic_boolean', '{tC_01.00,r0290,c0010}=true', ''],
  ['synthetic_no_target', '1=2', ''],
  ['synthetic_unsupported', 'abs(1)=1', ''],
  ['synthetic_bad_type', '{tC_01.00,r0290,c0010}=1', ''],
  ['synthetic_self_rhs', '{tC_01.00,r0230,c0010}={tC_01.00,r0230,c0010}+1', ''],
  ['synthetic_self_guard', '{tC_01.00,r0250,c0010}=3', '{tC_01.00,r0250,c0010}=0'],
  ['synthetic_indicator_target', '{v_C_01.00}=true', ''],
] as const;
async function setup(options: AppOptions = {}, validated = true) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
    workerModules: { preview: new URL('../../apps/api/dist/workers/preview.worker.js', import.meta.url) }, ...options }); applications.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'Preview SYNTHETIC' } })).json();
  const directory = await mkdtemp(path.resolve('.cache/preview-contract-')); directories.push(directory);
  const source = (await readXlsxFile(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), { parseNumber: (text) => text, trim: false }))[0]!;
  const original = source.data.map((row) => row.map((value) => value === null ? null : String(value)));
  const rows = [original[0]!, ...expressions.map(([code, expression, precondition]) => {
    const row = [...original[2]!]; row[0] = code; row[1] = 'SYNTHETIC_TEST'; row[6] = expression; row[7] = precondition; return row;
  })];
  const catalog = path.join(directory, 'synthetic-directions.xlsx');
  await writeXlsxFile(rows.map((row) => row.map((value) => value === null ? null : { type: String, value })), { sheet: source.sheet }).toFile(catalog);
  const reportSheets = (await readXlsxFile(path.resolve('tests/fixtures/generated/report-42.xlsx'), { parseNumber: (text) => text, trim: false }))
    .map((sheet) => ({ sheet: sheet.sheet, data: sheet.data.map((row) => row.map((value) => value === null ? null : String(value))) }));
  reportSheets.find((sheet) => sheet.sheet === 'Coordinates')!.data.push(['demo', 'C_01.00', '', '0290', '0010', 'boolean', '', '', '{}']);
  reportSheets.find((sheet) => sheet.sheet === 'Facts')!.data.push(['demo', 'C_01.00', '', '0290', '0010', 'value', 'false']);
  const report = path.join(directory, 'synthetic-report.xlsx');
  await writeXlsxFile(reportSheets.map((sheet) => ({ ...sheet, data: sheet.data.map((row) => row.map((value) => value === null ? null : { type: String, value })) }))).toFile(report);
  const files = await Promise.all([[catalog, 'catalog'], [report, 'report']].map(async ([location, kind]) => {
    const bytes = await readFile(location!); return { path: location!, id: randomUUID(), kind: kind as 'catalog' | 'report', displayName: path.basename(location!),
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: '2026-10-31T00:00:00.000Z' };
  }));
  const content = await importWorkspace(files, { cancelled: () => false, progress: () => {} } as unknown as OperationContext);
  const snapshot = app.ce.store.publish(workspace.id, undefined, content);
  const recordRun = (base: Snapshot = app.ce.store.current(workspace.id)!) => {
    const bundle = runValidation(base, { runId: randomUUID(), startedAt: '2026-10-31T00:00:00.000Z' });
    app.ce.store.putRecords([{ key: validationKey(workspace.id, bundle.run.id), value: bundle as unknown as JsonValue }]); return bundle;
  };
  const bundle = validated ? recordRun() : undefined;
  const instance = (code: string) => { const result = bundle?.results.find((row) => row.code === code); if (!result?.instanceId) throw new Error(`Fixture has no structural instance: ${code}`); return result.instanceId; };
  const configure = (directions: unknown[], match: string | null = app.ce.store.etag(workspace.id)) => app.inject({ method: 'PUT', url: `/api/v1/workspaces/${workspace.id}/directions`,
    headers: { ...headers, ...(match === null ? {} : { 'if-match': match }) }, payload: { directions } });
  const start = (body: unknown = { baseVersionId: app.ce.store.current(workspace.id)!.versionId }, key = randomUUID(), match: string | null = app.ce.store.etag(workspace.id)) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/previews`,
    headers: { ...headers, 'idempotency-key': key, ...(match === null ? {} : { 'if-match': match }) }, payload: body });
  const poll = async (jobId: string) => {
    for (let i = 0; i < 400; i++) { const job = (await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers })).json();
      if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) return job; await new Promise((resolve) => setTimeout(resolve, 10)); }
    throw new Error('Preview worker did not finish');
  };
  const detail = (id: string) => app.inject({ url: `/api/v1/workspaces/${workspace.id}/previews/${id}`, headers });
  const proposals = (id: string, query = '') => app.inject({ url: `/api/v1/workspaces/${workspace.id}/previews/${id}/proposals${query}`, headers });
  const select = (id: string, selectedIds: string[], extension: object = {}) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/previews/${id}/selection`, headers, payload: { selectedIds, ...extension } });
  const preview = async () => { const accepted = await start(); expect(accepted.statusCode).toBe(202); const job = await poll(accepted.json().jobId); expect(job.status).toBe('succeeded'); expect(job.resultRef.type).toBe('preview'); return job.resultRef.id as string; };
  return { app, headers, workspace, snapshot, bundle, recordRun, instance, configure, start, poll, detail, proposals, select, preview };
}

describe('explicit directions and read-only previews', () => {
  it('requires current ETag and authentication, with closed bodies that cannot upload expression, AST or executable code', async () => {
    const { app, headers, workspace, snapshot, instance, configure } = await setup(); const choice = { instanceId: instance('synthetic_A'), targetSide: 'left' };
    expect((await configure([choice], null)).statusCode).toBe(428); expect((await configure([choice], '"old"')).statusCode).toBe(412);
    const anonymous = await app.inject({ method: 'PUT', url: `/api/v1/workspaces/${workspace.id}/directions`, headers: { host: headers.host, 'if-match': app.ce.store.etag(workspace.id) }, payload: { directions: [choice] } });
    expect(anonymous.statusCode).toBe(403);
    for (const extension of [{ expression: '1=1' }, { ast: { kind: 'number', lexeme: '1' } }, { code: 'process.exit(1)' }, { targetKey: 'forged' }]) expect((await configure([{ ...choice, ...extension }])).statusCode).toBe(400);
    expect((await configure([{ ...choice, targetSide: 'both' }])).statusCode).toBe(400); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
  });
  it('rejects absent destinations, unknown instances and duplicate direction choices atomically', async () => {
    const { app, workspace, snapshot, instance, configure } = await setup();
    for (const choices of [
      [{ instanceId: 'f'.repeat(64), targetSide: 'left' }], [{ instanceId: instance('synthetic_no_target'), targetSide: 'left' }],
      [{ instanceId: instance('synthetic_A'), targetSide: 'right' }],
      [{ instanceId: instance('synthetic_A'), targetSide: 'left' }, { instanceId: instance('synthetic_A'), targetSide: 'left' }],
    ]) { const response = await configure(choices); expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('INVALID_DIRECTION'); }
    expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.get(workspace.id).versionIds).toEqual([snapshot.versionId]);
  });
  it('requires a complete validation of the current snapshot, not a run from an older data/configuration version', async () => {
    const unvalidated = await setup({}, false);
    expect((await unvalidated.configure([{ instanceId: 'a'.repeat(64), targetSide: 'left' }])).statusCode).toBe(422);
    await unvalidated.app.close(); applications.splice(applications.indexOf(unvalidated.app), 1);
    const { app, workspace, snapshot, instance, configure } = await setup(); app.ce.store.publish(workspace.id, snapshot.versionId, { ...snapshot.content, configVersion: 'different' });
    const response = await configure([{ instanceId: instance('synthetic_A'), targetSide: 'left' }]); expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('INVALID_DIRECTION');
  });
  it('replaces the complete configuration, preserves facts and keeps structural instances with false preconditions eligible', async () => {
    const { app, workspace, snapshot, bundle, instance, configure, recordRun } = await setup();
    expect(bundle!.results.find((row) => row.code === 'synthetic_condition')!.status).toBe('not_applicable');
    const choices = ['synthetic_A', 'synthetic_condition', 'synthetic_implicit', 'synthetic_boolean'].map((code) => ({ instanceId: instance(code), targetSide: 'left' }));
    choices.push({ instanceId: instance('synthetic_right'), targetSide: 'right' });
    const response = await configure(choices); expect(response.statusCode).toBe(200);
    const configured = app.ce.store.current(workspace.id)!; expect(configured.versionId).not.toBe(snapshot.versionId); expect(response.headers.etag).toBe(app.ce.store.etag(workspace.id));
    expect(response.json().versionId).toBe(configured.versionId); expect(configured.parentVersionId).toBe(snapshot.versionId); expect(configured.content.configVersion).not.toBe(snapshot.content.configVersion);
    expect(configured.content.facts).toEqual(snapshot.content.facts); expect(configured.content.coordinates).toEqual(snapshot.content.coordinates); expect(configured.content.directions).toHaveLength(5);
    expect(configured.content.directions.map((direction) => direction.instanceId).sort()).toEqual(choices.map((choice) => choice.instanceId).sort());
    expect(configured.content.directions.every((direction) => typeof direction.targetKey === 'string' && typeof direction.id === 'string')).toBe(true);
    expect(response.body).not.toMatch(/"ast"|ce-session-|"stack"/i);
    const again = recordRun(); expect(again.results.find((row) => row.code === 'synthetic_A')!.instanceId).toBe(instance('synthetic_A'));
    expect((await configure([])).statusCode).toBe(200); expect(app.ce.store.current(workspace.id)!.content.directions).toEqual([]); expect(app.ce.store.current(workspace.id)!.content.facts).toEqual(snapshot.content.facts);
  });
  it('requires If-Match/base version for a preview and rejects caller-supplied formulas or proposals', async () => {
    const { app, workspace, snapshot, start } = await setup();
    expect((await start(undefined, randomUUID(), null)).statusCode).toBe(428); expect((await start({ baseVersionId: randomUUID() })).statusCode).toBe(412);
    expect((await start({ baseVersionId: snapshot.versionId, expression: '1=1' })).statusCode).toBe(400);
    expect((await start({ baseVersionId: snapshot.versionId, proposals: [{ after: '1000000' }] })).statusCode).toBe(400);
    expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.get(workspace.id).activeJobId).toBeUndefined();
  });
  it('rejects reading the destination in RHS but preserves a precondition self read for conservative graph analysis', async () => {
    const { app, workspace, snapshot, instance, configure } = await setup();
    const self = await configure([{ instanceId: instance('synthetic_self_rhs'), targetSide: 'left' }]); expect(self.statusCode).toBe(422); expect(self.json().error.code).toBe('INVALID_DIRECTION');
    expect((await configure([{ instanceId: instance('synthetic_indicator_target'), targetSide: 'left' }])).statusCode).toBe(422);
    expect(app.ce.store.current(workspace.id)).toBe(snapshot);
    expect((await configure([{ instanceId: instance('synthetic_self_guard'), targetSide: 'left' }])).statusCode).toBe(200); expect(app.ce.store.current(workspace.id)!.content.directions).toHaveLength(1);
  });
  it('explains eligible sides through the same resolver even when a false precondition skipped the body', async () => {
    const { app, headers, workspace, snapshot, bundle } = await setup(); const beforeBytes = app.ce.store.bytes;
    const response = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/runs/${bundle!.run.id}/results?limit=200`, headers }); expect(response.statusCode).toBe(200);
    const rows = response.json().items; const conditional = rows.find((row: { code: string }) => row.code === 'synthetic_condition');
    expect(conditional.status).toBe('not_applicable'); expect(conditional.values).toEqual({}); expect(conditional.recalculation.left).toMatchObject({ eligible: true, target: { rowCode: '0250' }, diagnostics: [] });
    expect(conditional.recalculation.right.eligible).toBe(false); expect(conditional.recalculation.right.diagnostics.length).toBeGreaterThan(0);
    expect(rows.find((row: { code: string }) => row.code === 'synthetic_self_rhs').recalculation.left.eligible).toBe(false);
    expect(rows.find((row: { code: string }) => row.code === 'synthetic_unsupported').recalculation.left.eligible).toBe(false);
    expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.bytes).toBe(beforeBytes);
  });
  it('returns the full configuration for the run snapshot independently of filters, pagination and newer versions', async () => {
    const { app, headers, workspace, bundle, instance, configure, recordRun } = await setup();
    const choices = ['synthetic_A', 'synthetic_D'].map(code => ({ instanceId: instance(code), targetSide: 'left' })); expect((await configure(choices)).statusCode).toBe(200);
    const configured = recordRun();
    const fetch = (run: string, query = '') => app.inject({ url: `/api/v1/workspaces/${workspace.id}/runs/${run}/results${query}`, headers });
    const first = (await fetch(configured.run.id, '?limit=1&code=synthetic_A')).json(); expect(first.items).toHaveLength(1);
    expect(first.configuredDirections).toHaveLength(2); expect(first.configuredDirections).toEqual(expect.arrayContaining(choices));
    expect(first.configuredDirections.every((choice: object) => Object.keys(choice).sort().join(',') === 'instanceId,targetSide')).toBe(true);
    const compact = await fetch(configured.run.id, '?limit=1&code=synthetic_A&includeConfiguredDirections=false');
    expect(compact.statusCode).toBe(200);
    expect(compact.json()).not.toHaveProperty('configuredDirections');
    expect(compact.json().items).toEqual(first.items);
    expect(app.ce.store.current(workspace.id)!.content.directionDecisionState).toMatchObject({ mode: 'reviewed', source: 'replace' });
    expect((await fetch(bundle!.run.id)).json().configuredDirections).toEqual([]);
    expect((await configure([])).statusCode).toBe(200); const newer = recordRun();
    expect((await fetch(configured.run.id, '?limit=1')).json().configuredDirections).toEqual(first.configuredDirections);
    expect((await fetch(newer.run.id)).json().configuredDirections).toEqual([]);
    expect(app.ce.store.current(workspace.id)!.content.directionDecisionState).toMatchObject({ mode: 'reviewed', unselectedDefault: 'omitted' });
  });
  it.each([false, true])('versions configuration and invalidates only ready previews atomically (quota rejection=%s)', async (limited) => {
    const { app, workspace, snapshot, bundle, instance, configure } = await setup(limited ? { store: new WorkspaceStore({ maxSnapshots: 1 }) } : {});
    const result = bundle!.results.find((row) => row.code === 'synthetic_A')!, coordinate = snapshot.content.coordinates[0]!;
    const records = ['ready', 'applied', 'discarded'].map((state) => {
      const id = randomUUID(), proposalId = randomUUID();
      return { key: `preview:${workspace.id}:${id}`, value: { preview: { id, baseVersionId: snapshot.versionId, profileId: snapshot.content.profileId, policyId: 'half-even-v1', createdAt: '2026-10-31T10:00:00.000Z', state, proposalIds: [proposalId], graphSummary: { nodes: 1, edges: 0, blocked: 0, order: [], cycles: [], conflicts: [] }, diagnostics: [] },
        proposals: [{ id: proposalId, previewId: id, directionId: 'a'.repeat(64), instanceId: result.instanceId!, variantIds: result.variantIds, binding: result.binding!, code: result.code, targetKey: coordinate.factKey,
          before: { factKey: coordinate.factKey, coordinate, presence: 'implicit_null', sourceLocator: coordinate.sourceLocator }, after: { normalizedValue: { numerator: '1', denominator: '1' }, originalText: '1.00', decimals: '2', unit: 'EUR' },
          readKeys: [], predecessorIds: [], metadataReads: [], sources: [], state: state === 'ready' ? 'available' : state, diagnostics: [] }] } as unknown as JsonValue };
    });
    app.ce.store.putRecords(records); const bytes = app.ce.store.bytes;
    const response = await configure([{ instanceId: instance('synthetic_A'), targetSide: 'left' }]); expect(response.statusCode).toBe(limited ? 413 : 200);
    for (const [index, record] of records.entries()) {
      const saved = app.ce.store.getRecord<{ preview: { state: string }; proposals: { state: string }[] }>(record.key)!;
      const expected = index === 0 ? limited ? 'ready' : 'obsolete' : index === 1 ? 'applied' : 'discarded'; expect(saved.preview.state).toBe(expected);
      expect(saved.proposals[0]!.state).toBe(expected === 'ready' ? 'available' : expected);
    }
    if (limited) { expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.bytes).toBe(bytes); }
    else expect(app.ce.store.current(workspace.id)!.content.facts).toEqual(snapshot.content.facts);
  });
  it('simulates a dependency chain without publishing facts; selection reports missing ancestors and never accepts them automatically', async () => {
    const { app, workspace, snapshot, instance, configure, preview, detail, proposals, select } = await setup();
    expect((await configure(['synthetic_A', 'synthetic_D'].map((code) => ({ instanceId: instance(code), targetSide: 'left' })))).statusCode).toBe(200);
    const base = app.ce.store.current(workspace.id)!; const id = await preview(); const summary = (await detail(id)).json(); expect(summary.state).toBe('ready'); expect(summary.baseVersionId).toBe(base.versionId);
    const page = (await proposals(id)).json(); expect(page.versionId).toBe(base.versionId); expect(page.total).toBe(2); expect(page.items.every((proposal: { state: string }) => proposal.state === 'available')).toBe(true);
    const first = page.items.find((proposal: { after: { normalizedValue: { numerator: string; denominator: string } } }) => proposal.after.normalizedValue.numerator === '1' && proposal.after.normalizedValue.denominator === '1');
    const consumer = page.items.find((proposal: { id: string }) => proposal.id !== first.id); expect(consumer.after.normalizedValue).toEqual({ numerator: '2', denominator: '1' }); expect(consumer.predecessorIds).toContain(first.id);
    const partial = await select(id, [consumer.id]); expect(partial.statusCode).toBe(200); expect(partial.json()).toMatchObject({ selectedIds: [consumer.id], requiredIds: [first.id], complete: false });
    const complete = (await select(id, [consumer.id, first.id])).json(); expect(complete.complete).toBe(true); expect(complete.requiredIds).toEqual([]); expect(complete.selectedIds.slice().sort()).toEqual([consumer.id, first.id].sort()); expect(complete.closureHash).toMatch(/^[0-9a-f]{64}$/);
    expect((await select(id, [first.id, consumer.id])).json().closureHash).toBe(complete.closureHash);
    expect(app.ce.store.current(workspace.id)).toBe(base); expect(base.content.facts).toEqual(snapshot.content.facts);
    expect((await proposals(id)).json().items.every((proposal: { state: string }) => proposal.state === 'available')).toBe(true); expect((await detail(id)).json().state).toBe('ready');
  });
  it('paginates a fixed preview and rejects a cursor from another filter/resource without changing data', async () => {
    const { app, workspace, instance, configure, preview, proposals } = await setup(); expect((await configure(['synthetic_A', 'synthetic_D'].map((code) => ({ instanceId: instance(code), targetSide: 'left' })))).statusCode).toBe(200);
    const base = app.ce.store.current(workspace.id)!, id = await preview(); const first = (await proposals(id, '?limit=1')).json(); expect(first.items).toHaveLength(1); expect(first.nextCursor).toBeTypeOf('string');
    const cursor = encodeURIComponent(first.nextCursor); const second = (await proposals(id, '?limit=1&cursor=' + cursor)).json(); expect(second.items[0].id).not.toBe(first.items[0].id);
    expect((await proposals(id, '?limit=1&status=blocked&cursor=' + cursor)).statusCode).toBe(400); expect((await proposals(id, '?limit=201')).statusCode).toBe(400);
    const other = await preview(); expect((await proposals(other, '?limit=1&cursor=' + cursor)).statusCode).toBe(400); expect(app.ce.store.current(workspace.id)).toBe(base);
  });
  it('reports stale preview state after configuration changes while retaining its historical proposals and selection base', async () => {
    const { app, workspace, instance, configure, recordRun, preview, detail, proposals, select } = await setup(); expect((await configure([{ instanceId: instance('synthetic_A'), targetSide: 'left' }])).statusCode).toBe(200);
    const id = await preview(), page = (await proposals(id)).json(); recordRun(); expect((await configure([])).statusCode).toBe(200); const current = app.ce.store.current(workspace.id)!;
    expect((await detail(id)).json().state).toBe('obsolete'); const selection = await select(id, [page.items[0].id]); expect(selection.statusCode).toBe(200); expect(selection.json().state).toBe('obsolete');
    expect((await proposals(id)).json().versionId).toBe(page.versionId); expect(app.ce.store.current(workspace.id)).toBe(current);
  });
  it('rejects unknown selections and body extensions instead of accepting or applying them', async () => {
    const { app, workspace, instance, configure, preview, proposals, select } = await setup(); expect((await configure([{ instanceId: instance('synthetic_A'), targetSide: 'left' }])).statusCode).toBe(200);
    const id = await preview(), base = app.ce.store.current(workspace.id)!; const available = (await proposals(id)).json().items[0];
    expect((await select(id, [randomUUID()])).statusCode).toBe(400); expect((await select(id, [available.id], { accept: true })).statusCode).toBe(400);
    expect((await select(id, [])).json()).toMatchObject({ selectedIds: [], requiredIds: [], complete: true }); expect(app.ce.store.current(workspace.id)).toBe(base);
  });
  it('keeps a preview ready with blocked proposals, and refuses selecting a blocked direction', async () => {
    const { app, workspace, instance, configure, preview, detail, proposals, select } = await setup();
    expect((await configure([{ instanceId: instance('synthetic_condition'), targetSide: 'left' }])).statusCode).toBe(200);
    const base = app.ce.store.current(workspace.id)!, id = await preview(); expect((await detail(id)).json().state).toBe('ready');
    const proposal = (await proposals(id)).json().items[0]; expect(proposal.state).toBe('blocked'); expect(proposal.diagnostics.length).toBeGreaterThan(0);
    const selected = await select(id, [proposal.id]); expect(selected.statusCode).toBe(409); expect(selected.json().error.code).toBe('PREVIEW_NOT_APPLICABLE');
    expect(app.ce.store.current(workspace.id)).toBe(base);
  });
  it('offers a known boolean target without numeric quantization fields and keeps selection read-only', async () => {
    const { app, workspace, instance, configure, preview, proposals, select } = await setup();
    expect((await configure([{ instanceId: instance('synthetic_boolean'), targetSide: 'left' }])).statusCode).toBe(200);
    const base = app.ce.store.current(workspace.id)!, id = await preview(), proposal = (await proposals(id)).json().items[0];
    expect(proposal.state).toBe('available'); expect(proposal.before.normalizedValue).toBe(false); expect(proposal.after.normalizedValue).toBe(true);
    expect(proposal.after.originalText).toBe('true'); expect(proposal.exactNominal).toBeUndefined(); expect(proposal.derivedInterval).toBeUndefined(); expect(proposal.after.decimals).toBeUndefined();
    expect((await select(id, [proposal.id])).json()).toMatchObject({ selectedIds: [proposal.id], requiredIds: [], complete: true }); expect(app.ce.store.current(workspace.id)).toBe(base);
  });
  it('replays the same preview Job after a newer snapshot exists, but rejects changed bodies for that key', async () => {
    const { app, workspace, instance, configure, recordRun, start, poll } = await setup(); expect((await configure([{ instanceId: instance('synthetic_A'), targetSide: 'left' }])).statusCode).toBe(200);
    const base = app.ce.store.current(workspace.id)!, etag = app.ce.store.etag(workspace.id), key = randomUUID(), body = { baseVersionId: base.versionId };
    const first = await start(body, key, etag); expect(first.statusCode).toBe(202); const job = await poll(first.json().jobId); expect(job.status).toBe('succeeded'); recordRun(); expect((await configure([])).statusCode).toBe(200);
    const replay = await start(body, key, etag); expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(job.jobId); expect(replay.json().resultRef).toEqual(job.resultRef);
    expect((await start({ baseVersionId: app.ce.store.current(workspace.id)!.versionId }, key, etag)).statusCode).toBe(409);
  });
  it('cancels an active preview without publishing proposals or changing its base facts', async () => {
    const control = controlledFactory(); const { app, headers, workspace, instance, configure, start } = await setup({ workerFactory: control.factory });
    expect((await configure([{ instanceId: instance('synthetic_A'), targetSide: 'left' }])).statusCode).toBe(200); const base = app.ce.store.current(workspace.id)!;
    const accepted = await start(); expect(accepted.statusCode).toBe(202); await nextTurn(); expect((await configure([])).statusCode).toBe(409);
    const response = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${accepted.json().jobId}`, headers });
    expect(response.json().status).toBe('cancelled'); expect(response.json().resultRef).toBeUndefined(); expect(control.workers[0]!.terminated).toBe(true); expect(app.ce.store.current(workspace.id)).toBe(base);
  });
  it('fails a real worker quota without publishing a partial ready preview or changing the snapshot', async () => {
    const { app, workspace, instance, configure, start, poll } = await setup({ previewLimits: { instances: 0 } });
    expect((await configure([{ instanceId: instance('synthetic_A'), targetSide: 'left' }])).statusCode).toBe(200);
    const base = app.ce.store.current(workspace.id)!, accepted = await start(); expect(accepted.statusCode).toBe(202);
    const job = await poll(accepted.json().jobId); expect(job.status).toBe('failed'); expect(job.resultRef).toBeUndefined();
    expect(job.diagnostics[0].code).toBe('RESOURCE_LIMIT'); expect(app.ce.store.listRecords('preview:')).toEqual([]); expect(app.ce.store.current(workspace.id)).toBe(base);
  });
  it('computes deep transitive closure iteratively with one bounded budget and does not select ancestors', async () => {
    const count = 20_000, ids = Array.from({ length: count }, () => randomUUID());
    // This service-only graph fixture isolates depth; HTTP/engine-built proposal content is exercised above.
    const bundle = { preview: { id: randomUUID(), baseVersionId: randomUUID(), profileId: 'profile', policyId: 'policy', state: 'ready' },
      proposals: ids.map((id, index) => ({ id, state: 'available', predecessorIds: index ? [ids[index - 1]] : [] })) } as unknown as PreviewBundle;
    const result = selectPreview(bundle, [ids.at(-1)!]); expect(result.selectedIds).toEqual([ids.at(-1)]); expect(result.requiredIds).toHaveLength(count - 1); expect(result.complete).toBe(false);
    expect(() => selectPreview(bundle, [ids.at(-1)!], new WorkBudget({ limits: { edges: 10 } }))).toThrow('EXPANSION_LIMIT');
    expect(bundle.proposals.every(proposal => proposal.state === 'available')).toBe(true);
  });
});
