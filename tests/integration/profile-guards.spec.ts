import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { DirectionDTO, JobDTO, JsonValue, RuleVariant, Snapshot, SnapshotContent, ValidationBundle } from '@ce/contracts';
import { parseRule, resolveDirection, runValidation, selectionClosureHash, simulate } from '@ce/engine';
import { createApp } from '../../apps/api/src/app.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import { previewKey } from '../../apps/api/src/recalculation/preview-store.js';
import { execute as previewWorker } from '../../apps/api/src/workers/preview.worker.js';
import { execute as applyWorker } from '../../apps/api/src/workers/apply.worker.js';
import { prepareApplication } from '../../apps/api/src/recalculation/application-service.js';
import { coordinate, fact, ref, report } from '../../packages/engine/test/helpers/report-fixture.js';

const V1 = 'ce-dpmxl-0.9-closed-v1', V2 = 'ce-dpmxl-0.9-closed-v2';
const startedAt = '2026-11-04T00:00:00.000Z';
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup() {
  const app = await createApp(); apps.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:3000' } })).json().sessionToken };
  const workspace = app.ce.store.create('Profile guards SYNTHETIC');
  const cells = [coordinate({ row: '0010' }), coordinate({ row: '0020' }), coordinate({ row: '0030', dataType: 'boolean' }), coordinate({ row: '0040', dataType: 'boolean' })];
  const variants: RuleVariant[] = [['NUMERIC', `${ref(cells[0]!)}=${ref(cells[1]!)}+1`], ['BOOLEAN', `${ref(cells[2]!)}=not(${ref(cells[3]!)})`]].map(([code, expression], i) => ({
    variantId: canonicalHash([code, expression]), code: code!, expression: expression!, framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: ['T'], active: true,
    referenceWindow: {}, severityOriginal: 'error', severity: 'error', sourceRecords: [String(i)], sourceLocators: [{ sheet: 'Rules', row: i + 2 }] }));
  const data = report(cells, cells.map((cell, i) => fact(cell, i < 2 ? ['1', '5'][i]! : false)));
  const content: SnapshotContent = { profileId: V1, catalogVersion: 'c', reportVersion: 'r', configVersion: 'none', contexts: data.contexts, coordinates: cells, facts: data.facts, directions: [], sources: [],
    catalog: { records: variants.map(v => ({ id: v.sourceRecords[0]!, variantId: v.variantId, code: v.code, sourceLocator: v.sourceLocators[0]!, originalFields: { Expression: v.expression }, diagnostics: [] })),
      variants, analyses: variants.map(v => ({ variantId: v.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId: V1, ...parseRule(v.expression) })),
      coverage: { rows: 2, variants: 2, applicableVariants: 2, supportedVariants: 2, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } };
  const initial = app.ce.store.publish(workspace.id, undefined, content), run = runValidation(initial, { runId: randomUUID(), startedAt });
  const directions = run.results.map(result => resolveDirection(initial, { instanceId: result.instanceId!, variantIds: result.variantIds, binding: result.binding!, targetSide: 'left' }).resolved!.direction);
  const base = app.ce.store.publish(workspace.id, initial.versionId, { ...content, profileId: V2 });
  // A stored historical run is seeded deliberately to test the independent API guard,
  // not to claim v2 validation has already run through a worker.
  const seeded: ValidationBundle = { run: { ...run.run, versionId: base.versionId, validationBasisId: base.validationBasisId, profileId: V2 }, results: run.results.map(row => ({ ...row, versionId: base.versionId, profileId: V2 })) };
  app.ce.store.putRecords([{ key: validationKey(workspace.id, run.run.id), value: seeded as unknown as JsonValue }]);
  return { app, headers, workspace, initial, base, directions, run: seeded };
}

it('rejects a mixed numeric/boolean v2 direction replacement atomically while numeric-only remains usable', async () => {
  const { app, headers, workspace, base, directions } = await setup();
  const versionIds = [...app.ce.store.get(workspace.id).versionIds];
  const payload = { directions: directions.map(({ instanceId, targetSide }) => ({ instanceId, targetSide })) };
  const response = await app.inject({ method: 'PUT', url: `/api/v1/workspaces/${workspace.id}/directions`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id) }, payload });
  expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('INVALID_DIRECTION');
  expect(app.ce.store.current(workspace.id)).toBe(base); expect(app.ce.store.get(workspace.id).versionIds).toEqual(versionIds);
  const numeric = directions.find(direction => base.content.catalog.variants.find(v => v.variantId === direction.variantIds[0])!.code === 'NUMERIC')!;
  const accepted = await app.inject({ method: 'PUT', url: `/api/v1/workspaces/${workspace.id}/directions`, headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id) },
    payload: { directions: [{ instanceId: numeric.instanceId, targetSide: numeric.targetSide }] } });
  expect(accepted.statusCode).toBe(200); expect(app.ce.store.current(workspace.id)!.content.directions).toHaveLength(1);
});

