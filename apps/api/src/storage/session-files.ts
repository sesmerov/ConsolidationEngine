import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile, lstat, open, stat } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UUID_PATTERN } from '@ce/contracts';
import type { SourceFile } from '@ce/contracts';
import { ApiError } from '../errors.js';
export const FILE_SESSION_LIMIT = 512 * 1024 * 1024;
export interface FileLease { readonly workspaceId: string; readonly id: string; resize(bytes: number): void; release(): void }
interface FileBudget { readonly retained: Map<string, number>; readonly reservations: Map<string, number> }

export class SessionFiles {
  private readonly budgets = new Map<string, FileBudget>();
  private constructor(readonly directory: string, private readonly parent: string, private readonly sessionId: string, private readonly maxBytes: number) {}
  static async create(sessionId: string, parent = os.tmpdir(), maxBytes = FILE_SESSION_LIMIT): Promise<SessionFiles> {
    if (!UUID_PATTERN.test(sessionId)) throw new ApiError('INTERNAL_ERROR');
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > FILE_SESSION_LIMIT) throw new ApiError('INTERNAL_ERROR');
    await mkdir(parent, { recursive: true }); const canonicalParent = await realpath(parent);
    const directory = await mkdtemp(path.join(canonicalParent, 'ce-session-'));
    await writeFile(path.join(directory, '.ce-session.json'), JSON.stringify({ sessionId }), { flag: 'wx' });
    return new SessionFiles(directory, canonicalParent, sessionId, maxBytes);
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
  async createWorkspace(workspaceId: string): Promise<void> { await this.verify(); await mkdir(this.workspacePath(workspaceId), { recursive: false }); this.budgets.set(workspaceId, { retained: new Map(), reservations: new Map() }); }
  usage(workspaceId: string): { retainedBytes: number; reservedBytes: number; limitBytes: number } {
    const budget = this.budgets.get(workspaceId); if (!budget) throw new ApiError('RESOURCE_NOT_FOUND');
    return { retainedBytes: [...budget.retained.values()].reduce((sum, size) => sum + size, 0), reservedBytes: [...budget.reservations.values()].reduce((sum, size) => sum + size, 0), limitBytes: this.maxBytes };
  }
  reserve(workspaceId: string, bytes: number): FileLease {
    const budget = this.budgets.get(workspaceId); if (!budget) throw new ApiError('RESOURCE_NOT_FOUND');
    const id = randomUUID(); let released = false;
    const resize = (size: number) => { if (released || !Number.isSafeInteger(size) || size < 0) throw new ApiError('INTERNAL_ERROR');
      const used = this.usage(workspaceId); if (used.retainedBytes + used.reservedBytes - (budget.reservations.get(id) ?? 0) + size > this.maxBytes) throw new ApiError('SESSION_LIMIT'); budget.reservations.set(id, size); };
    resize(bytes); return { workspaceId, id, resize, release: () => { if (!released) { budget.reservations.delete(id); released = true; } } };
  }
  async retain(lease: FileLease, ids: readonly string[]): Promise<void> {
    const budget = this.budgets.get(lease.workspaceId); if (!budget?.reservations.has(lease.id)) throw new ApiError('INTERNAL_ERROR');
    const entries: [string, number][] = [];
    for (const id of ids) { const location = await this.filePath(lease.workspaceId, id); entries.push([id, (await stat(location)).size]); }
    const total = entries.reduce((sum, [, size]) => sum + size, 0); if (total > budget.reservations.get(lease.id)!) throw new ApiError('SESSION_LIMIT');
    for (const [id, size] of entries) budget.retained.set(id, size); lease.release();
  }
  async filePath(workspaceId: string, id: string): Promise<string> {
    await this.verify(); if (!UUID_PATTERN.test(id)) throw new ApiError('INVALID_REQUEST'); const directory = this.workspacePath(workspaceId);
    if ((await lstat(directory)).isSymbolicLink() || await realpath(directory) !== directory) throw new ApiError('INTERNAL_ERROR');
    const location = path.join(directory, id); if ((await lstat(location)).isSymbolicLink() || await realpath(location) !== location) throw new ApiError('INTERNAL_ERROR'); return location;
  }
  /** Only retained files in this workspace may be passed to an export worker as originals. */
  async retainedSource(workspaceId:string,source:SourceFile):Promise<SourceFile&{readonly path:string}>{
    try{if(this.budgets.get(workspaceId)?.retained.get(source.id)!==source.size)throw new ApiError('EXPORT_NOT_AVAILABLE');
      const location=await this.filePath(workspaceId,source.id),info=await lstat(location);if(!info.isFile()||info.size!==source.size)throw new ApiError('EXPORT_NOT_AVAILABLE');
      const hash=createHash('sha256');let size=0;for await(const bytes of createReadStream(location,{highWaterMark:64*1024})){size+=bytes.length;if(size>source.size)throw new ApiError('EXPORT_NOT_AVAILABLE');hash.update(bytes);}if(size!==source.size||hash.digest('hex')!==source.sha256)throw new ApiError('EXPORT_NOT_AVAILABLE');
      return {...source,path:location};
    }catch{throw new ApiError('EXPORT_NOT_AVAILABLE',{reason:'INVALID_REPORT_SOURCE'});}
  }
  async write(workspaceId: string, bytes: Uint8Array): Promise<{ id: string; sha256: string; path: string; size: number }> {
    const lease = this.reserve(workspaceId, bytes.byteLength); let allocated: { id: string; path: string; handle: FileHandle } | undefined;
    try { allocated = await this.openFile(workspaceId, lease); await allocated.handle.writeFile(bytes); await allocated.handle.close(); await this.retain(lease, [allocated.id]);
      return { id: allocated.id, sha256: createHash('sha256').update(bytes).digest('hex'), path: allocated.path, size: bytes.byteLength };
    } catch (error) { await allocated?.handle.close().catch(() => undefined); if (allocated) await this.removeFiles(workspaceId, [allocated.id]); lease.release(); throw error; }
  }
  async openFile(workspaceId: string, lease: FileLease): Promise<{ id: string; path: string; handle: FileHandle }> {
    if (lease.workspaceId !== workspaceId || !this.budgets.get(workspaceId)?.reservations.has(lease.id)) throw new ApiError('INTERNAL_ERROR');
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
      this.budgets.get(workspaceId)?.retained.delete(id);
    }
  }
  async removeWorkspace(workspaceId: string): Promise<void> {
    await this.verify(); const target = this.workspacePath(workspaceId);
    const relative = path.relative(this.directory, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new ApiError('INTERNAL_ERROR');
    if ((await lstat(target)).isSymbolicLink() || await realpath(target) !== target) throw new ApiError('INTERNAL_ERROR');
    await rm(target, { recursive: true, force: false });
    this.budgets.delete(workspaceId);
  }
  async close(): Promise<void> { await this.verify(); await rm(this.directory, { recursive: true, force: false }); this.budgets.clear(); }
}
