import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { conflictSnapshot, iterationSnapshot } from '../helpers/iteration004-fixtures.js';
import { reviewHarness } from '../helpers/direction-review-harness.js';

it('retains resolved/omitted groups and pages the complete eligible candidate catalog', async () => {
  const h = await reviewHarness({ content: conflictSnapshot(51).content }), view = await h.ready();
  const base = '/' + view.id + '/groups';
  const response = await h.get(base);
  expect(response.statusCode, response.body).toBe(200);
  const first = response.json();
  expect(first).toMatchObject({ reviewId: view.id, revision: 1, total: 1, items: [{ candidateCount: 51, activeCount: 51, state: 'conflicted' }] });
  const groupId = first.items[0].groupId;
  const path = base + '/' + groupId + '/candidates';
  const page = (await h.get(path)).json();
  expect(page.items).toHaveLength(50); expect(page.total).toBe(51);
  const maximumPage = (await h.get(path + '?limit=200')).json();
  expect(maximumPage.items).toHaveLength(51); expect(maximumPage.nextCursor).toBeNull();
  const last = (await h.get(path + '?cursor=' + encodeURIComponent(page.nextCursor))).json().items[0];
  expect(last.code).toBe('CANDIDATE_051');
  const mutation = randomUUID(), operation = { op: 'resolveGroup', groupId, winnerInstanceId: last.instanceId };
  const chosen = await h.edit(view.id, 1, [operation], mutation);
  expect(chosen.statusCode, chosen.body).toBe(200);
  expect((await h.get(base)).json().items[0]).toMatchObject({ state: 'resolved', candidateCount: 51, activeCount: 1, selectedCandidate: { code: last.code } });
  expect((await h.get(path + '?cursor=' + encodeURIComponent(page.nextCursor))).json().error.code).toBe('INVALID_CURSOR');
  expect((await h.edit(view.id, 2, [{ ...operation, winnerInstanceId: page.items[0].instanceId }])).json().appliedRevision).toBe(3);
  expect((await h.edit(view.id, 3, [{ ...operation, winnerInstanceId: null }])).json().appliedRevision).toBe(4);
  expect((await h.get(base)).json().items[0]).toMatchObject({ state: 'omitted', candidateCount: 51, activeCount: 0 });
  expect((await h.edit(view.id, 1, [operation], mutation)).json().appliedRevision).toBe(2);
  expect((await h.edit(view.id, 1, [{ ...operation, winnerInstanceId: null }], mutation)).json().error.code).toBe('IDEMPOTENCY_CONFLICT');
  expect((await h.edit(view.id, 3, [operation])).json().error.code).toBe('STALE_DIRECTION_REVIEW');
  expect(h.store.current(h.workspace.id)).toBe(h.snapshot);
});

it('enforces closed queries, limits, resource ownership, signed scope and expiry without extending the deadline', async () => {
  const h = await reviewHarness(), view = await h.ready(), base = '/' + view.id + '/groups';
  expect((await h.get(base)).statusCode).toBe(200);
  const first = (await h.get(base + '?limit=1')).json();
  const group = first.items[0], candidates = base + '/' + group.groupId + '/candidates';
  const candidate = (await h.get(candidates)).json().items[0];
  for (const suffix of [base, candidates]) {
    for (const query of ['limit=0', 'limit=201', 'limit=1.5', 'extra=1', 'cursor=' + 'x'.repeat(8193)]) {
      expect((await h.get(suffix + '?' + query)).statusCode).toBe(400);
    }
    expect((await h.app.inject({ url: h.url + suffix, headers: { host: h.headers.host } })).statusCode).toBe(403);
    expect((await h.app.inject({ url: h.url.replace(h.workspace.id, randomUUID()) + suffix, headers: h.headers })).statusCode).toBe(404);
  }
  expect((await h.get(candidates + '?cursor=' + encodeURIComponent(first.nextCursor))).json().error.code).toBe('INVALID_CURSOR');
  expect((await h.get(base + '/' + 'f'.repeat(64) + '/candidates')).statusCode).toBe(404);
  expect((await h.get(candidates + '/' + 'f'.repeat(64))).statusCode).toBe(404);
  expect((await h.get(candidates + '/invalid')).statusCode).toBe(400);
  expect((await h.get(candidates + '/' + candidate.instanceId + '?limit=1')).statusCode).toBe(400);
  h.advance(899_999);
  expect((await h.get(candidates)).statusCode).toBe(200);
  expect((await h.get('/' + view.id)).json().expiresAt).toBe(view.expiresAt);
  h.advance(1);
  for (const suffix of [base, candidates, candidates + '/' + candidate.instanceId]) {
    expect((await h.get(suffix)).json().error.code).toBe('DIRECTION_REVIEW_EXPIRED');
  }
});

