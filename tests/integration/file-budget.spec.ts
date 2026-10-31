import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionFiles } from '../../apps/api/src/storage/session-files.js';

const sessions = new Set<SessionFiles>(); const parents: string[] = [];
afterEach(async () => {
  for (const files of sessions) await files.close(); sessions.clear();
  for (const parent of parents.splice(0)) {
    const relative = path.relative(path.resolve('.cache'), path.resolve(parent));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !relative.startsWith('file-budget-')) throw new Error('Unsafe fixture cleanup');
    await rm(parent, { recursive: true, force: true });
  }
});
async function setup(maximum = 1000) {
  await mkdir(path.resolve('.cache'), { recursive: true }); const parent = await mkdtemp(path.resolve('.cache/file-budget-')); parents.push(parent);
  const files = await SessionFiles.create(randomUUID(), parent, maximum); sessions.add(files);
  const workspaceId = randomUUID(); await files.createWorkspace(workspaceId); return { files, workspaceId, parent };
}

describe('owned workspace file capacity and reservations', () => {
  it('prevents reservation overcommit and leaves the previous reservation intact after a rejected resize', async () => {
    const { files, workspaceId } = await setup(); const first = files.reserve(workspaceId, 600), second = files.reserve(workspaceId, 400);
    expect(() => files.reserve(workspaceId, 1)).toThrowError(expect.objectContaining({ code: 'SESSION_LIMIT' }));
    expect(() => first.resize(601)).toThrowError(expect.objectContaining({ code: 'SESSION_LIMIT' }));
    expect(files.usage(workspaceId)).toEqual({ retainedBytes: 0, reservedBytes: 1000, limitBytes: 1000 });
    second.release(); second.release(); first.resize(700); expect(files.usage(workspaceId).reservedBytes).toBe(700);
    first.release(); expect(files.usage(workspaceId).reservedBytes).toBe(0);
  });
  it('converts the reservation into actual retained bytes once and preserves previous exports on exhaustion', async () => {
    const { files, workspaceId } = await setup(); const first = await files.write(workspaceId, Buffer.alloc(600, 65));
    const lease = files.reserve(workspaceId, 400), next = await files.openFile(workspaceId, lease);
    await next.handle.writeFile(Buffer.alloc(250, 66)); await next.handle.close(); await files.retain(lease, [next.id]);
    expect(files.usage(workspaceId)).toEqual({ retainedBytes: 850, reservedBytes: 0, limitBytes: 1000 });
    await expect(files.write(workspaceId, Buffer.alloc(151))).rejects.toMatchObject({ code: 'SESSION_LIMIT' });
    expect(files.usage(workspaceId)).toEqual({ retainedBytes: 850, reservedBytes: 0, limitBytes: 1000 });
    expect(await readFile(first.path)).toEqual(Buffer.alloc(600, 65)); expect(await readdir(files.workspacePath(workspaceId))).toHaveLength(2);
    await files.removeFiles(workspaceId, [next.id]); expect(files.usage(workspaceId).retainedBytes).toBe(600);
    await files.write(workspaceId, Buffer.alloc(400)); expect(files.usage(workspaceId).retainedBytes).toBe(1000);
  });
  it('reserves synchronously before concurrent file writes so only one can consume the remaining space', async () => {
    const { files, workspaceId } = await setup();
    const results = await Promise.allSettled([files.write(workspaceId, Buffer.alloc(600, 65)), files.write(workspaceId, Buffer.alloc(600, 66))]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ status: 'rejected', reason: { code: 'SESSION_LIMIT' } });
    expect(files.usage(workspaceId)).toEqual({ retainedBytes: 600, reservedBytes: 0, limitBytes: 1000 }); expect(await readdir(files.workspacePath(workspaceId))).toHaveLength(1);
  });
  it('rejects retaining bytes beyond the lease and allows cleanup to release the whole reservation', async () => {
    const { files, workspaceId } = await setup(); const previous = await files.write(workspaceId, Buffer.alloc(100, 65));
    const lease = files.reserve(workspaceId, 200), working = await files.openFile(workspaceId, lease);
    await working.handle.writeFile(Buffer.alloc(201)); await working.handle.close();
    await expect(files.retain(lease, [working.id])).rejects.toMatchObject({ code: 'SESSION_LIMIT' });
    expect(files.usage(workspaceId)).toEqual({ retainedBytes: 100, reservedBytes: 200, limitBytes: 1000 });
    await files.removeFiles(workspaceId, [working.id]); lease.release();
    expect(files.usage(workspaceId)).toEqual({ retainedBytes: 100, reservedBytes: 0, limitBytes: 1000 }); expect(await readFile(previous.path)).toEqual(Buffer.alloc(100, 65));
  });
  it('closing the owned workspace clears its quota and leaves original or saved copies outside intact', async () => {
    const { files, workspaceId, parent } = await setup();
    const original = path.join(parent, 'original.xlsx'), saved = path.join(parent, 'saved-results.zip');
    await writeFile(original, 'original'); const stored = await files.write(workspaceId, Buffer.from('saved copy')); await writeFile(saved, await readFile(stored.path));
    await files.removeWorkspace(workspaceId); expect(() => files.usage(workspaceId)).toThrowError(expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }));
    expect(await readFile(original, 'utf8')).toBe('original'); expect(await readFile(saved, 'utf8')).toBe('saved copy');
    const replacement = randomUUID(); await files.createWorkspace(replacement); await files.write(replacement, Buffer.alloc(1000));
    expect(files.usage(replacement)).toEqual({ retainedBytes: 1000, reservedBytes: 0, limitBytes: 1000 });
  });
});
