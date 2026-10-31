import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SNAPSHOTS, SESSION_LIMIT_BYTES, isTerminalJob } from '@ce/contracts';
import type { ApplicationBundle, JsonValue, PreviewBundle, RuleVariant, Snapshot, SnapshotContent } from '@ce/contracts';
import { parseRule, resolveDirection, runValidation, simulate } from '@ce/engine';
import { createApp, type AppOptions } from '../../apps/api/src/app.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { canonicalHash, canonicalStateBytes, canonicalStringify } from '../../apps/api/src/session/canonical-state.js';
import { discardPreview, getPreview, previewKey, selectPreview } from '../../apps/api/src/recalculation/preview-store.js';
import type { WorkerOperation, WorkerOutput, WorkerRequest } from '../../apps/api/src/workers/protocol.js';
import { coordinate, fact, report, ref } from '../../packages/engine/test/helpers/report-fixture.js';
import { ControlledWorker, nextTurn } from '../helpers/foundation.js';

const applications: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(applications.splice(0).map(app => app.close())); vi.restoreAllMocks(); });
const PROFILE = 'ce-dpmxl-0.9-closed-v1';
const STARTED = '2026-10-31T00:00:00.000Z';

/** In-memory SYNTHETIC input. Parsing, directions and previews use the real engine. */
function fixtureContent(noop = false): SnapshotContent {
  const cells = ['0010', '0020', '0030', '0040', '0090'].map((row, index) => coordinate({ row, unit: 'EUR', decimals: '2', sourceRow: index + 2 }));
  const [a, b, c, d] = cells;
  const expressions = [['A', `${ref(a!)}=${ref(b!)}+${ref(c!)}`], ['D', `${ref(d!)}=${ref(a!)}*2`]] as const;
  const variants: RuleVariant[] = expressions.map(([code, equation], index) => {
    const expression = `with {interval:true}: ${equation}`;
    return { variantId: canonicalHash([code, expression]), code, expression, framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false,
      tables: ['T'], active: true, referenceWindow: {}, severityOriginal: 'Warning', severity: 'warning', sourceRecords: [code + '-row'], sourceLocators: [{ sheet: 'Catalog', row: index + 2 }] };
  });
  const records = variants.map(item => ({ id: item.sourceRecords[0]!, code: item.code, variantId: item.variantId, originalFields: {}, sourceLocator: item.sourceLocators[0]!, diagnostics: [] }));
  const analyses = variants.map(item => ({ variantId: item.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId: PROFILE, ...parseRule(item.expression) }));
  const input = report(cells, cells.map((cell, index) => ({ ...fact(cell, (noop ? ['12', '5', '7', '24.000', '123'] : ['10', '5', '7', '20', '123'])[index]!, index + 2),
    ...(noop && index === 0 ? { derivation: { receiptId: randomUUID(), previewId: randomUUID(), proposalId: randomUUID(), baseVersionId: randomUUID() } } : {}) })));
  return { catalogVersion: 'synthetic-catalog', reportVersion: 'synthetic-report', configVersion: 'unconfigured', profileId: PROFILE,
    contexts: input.contexts, coordinates: input.coordinates, facts: input.facts, directions: [], sources: [],
    catalog: { records, variants, analyses, coverage: { rows: 2, variants: 2, applicableVariants: 2, supportedVariants: 2, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } };
}

/** Only the worker transport/timing is controlled. Successful payloads come from the real apply worker. */
function controlledTransport() {
  const requests: WorkerRequest[] = [], workers: ControlledWorker[] = [];
  return {
    requests, workers,
    factory(request: WorkerRequest) { requests.push(structuredClone(request)); const worker = new ControlledWorker(); workers.push(worker); return worker; },
    async output(index = 0): Promise<WorkerOutput> {
      // Dynamic loading permits preparation before T063 without replacing the missing implementation with a stub.
      const modulePath = '../../apps/api/src/workers/apply.worker.js';
      const operation = await import(modulePath) as WorkerOperation;
      const request = requests[index]!;
      return structuredClone(await operation.execute(request.input, {
        job: request.job, ...(request.snapshot ? { snapshot: request.snapshot } : {}),
        cancelled: () => Atomics.load(new Int32Array(request.cancellation), 0) !== 0, progress: () => {},
      }));
    },
    async emit(output: WorkerOutput, index = 0) { workers[index]!.emit('message', { type: 'result', output }); await nextTurn(); },
  };
}
type Transport = ReturnType<typeof controlledTransport>;
async function setup(options: AppOptions = {}, snapshots = 2, noop = false) {
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url),
    workerModules: { apply: new URL('../../apps/api/dist/workers/apply.worker.js', import.meta.url) }, ...options }); applications.push(app);
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' };
  headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = app.ce.store.create('Application atomicity SYNTHETIC');
  const initial = app.ce.store.publish(workspace.id, undefined, fixtureContent(noop));
  const validation = runValidation(initial, { runId: randomUUID(), startedAt: STARTED });
  const directions = validation.results.map(result => {
    if (!result.instanceId || !result.binding) throw new Error('Synthetic rule lacks a real structural instance');
    const resolved = resolveDirection(initial, { instanceId: result.instanceId, binding: result.binding, variantIds: result.variantIds, targetSide: 'left' });
    if (!resolved.resolved) throw new Error(JSON.stringify(resolved.diagnostics)); return resolved.resolved.direction;
  });
  let base = app.ce.store.publish(workspace.id, initial.versionId, { ...initial.content, directions, configVersion: canonicalHash(directions) });
  for (let i = 2; i < snapshots; i++) base = app.ce.store.publish(workspace.id, base.versionId, { ...base.content, configVersion: String(i) });
  const bundle = simulate(base, { previewId: randomUUID() });
  expect(bundle.proposals.map(proposal => proposal.state)).toEqual(['available', 'available']);
  app.ce.store.putRecords([{ key: previewKey(workspace.id, bundle.preview.id), value: bundle as unknown as JsonValue }]);
  const original = canonicalStringify(base), versionIds = [...app.ce.store.get(workspace.id).versionIds];
  const selectedIds = bundle.proposals.map(proposal => proposal.id);
  const selection = selectPreview(bundle, selectedIds);
  const body = { baseVersionId: base.versionId, previewId: bundle.preview.id, selectedIds, closureHash: selection.closureHash };
  const start = (payload: object = body) => app.inject({ method: 'POST', url: `/api/v1/workspaces/${workspace.id}/applications`,
    headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload });
  const accepted = async () => { const response = await start(); expect(response.statusCode).toBe(202); await nextTurn(); return response.json().jobId as string; };
  const poll = async (jobId: string) => {
    for (let i = 0; i < 400; i++) { const job = app.ce.jobs.get(workspace.id, jobId); if (isTerminalJob(job.status)) return job; await new Promise(resolve => setTimeout(resolve, 10)); }
    throw new Error('Application worker did not reach a terminal state');
  };
  const cancel = (jobId: string) => app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${jobId}`, headers });
  const pristine = (current: Snapshot = base, previewState = 'ready') => {
    expect(app.ce.store.current(workspace.id)).toBe(current);
    expect(app.ce.store.snapshot(workspace.id, base.versionId)).toBe(base);
    expect(canonicalStringify(base)).toBe(original);
    expect(app.ce.store.listRecords(`application:${workspace.id}:`)).toEqual([]);
    expect(app.ce.store.listRecords(`validation:${workspace.id}:`)).toEqual([]);
    expect(getPreview(app.ce.store, workspace.id, bundle.preview.id).preview.state).toBe(previewState);
    if (current === base) expect(app.ce.store.get(workspace.id).versionIds).toEqual(versionIds);
  };
  return { app, headers, workspace, base, bundle, body, original, versionIds, start, accepted, poll, cancel, pristine };
}
async function controlledSetup(options: AppOptions = {}, snapshots = 2, noop = false) {
  const transport = controlledTransport(); return { ...await setup({ ...options, workerFactory: transport.factory }, snapshots, noop), transport };
}
type Setup = Awaited<ReturnType<typeof setup>>;
function expectCowPublication(s: Setup) {
  const published = s.app.ce.store.current(s.workspace.id)!;
  expect(published).not.toBe(s.base); expect(published.parentVersionId).toBe(s.base.versionId);
  for (const branch of ['contexts', 'coordinates', 'catalog', 'directions', 'sources'] as const) expect(published.content[branch]).toBe(s.base.content[branch]);
  expect(published.content.facts).not.toBe(s.base.content.facts);
  for (const before of s.base.content.facts) {
    const after = published.content.facts.find(item => item.factKey === before.factKey)!;
    if (before.rowCode === '0010' || before.rowCode === '0040') {
      expect(after).not.toBe(before);
      expect(after.normalizedValue).toEqual({ numerator: before.rowCode === '0010' ? '12' : '24', denominator: '1' });
    } else expect(after).toBe(before);
  }
  expect(canonicalStringify(s.base)).toBe(s.original);
  expect(canonicalStateBytes([s.base, published])).toBeLessThan(canonicalStateBytes([structuredClone(s.base), structuredClone(published)]));
  expect(s.app.ce.store.bytes).toBeLessThan(SESSION_LIMIT_BYTES);
  return published;
}
async function complete(transport: Transport) { const output = await transport.output(); expect(output.complete).toBe(true); await transport.emit(output); }

describe('application fixture prerequisites', () => {
  it('has two real chained proposals, a closed selection and unchanged input facts', async () => {
    const s = await controlledSetup(); expect(s.body.selectedIds).toHaveLength(2);
    expect(s.bundle.proposals[1]!.predecessorIds).toEqual([s.bundle.proposals[0]!.id]);
    expect(selectPreview(s.bundle, [s.bundle.proposals[1]!.id]).requiredIds).toEqual([s.bundle.proposals[0]!.id]); s.pristine();
  });
});

describe('application atomicity across the worker boundary', () => {
  it.each(['succeeded', 'cancelled', 'failed', 'timed_out'] as const)('accounts the private retained intent and releases it atomically on %s', async status => {
    const s = await controlledSetup(), jobId = await s.accepted();
    const retained = s.app.ce.store.getRecord<Record<string, unknown>>('operation:' + jobId)!;
    expect(retained).toMatchObject({ previewId: s.bundle.preview.id, baseVersionId: s.base.versionId, selectedIds: s.body.selectedIds.slice().sort() });
    expect(Object.isFrozen(retained)).toBe(true); expect(retained['preview']).toBeUndefined(); expect(retained['snapshot']).toBeUndefined();
    const jobResponse = await s.app.inject({ url: `/api/v1/workspaces/${s.workspace.id}/jobs/${jobId}`, headers: s.headers });
    expect(jobResponse.statusCode).toBe(200); expect(jobResponse.body).not.toMatch(/receiptId|beforeRunId|closureHash|selectedIds|operation:/); expect(s.app.ce.store.listRecords(`application:${s.workspace.id}:`)).toEqual([]);
    if (status === 'succeeded') await complete(s.transport);
    else if (status === 'cancelled') await s.cancel(jobId);
    else if (status === 'failed') s.transport.workers[0]!.emit('error', new Error('Controlled failure'));
    else {
      const output = await s.transport.output(), now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(s.app.ce.jobs.get(s.workspace.id, jobId).deadline!) + 1);
      try { await s.transport.emit(output); } finally { now.mockRestore(); }
    }
    expect((await s.poll(jobId)).status).toBe(status); expect(s.app.ce.store.getRecord('operation:' + jobId)).toBeUndefined();
    expect(s.app.ce.store.listRecords(`application:${s.workspace.id}:`)).toHaveLength(status === 'succeeded' ? 1 : 0);
  });
  it('rolls back Job, retained intent and idempotency entry when acceptance exceeds its real byte quota', async () => {
    const s = await controlledSetup({ store: new WorkspaceStore({ maxBytes: 250_000 }) }), bytes = s.app.ce.store.bytes;
    const register = s.app.ce.store.registerJob.bind(s.app.ce.store);
    // Only reservation size is controlled; the actual store quota/route rollback remains in use.
    vi.spyOn(s.app.ce.store, 'registerJob').mockImplementation((job, records, retained) => register(job, records, { retained: retained ?? null, syntheticQuotaProbe: 'x'.repeat(250_000) }));
    const response = await s.start(); expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('SESSION_LIMIT');
    for (const prefix of ['job:', 'operation:', 'reserve:', 'idempotency:']) expect(s.app.ce.store.listRecords(prefix)).toEqual([]);
    expect(s.app.ce.store.bytes).toBe(bytes); expect(s.transport.requests).toEqual([]); s.pristine();
  });
  it('releases the private intent and terminates the worker when closing a workspace', async () => {
    const s = await controlledSetup(); await s.app.ce.files.createWorkspace(s.workspace.id); await s.accepted(); expect(s.app.ce.store.listRecords('operation:')).toHaveLength(1);
    const response = await s.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${s.workspace.id}`, headers: { ...s.headers, 'if-match': s.app.ce.store.etag(s.workspace.id) } });
    expect(response.statusCode).toBe(204); expect(s.transport.workers[0]!.terminated).toBe(true); expect(s.app.ce.store.listRecords('operation:')).toEqual([]); expect(s.app.ce.store.currentWorkspaceId).toBeUndefined();
  });
  it('rejects an incomplete dependency closure before accepting any worker or mutation', async () => {
    const s = await controlledSetup(); const selectedIds = [s.bundle.proposals[1]!.id];
    const response = await s.start({ ...s.body, selectedIds, closureHash: selectPreview(s.bundle, selectedIds).closureHash });
    expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('SELECTION_NOT_CLOSED');
    expect(s.transport.requests).toHaveLength(0); expect(s.app.ce.store.get(s.workspace.id).activeJobId).toBeUndefined(); s.pristine();
  });
  it('rechecks the base at publication and preserves a competing version without any partial application', async () => {
    const s = await controlledSetup(), jobId = await s.accepted(), output = await s.transport.output();
    const newer = s.app.ce.store.publish(s.workspace.id, s.base.versionId, { ...s.base.content, configVersion: 'competing-publication' });
    await s.transport.emit(output); const terminal = await s.poll(jobId);
    expect(terminal.status).toBe('failed'); expect(terminal.diagnostics).toContainEqual(expect.objectContaining({ code: 'STALE_VERSION' })); s.pristine(newer, 'obsolete');
  });
  it('ignores a fully computed candidate arriving after accepted cancellation', async () => {
    const s = await controlledSetup(), jobId = await s.accepted(), output = await s.transport.output();
    const cancelled = await s.cancel(jobId); expect(cancelled.statusCode).toBe(202);
    await s.transport.emit(output); expect((await s.poll(jobId)).status).toBe('cancelled'); expect(s.transport.workers[0]!.terminated).toBe(true); s.pristine();
  });
  it('keeps a successful publication when cancellation arrives after the commit', async () => {
    const s = await controlledSetup(), jobId = await s.accepted(); await complete(s.transport);
    const published = expectCowPublication(s); const cancellation = await s.cancel(jobId);
    expect(cancellation.statusCode).toBe(200); expect(cancellation.json().status).toBe('succeeded');
    expect(s.app.ce.store.current(s.workspace.id)).toBe(published);
    expect(s.app.ce.store.listRecords(`application:${s.workspace.id}:`)).toHaveLength(1);
  });
  it('enforces the deadline at the final commit guard after computing the candidate', async () => {
    const s = await controlledSetup(), jobId = await s.accepted(), output = await s.transport.output();
    const publish = s.app.ce.store.publishJobResult.bind(s.app.ce.store);
    vi.spyOn(s.app.ce.store, 'publishJobResult').mockImplementation((job, result, guard) => publish(job, result, () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(job.deadline!) + 1);
      try { guard?.(); } finally { now.mockRestore(); }
    }));
    await s.transport.emit(output); expect((await s.poll(jobId)).status).toBe('timed_out'); s.pristine();
  });
  it('does not roll back an already committed application after its deadline passes', async () => {
    const s = await controlledSetup(), jobId = await s.accepted(); await complete(s.transport);
    const terminal = await s.poll(jobId), published = expectCowPublication(s);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(terminal.deadline!) + 1);
    try { expect((await s.app.ce.jobs.cancel(s.workspace.id, jobId)).status).toBe('succeeded'); } finally { now.mockRestore(); }
    expect(s.app.ce.store.current(s.workspace.id)).toBe(published);
  });
  it.each(['error', 'exit'] as const)('preserves all base state when the application worker ends via %s', async fault => {
    const s = await controlledSetup(), jobId = await s.accepted();
    if (fault === 'error') s.transport.workers[0]!.emit('error', new Error('private-token C:\\private\\report.xlsx'));
    else s.transport.workers[0]!.emit('exit', 1);
    const terminal = await s.poll(jobId); expect(terminal.status).toBe('failed'); expect(JSON.stringify(terminal)).not.toContain('private'); s.pristine();
  });
  it('checks the session byte budget against the whole staged publication, retaining no oversized auxiliary record', async () => {
    // A reduced real byte budget exercises the same boundary without allocating a 512 MiB fixture.
    expect(SESSION_LIMIT_BYTES).toBe(512 * 1024 * 1024);
    const store = new WorkspaceStore({ maxBytes: 250_000 }); const s = await controlledSetup({ store }), jobId = await s.accepted();
    const output = await s.transport.output(); expect(output.complete).toBe(true);
    const key = 'application-test-oversized';
    await s.transport.emit({ ...output, records: [...(output.records ?? []), { key, value: 'x'.repeat(300_000) }] });
    const terminal = await s.poll(jobId); expect(terminal.status).toBe('failed'); expect(terminal.diagnostics).toContainEqual(expect.objectContaining({ code: 'SESSION_LIMIT' }));
    expect(store.getRecord(key)).toBeUndefined(); expect(store.bytes).toBeLessThanOrEqual(250_000); s.pristine();
  });
  it('refuses the 21st snapshot atomically without evicting any of the previous twenty', async () => {
    expect(MAX_SNAPSHOTS).toBe(20); const s = await controlledSetup({}, 20), jobId = await s.accepted(); await complete(s.transport);
    const terminal = await s.poll(jobId); expect(terminal.status).toBe('failed'); expect(terminal.diagnostics).toContainEqual(expect.objectContaining({ code: 'SESSION_LIMIT' }));
    for (const id of s.versionIds) expect(s.app.ce.store.snapshot(s.workspace.id, id).versionId).toBe(id); s.pristine();
  });
  it('guards normal discard while an application is active', async () => {
    const s = await controlledSetup(); await s.accepted();
    expect(() => discardPreview(s.app.ce.store, s.workspace.id, s.bundle.preview.id)).toThrowError(/WORKSPACE_BUSY/); s.pristine();
  });
  it.each(['discarded', 'obsolete'] as const)('rechecks preview state %s at publication even when the base CAS still matches', async state => {
    const s = await controlledSetup(), jobId = await s.accepted(), output = await s.transport.output();
    // Deliberate internal race bypasses the public discard lock to test the final publication invariant.
    const changed: PreviewBundle = { ...s.bundle, preview: { ...s.bundle.preview, state }, proposals: s.bundle.proposals.map(p => ({ ...p, state })) };
    s.app.ce.store.putRecords([{ key: previewKey(s.workspace.id, s.bundle.preview.id), value: changed as unknown as JsonValue }]);
    await s.transport.emit(output); const terminal = await s.poll(jobId);
    expect(terminal.status).toBe('failed'); expect(terminal.diagnostics).toContainEqual(expect.objectContaining({ code: 'PREVIEW_NOT_APPLICABLE' })); s.pristine(s.base, state);
  });
  it('does not publish candidate data when the worker reports incomplete work', async () => {
    const s = await controlledSetup(), jobId = await s.accepted(), output = await s.transport.output();
    await s.transport.emit({ ...output, complete: false, diagnostics: [{ code: 'RESOURCE_LIMIT', message: 'Controlled work limit', severity: 'error' }] });
    const terminal = await s.poll(jobId); expect(terminal.status).toBe('failed'); expect(terminal.diagnostics).toContainEqual(expect.objectContaining({ code: 'RESOURCE_LIMIT' })); s.pristine();
  });
  it('rejects an incomplete revalidation even when the worker envelope incorrectly says complete', async () => {
    const s = await controlledSetup(), jobId = await s.accepted(), output = await s.transport.output();
    let found = 0;
    const pending: unknown[] = [output];
    while (pending.length) {
      const value = pending.pop(); if (!value || typeof value !== 'object') continue;
      const row = value as Record<string, unknown>, run = row.run as { versionId?: string; status?: string; summary?: { complete: boolean } } | undefined;
      if (run?.versionId && run.versionId !== s.base.versionId && Array.isArray(row.results) && run.summary) { run.status = 'incomplete'; run.summary.complete = false; found++; }
      pending.push(...Object.values(row));
    }
    expect(found).toBeGreaterThan(0); expect(output.complete).toBe(true); await s.transport.emit(output);
    expect((await s.poll(jobId)).status).toBe('failed'); s.pristine();
  });
  it('restores actual copy-on-write identities after structured cloning the request and candidate output', async () => {
    const s = await controlledSetup(), jobId = await s.accepted();
    expect(s.transport.requests[0]!.snapshot).not.toBe(s.base);
    expect(s.transport.requests[0]!.snapshot!.content.catalog).not.toBe(s.base.content.catalog);
    await complete(s.transport); const terminal = await s.poll(jobId); expect(terminal.status).toBe('succeeded');
    const published = expectCowPublication(s); expect(terminal.newVersionId).toBe(published.versionId);
    expect(terminal.resultRef?.type).toBe('application');
    expect(s.app.ce.store.listRecords(`application:${s.workspace.id}:`)).toHaveLength(1);
    expect(getPreview(s.app.ce.store, s.workspace.id, s.bundle.preview.id).preview.state).toBe('applied');
  });
  it('publishes with real worker_threads transport and retains sharing with the original main-thread base', async () => {
    const s = await setup(), jobId = await s.accepted(), terminal = await s.poll(jobId);
    expect(terminal.status).toBe('succeeded'); expectCowPublication(s);
    expect(s.app.ce.store.listRecords(`validation:${s.workspace.id}:`)).toHaveLength(2);
  });
  it('publishes an explicit no-op selection while sharing every fact and retaining original text and prior derivation', async () => {
    const s = await controlledSetup({}, 2, true), jobId = await s.accepted(), output = await s.transport.output();
    expect(output.applicationCandidate?.factPatches).toEqual([]); await s.transport.emit(output); expect((await s.poll(jobId)).status).toBe('succeeded');
    const published = s.app.ce.store.current(s.workspace.id)!; expect(published.versionId).not.toBe(s.base.versionId);
    expect(published.content.facts).toBe(s.base.content.facts);
    for (const original of s.base.content.facts) expect(published.content.facts.find(f => f.factKey === original.factKey)).toBe(original);
    const stored = s.app.ce.store.listRecords<ApplicationBundle>(`application:${s.workspace.id}:`)[0]!.value;
    expect(stored.receipt.acceptedIds).toHaveLength(2); expect(stored.changes.every(change => !change.changed)).toBe(true);
    expect(stored.changes.find(change => change.targetKey === s.base.content.facts[0]!.factKey)!.after.originalText).toBe('12');
    expect(stored.changes.find(change => change.targetKey === s.base.content.facts[3]!.factKey)!.after.originalText).toBe('24.000');
    expect(canonicalStringify(s.base)).toBe(s.original);
  });
  it('does not publish either validation or any facts when the real application exhausts its shared work budget', async () => {
    const options: AppOptions & { applicationLimits: { reads: number } } = { applicationLimits: { reads: 0 } };
    const s = await setup(options), jobId = await s.accepted(), terminal = await s.poll(jobId);
    expect(terminal.status).toBe('failed'); expect(terminal.diagnostics).toContainEqual(expect.objectContaining({ code: 'RESOURCE_LIMIT' })); s.pristine();
  });
});
