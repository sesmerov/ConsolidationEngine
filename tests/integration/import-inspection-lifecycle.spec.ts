import { randomUUID } from 'node:crypto';
import { access, appendFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../apps/api/src/errors.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { canonicalStateBytes } from '../../apps/api/src/session/canonical-state.js';
import { inspectionHarness, inspectionMultipart, inspectionTick, type InspectionView } from '../helpers/inspection-lifecycle-harness.js';

const harnesses: Awaited<ReturnType<typeof inspectionHarness>>[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(harnesses.splice(0).map(h => h.close())); });
async function setup(options: Parameters<typeof inspectionHarness>[0] = {}) { const h = await inspectionHarness(options); harnesses.push(h); return h; }
async function accepted(h: Awaited<ReturnType<typeof setup>>) {
  const response = await h.start(); expect(response.statusCode, response.body).toBe(202); await inspectionTick(); return response.json().jobId as string;
}
async function committed(h: Awaited<ReturnType<typeof setup>>, view: InspectionView) {
  const response = await h.commit(view); expect(response.statusCode, response.body).toBe(202); await inspectionTick(); return h.finish(h.requests.length - 1);
}

describe('bounded import inspection lifecycle (real HTTP/operation logic; explicitly controlled scheduling)', () => {
  it.each([true, false])('publishes only a ready inspection, without a snapshot slot, changed ETag or old snapshot in the worker (empty=%s)', async empty => {
    const h = await setup({ empty, store: new WorkspaceStore({ maxSnapshots: 1 }) }), bytesBefore = h.app.ce.store.bytes;
    const view = await h.ready();
    expect(view.state).toBe('ready'); expect(view.baseVersionId).toBe(h.base?.versionId);
    expect(h.app.ce.store.current(h.workspace.id)).toBe(h.base); expect(h.app.ce.store.get(h.workspace.id).versionIds).toEqual(h.originalVersions);
    expect(h.app.ce.store.etag(h.workspace.id)).toBe(h.originalETag); expect(h.requests[0]!.snapshot).toBeUndefined();
    expect(JSON.stringify(h.requests[0])).not.toContain('PREVIOUS_SNAPSHOT_SENTINEL'); expect(h.requests[0]!.job.baseVersionId).toBe(h.base?.versionId);
    const usage = h.app.ce.files.usage(h.workspace.id); expect(usage.retainedBytes + usage.reservedBytes).toBe((await inspectionMultipart()).fileBytes);
    expect(h.app.ce.store.bytes).toBeGreaterThan(bytesBefore + 10_000);
    expect(h.app.ce.store.listRecords('reserve:')).toEqual([]); expect(h.app.ce.store.listRecords('operation:')).toEqual([]);
    expect((await h.active()).json().active.id).toBe(view.id);
  });

  it('allows one ready inspection, discards explicitly, keeps a charged minimal tombstone and releases every private file', async () => {
    const h = await setup(), view = await h.ready(), retained = h.app.ce.store.bytes;
    const duplicate = await h.start(); expect(duplicate.statusCode).toBe(409); expect(duplicate.json().error.code).toBe('IMPORT_INSPECTION_EXISTS');
    expect(h.requests).toHaveLength(1); expect((await h.discard(view.id)).json().state).toBe('discarded');
    expect((await h.discard(view.id)).json().state).toBe('discarded'); expect((await h.active()).json()).toEqual({ active: null });
    const tombstone = (await h.get(view.id)).json(); expect(tombstone.state).toBe('discarded'); expect(JSON.stringify(tombstone)).not.toMatch(/"(?:candidate|facts|coordinates|path|ast)":/);
    expect(h.app.ce.store.bytes).toBeLessThan(retained); expect(h.app.ce.store.bytes).toBeGreaterThan(canonicalStateBytes([tombstone]));
    const records = h.app.ce.store.listRecords(''); expect(records.some(record => JSON.stringify(record.value).includes(view.id) && JSON.stringify(record.value).includes('discarded'))).toBe(true);
    await h.clean(); const replacement = await h.ready(); expect(replacement.id).not.toBe(view.id);
  });

  it('expires at the fixed 15-minute ready deadline; GET never renews it', async () => {
    const h = await setup(), view = await h.ready(); expect(Date.parse(view.expiresAt) - Date.parse(view.createdAt)).toBe(900_000);
    h.advance(899_999); const near = (await h.get(view.id)).json(); expect(near.state).toBe('ready'); expect(near.expiresAt).toBe(view.expiresAt);
    expect((await h.active()).json().active.expiresAt).toBe(view.expiresAt); h.advance(1);
    expect((await h.get(view.id)).json().state).toBe('expired'); expect((await h.active()).json()).toEqual({ active: null });
    const commit = await h.commit(view); expect(commit.statusCode).toBe(410); expect(commit.json().error.code).toBe('IMPORT_INSPECTION_EXPIRED'); await h.clean();
  });

  it('invalidates and releases a ready inspection when another publication changes its base', async () => {
    const h = await setup(), view = await h.ready();
    const newer = h.app.ce.store.publish(h.workspace.id, h.base!.versionId, { ...h.base!.content, configVersion: 'concurrent' });
    expect((await h.get(view.id)).json().state).toBe('invalidated'); expect((await h.active()).json()).toEqual({ active: null });
    const response = await h.commit(view, randomUUID(), h.originalETag); expect(response.statusCode).toBe(412); expect(response.json().error.code).toBe('STALE_VERSION');
    expect(h.app.ce.store.current(h.workspace.id)).toBe(newer); expect(h.app.ce.files.usage(h.workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 });
    expect(await readdir(h.app.ce.files.workspacePath(h.workspace.id))).toEqual([]);
  });

  it('requires the exact inspection hash and explicit acceptance before starting a commit Job', async () => {
    const h = await setup(), view = await h.ready(); expect(view.requiresPartialCoverageAcceptance).toBe(true);
    const missing = await h.commit(view, randomUUID(), h.originalETag, false); expect(missing.statusCode).toBe(409); expect(missing.json().error.code).toBe('PARTIAL_COVERAGE_NOT_ACCEPTED');
    const wrong = await h.commit({ ...view, inspectionHash: '0'.repeat(64) }); expect(wrong.statusCode).toBe(409); expect(wrong.json().error.code).toBe('IMPORT_INSPECTION_NOT_APPLICABLE');
    expect(h.requests).toHaveLength(1); expect((await h.get(view.id)).json().state).toBe('ready'); expect(h.app.ce.store.current(h.workspace.id)).toBe(h.base);
  });

  it('commits once, releases private copies, preserves normalized provenance and replays before stale ETag/TTL checks', async () => {
    const h = await setup(), view = await h.ready(), key = randomUUID();
    const priorFile = await h.app.ce.files.write(h.workspace.id, Buffer.from('existing legacy source outside this inspection'));
    const privateFiles = (await readdir(h.app.ce.files.workspacePath(h.workspace.id))).filter(id => id !== priorFile.id);
    const first = await h.commit(view, key); expect(first.statusCode).toBe(202); await inspectionTick(); const job = await h.finish(1);
    expect(job.status).toBe('succeeded'); const current = h.app.ce.store.current(h.workspace.id)!;
    expect(current.versionId).toBe(job.newVersionId); expect(h.app.ce.store.get(h.workspace.id).versionIds).toHaveLength(h.originalVersions.length + 1);
    const detail = (await h.get(view.id)).json(); expect(detail).toMatchObject({ state: 'committed', committedVersionId: current.versionId, commitJobId: job.jobId });
    // Visual import keeps normalized facts, hashes and bindings; its private workbook copies are released.
    expect(current.content.coordinates).toHaveLength(110); expect(current.content.reportSourceBindings).toHaveLength(1);
    expect(current.content.sources.every(source => /^[0-9a-f]{64}$/.test(source.sha256))).toBe(true);
    expect(h.app.ce.files.usage(h.workspace.id)).toMatchObject({ reservedBytes: 0, retainedBytes: priorFile.size });
    for (const id of privateFiles) await expect(access(path.join(h.app.ce.files.workspacePath(h.workspace.id), id))).rejects.toThrow();
    expect(await readFile(priorFile.path, 'utf8')).toBe('existing legacy source outside this inspection');
    h.advance(901_000); const replay = await h.commit(view, key, h.originalETag); expect(replay.statusCode).toBe(202); expect(replay.json().jobId).toBe(job.jobId);
    expect(h.requests).toHaveLength(2); expect(h.app.ce.store.current(h.workspace.id)).toBe(current);
    const changedBody = await h.commit(view, key, h.originalETag, false); expect(changedBody.statusCode).toBe(409);
    expect((await h.discard(view.id)).statusCode).toBe(409); expect(h.app.ce.store.current(h.workspace.id)).toBe(current);
  });

  it('accepts at most one of two concurrent commits and rejects discard while committing', async () => {
    const h = await setup(), view = await h.ready(); const replies = await Promise.all([h.commit(view), h.commit(view)]);
    expect(replies.map(reply => reply.statusCode).sort()).toEqual([202, 409]); await inspectionTick(); expect(h.requests).toHaveLength(2);
    const detail = (await h.get(view.id)).json(); expect(detail.state).toBe('committing'); expect(detail.commitJobId).toBe(replies.find(reply => reply.statusCode === 202)!.json().jobId);
    expect((await h.discard(view.id)).statusCode).toBe(409); expect((await h.finish(1)).status).toBe('succeeded');
    expect(h.app.ce.store.get(h.workspace.id).versionIds).toHaveLength(h.originalVersions.length + 1);
  });

  it('rejects altered retained bytes before commit without reparsing or publishing a replacement', async () => {
    const h = await setup(), view = await h.ready(), directory = h.app.ce.files.workspacePath(h.workspace.id);
    const owned = (await readdir(directory))[0]!; await appendFile(path.join(directory, owned), Buffer.from('tampered after inspection'));
    const response = await h.commit(view); expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('IMPORT_INSPECTION_NOT_APPLICABLE');
    expect(h.requests).toHaveLength(1); expect((await h.get(view.id)).json().state).toBe('invalidated'); await h.clean();
  });

  it('an accepted commit retains its lease across inspection expiry and can finish within its Job deadline', async () => {
    const h = await setup(), view = await h.ready(); h.advance(899_999);
    const response = await h.commit(view); expect(response.statusCode).toBe(202); await inspectionTick(); h.advance(2);
    expect((await h.get(view.id)).json().state).toBe('committing'); expect((await h.active()).json().active.id).toBe(view.id);
    const job = await h.finish(1); expect(job.status).toBe('succeeded'); expect(h.app.ce.store.current(h.workspace.id)!.versionId).toBe(job.newVersionId);
  });

  it('cancels a commit without mutation and restores ready while its original TTL and files remain valid', async () => {
    const h = await setup(), view = await h.ready(); const response = await h.commit(view); expect(response.statusCode).toBe(202); await inspectionTick();
    const cancelled = await h.cancel(response.json().jobId); expect(cancelled.json().status).toBe('cancelled'); expect(h.workers[1]!.terminated).toBe(true);
    const restored = (await h.get(view.id)).json(); expect(restored.state).toBe('ready'); expect(restored.expiresAt).toBe(view.expiresAt);
    expect(h.app.ce.store.current(h.workspace.id)).toBe(h.base); expect((await committed(h, view)).status).toBe('succeeded');
  });

  it('releases an expired inspection after an accepted commit fails instead of restoring ready', async () => {
    const h = await setup(), view = await h.ready(); h.advance(899_999); const response = await h.commit(view); expect(response.statusCode).toBe(202); await inspectionTick(); h.advance(2);
    h.workers[1]!.emit('error', new Error('controlled commit crash')); expect((await h.settle(response.json().jobId)).status).toBe('failed');
    expect((await h.get(view.id)).json().state).toBe('expired'); await h.clean();
  });

  it.each(['failure', 'cancel'] as const)('cleans a %s during inspection and ignores late worker publication', async outcome => {
    const h = await setup(), jobId = await accepted(h);
    if (outcome === 'failure') h.workers[0]!.emit('error', new Error('controlled parser failure'));
    else expect((await h.cancel(jobId)).json().status).toBe('cancelled');
    const job = await h.settle(jobId); expect(job.status).toBe(outcome === 'failure' ? 'failed' : 'cancelled');
    h.workers[0]!.complete({ complete: true, snapshotContent: h.base!.content }); await inspectionTick();
    expect((await h.active()).json()).toEqual({ active: null }); await h.clean();
  });

  it('terminates an unresponsive controlled inspection worker at the real Job deadline and cleans all reservations', async () => {
    const h = await setup({ deadlineMs: 40 }), jobId = await accepted(h), job = await h.settle(jobId);
    expect(job.status).toBe('timed_out'); expect(h.workers[0]!.terminated).toBe(true); expect((await h.active()).json()).toEqual({ active: null }); await h.clean();
  });

  it('cleans staging when atomic Job acceptance rejects the state quota (injected registerJob failure)', async () => {
    const h = await setup(); vi.spyOn(h.app.ce.store, 'registerJob').mockImplementationOnce(() => { throw new ApiError('SESSION_LIMIT'); });
    const response = await h.start(); expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('SESSION_LIMIT');
    expect(h.app.ce.store.listRecords('job:')).toEqual([]); expect(h.app.ce.store.listRecords('idempotency:')).toEqual([]); await h.clean();
  });

  it('charges the candidate against the actual state quota before publishing ready', async () => {
    const h = await setup({ store: new WorkspaceStore({ maxBytes: 32_000 }) }), jobId = await accepted(h);
    const job = await h.finish(0); expect(job.jobId).toBe(jobId); expect(job.status).toBe('failed');
    expect(job.diagnostics.some(d => d.code === 'SESSION_LIMIT')).toBe(true); expect((await h.active()).json()).toEqual({ active: null }); await h.clean();
  });

  it('charges reception reservations against the real file quota before accepting a Job', async () => {
    const h = await setup({ fileLimitBytes: 1024 * 1024 }), response = await h.start();
    expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('SESSION_LIMIT'); expect(h.requests).toHaveLength(0); await h.clean();
  });

  it('releases partial reception when a file exceeds its configured byte limit', async () => {
    const h = await setup({ uploadLimits: { maxFileBytes: 128 } }), response = await h.start();
    expect(response.statusCode).toBe(413); expect(h.requests).toHaveLength(0); await h.clean();
  });

  it('does not publish ready when the final publication fails (injected synchronous commit fault)', async () => {
    const h = await setup(), jobId = await accepted(h), output = await h.compute(0);
    vi.spyOn(h.app.ce.store, 'publishJobResult').mockImplementationOnce(() => { throw new ApiError('SESSION_LIMIT'); });
    h.workers[0]!.complete(output); expect((await h.settle(jobId)).status).toBe('failed'); expect((await h.active()).json()).toEqual({ active: null }); await h.clean();
  });

  it('restores ready after a commit publication fault without leaving a snapshot or Job reservation', async () => {
    const h = await setup(), view = await h.ready(), response = await h.commit(view); expect(response.statusCode).toBe(202); await inspectionTick();
    const output = await h.compute(1); vi.spyOn(h.app.ce.store, 'publishJobResult').mockImplementationOnce(() => { throw new ApiError('SESSION_LIMIT'); });
    h.workers[1]!.complete(output); expect((await h.settle(response.json().jobId)).status).toBe('failed');
    expect((await h.get(view.id)).json().state).toBe('ready'); expect(h.app.ce.store.current(h.workspace.id)).toBe(h.base);
    expect(h.app.ce.store.get(h.workspace.id).versionIds).toEqual(h.originalVersions); expect(h.app.ce.store.listRecords('reserve:')).toEqual([]); expect(h.app.ce.store.listRecords('operation:')).toEqual([]);
  });

  it('permits inspection at the snapshot-count limit but rejects commit atomically', async () => {
    const h = await setup({ store: new WorkspaceStore({ maxSnapshots: 1 }) }), view = await h.ready();
    const response = await h.commit(view); if (response.statusCode === 202) { await inspectionTick(); expect((await h.finish(1)).status).toBe('failed'); }
    else { expect(response.statusCode).toBe(413); expect(response.json().error.code).toBe('SESSION_LIMIT'); }
    expect(h.app.ce.store.current(h.workspace.id)).toBe(h.base); expect(h.app.ce.store.get(h.workspace.id).versionIds).toEqual(h.originalVersions);
    expect((await h.get(view.id)).json().state).toBe('ready'); expect(h.app.ce.store.listRecords('reserve:')).toEqual([]);
  });

  it('rechecks the base after commit verification and invalidates without any partial snapshot', async () => {
    const h = await setup(), view = await h.ready(), response = await h.commit(view); expect(response.statusCode).toBe(202); await inspectionTick();
    const output = await h.compute(1), newer = h.app.ce.store.publish(h.workspace.id, h.base!.versionId, { ...h.base!.content, configVersion: 'changed-during-commit' });
    h.workers[1]!.complete(output); const job = await h.settle(response.json().jobId); expect(job.status).toBe('failed'); expect(job.diagnostics.some(d => d.code === 'STALE_VERSION')).toBe(true);
    expect((await h.get(view.id)).json().state).toBe('invalidated'); expect(h.app.ce.store.current(h.workspace.id)).toBe(newer);
    expect(h.app.ce.files.usage(h.workspace.id)).toMatchObject({ retainedBytes: 0, reservedBytes: 0 }); expect(await readdir(h.app.ce.files.workspacePath(h.workspace.id))).toEqual([]);
  });

  it.each(['parsing', 'ready', 'committing'] as const)('closes during %s, waits for worker cleanup and removes its owned resources', async phase => {
    const h = await setup();
    if (phase === 'parsing') await accepted(h);
    else { const view = await h.ready(); if (phase === 'committing') { expect((await h.commit(view)).statusCode).toBe(202); await inspectionTick(); } }
    const directory = h.app.ce.files.workspacePath(h.workspace.id);
    const response = await h.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${h.workspace.id}`, headers: { ...h.headers, 'if-match': h.originalETag } });
    expect(response.statusCode).toBe(204); expect(h.workers.every(worker => worker.terminated)).toBe(true); await expect(access(directory)).rejects.toThrow();
    expect(h.app.ce.store.listRecords('')).toEqual([]); expect(h.app.ce.store.currentWorkspaceId).toBeUndefined();
  });

  it('coordinates workspace close with an in-flight reception before removing its directory', async () => {
    const h = await setup(); let enter!: () => void, release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
    const original = h.app.ce.files.openFile.bind(h.app.ce.files);
    vi.spyOn(h.app.ce.files, 'openFile').mockImplementationOnce(async (...args) => { const allocated = await original(...args); enter(); await gate; return allocated; });
    const reception = h.start();
    const first = await Promise.race([entered.then(() => undefined), reception.then(response => response)]);
    if (first) { release(); expect(first.statusCode, first.body).toBe(202); return; }
    const closing = h.app.inject({ method: 'DELETE', url: `/api/v1/workspaces/${h.workspace.id}`, headers: { ...h.headers, 'if-match': h.originalETag } }).then(response => response);
    await inspectionTick(); release(); const [upload, removed] = await Promise.all([reception, closing]);
    expect(upload.statusCode).not.toBe(202); expect(removed.statusCode).toBe(204); expect(h.requests).toHaveLength(0);
    await expect(access(h.app.ce.files.workspacePath(h.workspace.id))).rejects.toThrow(); expect(h.app.ce.store.listRecords('')).toEqual([]);
  });

  it('runs an inspection through a real worker thread, preserving the previous version until explicit commit', async () => {
    const h = await setup({ realWorker: true }), view = await h.ready(); expect(view.state).toBe('ready'); expect(h.app.ce.store.current(h.workspace.id)).toBe(h.base);
    expect(h.app.ce.store.etag(h.workspace.id)).toBe(h.originalETag); expect((await h.discard(view.id)).statusCode).toBe(200); await h.clean();
  });
});
