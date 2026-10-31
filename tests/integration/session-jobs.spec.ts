import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { canonicalStateBytes, canonicalStringify } from '../../apps/api/src/session/canonical-state.js';
import { JobManager } from '../../apps/api/src/jobs/job-manager.js';
import { SessionFiles } from '../../apps/api/src/storage/session-files.js';
import { content, controlledFactory, nextTurn } from '../helpers/foundation.js';

describe('session snapshots and accounted state', () => {
  it('freezes owned data, shares unchanged branches, and preserves the first snapshot', () => {
    const store = new WorkspaceStore();
    const workspace = store.create('Prueba');
    const first = store.publish(workspace.id, undefined, content());
    expect(() => { (first.content.facts[0] as { originalText: string }).originalText = '99'; }).toThrow();
    const second = store.publish(workspace.id, first.versionId, { ...first.content, configVersion: 'two' });
    expect(second.content.facts).toBe(first.content.facts);
    expect(store.snapshot(workspace.id, first.versionId).content.facts[0]).toMatchObject({ originalText: '10' });
    expect(() => store.publish(workspace.id, first.versionId, content())).toThrowError(/STALE_VERSION/);
  });
  it('does not trust a shallow-frozen object supplied by a caller', () => {
    const store = new WorkspaceStore(); const w = store.create('Prueba');
    const mutable = { ...content().facts[0]!, originalText: '10' }; const source = { ...content(), facts: Object.freeze([mutable]) };
    const first = store.publish(w.id, undefined, source); mutable.originalText = '99';
    expect(first.content.facts[0]).toMatchObject({ originalText: '10' });
  });
  it('counts shared JSON once, canonicalizes keys, rejects BigInt and invalid JSON', () => {
    const shared = Object.freeze({ value: 'á'.repeat(50) });
    expect(canonicalStateBytes([{ a: shared }, { b: shared }])).toBeLessThan(canonicalStateBytes([{ a: shared }, { b: { ...shared } }]));
    expect(canonicalStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
    expect(() => canonicalStringify({ value: 1n })).toThrow();
    expect(() => canonicalStringify({ value: Number.NaN })).toThrow();
    expect(() => canonicalStringify({ value: undefined })).toThrow();
  });
  it('rejects the 21st snapshot and auxiliary state over quota without changing the original', () => {
    const store = new WorkspaceStore();
    const w = store.create('Prueba');
    let snapshot = store.publish(w.id, undefined, content());
    const original = snapshot.versionId;
    for (let i = 1; i < 20; i++) snapshot = store.publish(w.id, snapshot.versionId, { ...snapshot.content, configVersion: String(i) });
    expect(() => store.publish(w.id, snapshot.versionId, content())).toThrowError(/SESSION_LIMIT/);
    expect(store.get(w.id).currentVersionId).toBe(snapshot.versionId);
    expect(store.snapshot(w.id, original)).toBeDefined();
    const small = new WorkspaceStore({ maxBytes: 2000 });
    const smallW = small.create('Pequeño');
    const base = small.publish(smallW.id, undefined, content());
    expect(() => small.putRecords([{ key: 'run:oversized', value: { diagnostics: 'x'.repeat(3000) } }])).toThrowError(/SESSION_LIMIT/);
    expect(small.getRecord('run:oversized')).toBeUndefined();
    expect(small.get(smallW.id).currentVersionId).toBe(base.versionId);
  });
});

describe('job ownership and publication races', () => {
  it('allows one active job and refuses a late result after cancellation', async () => {
    const store = new WorkspaceStore(); const w = store.create('Prueba');
    const controlled = controlledFactory(); const manager = new JobManager(store, { workerFactory: controlled.factory });
    const job = manager.start({ workspaceId: w.id, kind: 'import', input: {} });
    expect(() => manager.start({ workspaceId: w.id, kind: 'import', input: {} })).toThrowError(/WORKSPACE_BUSY/);
    await nextTurn();
    await manager.cancel(w.id, job.jobId);
    controlled.workers[0]!.complete({ snapshotContent: content() });
    expect(manager.get(w.id, job.jobId).status).toBe('cancelled');
    expect(store.get(w.id).currentVersionId).toBeUndefined();
    expect(controlled.workers[0]!.terminated).toBe(true);
    await manager.dispose();
  });
  it('publishes atomically and cancellation after publication reports succeeded', async () => {
    const store = new WorkspaceStore(); const w = store.create('Prueba');
    const controlled = controlledFactory(); const manager = new JobManager(store, { workerFactory: controlled.factory });
    const job = manager.start({ workspaceId: w.id, kind: 'import', input: {} }); await nextTurn();
    controlled.workers[0]!.complete({ snapshotContent: content(), records: [{ key: 'run:one', value: { status: 'completed' } }] });
    const result = await manager.cancel(w.id, job.jobId);
    expect(result.status).toBe('succeeded');
    expect(result.newVersionId).toBe(store.get(w.id).currentVersionId);
    expect(store.getRecord('run:one')).toEqual({ status: 'completed' });
    await manager.dispose();
  });
  it('checks the base again at publication and never publishes an incomplete result', async () => {
    const store = new WorkspaceStore(); const w = store.create('Prueba');
    const base = store.publish(w.id, undefined, content());
    const controlled = controlledFactory(); const manager = new JobManager(store, { workerFactory: controlled.factory });
    const job = manager.start({ workspaceId: w.id, kind: 'validate', baseVersionId: base.versionId, input: {} }); await nextTurn();
    // Simulate a competing internal publication to verify the final CAS independently of route guards.
    const newer = store.publish(w.id, base.versionId, { ...base.content, configVersion: 'new' });
    controlled.workers[0]!.complete({ snapshotContent: content() });
    expect(manager.get(w.id, job.jobId).status).toBe('failed');
    expect(manager.get(w.id, job.jobId).diagnostics[0]?.code).toBe('STALE_VERSION');
    expect(store.get(w.id).currentVersionId).toBe(newer.versionId);
    const next = manager.start({ workspaceId: w.id, kind: 'validate', baseVersionId: newer.versionId, input: {} }); await nextTurn();
    controlled.workers[1]!.emit('message', { type: 'result', output: { complete: false, snapshotContent: content() } });
    expect(manager.get(w.id, next.jobId).status).toBe('failed');
    expect(store.get(w.id).currentVersionId).toBe(newer.versionId);
    await manager.dispose();
  });
  it('times out, terminates the worker, and sanitizes unexpected worker errors', async () => {
    const store = new WorkspaceStore(); const w = store.create('Prueba');
    const controlled = controlledFactory(); const manager = new JobManager(store, { workerFactory: controlled.factory, deadlineMs: 15 });
    const job = manager.start({ workspaceId: w.id, kind: 'import', input: {} });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(manager.get(w.id, job.jobId).status).toBe('timed_out');
    expect(controlled.workers[0]!.terminated).toBe(true);
    controlled.workers[0]!.complete({ snapshotContent: content() });
    expect(store.get(w.id).state).toBe('empty');
    const next = manager.start({ workspaceId: w.id, kind: 'import', input: {} }); await nextTurn();
    controlled.workers[1]!.emit('error', new Error('secret token C:\\private\\file.xlsx'));
    expect(JSON.stringify(manager.get(w.id, next.jobId))).not.toContain('private');
    expect(manager.get(w.id, next.jobId).status).toBe('failed');
    await manager.dispose();
  });
  it('runs an actual worker thread through the trusted operation module protocol', async () => {
    const store = new WorkspaceStore(); const w = store.create('Prueba');
    const manager = new JobManager(store, { workerEntry: new URL('../../apps/api/dist/workers/operation-worker.js', import.meta.url), workerModules: { validate: new URL('../fixtures/foundation-worker.mjs', import.meta.url) } });
    const job = manager.start({ workspaceId: w.id, kind: 'validate', input: { value: 'fixture' } });
    for (let i = 0; i < 100 && manager.get(w.id, job.jobId).status !== 'succeeded'; i++) await new Promise((r) => setTimeout(r, 10));
    expect(manager.get(w.id, job.jobId).status).toBe('succeeded');
    expect(store.getRecord('fixture:thread')).toEqual({ value: 'fixture', isMainThread: false });
    await manager.dispose();
  });
  it('checks the deadline after preparing the publication candidate', async () => {
    const store = new WorkspaceStore(); const w = store.create('Prueba');
    const controlled = controlledFactory(); const manager = new JobManager(store, { workerFactory: controlled.factory });
    const originalPublish = store.publishJobResult.bind(store);
    vi.spyOn(store, 'publishJobResult').mockImplementation((job, output, guard) => originalPublish(job, output, () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(job.deadline!) + 1);
      try { guard?.(); } finally { now.mockRestore(); }
    }));
    const job = manager.start({ workspaceId: w.id, kind: 'import', input: {} }); await nextTurn();
    controlled.workers[0]!.complete({ snapshotContent: content() }); await nextTurn();
    expect(manager.get(w.id, job.jobId).status).toBe('timed_out');
    expect(store.get(w.id).currentVersionId).toBeUndefined(); await manager.dispose();
  });
});

