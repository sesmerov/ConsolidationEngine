import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { injectPublicConfig, packageWeb, readPublicConfig } from '../../scripts/package-vercel-web.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Vercel web packaging', () => {
  it('includes only the two public values and normalizes the API origin', () => {
    const config = readPublicConfig({
      API_BASE_URL: 'https://API.example.test:443/', DEPLOYMENT_PROFILE: 'demo-public',
      DATABASE_URL: 'postgres://private', BLOB_READ_WRITE_TOKEN: 'secret-blob',
      QSTASH_TOKEN: 'secret-queue', CE_CURSOR_SIGNING_KEY: 'secret-cursor',
    });
    expect(config).toEqual({ apiBaseUrl: 'https://api.example.test', deploymentProfile: 'demo-public' });
    expect(readPublicConfig({})).toEqual({ apiBaseUrl: '', deploymentProfile: 'local' });
    expect(readPublicConfig({ API_BASE_URL: 'http://127.0.0.1:3351/', DEPLOYMENT_PROFILE: 'local' }).apiBaseUrl)
      .toBe('http://127.0.0.1:3351');
  });

  it.each([
    '/api/v1', 'https://api.example.test/api/v1', 'https://api.example.test/?secret=yes',
    'https://user:secret@api.example.test', 'https://api.example.test/#fragment',
    'javascript:alert(1)', 'http://api.example.test', 'http://127.0.0.1:3351',
    'https://api.example.test/../', 'https://*.example.test', 'https://api.example.test\\path', 'https://api.\nexample.test',
  ])('rejects invalid hosted API origins before building: %s', async (apiBaseUrl) => {
    let calls = 0;
    await expect(packageWeb({ environment: { API_BASE_URL: apiBaseUrl, DEPLOYMENT_PROFILE: 'demo-public' },
      runNpm: async () => { calls++; return '11.19.1'; } })).rejects.toThrow('API_BASE_URL');
    expect(calls).toBe(0);
  });

  it('rejects an absent hosted origin and unsafe profile values', () => {
    expect(() => readPublicConfig({ DEPLOYMENT_PROFILE: 'demo-public' })).toThrow('API_BASE_URL');
    expect(() => readPublicConfig({ DEPLOYMENT_PROFILE: '</script><script>alert(1)</script>' })).toThrow('DEPLOYMENT_PROFILE');
  });

  it('adds one inert configuration before the app scripts without modifying the source template', () => {
    const source = '<!doctype html><html><head></head><body><script type="module" src="main.js"></script></body></html>';
    const output = injectPublicConfig(source, { apiBaseUrl: 'https://api.example.test', deploymentProfile: 'demo-public' });
    expect(output).toContain('<script id="ce-public-config" type="application/json">');
    expect(output.indexOf('ce-public-config')).toBeLessThan(output.indexOf('main.js'));
    expect(source).not.toContain('ce-public-config');
    expect(() => injectPublicConfig(output, readPublicConfig({}))).toThrow('ce-public-config');
  });

  it('builds contracts and Angular only, then publishes a clean static output without environment secrets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-web-package-'));
    roots.push(root);
    await mkdir(join(root, 'dist/vercel-web/browser'), { recursive: true });
    await mkdir(join(root, 'apps/web/.vercel-dist/browser'), { recursive: true });
    await mkdir(join(root, 'dist/web/browser'), { recursive: true });
    await writeFile(join(root, 'dist/vercel-web/browser/index.html'), '<html><head></head><body></body></html>');
    await writeFile(join(root, 'dist/vercel-web/browser/main-123.js'), 'console.log("public app");');
    await writeFile(join(root, 'apps/web/.vercel-dist/browser/obsolete.js'), 'old');
    await writeFile(join(root, 'dist/web/browser/current-e2e.html'), 'do not change');
    const calls: string[][] = [];
    const result = await packageWeb({ root, environment: {
      API_BASE_URL: 'https://api.example.test/', DEPLOYMENT_PROFILE: 'demo-public', DATABASE_URL: 'private-sentinel',
    }, runNpm: async (args: string[]) => { calls.push(args); return args[0] === '--version' ? '11.19.1' : ''; } });
    expect(calls).toEqual([
      ['--version'], ['run', 'build', '--workspace', '@ce/contracts'],
      ['run', 'build', '--workspace', '@ce/web', '--', '--configuration=production,vercel'],
    ]);
    expect(result.outputDirectory).toBe(join(root, 'apps/web/.vercel-dist/browser'));
    const index = await readFile(join(result.outputDirectory, 'index.html'), 'utf8');
    expect(index).toContain('https://api.example.test');
    expect(index).not.toContain('private-sentinel');
    expect(await readFile(join(result.outputDirectory, 'main-123.js'), 'utf8')).toContain('public app');
    await expect(readFile(join(result.outputDirectory, 'obsolete.js'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(join(root, 'dist/web/browser/current-e2e.html'), 'utf8')).toBe('do not change');
  });

  it('refuses a different npm version before compiling', async () => {
    const calls: string[][] = [];
    await expect(packageWeb({ environment: {}, runNpm: async (args: string[]) => { calls.push(args); return '11.0.0'; } }))
      .rejects.toThrow('npm 11.19.1');
    expect(calls).toEqual([['--version']]);
  });

  it('retains the last complete package if Angular fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-web-package-failed-'));
    roots.push(root);
    await mkdir(join(root, 'apps/web/.vercel-dist/browser'), { recursive: true });
    const previousIndex = join(root, 'apps/web/.vercel-dist/browser/index.html');
    await writeFile(previousIndex, 'last complete package');
    await expect(packageWeb({ root, environment: {}, runNpm: async (args: string[]) => {
      if (args.includes('@ce/web')) throw new Error('Angular build failed');
      return args[0] === '--version' ? '11.19.1' : '';
    } })).rejects.toThrow('Angular build failed');
    expect(await readFile(previousIndex, 'utf8')).toBe('last complete package');
  });

  it('serves only known app paths through SPA rewrites and keeps unknown assets as 404s', async () => {
    const config = JSON.parse(await readFile(new URL('../../apps/web/vercel.json', import.meta.url), 'utf8'));
    expect(config.outputDirectory).toBe('.vercel-dist/browser');
    expect(config.installCommand).toBe('cd ../.. && npx --yes npm@11.19.1 ci --engine-strict=false');
    expect(config.buildCommand).toBe('cd ../.. && npx --yes npm@11.19.1 run package:vercel:web');
    const manifest = JSON.parse(await readFile(new URL('../../apps/web/package.json', import.meta.url), 'utf8'));
    const lock = JSON.parse(await readFile(new URL('../../package-lock.json', import.meta.url), 'utf8'));
    expect(manifest.engines).toEqual({ node: '24.x' });
    expect(lock.packages['apps/web'].engines).toEqual(manifest.engines);
    // The app changes stages in memory; it does not implement URL routes for them.
    expect(config.rewrites).toEqual([{ source: '/', destination: '/index.html' }]);
    for (const url of ['/missing.js', '/assets/missing.svg', '/api/v1/session', '/validar', '/does-not-exist']) {
      expect(config.rewrites.some((rewrite: { source: string }) => rewrite.source === url)).toBe(false);
    }
  });
});
