import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createApp } from '../../apps/api/src/app.js';

const apps: Awaited<ReturnType<typeof createApp>>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
async function setup() {
  const app = await createApp(); apps.push(app); const host = '127.0.0.1:3000';
  const headers = { host, 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host } })).json().sessionToken as string };
  return { app, headers };
}
it.each([['corep', 'catalog'], ['corep', 'report'], ['types', 'catalog'], ['types', 'report']] as const)('downloads the authenticated packaged %s %s workbook with its declared content hash', async (demo, kind) => {
  const { app, headers } = await setup(), url = `/api/v1/templates/demos/${demo}/${kind}`;
  expect((await app.inject({ url, headers: { host: headers.host } })).statusCode).toBe(403);
  expect((await app.inject({ url, headers: { ...headers, origin: 'https://untrusted.example' } })).statusCode).toBe(403);
  const response = await app.inject({ url, headers }); expect(response.statusCode, response.body).toBe(200);
  expect(response.headers['content-type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  expect(response.headers['content-disposition']).toBe(`attachment; filename="demo-${demo}-${kind}.xlsx"`);
  expect(response.headers['cache-control']).toBe('no-store'); expect(response.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 3, 4]));
  const manifest = JSON.parse(await readFile(new URL('../../assets/demos/manifest.json', import.meta.url), 'utf8')) as { files: { demo: string; kind: string; file: string; sha256: string; size: number }[] };
  const entry = manifest.files.find(row => row.demo === demo && row.kind === kind)!;
  expect(entry.file).toBe(`demo-${demo}-${kind}.xlsx`); expect(response.rawPayload.length).toBe(entry.size); expect(createHash('sha256').update(response.rawPayload).digest('hex')).toBe(entry.sha256);
  expect(response.rawPayload).toEqual(await readFile(new URL('../../assets/demos/' + entry.file, import.meta.url)));
  expect((await app.inject({ url: url + '?path=private.xlsx', headers })).statusCode).toBe(400);
});
it('does not expose arbitrary demo names, file paths or write actions', async () => {
  const { app, headers } = await setup();
  for (const url of ['/api/v1/templates/demos/unknown/report', '/api/v1/templates/demos/corep/secrets']) expect((await app.inject({ url, headers })).statusCode).toBe(404);
  expect((await app.inject({ method: 'POST', url: '/api/v1/templates/demos/corep/report', headers })).statusCode).toBe(404);
});
it('serves COREP from the packaged assets when the compiled API is relocated away from root assets', async () => {
  const scratch = path.resolve(fileURLToPath(new URL('../../.cache/', import.meta.url))); await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(path.join(scratch, 'packaged-template-'));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  try {
    await cp(fileURLToPath(new URL('../../apps/api/dist/', import.meta.url)), directory, { recursive: true });
    const packaged = await import(pathToFileURL(path.join(directory, 'app.js')).href) as { createApp: typeof createApp };
    app = await packaged.createApp(); const host = '127.0.0.1:3000';
    const headers = { host, 'x-ce-session': (await app.inject({ url: '/api/v1/bootstrap', headers: { host } })).json().sessionToken as string };
    const response = await app.inject({ url: '/api/v1/templates/corep-ca1', headers }); expect(response.statusCode, response.body).toBe(200);
    const bytes = await readFile(path.join(directory, 'assets', 'templates', 'corep-ca1.xlsx'));
    expect(response.rawPayload).toEqual(bytes); expect(response.headers['content-disposition']).toContain('corep-ca1.xlsx');
  } finally {
    await app?.close();
    const resolved = path.resolve(directory); if (!resolved.startsWith(scratch + path.sep)) throw new Error('Unexpected test cleanup directory');
    await rm(resolved, { recursive: true, force: true });
  }
});
it('declares typed v2 validation separately from legacy numeric and boolean capabilities', async () => {
  const { app, headers } = await setup(), response = await app.inject({ url: '/api/v1/capabilities', headers }); expect(response.statusCode).toBe(200);
  const capabilities = response.json();
  expect(capabilities.languageProfiles.find((profile: { id: string }) => profile.id === 'ce-dpmxl-0.9-closed-v1').support).toEqual(['number', 'boolean']);
  expect(capabilities.languageProfiles.find((profile: { id: string }) => profile.id === 'ce-dpmxl-0.9-closed-v2').support).toEqual(expect.arrayContaining(['number', 'boolean', 'text', 'date', 'if']));
  expect(capabilities.reportProfiles).toContainEqual(expect.objectContaining({ id: 'ce-demo-types-1', moduleVersion: 'DEMO_TYPES_1', supportedTables: ['DEMO_TYPES'], languageProfileId: 'ce-dpmxl-0.9-closed-v2' }));
});
