import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveDirection, runValidation, simulate } from '@ce/engine';
import type { JsonValue, PreviewBundle, Snapshot } from '@ce/contracts';
import { createApp, type AppOptions } from '../../apps/api/src/app.js';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { controlledFactory, nextTurn } from '../helpers/foundation.js';

const applications: Awaited<ReturnType<typeof createApp>>[] = [], directories: string[] = [];
const date = '2026-10-31T00:00:00.000Z';
const uuid = (n: number) => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const previewKey = (workspaceId: string, previewId: string) => `preview:${workspaceId}:${previewId}`;
afterEach(async () => {
  await Promise.all(applications.splice(0).map(app => app.close()));
  for (const directory of directories.splice(0)) {
    const relative = path.relative(path.resolve('.cache'), path.resolve(directory));
    if (!relative.startsWith('preview-history-') || relative.includes(path.sep)) throw new Error('Unsafe fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

/** Real XLSX import and real engine results; the history routes themselves are exercised through HTTP. */
async function setup(options: AppOptions = {}) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), ...options }); applications.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = (await app.inject({ method: 'POST', url: '/api/v1/workspaces', headers, payload: { name: 'History SYNTHETIC' } })).json();
  const directory = await mkdtemp(path.resolve('.cache/preview-history-')); directories.push(directory);
  const source = (await readXlsxFile(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), { parseNumber: text => text, trim: false }))[0]!;
  const original = source.data.map(row => row.map(value => value === null ? null : String(value)));
  const rules = [
    ['synthetic_available', '{tC_01.00,r0230,c0010}=1'],
    ['synthetic_blocked', '{tC_01.00,r0250,c0010}=1/0'],
  ];
  const rows = [original[0]!, ...rules.map(([code, expression]) => {
    const row = [...original[2]!]; row[0] = code!; row[1] = 'SYNTHETIC_HISTORY'; row[6] = expression!; row[7] = ''; return row;
  })];
  const catalog = path.join(directory, 'synthetic-history.xlsx');
  await writeXlsxFile(rows.map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: source.sheet }).toFile(catalog);
  const files = await Promise.all([[catalog, 'catalog'], [path.resolve('tests/fixtures/generated/report-42.xlsx'), 'report']].map(async ([location, kind]) => {
    const bytes = await readFile(location!); return { path: location!, id: randomUUID(), kind: kind as 'catalog' | 'report', displayName: path.basename(location!),
      size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), importedAt: date };
  }));
  const imported = await importWorkspace(files, { cancelled: () => false, progress: () => {} } as unknown as OperationContext);
  const initial = app.ce.store.publish(workspace.id, undefined, imported);
  const structural = runValidation(initial, { runId: randomUUID(), startedAt: date, now: () => Date.parse(date) });
  const directions = rules.map(([code]) => {
    const result = structural.results.find(row => row.code === code)!;
    if (!result.instanceId || !result.binding) throw new Error('Missing real fixture instance');
    const resolution = resolveDirection(initial, { instanceId: result.instanceId, variantIds: result.variantIds, binding: result.binding, targetSide: 'left' });
    if (!resolution.resolved) throw new Error(JSON.stringify(resolution.diagnostics)); return resolution.resolved.direction;
  });
  const snapshot = app.ce.store.publish(workspace.id, initial.versionId, { ...initial.content, configVersion: 'history-fixture', directions });
  const storePreview = (bundle: PreviewBundle) => app.ce.store.putRecords([{ key: previewKey(workspace.id, bundle.preview.id), value: bundle as unknown as JsonValue }]);
  const addPreview = (id = randomUUID(), createdAt = date) => {
    const bundle = simulate(snapshot, { previewId: id, now: () => Date.parse(createdAt) }); storePreview(bundle); return bundle;
  };
  const addRun = (id = randomUUID(), startedAt = date, incomplete = false, base: Snapshot = snapshot) => {
    const bundle = runValidation(base, { runId: id, startedAt, now: () => Date.parse(startedAt), ...(incomplete ? { limits: { instances: 0 } } : {}) });
    app.ce.store.putRecords([{ key: validationKey(workspace.id, id), value: bundle as unknown as JsonValue }]); return bundle;
  };
  const list = (resource: 'runs' | 'previews', query = '') => app.inject({ url: `/api/v1/workspaces/${workspace.id}/${resource}${query}`, headers });
  const discard = (id: string, match: string | null = app.ce.store.etag(workspace.id), payload?: object) => app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/previews/${id}`,
    headers: { ...headers, ...(match === null ? {} : { 'if-match': match }) }, ...(payload ? { payload } : {}) });
  const stored = (id: string) => app.ce.store.getRecord<PreviewBundle>(previewKey(workspace.id, id))!;
  return { app, headers, workspace, initial, snapshot, addPreview, storePreview, addRun, list, discard, stored };
}

describe('minimal, versioned histories', () => {
  it.each(['runs', 'previews'] as const)('paginates %s by date then descending id and returns only summary fields', async resource => {
    const fixture = await setup(); const { app, workspace, snapshot, list, addRun, addPreview } = fixture;
    const add = resource === 'runs' ? addRun : addPreview;
    add(uuid(21), date); add(uuid(22), '2026-10-31T00:00:01.000Z'); add(uuid(23), '2026-10-31T00:00:01.000Z');
    // A record outside this workspace must not affect its total or summaries.
    app.ce.store.putRecords([{ key: `${resource === 'runs' ? 'validation' : 'preview'}:${uuid(99)}:${uuid(24)}`,
      value: (resource === 'runs' ? app.ce.store.getRecord(validationKey(workspace.id, uuid(21))) : fixture.stored(uuid(21))) as JsonValue }]);
    const bytes = app.ce.store.bytes, firstResponse = await list(resource, '?limit=1'); expect(firstResponse.statusCode).toBe(200);
    const first = firstResponse.json(); expect(Object.keys(first).sort()).toEqual(['items', 'nextCursor', 'revision', 'total']);
    expect(first.total).toBe(3); expect(first.items.map((item: { id: string }) => item.id)).toEqual([uuid(23)]); expect(first.revision).toBeTypeOf('string');
    expect(first.nextCursor).toBeTypeOf('string');
    const allowed = resource === 'runs' ? ['endedAt', 'id', 'profileId', 'startedAt', 'status', 'versionId'] : ['baseVersionId', 'createdAt', 'id', 'policyId', 'profileId', 'state'];
    expect(Object.keys(first.items[0]).sort()).toEqual(allowed.sort());
    expect(firstResponse.body).not.toMatch(/"(?:ast|expression|proposals|results|facts|sourceLocator|path|stack)"|ce-session-/i);
    const second = (await list(resource, '?limit=1&cursor=' + encodeURIComponent(first.nextCursor))).json();
    expect(second.items[0].id).toBe(uuid(22)); expect(second.revision).toBe(first.revision);
    const third = (await list(resource, '?limit=1&cursor=' + encodeURIComponent(second.nextCursor))).json();
    expect(third.items[0].id).toBe(uuid(21)); expect(third.nextCursor).toBeNull(); expect(third.total).toBe(3);
    expect((await list(resource)).json().items.map((item: { id: string }) => item.id)).toEqual([uuid(23), uuid(22), uuid(21)]);
    expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.bytes).toBe(bytes);
  });
  it.each(['runs', 'previews'] as const)('requires authentication and rejects open queries on %s', async resource => {
    const { app, headers, workspace, list } = await setup();
    const anonymous = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/${resource}`, headers: { host: headers.host } }); expect(anonymous.statusCode).toBe(403);
    for (const query of ['?limit=0', '?limit=201', '?limit=01', '?limit=1.5', '?status=unknown', '?state=ready', '?versionId=' + uuid(2)]) expect((await list(resource, query)).statusCode).toBe(400);
    const empty = await list(resource); expect(empty.statusCode).toBe(200); expect(empty.json()).toMatchObject({ items: [], total: 0, nextCursor: null });
    expect((await app.inject({ url: `/api/v1/workspaces/${uuid(999)}/${resource}`, headers })).statusCode).toBe(404);
  });
  it('filters real completed and quota-incomplete runs while keeping historical snapshots accessible', async () => {
    const { app, workspace, snapshot, initial, addRun, list, headers } = await setup();
    const completed = addRun(uuid(31)), incomplete = addRun(uuid(32), date, true), historical = addRun(uuid(33), date, false, initial);
    expect(completed.run.status).toBe('completed'); expect(incomplete.run.status).toBe('incomplete');
    const completedResponse = await list('runs', '?status=completed'), incompleteResponse = await list('runs', '?status=incomplete');
    expect(completedResponse.statusCode).toBe(200); expect(incompleteResponse.statusCode).toBe(200);
    const completedPage = completedResponse.json(), incompletePage = incompleteResponse.json();
    expect(completedPage.total).toBe(2); expect(incompletePage.items.map((item: { id: string }) => item.id)).toEqual([incomplete.run.id]);
    expect(completedPage.items.find((item: { id: string }) => item.id === historical.run.id).versionId).toBe(initial.versionId);
    const oldResults = await app.inject({ url: `/api/v1/workspaces/${workspace.id}/runs/${historical.run.id}/results`, headers });
    expect(oldResults.statusCode).toBe(200); expect(oldResults.json().versionId).toBe(initial.versionId); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
  });
  it.each(['runs', 'previews'] as const)('authenticates %s cursors and binds them to filters, resource, session and collection revision', async resource => {
    const { list, addRun, addPreview } = await setup(); const add = resource === 'runs' ? addRun : addPreview;
    add(uuid(41)); add(uuid(42));
    const response = await list(resource, '?limit=1'); expect(response.statusCode).toBe(200);
    const first = response.json(), encoded = encodeURIComponent(first.nextCursor);
    expect(first.nextCursor).toBeTypeOf('string');
    const last = first.nextCursor.at(-1), tampered = first.nextCursor.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    for (const query of ['?limit=1&cursor=' + encodeURIComponent(tampered), '?limit=1&status=' + (resource === 'runs' ? 'completed' : 'ready') + '&cursor=' + encoded]) {
      const response = await list(resource, query); expect(response.statusCode).toBe(400); expect(response.json().error.code).toBe('INVALID_CURSOR');
    }
    expect((await list(resource === 'runs' ? 'previews' : 'runs', '?cursor=' + encoded)).statusCode).toBe(400);
    const otherSession = await setup(); expect((await otherSession.list(resource, '?cursor=' + encoded)).statusCode).toBe(400);
    add(uuid(43)); const stale = await list(resource, '?limit=1&cursor=' + encoded); expect(stale.statusCode).toBe(400); expect(stale.json().error.code).toBe('INVALID_CURSOR');
    expect((await list(resource)).json().revision).not.toBe(first.revision);
  });
});

