import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import type { JsonValue, PreviewBundle, ProposalDTO, SnapshotContent } from '@ce/contracts';
import { createProposalSelection, validateSelectionMask } from '@ce/engine';
import { createApp } from '../../apps/api/src/app.js';
import { proposalSelectionKey, selectionSummary } from '../../apps/api/src/recalculation/proposal-selection-record.js';
import { selectionSnapshot } from '../helpers/iteration004-fixtures.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';

/** Directly seeded preview capacity, not a claim of importing or simulating 100,000 rules. */
it('keeps 100,000 selectable destinations server-side, pages compact, queries cooperative and edits below 1 MiB', async () => {
  const started = performance.now(), count = 100_000, input = selectionSnapshot(2), template = input.content.coordinates[0]!;
  const coordinates = Array.from({ length: count }, (_, n) => ({ ...template, factKey: `seeded-${n}`, rowCode: String(n).padStart(6, '0') }));
  const content: SnapshotContent = { ...input.content, coordinates, facts: [], directions: [] };
  const app = await createApp({ workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { 'select-proposals': new URL('../../apps/api/dist/workers/select-proposals.worker.js', import.meta.url) } });
  onTestFinished(() => app.close());
  const headers = { host: '127.0.0.1:3000', 'x-ce-session': '' }; headers['x-ce-session'] = (await app.inject({ url: '/api/v1/bootstrap', headers })).json().sessionToken;
  const workspace = app.ce.store.create('volume synthetic'), snapshot = app.ce.store.publish(workspace.id, undefined, content), id = randomUUID();
  const exact = { numerator: '1', denominator: '1' }, after = { normalizedValue: exact, originalText: '1', decimals: '2', unit: 'EUR' };
  const proposals: ProposalDTO[] = coordinates.map((coordinate, n) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, previewId: id, directionId: 'a'.repeat(64), instanceId: 'b'.repeat(64), variantIds: [], binding: { contextId: coordinate.contextId }, code: `ROW_${String(n).padStart(6, '0')}`, targetKey: coordinate.factKey,
    before: { factKey: coordinate.factKey, coordinate, presence: 'implicit_null', sourceLocator: {} }, after, exactNominal: exact, derivedInterval: { lo: exact, hi: exact },
    readKeys: [], predecessorIds: [], metadataReads: [], sources: [], diagnostics: [], state: 'available' }));
  const bundle: PreviewBundle = { preview: { id, baseVersionId: snapshot.versionId, profileId: snapshot.content.profileId, policyId: 'half-even-v1', createdAt: new Date().toISOString(), state: 'ready', proposalIds: proposals.map(p => p.id), graphSummary: { nodes: count, edges: 0, order: [], conflicts: [], cycles: [], blocked: 0 }, diagnostics: [] }, proposals };
  const projection = createProposalSelection(bundle, 'available'), selection = { summary: selectionSummary({ id: randomUUID(), workspaceId: workspace.id, previewId: id, baseVersionId: snapshot.versionId, revision: 1, state: 'ready', initializationJobId: randomUUID() }, projection), projection };
  app.ce.store.putRecords([{ key: `preview:${workspace.id}:${id}`, value: bundle as unknown as JsonValue }, { key: proposalSelectionKey(workspace.id, id), value: selection as unknown as JsonValue }]);
  const prefix = `/api/v1/workspaces/${workspace.id}/previews/${id}`, state = prefix + '/selection-state';
  let ticks = 0; const timer = setInterval(() => ticks++, 1); const queryStart = performance.now();
  const page = await app.inject({ url: state + '/rows?limit=50', headers }); clearInterval(timer); const queryMs = Math.round(performance.now() - queryStart);
  expect(page.statusCode, page.body).toBe(200); expect(page.json()).toMatchObject({ total: count, summary: { selectedCount: count }, filterCounts: { available: count, selected: count, selectedOutsidePage: count - 50 } });
  expect(page.json().items).toHaveLength(50); expect(Buffer.byteLength(page.body)).toBeLessThan(1024 * 1024); expect(ticks).toBeGreaterThan(1);
  expect(page.body).not.toMatch(/predecessorIds|variantIds|readKeys|metadataReads|"proposalIds"/);
  const compact = await app.inject({ url: prefix + '?compact=true', headers }); expect(compact.statusCode).toBe(200); expect(Buffer.byteLength(compact.body)).toBeLessThan(2048); expect(compact.json()).not.toHaveProperty('proposalIds');
  const body = { selectionId: selection.summary.id, expectedRevision: 1, operations: [{ op: 'clear' }] };
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1024);
  const edit = await app.inject({ method: 'POST', url: state + '/edits', headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: body }); expect(edit.statusCode, edit.body).toBe(202);
  let job: any; const workerStart = performance.now();
  do { job = (await app.inject({ url: `/api/v1/workspaces/${workspace.id}/jobs/${edit.json().jobId}`, headers })).json(); if (['succeeded', 'failed', 'cancelled', 'timed_out'].includes(job.status)) break; await new Promise(r => setTimeout(r, 20)); } while (performance.now() - workerStart < 60_000);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); const final = (await app.inject({ url: state, headers })).json(); expect(final).toMatchObject({ revision: 2, selectedCount: 0, requiredCount: 0 });
  const workerMs = Math.round(performance.now() - workerStart);
  const selecting = await app.inject({ method: 'POST', url: state + '/edits', headers: { ...headers, 'if-match': app.ce.store.etag(workspace.id), 'idempotency-key': randomUUID() }, payload: { selectionId: selection.summary.id, expectedRevision: 2, operations: [{ op: 'selectMatching', filter: {} }] } });
  expect(selecting.statusCode).toBe(202);
  const cancelled = await app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${workspace.id}/jobs/${selecting.json().jobId}`, headers }); expect(cancelled.json().status).toBe('cancelled');
  expect((await app.inject({ url: state, headers })).json()).toEqual(final); expect(app.ce.store.current(workspace.id)).toBe(snapshot);
  const measurements = { positions: count, queryMs, workerMs, totalMs: Math.round(performance.now() - started), responseBytes: Buffer.byteLength(page.body), requestBytes: Buffer.byteLength(JSON.stringify(body)), stateBytes: app.ce.store.bytes, processRssAtEnd: process.memoryUsage().rss, eventLoopTicks: ticks, cancellationPreservedRevision: final.revision };
  await mkdir(path.resolve('.cache/verification-004'), { recursive: true });
  await writeFile(path.resolve('.cache/verification-004/selection-volume-' + Date.now() + '.json'), JSON.stringify(measurements, null, 2));
  console.info('selection-volume-004', JSON.stringify(measurements));
}, 120_000);

it('bounds a million-bit representation and rejects quota excess before changing the prior state', () => {
  const length = 1_000_000, bytes = Buffer.alloc(Math.ceil(length / 8)), blocks: string[] = [];
  for (let n = 0; n < bytes.length; n += 4096) blocks.push(bytes.subarray(n, n + 4096).toString('base64'));
  const mask = { length, blocks }; expect(() => validateSelectionMask(mask)).not.toThrow(); expect(Buffer.byteLength(JSON.stringify(mask))).toBeLessThan(170_000);
  expect(() => validateSelectionMask({ ...mask, length: length + 1 })).toThrow();
  const store = new WorkspaceStore({ maxBytes: 64 * 1024 }), workspace = store.create('quota'); store.putInternalRecord('sentinel', { value: 'retained' }); const before = store.bytes;
  expect(() => store.putInternalRecord('oversized-selection', mask)).toThrow(); expect(store.bytes).toBe(before); expect(store.getRecord('sentinel')).toEqual({ value: 'retained' }); expect(store.getRecord('oversized-selection')).toBeUndefined(); store.close(workspace.id);
});