it('rejects internally retained mixed v2 configuration before accepting a preview Job or publishing proposals', async () => {
  const { app, headers, workspace, base, directions } = await setup();
  const configured = app.ce.store.publish(workspace.id, base.versionId, { ...base.content, directions });
  const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/previews`,
    headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { baseVersionId: configured.versionId } });
  expect(response.statusCode).toBe(422); expect(response.json().error.code).toBe('INVALID_DIRECTION');
  expect(app.ce.store.current(workspace.id)).toBe(configured); expect(app.ce.store.listRecords(`preview:${workspace.id}:`)).toEqual([]);
  expect(app.ce.store.get(workspace.id).activeJobId).toBeUndefined();
});

it('returns explained worker rejection rather than publishing blocked proposals for a typed reference', async () => {
  const { app, workspace, base, directions } = await setup();
  const numeric = directions.find(direction => base.content.catalog.variants.find(v => v.variantId === direction.variantIds[0])!.code === 'NUMERIC')!;
  const source = base.content.coordinates[1]!;
  const typed = { ...base, content: { ...base.content, directions: [numeric], coordinates: base.content.coordinates.map(c => c.factKey === source.factKey ? { ...c, dataType: 'text' as const, unit: '', decimals: '' } : c),
    facts: base.content.facts.map(f => f.factKey === source.factKey ? { ...f, normalizedValue: { kind: 'text' as const, value: '5' }, originalText: '5' } : f) } };
  const output = previewWorker({ previewId: randomUUID() }, { snapshot: typed, cancelled: () => false, progress: () => {},
    job: { jobId: randomUUID(), workspaceId: workspace.id, kind: 'preview', status: 'running', baseVersionId: base.versionId, progress: { completed: 0, total: 1, complete: false }, diagnostics: [], pollAfterMs: 10 } });
  expect(output.complete).toBe(false); expect(output.records).toBeUndefined();
  expect(output.diagnostics?.some(d => d.code === 'INVALID_DIRECTION')).toBe(true);
  expect(output.diagnostics?.some(d => d.code === 'RULE_VALIDATION_ONLY')).toBe(true);
  expect(app.ce.store.current(workspace.id)).toBe(base);
});

it('never reuses a preview from a different profile as numeric v2 authority', async () => {
  const { app, headers, workspace, initial, base, directions } = await setup();
  const numeric = directions.filter(direction => initial.content.catalog.variants.find(v => v.variantId === direction.variantIds[0])!.code === 'NUMERIC') as readonly DirectionDTO[];
  const old = simulate({ ...initial, content: { ...initial.content, directions: numeric } }, { previewId: randomUUID() });
  const crossed = { ...old, preview: { ...old.preview, baseVersionId: base.versionId } };
  app.ce.store.putRecords([{ key: previewKey(workspace.id, old.preview.id), value: crossed as unknown as JsonValue }]);
  const selectedIds = old.proposals.map(p => p.id);
  const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/applications`,
    headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() },
    payload: { baseVersionId: base.versionId, previewId: old.preview.id, selectedIds, closureHash: selectionClosureHash(crossed.preview, selectedIds) } });
  expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('PREVIEW_NOT_APPLICABLE');
  expect(app.ce.store.current(workspace.id)).toBe(base); expect(app.ce.store.get(workspace.id).activeJobId).toBeUndefined();
});

