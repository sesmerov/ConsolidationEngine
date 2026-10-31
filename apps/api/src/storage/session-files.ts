import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat, open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UUID_PATTERN } from '@ce/contracts';
import { ApiError } from '../errors.js';

export class SessionFiles {
  private constructor(readonly directory: string, private readonly parent: string, private readonly sessionId: string) {}
  static async create(sessionId: string, parent = os.tmpdir()): Promise<SessionFiles> {
    if (!UUID_PATTERN.test(sessionId)) throw new ApiError('INTERNAL_ERROR');
    await mkdir(parent, { recursive: true }); const canonicalParent = await realpath(parent);
    const directory = await mkdtemp(path.join(canonicalParent, 'ce-session-'));
    await writeFile(path.join(directory, '.ce-session.json'), JSON.stringify({ sessionId }), { flag: 'wx' });
    return new SessionFiles(directory, canonicalParent, sessionId);
  }
  workspacePath(workspaceId: string): string {
    if (!UUID_PATTERN.test(workspaceId)) throw new ApiError('INVALID_REQUEST');
    return path.join(this.directory, workspaceId);
  }
  private async verify(): Promise<void> {
    const relative = path.relative(this.parent, this.directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || (await lstat(this.directory)).isSymbolicLink()) throw new ApiError('INTERNAL_ERROR');
    if (await realpath(this.directory) !== this.directory) throw new ApiError('INTERNAL_ERROR');
    const marker = JSON.parse(await readFile(path.join(this.directory, '.ce-session.json'), 'utf8')) as { sessionId?: string };
    if (marker.sessionId !== this.sessionId) throw new ApiError('INTERNAL_ERROR');
  }
  async createWorkspace(workspaceId: string): Promise<void> { await this.verify(); await mkdir(this.workspacePath(workspaceId), { recursive: false }); }
  async write(workspaceId: string, bytes: Uint8Array): Promise<{ id: string; sha256: string; path: string; size: number }> {
    await this.verify(); const directory = this.workspacePath(workspaceId);
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new ApiError('INTERNAL_ERROR');
    const id = randomUUID(); const location = path.join(directory, id); await writeFile(location, bytes, { flag: 'wx' });
    return { id, sha256: createHash('sha256').update(bytes).digest('hex'), path: location, size: bytes.byteLength };
  }
  async openFile(workspaceId: string): Promise<{ id: string; path: string; handle: FileHandle }> {
    await this.verify(); const directory = this.workspacePath(workspaceId);
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new ApiError('INTERNAL_ERROR');
    const id = randomUUID(); const location = path.join(directory, id);
    return { id, path: location, handle: await open(location, 'wx') };
  }
  async removeFiles(workspaceId: string, ids: readonly string[]): Promise<void> {
    await this.verify(); const directory = this.workspacePath(workspaceId);
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new ApiError('INTERNAL_ERROR');
    for (const id of ids) {
      if (!UUID_PATTERN.test(id)) throw new ApiError('INTERNAL_ERROR');
      await rm(path.join(directory, id), { force: true });
    }
  }
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.verify(); const target = this.workspacePath(workspaceId);
    const relative = path.relative(this.directory, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ApiError('INTERNAL_ERROR');
    if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new ApiError('INTERNAL_ERROR');
    await rm(target, { recursive: true, force: false });
  }
  async close(): Promise<void> { await this.verify(); await rm(this.directory, { recursive: true, force: false }); }
}