describe('owned temporary files', () => {
  it('uses generated names and checks its marker before removing only its own directory', async () => {
    const parent = await mkdtemp(path.resolve('.cache/foundation-files-'));
    const outside = path.join(parent, 'original.xlsx'); await writeFile(outside, 'original');
    const files = await SessionFiles.create(randomUUID(), parent);
    const workspaceId = randomUUID();
    await files.createWorkspace(workspaceId);
    const stored = await files.write(workspaceId, Buffer.from('copy'));
    expect(stored.path).toContain(files.directory);
    expect(() => files.workspacePath('../outside')).toThrow();
    await files.close();
    expect(await readFile(outside, 'utf8')).toBe('original');
    const relative = path.relative(path.resolve('.cache'), parent);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup');
    await rm(parent, { recursive: true, force: true });
  });
  it.each(['missing', 'altered'])('refuses cleanup with a %s marker and preserves outside files', async (mode) => {
    const parent = await mkdtemp(path.resolve('.cache/foundation-marker-'));
    const outside = path.join(parent, 'original.xlsx'); await writeFile(outside, 'original');
    const files = await SessionFiles.create(randomUUID(), parent);
    const marker = path.join(files.directory, '.ce-session.json'); const original = await readFile(marker);
    if (mode === 'missing') await rm(marker); else await writeFile(marker, '{"sessionId":"another-session"}');
    await expect(files.close()).rejects.toThrow();
    expect(await readFile(outside, 'utf8')).toBe('original');
    await writeFile(marker, original); await files.close();
    const relative = path.relative(path.resolve('.cache'), parent);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup');
    await rm(parent, { recursive: true, force: true });
  });
});
