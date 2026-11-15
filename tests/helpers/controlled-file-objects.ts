import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, link, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { PrivateObjectTransport } from '../../apps/api/src/hosted/blob-object-store.js';

export interface ControlledFileObjectDescriptor { readonly kind: 'controlled-files'; readonly directory: string; readonly transportId: string }
const keyPattern = /^ce\/v1\/[a-f0-9-]{36}\/[a-f0-9-]{36}\/[a-f0-9-]{36}$/;
const limit = 3 * 1024 * 1024;
/** Explicit test provider, shared through an owned directory across actual worker threads/processes. Never selected from an HTTP body. */
export class ControlledFileObjectTransport implements PrivateObjectTransport {
  private constructor(readonly descriptor: ControlledFileObjectDescriptor) {}
  static async create(parent = os.tmpdir()): Promise<ControlledFileObjectTransport> {
    const root = await realpath(parent), directory = await mkdtemp(path.join(root, 'ce-test-objects-')), transportId = randomUUID();
    await writeFile(path.join(directory, '.owner.json'), JSON.stringify({ transportId }), { flag: 'wx' });
    return new ControlledFileObjectTransport({ kind: 'controlled-files', directory, transportId });
  }
  static async connect(descriptor: ControlledFileObjectDescriptor): Promise<ControlledFileObjectTransport> {
    const transport = new ControlledFileObjectTransport(descriptor); await transport.verify(); return transport;
  }
  async put(privateKey: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted(); if (!bytes.byteLength || bytes.byteLength > limit) throw new RangeError('Controlled part limit');
    const target = await this.location(privateKey), temporary = path.join(this.descriptor.directory, 'writing-' + randomUUID());
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); await file.close(); signal?.throwIfAborted();
      try { await link(temporary, target); } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') throw error;
        const existing = await this.get(privateKey, signal); if (!existing || Buffer.compare(Buffer.from(existing), Buffer.from(bytes))) throw new Error('Immutable controlled object already differs');
      }
    } finally { await file.close().catch(() => undefined); await rm(temporary, { force: true }); }
  }
  async get(privateKey: string, signal?: AbortSignal): Promise<Uint8Array | null> {
    signal?.throwIfAborted(); const target = await this.location(privateKey);
    try { const info = await lstat(target); if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > limit) throw new Error('Invalid controlled object');
      const bytes = await readFile(target, signal ? { signal } : undefined); if (bytes.length !== info.size) throw new Error('Incomplete controlled object'); signal?.throwIfAborted(); return bytes;
    } catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null; throw error; }
  }
  async remove(privateKey: string, signal?: AbortSignal): Promise<void> { signal?.throwIfAborted(); await rm(await this.location(privateKey), { force: true }); signal?.throwIfAborted(); }
  async removeMany(privateKeys: readonly string[], signal?: AbortSignal): Promise<void> {
    if (!privateKeys.length || privateKeys.length > 100 || new Set(privateKeys).size !== privateKeys.length || privateKeys.some(key => !keyPattern.test(key))) throw new TypeError('Invalid controlled deletion batch');
    for (const key of privateKeys) await this.remove(key, signal);
  }
  async close(): Promise<void> { await this.verify(); const target = this.descriptor.directory;
    if (path.dirname(target) === target || !path.basename(target).startsWith('ce-test-objects-')) throw new Error('Invalid owned object directory');
    await rm(target, { recursive: true, force: false });
  }
  private async location(privateKey: string): Promise<string> {
    if (!keyPattern.test(privateKey)) throw new TypeError('Invalid generated object key'); await this.verify();
    return path.join(this.descriptor.directory, createHash('sha256').update(privateKey).digest('hex') + '.part');
  }
  private async verify(): Promise<void> {
    const { directory, transportId } = this.descriptor; if (!path.isAbsolute(directory) || !/^[a-f0-9-]{36}$/.test(transportId)) throw new Error('Invalid controlled object descriptor');
    const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory) throw new Error('Invalid controlled object root');
    const marker = path.join(directory, '.owner.json'); if ((await lstat(marker)).isSymbolicLink()) throw new Error('Invalid controlled object marker'); await access(marker, constants.R_OK);
    const identity = JSON.parse(await readFile(marker, 'utf8')) as { transportId?: string }; if (identity.transportId !== transportId) throw new Error('Controlled object ownership mismatch');
  }
}
