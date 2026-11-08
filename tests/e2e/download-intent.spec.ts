import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { importLegacyFixture, navigateStage } from './workflow-helpers.js';

async function fresh(page: Page, versions = 2) {
  const connection = await (await page.request.get('/api/v1/bootstrap')).json();
  if (connection.activeWorkspaceId) { const base = '/api/v1/workspaces/' + connection.activeWorkspaceId, headers = { 'X-CE-Session': connection.sessionToken }, response = await page.request.get(base, { headers }); await page.request.delete(base, { headers: { ...headers, 'If-Match': response.headers()['etag']! } }); }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Descarga coherente SYNTHETIC'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  let result!: Awaited<ReturnType<typeof importLegacyFixture>>;
  for (let i = 0; i < versions; i++) result = await importLegacyFixture(page, path.resolve('tests/fixtures/generated/eba-subset.xlsx'), [path.resolve('tests/fixtures/generated/report-42.xlsx')]);
  await navigateStage(page, 'download'); return result.workspace;
}
function gate() { let release!: () => void; return { promise: new Promise<void>(resolve => { release = resolve; }), release }; }
async function unzip(page: Page, location: string) {
  const downloading = page.waitForEvent('download'); await page.locator('[data-download-action]').click(); const file = await downloading; expect(file.suggestedFilename()).toBe('report.zip'); await file.saveAs(location);
  const parts = await readZipParts(location); return JSON.parse(parts.find(part => part.name === 'changes.json')!.data.toString('utf8'));
}

test('SC-003/004: visible version 1, summary, payload and real ZIP agree after version 6 finishes late', async ({ page }, info) => {
  test.setTimeout(120_000); const workspace = await fresh(page, 6), first = workspace.versionIds[0]!, sixth = workspace.currentVersionId!;
  const summaryGate = gate(); let artifactRequested = false, preparations = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/exports')) preparations++; });
  const intercept = async (route: Route) => { if (route.request().headers()['accept']?.includes('application/json')) { artifactRequested = true; await summaryGate.promise; } await route.continue(); };
  await page.route('**/exports/*', intercept);
  await expect(page.locator('#export-version')).toHaveValue(sixth); await expect(page.locator('[data-download-action]')).toHaveCount(1);
  await page.locator('[data-download-action]').click(); await expect.poll(() => artifactRequested).toBe(true);
  await page.locator('#export-version').selectOption(first); await expect(page.getByRole('region', { name: 'Contenido de la versión elegida', exact: true })).toContainText('Versión 1');
  const unexpected: string[] = []; const onDownload = (download: { suggestedFilename(): string }) => unexpected.push(download.suggestedFilename()); page.on('download', onDownload);
  summaryGate.release(); await expect(page.locator('[data-download-action]')).toHaveText('Descargar'); await expect(page.locator('#export-version')).toHaveValue(first); expect(unexpected).toEqual([]); page.off('download', onDownload);
  const request = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/exports'));
  const original = await unzip(page, info.outputPath('version-1.zip')); expect((await request).postDataJSON()).toEqual({ versionId: first, kind: 'report' }); expect(original.versionId).toBe(first);
  await page.locator('#export-version').selectOption(sixth); await expect(page.locator('[data-download-action]')).toHaveText('Descargar'); const previous = preparations;
  expect((await unzip(page, info.outputPath('version-6.zip'))).versionId).toBe(sixth); expect(preparations).toBe(previous);
  await page.locator('#export-version').selectOption(first); await navigateStage(page, 'validation'); await navigateStage(page, 'download'); await expect(page.locator('#export-version')).toHaveValue(first);
});

test('SC-004: lost acceptance survives reload, recovers receipt and keeps one button without preparing twice', async ({ page }, info) => {
  test.setTimeout(90_000); const workspace = await fresh(page), first = workspace.versionIds[0]!; await page.locator('#export-version').selectOption(first);
  let acceptedKey = '', acceptedBody: unknown, preparations = 0;
  await page.route('**/workspaces/*/exports', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    preparations++; acceptedKey = route.request().headers()['idempotency-key']!; acceptedBody = route.request().postDataJSON(); const accepted = await route.fetch(); expect(accepted.status()).toBe(202); await route.abort('failed');
  });
  await page.locator('[data-download-action]').click(); await expect(page.locator('[data-download-action]')).toHaveText('Reintentar descarga'); await expect(page.locator('#export-version')).toBeDisabled();
  await page.unroute('**/workspaces/*/exports'); const receipt = page.waitForResponse(response => response.url().endsWith('/operation-receipts/' + acceptedKey));
  await page.reload(); await navigateStage(page, 'download'); expect((await receipt).status()).toBe(200); await expect(page.locator('[data-download-action]')).toHaveText('Descargar'); await expect(page.locator('#export-version')).toHaveValue(first);
  expect(acceptedBody).toEqual({ versionId: first, kind: 'report' }); expect(preparations).toBe(1); expect((await unzip(page, info.outputPath('recovered.zip'))).versionId).toBe(first);
});

test('SC-003: transfer failure retries the same artifact and no extra preparation', async ({ page }, info) => {
  test.setTimeout(90_000); const workspace = await fresh(page); let preparations = 0, failed = false;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/exports')) preparations++; });
  await page.route('**/exports/*', async route => { if (!failed && route.request().headers()['accept'] === 'application/zip') { failed = true; await route.abort('failed'); } else await route.continue(); });
  await page.locator('[data-download-action]').click(); await expect(page.locator('[data-download-action]')).toHaveText('Reintentar descarga'); await expect(page.locator('#export-version')).toBeEnabled(); expect(preparations).toBe(1);
  expect((await unzip(page, info.outputPath('retried.zip'))).versionId).toBe(workspace.currentVersionId); expect(preparations).toBe(1); await expect(page.locator('[data-download-action]')).toHaveText('Descargar');
});
