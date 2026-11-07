import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { selectionHarness } from '../helpers/proposal-selection-harness.js';

describe('selection reference application through production workers', () => {
  it('publishes preselection once, rejects mixed body, applies an exact revision and replays after base changes', async () => {
    const h = await selectionHarness();
    expect(h.selection).toMatchObject({ revision: 1, state: 'ready', selectedCount: 5, requiredCount: 0, initializationJobId: h.previewJob.jobId });
    const body = await h.applicationBody(), rows = (await h.getSelection('/rows?limit=200')).json();
    expect((await h.applySelection({ ...body, selectedIds: rows.items.map((r: any) => r.id) })).statusCode).toBe(400);
    const key = randomUUID(), etag = h.etag(), response = await h.applySelection(body, key, etag);
    expect(response.statusCode, response.body).toBe(202); const completed = await h.finish(response.json().jobId);
    expect(completed.status, JSON.stringify(completed.diagnostics)).toBe('succeeded');
    expect((await h.applySelection(body, key, etag)).json().jobId).toBe(completed.jobId);
    const legacy = await h.app.inject({ url: h.base + '/applications/' + completed.resultRef!.id, headers: h.headers });
    const compact = await h.app.inject({ url: h.base + '/applications/' + completed.resultRef!.id + '?includeAcceptedIds=false', headers: h.headers });
    expect(legacy.statusCode).toBe(200); expect(compact.statusCode).toBe(200);
    expect(legacy.json().receipt.acceptedIds).toHaveLength(5);
    expect(compact.json().receipt).toMatchObject({ newVersionId: completed.newVersionId, acceptedCount: 5, selectionRef: body.selectionRef });
    expect(compact.json().receipt).not.toHaveProperty('acceptedIds'); expect((await h.getSelection()).json().state).toBe('applied');
  });
  it('rejects an obsolete selection revision without writing any facts', async () => {
    const h = await selectionHarness(), original = await h.applicationBody();
    await h.editSelection([{ op: 'clear' }]);
    const response = await h.applySelection(original); expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STALE_PROPOSAL_SELECTION'); expect(h.store.current(h.workspace.id)?.versionId).toBe(h.configuredSnapshot.versionId);
  });
  it('legacy arrays and reference apply produce the same values while only reference seals its record', async () => {
    const ref = await selectionHarness(), legacy = await selectionHarness();
    const response = await ref.applySelection(await ref.applicationBody()); expect(response.statusCode).toBe(202);
    expect((await ref.finish(response.json().jobId)).status).toBe('succeeded');
    const rows = (await legacy.getSelection('/rows?limit=200')).json(); const current = (await legacy.getSelection()).json();
    const oldResponse = await legacy.applySelection({ baseVersionId: legacy.configuredSnapshot.versionId, previewId: legacy.previewId, selectedIds: rows.items.map((r: any) => r.id), closureHash: current.closureHash });
    expect(oldResponse.statusCode, oldResponse.body).toBe(202); expect((await legacy.finish(oldResponse.json().jobId)).status).toBe('succeeded');
    const values = (h: typeof ref) => h.store.current(h.workspace.id)!.content.facts.map(f => [f.rowCode, f.normalizedValue]);
    expect(values(ref)).toEqual(values(legacy)); expect((await legacy.getSelection()).json().state).toBe('obsolete');
  });
});
