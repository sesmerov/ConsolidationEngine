import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { API_RUNTIME_FILES, packageApi } from '../../scripts/package-vercel-api.mjs';
import { packageBuildEnvironment } from '../../scripts/lib/package-build.mjs';

const roots: string[] = [];
async function temporaryRoot() { const root = await mkdtemp(join(tmpdir(), 'ce-api-package-')); roots.push(root); return root; }
async function file(root: string, name: string, content = 'packaged fixture') {
  await mkdir(dirname(join(root, name)), { recursive: true }); await writeFile(join(root, name), content);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Vercel API packaging', () => {
  it('does not pass provider secrets or public runtime configuration to compiler processes', () => {
    expect(packageBuildEnvironment({ PATH: 'path', JAVA_HOME: 'jdk', npm_execpath: 'npm.js',
      DATABASE_URL: 'private', DATABASE_URL_UNPOOLED: 'private-direct', QSTASH_TOKEN: 'private', BLOB_READ_WRITE_TOKEN: 'private',
      API_BASE_URL: 'https://public.test', DEPLOYMENT_PROFILE: 'demo-public' }))
      .toEqual({ PATH: 'path', JAVA_HOME: 'jdk', npm_execpath: 'npm.js' });
  });

  it('refuses packaging without the explicit hosted entry, before building', async () => {
    const root = await temporaryRoot(); const calls: unknown[] = [];
    await expect(packageApi({ root, environment: {}, runNpm: async (...args: unknown[]) => { calls.push(args); return '11.19.1'; } }))
      .rejects.toThrow('hosted entry');
    expect(calls).toEqual([]);
  });

  it('generates ANTLR, compiles all API workspaces and verifies workers and binary assets', async () => {
    const root = await temporaryRoot(); const calls: string[][] = [];
    await file(root, 'apps/api/api/index.ts'); await file(root, 'apps/api/src/hosted-entry.ts');
    await file(root, 'packages/contracts/package.json', '{"name":"@ce/contracts"}');
    await file(root, 'packages/engine/package.json', '{"name":"@ce/engine"}');
    for (const name of API_RUNTIME_FILES) await file(root, name);
    const result = await packageApi({ root, environment: {}, runNpm: async (args: string[]) => {
      calls.push(args); return args[0] === '--version' ? '11.19.1' : '';
    } });
    expect(calls).toEqual([['--version'], ['run', 'generate:parser'], ['run', 'build:api']]);
    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.files).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'apps/api/dist/workers/operation-worker.js', bytes: 16, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: 'packages/engine/dist/generated/dpm_xlParser.js' }),
      expect.objectContaining({ path: 'apps/api/dist/assets/demos/demo-finrep-report.xlsx' }),
    ]));
    await rm(join(root, 'apps/api/dist/assets/demos/demo-finrep-report.xlsx'));
    await expect(packageApi({ root, environment: {}, runNpm: async () => '11.19.1' })).rejects.toThrow('demo-finrep-report.xlsx');
  });

  it('uses explicit function routing and traces the dynamically loaded runtime trees', async () => {
    const config = JSON.parse(await readFile(new URL('../../apps/api/vercel.json', import.meta.url), 'utf8'));
    expect(config.framework).toBeNull();
    // Vercel's static builder requires a non-empty directory, even for this API-only project.
    // Serving the project root instead would expose source files and runtime assets.
    expect(config.outputDirectory).toBe('public');
    const staticDirectory = new URL(`../../apps/api/${config.outputDirectory}/`, import.meta.url);
    expect(await readdir(staticDirectory)).toEqual(['robots.txt']);
    expect((await readFile(new URL('robots.txt', staticDirectory), 'utf8')).replaceAll('\r\n', '\n')).toBe('User-agent: *\nDisallow: /\n');
    expect(config.functions['api/index.ts']).toEqual({ maxDuration: 120,
      includeFiles: '{dist/**,../../packages/contracts/dist/**,../../packages/contracts/package.json,../../packages/engine/dist/**,../../packages/engine/package.json}' });
    expect(config.rewrites).toEqual([
      { source: '/api/v1/(.*)', destination: '/api/index' }, { source: '/internal/(.*)', destination: '/api/index' },
    ]);
    expect(config.functions['api/index.ts']).not.toHaveProperty('memory');
    expect(config.installCommand).toContain('npm@11.19.1 ci --engine-strict=false');
    expect(JSON.parse(await readFile(new URL('../../apps/api/package.json', import.meta.url), 'utf8')).engines.node).toBe('24.x');
    expect(JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')).engines.node).toBe('24.22.2');
  });
});