describe('atomic preview discard', () => {
  it('discards only available proposals, keeps blocked reasons and invalidates history cursors without publishing a snapshot', async () => {
    const { app, workspace, snapshot, addPreview, list, discard, stored, headers } = await setup();
    const bundle = addPreview(uuid(51)), untouched = addPreview(uuid(52));
    expect(bundle.proposals.map(item => item.state).sort()).toEqual(['available', 'blocked']);
    const first = (await list('previews', '?limit=1')).json(), etag = app.ce.store.etag(workspace.id), versions = app.ce.store.get(workspace.id).versionIds;
    const originalStored = stored(bundle.preview.id), response = await discard(bundle.preview.id);
    expect(response.statusCode).toBe(200); expect(response.headers.etag).toBe(etag); expect(response.json()).toMatchObject({ id: bundle.preview.id, state: 'discarded', baseVersionId: snapshot.versionId });
    const discarded = stored(bundle.preview.id); expect(discarded.preview.state).toBe('discarded');
    expect(discarded.proposals.find(item => item.state === 'blocked')).toEqual(bundle.proposals.find(item => item.state === 'blocked'));
    expect(discarded.proposals.find(item => item.id === bundle.proposals.find(row => row.state === 'available')!.id)!.state).toBe('discarded');
    expect(originalStored.preview.state).toBe('ready'); expect(stored(untouched.preview.id)).toEqual(untouched);
    const bytes = app.ce.store.bytes, again = await discard(bundle.preview.id); expect(again.statusCode).toBe(200); expect(stored(bundle.preview.id)).toBe(discarded); expect(app.ce.store.bytes).toBe(bytes);
    expect((await list('previews', '?status=discarded')).json().items.map((item: { id: string }) => item.id)).toEqual([bundle.preview.id]);
    expect((await list('previews', '?cursor=' + encodeURIComponent(first.nextCursor))).statusCode).toBe(400);
    const selection = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/previews/${bundle.preview.id}/selection`, headers, payload: { selectedIds: [] } });
    expect(selection.statusCode).toBe(409); expect(selection.json().error.code).toBe('PREVIEW_NOT_APPLICABLE');
    expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.get(workspace.id).versionIds).toEqual(versions);
    expect(app.ce.store.etag(workspace.id)).toBe(etag); expect(app.ce.store.listRecords('job:')).toEqual([]);
  });
  it('requires token and current If-Match and rejects every DELETE payload extension', async () => {
    const { app, headers, workspace, snapshot, addPreview, discard, stored } = await setup(); const bundle = addPreview(), original = stored(bundle.preview.id);
    expect((await discard(bundle.preview.id, null)).statusCode).toBe(428); expect((await discard(bundle.preview.id, '"old"')).statusCode).toBe(412);
    const anonymous = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/previews/${bundle.preview.id}`, headers: { host: headers.host, 'if-match': app.ce.store.etag(workspace.id) } }); expect(anonymous.statusCode).toBe(403);
    for (const body of [{}, { state: 'discarded' }, { selectedIds: [] }, { expression: '1=1' }]) expect((await discard(bundle.preview.id, undefined, body)).statusCode).toBe(400);
    expect(stored(bundle.preview.id)).toBe(original); expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect((await discard(uuid(999))).statusCode).toBe(404);
  });
  it.each(['applied', 'obsolete'] as const)('retains an explicitly seeded %s lifecycle fixture and rejects discard', async state => {
    const { app, workspace, snapshot, addPreview, storePreview, discard, stored } = await setup(); const realSimulation = addPreview();
    // Lifecycle fixture only: no application Job has run, and this test makes no claim of applied facts.
    const lifecycleFixture: PreviewBundle = { ...realSimulation, preview: { ...realSimulation.preview, state },
      proposals: realSimulation.proposals.map(proposal => proposal.state === 'available' ? { ...proposal, state } : proposal) };
    storePreview(lifecycleFixture); const original = stored(realSimulation.preview.id), bytes = app.ce.store.bytes;
    const response = await discard(realSimulation.preview.id); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('PREVIEW_NOT_APPLICABLE');
    expect(stored(realSimulation.preview.id)).toBe(original); expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.bytes).toBe(bytes);
  });
  it('rejects discard during an active Job without changing the preview', async () => {
    // Only the scheduling boundary is controlled; imported data and stored simulations use the real engine.
    const control = controlledFactory(); const { app, headers, workspace, snapshot, addPreview, discard, stored, list } = await setup({ workerFactory: control.factory });
    const bundle = addPreview(), original = stored(bundle.preview.id);
    const accepted = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/validations`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { baseVersionId: snapshot.versionId } });
    expect(accepted.statusCode).toBe(202); await nextTurn();
    const runningResponse = await list('runs', '?status=running'); expect(runningResponse.statusCode).toBe(200);
    expect(runningResponse.json().items).toHaveLength(1); expect(runningResponse.json().items[0]).toMatchObject({ status: 'running', versionId: snapshot.versionId });
    expect(runningResponse.json().items[0]).not.toHaveProperty('endedAt');
    const response = await discard(bundle.preview.id); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('WORKSPACE_BUSY');
    expect(stored(bundle.preview.id)).toBe(original); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
    await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${accepted.json().jobId}`, headers });
  });
  it('leaves the entire record unchanged when the atomic discard would exceed the session quota', async () => {
    const maxBytes = 500_000; const { app, workspace, snapshot, addPreview, discard, stored } = await setup({ store: new WorkspaceStore({ maxBytes }) });
    const bundle = addPreview(), original = stored(bundle.preview.id);
    app.ce.store.putRecords([{ key: 'fixture:quota-padding', value: '' }]);
    const available = maxBytes - app.ce.store.bytes; expect(available).toBeGreaterThan(2);
    app.ce.store.putRecords([{ key: 'fixture:quota-padding', value: 'x'.repeat(available - 2) }]);
    const bytes = app.ce.store.bytes, response = await discard(bundle.preview.id);
    expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('SESSION_LIMIT');
    expect(stored(bundle.preview.id)).toBe(original); expect(app.ce.store.current(workspace.id)).toBe(snapshot); expect(app.ce.store.bytes).toBe(bytes);
  });
});