it('returns bounded previews and exact source text only in the requested individual candidate', async () => {
  const snapshot = conflictSnapshot(2);
  const variants = snapshot.content.catalog.variants.map((variant, index) => ({ ...variant,
    expression: variant.expression + ' '.repeat(700), precondition: 'true',
    sourceRecords: [variant.code, variant.code + '-duplicate'],
  }));
  const records = variants.flatMap((variant, index) => variant.sourceRecords.map((id, copy) => ({
    id, code: variant.code, variantId: variant.variantId, sourceLocator: { sheet: 'Rules', row: index * 2 + copy + 2 },
    originalFields: { Description: '<b>plain source</b>' + 'Á'.repeat(700) }, diagnostics: [],
  })));
  const h = await reviewHarness({ content: { ...snapshot.content, catalog: { ...snapshot.content.catalog, variants, records } } });
  const view = await h.ready(), base = '/' + view.id + '/groups';
  const list = await h.get(base); expect(list.statusCode).toBe(200);
  const group = list.json().items[0], path = base + '/' + group.groupId + '/candidates';
  const page = (await h.get(path)).json();
  const row = page.items[0];
  expect(row).toMatchObject({ descriptionTruncated: true, expressionTruncated: true });
  expect(row.descriptionPreview).toHaveLength(512); expect(row.expressionPreview).toHaveLength(512);
  expect(JSON.stringify(row)).not.toMatch(/"(?:factKey|targetKey|ast|factReads|variantIds)":/);
  const detail = (await h.get(path + '/' + row.instanceId)).json();
  expect(detail).toMatchObject({ reviewId: view.id, revision: 1, candidate: { instanceId: row.instanceId }, expression: variants[0]!.expression, precondition: 'true' });
  expect(detail.descriptions).toHaveLength(1);
  expect(detail.descriptions[0]).toEqual({ description: records[0]!.originalFields.Description, sourceLabel: 'Catálogo · Rules · fila 2' });
});

it('rejects assignedElsewhere without moving the producer and keeps other destinations when choosing another candidate', async () => {
  const snapshot = iterationSnapshot([
    { code: 'A', expression: '{tT,r0010,c0010}=1' },
    { code: 'B', expression: '{tT,r0010,c0010}={tT,r0020,c0010}' },
  ], ['0010', '0020']);
  const h = await reviewHarness({ content: snapshot.content }), view = await h.ready();
  const rows = (await h.get('/' + view.id + '/rows')).json().items;
  expect((await h.edit(view.id, 1, [{ op: 'set', instanceId: rows[1].instanceId, choice: 'left' }])).statusCode).toBe(200);
  const base = '/' + view.id + '/groups', groupId = (await h.get(base)).json().items[0].groupId;
  expect((await h.edit(view.id, 2, [{ op: 'resolveGroup', groupId, winnerInstanceId: rows[1].instanceId }])).statusCode).toBe(200);
  expect((await h.edit(view.id, 3, [{ op: 'set', instanceId: rows[1].instanceId, choice: 'right' }])).statusCode).toBe(200);
  const failed = await h.edit(view.id, 4, [{ op: 'resolveGroup', groupId, winnerInstanceId: rows[1].instanceId }]);
  expect(failed.statusCode).toBe(409);
  expect(failed.json().error).toMatchObject({ code: 'GROUP_CANDIDATE_ASSIGNED_ELSEWHERE', message: 'Esta regla ya tiene otro destino elegido. Revisa su destino antes de seleccionarla aquí.' });
  expect((await h.get('/' + view.id)).json().revision).toBe(4);
  expect((await h.edit(view.id, 4, [{ op: 'resolveGroup', groupId, winnerInstanceId: rows[0].instanceId }])).json().summary.counts.included).toBe(2);
  expect((await h.get('/' + view.id + '/rows')).json().items[1].selectedSide).toBe('right');
});
