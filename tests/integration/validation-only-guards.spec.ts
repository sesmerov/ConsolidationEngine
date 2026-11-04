import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectionDTO, JobDTO, JsonValue, PreviewBundle, RuleVariant, Snapshot, SnapshotContent, ValidationBundle } from '@ce/contracts';
import { getRecalculationPolicy, parseRule, resolveDirection, runValidation, selectionClosureHash, simulate } from '@ce/engine';
import { createApp } from '../../apps/api/src/app.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { validationKey } from '../../apps/api/src/validation/validation-service.js';
import { previewKey } from '../../apps/api/src/recalculation/preview-store.js';
import { prepareApplication } from '../../apps/api/src/recalculation/application-service.js';
import { execute as previewWorker } from '../../apps/api/src/workers/preview.worker.js';
import { execute as applyWorker } from '../../apps/api/src/workers/apply.worker.js';
import { coordinate, fact, identity, ref, report } from '../../packages/engine/test/helpers/report-fixture.js';
import { controlledFactory, nextTurn } from '../helpers/foundation.js';

const profileId = 'ce-dpmxl-0.9-closed-v2', startedAt = '2026-11-04T00:00:00.000Z';
const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(apps.splice(0).map(app => app.close())); });

/** Real parser, evaluator and simulation results. Only explicitly labelled adversarial state is altered. */
async function setup() {
  const controlled = controlledFactory(), app = await createApp({ workerFactory: controlled.factory }); apps.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host: '127.0.0.1:3000' } })).json().sessionToken };
  const workspace = app.ce.store.create('Validation-only guards SYNTHETIC');
  const cells = [coordinate({ row: '0010' }), coordinate({ row: '0020' }),
    { ...coordinate({ row: '0030' }), dataType: 'text' as const, unit: '', decimals: '' },
    { ...coordinate({ row: '0040' }), dataType: 'date' as const, unit: '', decimals: '' },
    coordinate({ row: '0050' }), coordinate({ row: '0060' })];
  const [target, source, text, date, cycleA, cycleB] = cells as [typeof cells[number], typeof cells[number], typeof cells[number], typeof cells[number], typeof cells[number], typeof cells[number]];
  const specs = [
    ['NUMERIC', `${ref(target)}=${ref(source)}+1`],
    ['IF_NUMERIC', `${ref(target)}=(if true then ${ref(source)}+1 else 1/0 endif)`],
    ['TEXT', `${ref(text)}="Banco"`],
    ['DATE', `${ref(date)}=#2024-02-29#`],
    ['PRECONDITION_TEXT', `${ref(target)}=${ref(source)}+1`, `${ref(text)}="Banco"`],
    ['INACTIVE_TEXT', `if true then ${ref(target)}=${ref(source)}+1 else ${ref(text)}="Banco" endif`],
    ['TEXT_REFERENCE', `isnull(${ref(text)})`],
    ['NOT_EQUALITY', `${ref(source)}>0`],
    ['CYCLE_A', `${ref(cycleA)}=${ref(cycleB)}+1`],
    ['CYCLE_B', `${ref(cycleB)}=${ref(cycleA)}+1`],
  ];
  const variants: RuleVariant[] = specs.map(([code, expression, precondition], i) => ({ variantId: canonicalHash([code, expression, precondition ?? '']), code: code!, expression: expression!, ...(precondition ? { precondition } : {}), framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: ['T'], active: true,
    referenceWindow: {}, severityOriginal: 'error', severity: 'error', sourceRecords: [String(i)], sourceLocators: [{ sheet: 'Rules', row: i + 2 }] }));
  const data = report(cells, [fact(target, '1'), fact(source, '5'),
    { ...identity(text), presence: 'value', originalText: 'Banco', normalizedValue: { kind: 'text', value: 'Banco' }, sourceLocator: text.sourceLocator },
    { ...identity(date), presence: 'value', originalText: '2024-02-29', normalizedValue: { kind: 'date', value: '2024-02-29' }, sourceLocator: date.sourceLocator },
    fact(cycleA, '1'), fact(cycleB, '2')]);
  const content: SnapshotContent = { profileId, catalogVersion: 'typed-guards', reportVersion: 'synthetic', configVersion: 'none', contexts: data.contexts, coordinates: cells, facts: data.facts, directions: [], sources: [],
    catalog: { records: variants.map(v => ({ id: v.sourceRecords[0]!, variantId: v.variantId, code: v.code, sourceLocator: v.sourceLocators[0]!, originalFields: { Expression: v.expression }, diagnostics: [] })), variants,
      analyses: variants.map(v => { const expression = parseRule(v.expression, { profileId }), precondition = v.precondition ? parseRule(v.precondition, { profileId }) : undefined;
        return { variantId: v.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId, ...expression, ...(precondition?.ast ? { preconditionAst: precondition.ast } : {}) }; }),
      coverage: { rows: variants.length, variants: variants.length, applicableVariants: variants.length, supportedVariants: variants.length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } };
  const base = app.ce.store.publish(workspace.id, undefined, content), run = runValidation(base, { runId: randomUUID(), startedAt });
  app.ce.store.putRecords([{ key: validationKey(workspace.id, run.run.id), value: run as unknown as JsonValue }]);
  const row = (code: string) => { const found = run.results.find(value => value.code === code); expect(found, code).toBeDefined(); return found!; };
  const direction = (code: string) => { const result = row(code); const resolved = resolveDirection(base, { instanceId: result.instanceId!, variantIds: result.variantIds, binding: result.binding!, targetSide: 'left' }); expect(resolved.resolved, JSON.stringify(resolved.diagnostics)).toBeDefined(); return resolved.resolved!.direction; };
  const choice = (code: string) => { const result = row(code); expect(['pass', 'fail', 'not_applicable'], JSON.stringify(result.diagnostics)).toContain(result.status); expect(result.instanceId).toBeDefined(); return { instanceId: result.instanceId!, targetSide: 'left' as const }; };
  const excludedDirection = (code = 'IF_NUMERIC'): DirectionDTO => { const numeric = direction('NUMERIC'), excluded = row(code); return { ...numeric, id: canonicalHash('adversarial excluded direction'), instanceId: excluded.instanceId!, variantIds: excluded.variantIds, binding: excluded.binding! }; };
  return { app, headers, workspace, controlled, base, run, row, choice, direction, excludedDirection, prefix: `/api/v1/workspaces/${workspace.id}` };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
const auth = (f: Fixture) => ({ ...f.headers, 'if-match': f.app.ce.store.etag(f.workspace.id), 'idempotency-key': randomUUID() });
function unchanged(f: Fixture, base = f.base) { expect(f.app.ce.store.current(f.workspace.id)).toBe(base); expect(f.app.ce.store.listRecords(`preview:${f.workspace.id}:`)).toEqual([]); expect(f.app.ce.store.listRecords(`application:${f.workspace.id}:`)).toEqual([]); }
function job(f: Fixture, base: Snapshot, kind: 'preview' | 'apply'): JobDTO { return { jobId: randomUUID(), workspaceId: f.workspace.id, kind, status: 'running', baseVersionId: base.versionId, progress: { completed: 0, total: 1, complete: false }, diagnostics: [], pollAfterMs: 10 }; }
function workerContext(f: Fixture, base: Snapshot, kind: 'preview' | 'apply') { return { snapshot: base, job: job(f, base, kind), cancelled: () => false, progress: () => {} }; }
function forbiddenOutput(output: ReturnType<typeof previewWorker>) { expect(output.complete).toBe(false); expect(output.records).toBeUndefined(); expect(output.snapshotContent).toBeUndefined(); expect(output.applicationCandidate).toBeUndefined(); expect(output.diagnostics?.map(d => d.code)).toContain('INVALID_DIRECTION'); expect(output.diagnostics?.map(d => d.code)).toContain('RULE_VALIDATION_ONLY'); }
async function numericPreview(f: Fixture) {
  const current = f.app.ce.store.publish(f.workspace.id, f.base.versionId, { ...f.base.content, directions: [f.direction('NUMERIC')] });
  const bundle = simulate(current, { previewId: randomUUID() }); expect(bundle.proposals).toHaveLength(1); expect(bundle.proposals[0]!.state).toBe('available');
  f.app.ce.store.putRecords([{ key: previewKey(f.workspace.id, bundle.preview.id), value: bundle as unknown as JsonValue }]);
  const selectedIds = bundle.proposals.map(value => value.id), body = { baseVersionId: current.versionId, previewId: bundle.preview.id, selectedIds, closureHash: selectionClosureHash(bundle.preview, selectedIds) };
  return { current, bundle, body };
}
function withExcludedDirection(base: Snapshot, f: Fixture, code = 'IF_NUMERIC'): Snapshot { return { ...base, content: { ...base.content, directions: [...base.content.directions, f.excludedDirection(code)] } }; }

describe('validation-only rules cannot enter any recalculation boundary', () => {
  it('preserves the distinct non-equality diagnostic when a worker rejects numeric configuration', async () => {
    const f = await setup(), { current } = await numericPreview(f), row = f.row('NOT_EQUALITY');
    const response = await f.app.inject({ method: 'POST', url: `${f.prefix}/previews`, headers: auth(f), payload: { baseVersionId: current.versionId } }); expect(response.statusCode).toBe(202); await nextTurn();
    const stale = { ...current, content: { ...current.content, directions: [{ ...f.direction('NUMERIC'), variantIds: row.variantIds, instanceId: row.instanceId!, binding: row.binding! }] } };
    const output = previewWorker({ previewId: randomUUID() }, workerContext(f, stale, 'preview')); expect(output.complete).toBe(false);
    expect(output.diagnostics?.map(value => value.code)).toContain('NOT_EQUALITY');
    f.controlled.workers[0]!.complete(output); await nextTurn(); await f.app.ce.jobs.settle(response.json().jobId);
    const terminal = f.app.ce.jobs.get(f.workspace.id, response.json().jobId); expect(terminal.status).toBe('failed'); expect(terminal.diagnostics.map(value => value.code)).toContain('NOT_EQUALITY');
    expect(terminal.diagnostics.map(value => value.code)).not.toContain('RULE_VALIDATION_ONLY'); expect(f.app.ce.store.current(f.workspace.id)).toBe(current);
  });
  it.each(['IF_NUMERIC', 'TEXT', 'DATE', 'PRECONDITION_TEXT', 'INACTIVE_TEXT', 'TEXT_REFERENCE'])('rejects direct and mixed choices for %s atomically with the same explanation', async code => {
    const f = await setup(), forbidden = f.choice(code), numeric = f.choice('NUMERIC'), versions = f.app.ce.store.get(f.workspace.id).versionIds;
    for (const directions of [[forbidden], [numeric, forbidden]]) {
      const response = await f.app.inject({ method: 'PUT', url: `${f.prefix}/directions`, headers: auth(f), payload: { directions } });
      expect(response.statusCode, response.body).toBe(422); expect(response.json().error.code).toBe('INVALID_DIRECTION'); expect(response.json().error.details.reason).toBe('RULE_VALIDATION_ONLY');
      unchanged(f); expect(f.app.ce.store.get(f.workspace.id).versionIds).toEqual(versions);
    }
    const accepted = await f.app.inject({ method: 'PUT', url: `${f.prefix}/directions`, headers: auth(f), payload: { directions: [numeric] } }); expect(accepted.statusCode, accepted.body).toBe(200);
    expect(f.app.ce.store.current(f.workspace.id)!.content.directions).toHaveLength(1);
  });
  it('rejects stale internal directions at HTTP, simulation and worker boundaries without blocked proposals', async () => {
    const f = await setup(); f.choice('IF_NUMERIC'); const invalid = f.app.ce.store.publish(f.workspace.id, f.base.versionId, { ...f.base.content, directions: [f.direction('NUMERIC'), f.excludedDirection()] });
    const response = await f.app.inject({ method: 'POST', url: `${f.prefix}/previews`, headers: auth(f), payload: { baseVersionId: invalid.versionId } });
    expect(response.statusCode).toBe(422); expect(response.json().error.details.reason).toBe('RULE_VALIDATION_ONLY'); expect(f.app.ce.store.get(f.workspace.id).activeJobId).toBeUndefined();
    expect(() => simulate(invalid, { previewId: randomUUID() })).toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'RULE_VALIDATION_ONLY' })]) }));
    forbiddenOutput(previewWorker({ previewId: randomUUID() }, workerContext(f, invalid, 'preview'))); unchanged(f, invalid);
  });
  it('keeps numeric cycle blocking distinct and leaves an independent numeric branch available', async () => {
    const f = await setup(), configured = { ...f.base, content: { ...f.base.content, directions: [f.direction('NUMERIC'), f.direction('CYCLE_A'), f.direction('CYCLE_B')] } };
    const bundle = simulate(configured, { previewId: randomUUID() }); expect(bundle.preview.graphSummary.cycles).toHaveLength(1);
    expect(bundle.proposals.find(value => value.code === 'NUMERIC')?.state).toBe('available'); expect(bundle.proposals.filter(value => value.state === 'blocked')).toHaveLength(2);
    f.choice('IF_NUMERIC'); expect(() => simulate(withExcludedDirection(configured, f), { previewId: randomUUID() })).toThrow(expect.objectContaining({ code: 'INVALID_DIRECTION' })); unchanged(f);
  });
  it.each(['TEXT_REFERENCE', 'IF_NUMERIC'])('rejects a forged proposal claiming %s before accepting an application and inside its worker', async code => {
    const f = await setup(); if (code === 'IF_NUMERIC') f.choice(code); const { current, bundle, body } = await numericPreview(f), excluded = f.row(code);
    expect(getRecalculationPolicy(current, { variantIds: excluded.variantIds, binding: excluded.binding!, instanceId: excluded.instanceId! }).policy.mode).toBe('validation_only');
    const acceptance = prepareApplication(f.app.ce.store, f.workspace.id, body);
    // Deliberate private-state corruption: these fields were not returned by the simulator.
    const forged: PreviewBundle = { ...bundle, proposals: bundle.proposals.map(value => ({ ...value, variantIds: excluded.variantIds, code: excluded.code, binding: excluded.binding! })) };
    const input = { ...(acceptance.input as Record<string, JsonValue>), preview: forged as unknown as JsonValue };
    f.app.ce.store.putRecords([{ key: previewKey(f.workspace.id, bundle.preview.id), value: forged as unknown as JsonValue }]);
    const response = await f.app.inject({ method: 'POST', url: `${f.prefix}/applications`, headers: auth(f), payload: body });
    expect(response.statusCode, response.body).toBe(422); expect(response.json().error.details.reason).toBe('RULE_VALIDATION_ONLY');
    forbiddenOutput(applyWorker(input, workerContext(f, current, 'apply')));
    expect(f.app.ce.store.current(f.workspace.id)).toBe(current); expect(f.app.ce.store.listRecords(`application:${f.workspace.id}:`)).toEqual([]); expect(f.app.ce.store.get(f.workspace.id).activeJobId).toBeUndefined();
  });
  it.each(['preview', 'apply'] as const)('rechecks typed exclusion in the final %s publication and preserves RULE_VALIDATION_ONLY on the failed Job', async kind => {
    const f = await setup(), { current, bundle, body } = await numericPreview(f);
    let output: ReturnType<typeof previewWorker>;
    if (kind === 'apply') { const acceptance = prepareApplication(f.app.ce.store, f.workspace.id, body); output = applyWorker(acceptance.input!, workerContext(f, current, 'apply')); }
    else output = previewWorker({ previewId: randomUUID() }, workerContext(f, current, 'preview'));
    expect(output.complete).toBe(true);
    const response = await f.app.inject({ method: 'POST', url: `${f.prefix}/${kind === 'preview' ? 'previews' : 'applications'}`, headers: auth(f), payload: kind === 'preview' ? { baseVersionId: current.versionId } : body }); expect(response.statusCode, response.body).toBe(202); await nextTurn();
    // Controlled fault at the final store lookup, after actual calculation on a valid snapshot.
    const original = f.app.ce.store.snapshot.bind(f.app.ce.store), poisoned = withExcludedDirection(current, f, 'TEXT_REFERENCE');
    vi.spyOn(f.app.ce.store, 'snapshot').mockImplementation((workspaceId, versionId) => versionId === current.versionId ? poisoned : original(workspaceId, versionId));
    f.controlled.workers[0]!.complete(output); await nextTurn(); await f.app.ce.jobs.settle(response.json().jobId);
    const terminal = f.app.ce.jobs.get(f.workspace.id, response.json().jobId); expect(terminal.status).toBe('failed'); expect(terminal.diagnostics.map(d => d.code)).toContain('INVALID_DIRECTION'); expect(terminal.diagnostics.map(d => d.code)).toContain('RULE_VALIDATION_ONLY');
    vi.restoreAllMocks(); expect(f.app.ce.store.current(f.workspace.id)).toBe(current); expect(f.app.ce.store.listRecords(`application:${f.workspace.id}:`)).toEqual([]);
    expect(f.app.ce.store.listRecords<PreviewBundle>(`preview:${f.workspace.id}:`).map(record => record.value.preview.id)).toEqual([bundle.preview.id]);
  });
});
