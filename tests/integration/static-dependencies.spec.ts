import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { describe, expect, it } from 'vitest';

// These checks exercise the glob 14 override through its actual consumer.
// static 10 still declares glob 13; the scoped override fixes GHSA-3g3m-2fjr-6pw4
// and uses minimatch 11.0.1 for GHSA-g3hv-75wg-m249 without changing direct pins.
describe('the patched static dependency chain', () => {
  it.each([false, true])('serves only the configured static root (wildcard=%s)', async (wildcard) => {
    const cacheRoot = path.resolve('.cache');
    await mkdir(cacheRoot, { recursive: true });
    const fixture = await mkdtemp(path.join(cacheRoot, 'static-dependencies-'));
    const root = path.join(fixture, 'public');
    const server = Fastify();
    try {
      await mkdir(path.join(root, 'nested'), { recursive: true });
      await writeFile(path.join(root, 'index.html'), '<h1>Inicio</h1>');
      await writeFile(path.join(root, 'nested', 'asset.txt'), 'asset');
      await writeFile(path.join(root, '.hidden'), 'hidden');
      await writeFile(path.join(fixture, 'outside.txt'), 'outside');
      await server.register(fastifyStatic, { root, wildcard, serveDotFiles: false, dotfiles: 'ignore' });
      const index = await server.inject('/');
      expect(index.statusCode).toBe(200);
      expect(index.body).toBe('<h1>Inicio</h1>');
      const nested = await server.inject('/nested/asset.txt');
      expect(nested.statusCode).toBe(200);
      expect(nested.body).toBe('asset');
      expect((await server.inject('/missing.txt')).statusCode).toBe(404);
      expect((await server.inject('/.hidden')).statusCode).toBe(404);
      const traversal = await server.inject('/%2e%2e/outside.txt');
      expect([400, 403, 404]).toContain(traversal.statusCode);
      expect(traversal.body).not.toBe('outside');
    } finally {
      await server.close();
      const resolved = path.resolve(fixture);
      const relative = path.relative(cacheRoot, resolved);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe test cleanup path.');
      await rm(resolved, { recursive: true, force: true });
    }
  });
});
