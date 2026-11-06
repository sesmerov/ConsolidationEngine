import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it, onTestFinished } from 'vitest';
import { EBA_HEADERS } from '@ce/contracts';
import { deterministicZip, workbookParts } from '../../scripts/lib/visual-xlsx.mjs';
import { inspectWorkspace } from '../../apps/api/src/import/import-workspace.js';
import { cleanupVisualExports, visualDirectory, visualOperation, visualStaged } from '../helpers/visual-export-harness.js';
import { reviewHarness } from '../helpers/direction-review-harness.js';

it('checks local session, origin, ownership, ETag, run, UUID, size and closed request schemas', async () => {
  const h = await reviewHarness();
  for (const headers of [{ host: h.headers.host }, { ...h.headers, origin: 'https://external.invalid' }]) {
    expect((await h.app.inject({ url: h.url, headers })).statusCode).toBe(403);
  }
  expect((await h.app.inject({ url: h.url.replace(h.workspace.id, randomUUID()), headers: h.headers })).statusCode).toBe(404);
  expect((await h.prepare(randomUUID(), null)).statusCode).toBe(428);
  expect((await h.prepare(randomUUID(), '"stale"')).statusCode).toBe(412);
  expect((await h.mutation('POST', '', h.input, 'wrong-key')).statusCode).toBe(400);
  expect((await h.prepare(randomUUID(), h.etag(), { ...h.input, runId: randomUUID() })).statusCode).toBe(404);
  for (const body of [{ ...h.input, runId: 'x' }, { ...h.input, baseVersionId: 'x' }, { ...h.input, ast: {} }]) {
    expect((await h.mutation('POST', '', body, randomUUID())).statusCode).toBe(400);
  }
  expect((await h.get('/' + randomUUID())).statusCode).toBe(404);
  const view = await h.ready(), suffix = '/' + view.id;
  for (const query of ['limit=0', 'limit=201', 'state=custom', 'extra=1']) {
    expect((await h.get(suffix + '/rows?' + query)).statusCode).toBe(400);
  }
  for (const operations of [[], Array.from({ length: 201 }, () => ({ op: 'omitAll' })), [{ op: 'omitAll', factKey: 'forged' }]]) {
    expect((await h.edit(view.id, 1, operations)).statusCode).toBe(400);
  }
  expect((await h.mutation('PATCH', suffix, { expectedRevision: 1, mutationId: 'x', operations: [{ op: 'omitAll' }] })).statusCode).toBe(400);
  expect((await h.mutation('PATCH', suffix, { data: 'x'.repeat(1024 * 1024) })).statusCode).toBe(413);
  expect((await h.mutation('DELETE', suffix, undefined, undefined, null)).statusCode).toBe(428);
  expect((await h.mutation('DELETE', suffix)).json().state).toBe('discarded');
  expect((await h.mutation('DELETE', suffix)).json().state).toBe('discarded');
  expect((await h.get()).json()).toEqual({ active: null });
});