function typedSource(base: Snapshot): Snapshot {
  const source = base.content.coordinates[1]!;
  return { ...base, content: { ...base.content, coordinates: base.content.coordinates.map(cell => cell.factKey === source.factKey ? { ...cell, dataType: 'text', unit: '', decimals: '' } : cell),
    facts: base.content.facts.map(value => value.factKey === source.factKey ? { ...value, normalizedValue: { kind: 'text', value: '5' }, originalText: '5' } : value) } };
}
async function applicationSetup() {
  const state = await setup(), { app, workspace, base, directions } = state;
  const numeric = directions.find(direction => base.content.catalog.variants.find(v => v.variantId === direction.variantIds[0])!.code === 'NUMERIC')!;
  const current = app.ce.store.publish(workspace.id, base.versionId, { ...base.content, directions: [numeric] });
  const bundle = simulate(current, { previewId: randomUUID() }), selectedIds = bundle.proposals.map(proposal => proposal.id);
  app.ce.store.putRecords([{ key: previewKey(workspace.id, bundle.preview.id), value: bundle as unknown as JsonValue }]);
  const body = { baseVersionId: current.versionId, previewId: bundle.preview.id, selectedIds, closureHash: selectionClosureHash(bundle.preview, selectedIds) };
  const job: JobDTO = { jobId: randomUUID(), workspaceId: workspace.id, kind: 'apply', status: 'running', baseVersionId: current.versionId,
    progress: { completed: 0, total: 3, complete: false }, diagnostics: [], pollAfterMs: 10 };
  return { ...state, current, bundle, body, job };
}

it('rejects a manipulated application preview at the API and worker boundary without patches', async () => {
  const { app, workspace, headers, current, bundle, body, job } = await applicationSetup();
  const acceptance = prepareApplication(app.ce.store, workspace.id, body);
  const poisoned = typedSource(current);
  const output = applyWorker(acceptance.input!, { snapshot: poisoned, job, cancelled: () => false, progress: () => {} });
  expect(output.complete).toBe(false); expect(output.applicationCandidate).toBeUndefined();
  expect(output.diagnostics?.some(d => d.code === 'INVALID_DIRECTION')).toBe(true);
  expect(output.diagnostics?.some(d => d.code === 'RULE_VALIDATION_ONLY')).toBe(true);
  const changed = app.ce.store.publish(workspace.id, current.versionId, poisoned.content);
  // Forged internal preview: same displayed values and profile, but an incompatible source type.
  const forged = { ...bundle, preview: { ...bundle.preview, baseVersionId: changed.versionId } };
  app.ce.store.putRecords([{ key: previewKey(workspace.id, forged.preview.id), value: forged as unknown as JsonValue }]);
  const response = await app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/applications`,
    headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() },
    payload: { ...body, baseVersionId: changed.versionId, closureHash: selectionClosureHash(forged.preview, body.selectedIds) } });
  expect(response.statusCode).toBe(422); expect(response.json().error.details.reason).toBe('RULE_VALIDATION_ONLY');
  expect(app.ce.store.current(workspace.id)).toBe(changed); expect(app.ce.store.listRecords(`application:${workspace.id}:`)).toEqual([]);
});

it('rechecks classification at the final main-thread publication boundary after a valid worker result', async () => {
  const { app, workspace, current, body, job } = await applicationSetup();
  const acceptance = prepareApplication(app.ce.store, workspace.id, body);
  const output = applyWorker(acceptance.input!, { snapshot: current, job, cancelled: () => false, progress: () => {} });
  expect(output.complete).toBe(true);
  const publication = acceptance.preparePublication!(job, output);
  const poisoned = typedSource(current), originalSnapshot = app.ce.store.snapshot.bind(app.ce.store);
  // Controlled internal-state fault only; production snapshots remain immutable.
  vi.spyOn(app.ce.store, 'snapshot').mockImplementation((workspaceId, versionId) => versionId === current.versionId ? poisoned : originalSnapshot(workspaceId, versionId));
  expect(() => publication.assertCommit!()).toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION', details: expect.objectContaining({ reason: 'RULE_VALIDATION_ONLY' }) }));
  expect(app.ce.store.listRecords(`application:${workspace.id}:`)).toEqual([]);
});