it('pages complete conflict groups, rejects stale cursors, resolves CAS and both POST replays without double publication', async () => {
  const h = await reviewHarness(), originalTag = h.etag(), prepareKey = randomUUID();
  const preparing = await h.prepare(prepareKey);
  expect(preparing.statusCode, preparing.body).toBe(202);
  const admitted = preparing.json(); expect(admitted.kind).toBe('prepare-directions');
  const prepared = await h.finish(admitted.jobId);
  expect(prepared.status, JSON.stringify(prepared.diagnostics)).toBe('succeeded');
  expect(prepared.resultRef?.type).toBe('direction-review');
  const id = prepared.resultRef!.id, suffix = '/' + id;
  expect((await h.get()).json().active).toMatchObject({ id, ...h.input, state: 'ready', revision: 1,
    counts: { included: 4, conflicted: 5, excluded: 7, totalRows: 16 }, conflictGroupCount: 2 });
  expect((await h.prepare()).json().error.code).toBe('DIRECTION_REVIEW_EXISTS');
  const first = (await h.get(suffix + '/rows?state=conflicted&limit=1')).json();
  expect(first).toMatchObject({ reviewId: id, revision: 1, total: 5 }); expect(first.items).toHaveLength(1);
  expect(JSON.stringify(first.items)).not.toMatch(/"(?:factKey|targetKey|ast|factReads)":/);
  const cursor = encodeURIComponent(first.nextCursor);
  const second = (await h.get(suffix + '/rows?state=conflicted&limit=1&cursor=' + cursor)).json();
  expect(second.items[0].rowId).not.toBe(first.items[0].rowId);
  for (const query of ['state=included&cursor=' + cursor, 'cursor=tampered']) {
    expect((await h.get(suffix + '/rows?' + query)).json().error.code).toBe('INVALID_CURSOR');
  }
  const unresolved = await h.commit(id, 1, true);
  expect(unresolved.statusCode).toBe(409);
  const all = (await h.get(suffix + '/rows?state=conflicted')).json().items as { code: string; instanceId: string; groupId: string }[];
  const winner = all.find(row => row.code === 'v0174_m')!, other = all.find(row => row.code === 'DEMO_ZERO')!;
  const group = (await h.get(suffix + '/rows?groupId=' + encodeURIComponent(winner.groupId) + '&limit=1')).json();
  expect(group.total).toBe(3); expect(group.items[0].producerCount).toBe(3);
  const resolve = { op: 'resolveGroup', groupId: winner.groupId, winnerInstanceId: winner.instanceId };
  const editKey = randomUUID();
  const invalid = await h.edit(id, 1, [resolve, { ...resolve, groupId: other.groupId }]);
  expect(invalid.statusCode).toBe(422); expect((await h.get(suffix)).json().revision).toBe(1);
  const chosen = await h.edit(id, 1, [resolve], editKey);
  expect(chosen.json()).toMatchObject({ appliedRevision: 2, summary: { revision: 2, counts: { included: 5, omitted: 2, conflicted: 2 } } });
  expect((await h.get(suffix + '/rows?state=conflicted&cursor=' + cursor)).json().error.code).toBe('INVALID_CURSOR');
  const omit = { op: 'resolveGroup', groupId: other.groupId, winnerInstanceId: null };
  expect((await h.edit(id, 1, [omit])).json().error.code).toBe('STALE_DIRECTION_REVIEW');
  expect((await h.edit(id, 2, [omit])).json()).toMatchObject({ appliedRevision: 3, summary: { counts: { included: 5, omitted: 4, excluded: 7, conflicted: 0 } } });
  expect((await h.edit(id, 1, [resolve], editKey)).json().appliedRevision).toBe(2);
  expect((await h.edit(id, 1, [omit], editKey)).statusCode).toBe(409);
  expect((await h.get(suffix)).json().revision).toBe(3);
  const key = randomUUID(), committing = await h.commit(id, 3, false, key);
  expect(committing.statusCode, committing.body).toBe(202);
  const published = await h.finish(committing.json().jobId);
  expect(published).toMatchObject({ kind: 'commit-directions', status: 'succeeded' });
  const current = h.store.current(h.workspace.id)!;
  expect(current.content.facts).toEqual(h.snapshot.content.facts);
  expect(current.content.directions).toHaveLength(5);
  const receipt = { reviewId: id, ...h.input, newVersionId: current.versionId, configVersion: current.content.configVersion, included: 5 };
  expect((await h.get()).json()).toEqual({ active: null, latestCommit: receipt });
  expect((await h.get(suffix)).json()).toMatchObject({ state: 'committed', receipt });
  expect((await h.commit(id, 3, false, key, originalTag)).json().jobId).toBe(published.jobId);
  expect((await h.commit(id, 3, true, key, originalTag)).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await h.commit(randomUUID(), 3, false, key, originalTag)).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await h.prepare(prepareKey, originalTag)).json().jobId).toBe(prepared.jobId);
  expect(h.store.get(h.workspace.id).versionIds).toEqual([h.snapshot.versionId, current.versionId]);
});

it('requires partial consent on two eligible sides, distinguishes deferred intent from explicit empty replacement', async () => {
  const directory = await visualDirectory(); onTestFinished(cleanupVisualExports);
  const location = path.join(directory, 'ambiguous.xlsx');
  await writeFile(location, deterministicZip(workbookParts([{ name: 'Rules', rows: [EBA_HEADERS, [
    'AMBIGUOUS', 'SYNTHETIC', 'COREP', 'COREP_OF_4.0', 'No', 'C_01.00', 'with {tC_01.00,c0010}: {r0010}={r0020}',
    '', '', 'Active', '2025-01-01', '', 'Error', '', 'No',
  ]] }])));
  const files = [await visualStaged(location, 'catalog'), await visualStaged(path.resolve('assets/demos/demo-corep-report.xlsx'), 'report')];
  const candidate = await inspectWorkspace(files, visualOperation, { source: 'workbook' });
  const h = await reviewHarness({ content: candidate.content }), view = await h.ready();
  expect(view.counts).toMatchObject({ pending: 1, included: 0 });
  const [row] = (await h.get('/' + view.id + '/rows')).json().items;
  expect(row.classification).toBe('both');
  expect((await h.commit(view.id, 1, false)).statusCode).toBe(409);
  const accepted = await h.commit(view.id, 1, true);
  expect(accepted.statusCode).toBe(202);
  expect((await h.finish(accepted.json().jobId)).status).toBe('succeeded');
  expect((await h.get()).json().latestCommit.included).toBe(0);
  const body = h.validate(), prepared = await h.prepare(randomUUID(), h.etag(), body);
  const next = await h.finish(prepared.json().jobId);
  const newId = next.resultRef!.id;
  expect((await h.get('/' + newId)).json().counts.pending).toBe(1);
  expect((await h.edit(newId, 1, [{ op: 'set', instanceId: row.instanceId, choice: 'right' }])).json().summary.counts.included).toBe(1);
  expect((await h.edit(newId, 2, [{ op: 'omitAll' }])).json().summary.counts.omitted).toBe(1);
  const empty = await h.commit(newId, 3);
  expect((await h.finish(empty.json().jobId)).status).toBe('succeeded');
  expect(h.store.current(h.workspace.id)!.content.directions).toEqual([]);
});
