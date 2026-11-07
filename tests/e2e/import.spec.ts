import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { changeXml, readZipParts, replaceCell, zipBytes } from '../helpers/xlsx-fixtures.js';
import { importLegacyFixture } from './workflow-helpers.js';
import type { Page } from '@playwright/test';
const catalogPath = path.resolve('tests/fixtures/generated/eba-subset.xlsx'), reportPath = path.resolve('tests/fixtures/generated/report-42.xlsx');
const sourceHashes = new Map<string, string>();
test.beforeAll(async () => {
  const manifest = JSON.parse(await readFile(path.resolve('tests/fixtures/source-manifest.json'), 'utf8')) as { sourceName: string; sha256: string; grammarHashes: { lexer: string; parser: string } };
  sourceHashes.set(manifest.sourceName, manifest.sha256); sourceHashes.set('grammar/dpm_xlLexer-v0.9.g4', manifest.grammarHashes.lexer); sourceHashes.set('grammar/dpm_xlParser-v0.9.g4', manifest.grammarHashes.parser);
  for (const [file, hash] of sourceHashes) expect(createHash('sha256').update(await readFile(path.resolve(file))).digest('hex')).toBe(hash);
});
test.afterAll(async () => { for (const [file, hash] of sourceHashes) expect(createHash('sha256').update(await readFile(path.resolve(file))).digest('hex')).toBe(hash); });
test.beforeEach(async ({ page }) => {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  if (bootstrap.activeWorkspaceId) {
    const headers = { 'X-CE-Session': bootstrap.sessionToken as string };
    const current = await page.request.get('/api/v1/workspaces/' + bootstrap.activeWorkspaceId, { headers });
    await page.request.delete('/api/v1/workspaces/' + bootstrap.activeWorkspaceId, { headers: { ...headers, 'If-Match': current.headers()['etag']! } });
  }
  await page.goto('/');
});
async function createWorkspace(page: Page, name = 'Carga SYNTHETIC') {
  await page.getByLabel('Nombre del conjunto').fill(name); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cargar catálogo e informes' })).toBeVisible();
  await expect(page.getByRole('button', { name: '1. Cargar', exact: true })).toBeVisible();
  await expect(page.locator('ce-validation-page, ce-preview-page, ce-exports')).toHaveCount(0);
}
test('SC-007: the anonymous HTML and local product icon expose only the product before and after a publication', async ({ page, browser, baseURL }, info) => {
  const reader = await browser.newContext({ baseURL, javaScriptEnabled: false });
  try {
    const publicPage = await reader.newPage();
    async function readPublicDescription() {
      const response = await publicPage.goto('/');
      expect(response?.status()).toBe(200);
      const html = await response!.text();
      await expect(publicPage.locator('html')).toHaveAttribute('lang', 'es');
      await expect(publicPage).toHaveTitle(/ConsolidationEngine.*informes regulatorios/i);
      await expect(publicPage.locator('meta[name="description"]')).toHaveAttribute('content', /valid.*recálcul/i);
      await expect(publicPage.getByRole('heading', { level: 1 })).toContainText('ConsolidationEngine');
      await expect(publicPage.locator('ce-root')).toContainText(/informes regulatorios/i);
      const href = await publicPage.locator('link[rel~="icon"]').getAttribute('href');
      expect(href).toBe('/consolidation-engine.svg');
      const icon = await reader.request.get(href!);
      expect(icon.status()).toBe(200);
      expect(icon.headers()['content-type']).toMatch(/^image\/svg\+xml/);
      const bytes = await icon.body();
      expect(bytes.toString('utf8')).toContain('<svg');
      return { html, iconHash: createHash('sha256').update(bytes).digest('hex'), iconURL: new URL(href!, publicPage.url()).href };
    }
    const empty = await readPublicDescription();
    const workspaceName = 'PRIVATE-SYNTHETIC-PORTADA';
    const catalogName = 'private-catalog-003.xlsx';
    const reportName = 'private-report-003.xlsx';
    await createWorkspace(page, workspaceName);
    const imported = await importLegacyFixture(page, { name: catalogName, buffer: await readFile(catalogPath) }, [{ name: reportName, buffer: await readFile(reportPath) }]);
    expect(imported.workspace.counts.facts).toBeGreaterThan(0);
    const active = await readPublicDescription();
    // Compare hashes so a failed assertion cannot put the private HTML or token into a test report.
    expect(createHash('sha256').update(active.html).digest('hex')).toBe(createHash('sha256').update(empty.html).digest('hex'));
    expect(active.iconHash).toBe(empty.iconHash);
    const token = (await (await page.request.get('/api/v1/bootstrap')).json()).sessionToken;
    const privateMarkers = [workspaceName, catalogName, reportName, imported.workspace.id, imported.newVersionId,
      imported.workspace.contexts[0]!.entityId, 'v0190_m', '123456789012345678901234567890.123456789', token];
    expect(privateMarkers.some(value => active.html.includes(value)), 'private workspace data exposed by the HTML').toBe(false);
    await expect(page.locator('.app-header img')).toHaveAttribute('src', '/consolidation-engine.svg');
    const comparison = await reader.newPage();
    const tiles = [16, 32].flatMap(size => ['white', '#142536'].map(background =>
      `<div style="padding:8px;background:${background}"><img alt="Marca de ${size} px" width="${size}" height="${size}" src="${active.iconURL}"></div>`));
    await comparison.setContent('<main style="display:inline-flex;align-items:center">' + tiles.join('') + '</main>');
    const icons = comparison.getByRole('img');
    await expect(icons).toHaveCount(4);
    for (const icon of await icons.all()) {
      await expect.poll(() => icon.evaluate(node => (node as HTMLImageElement).complete && (node as HTMLImageElement).naturalWidth > 0)).toBe(true);
    }
    await comparison.locator('main').screenshot({ path: info.outputPath('favicon-16-32.png') });
    await page.locator('.app-header').screenshot({ path: info.outputPath('product-header.png') });
  } finally {
    await reader.close();
  }
});
async function inspectAndPublish(page: Page) {
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  const review = page.getByRole('region', { name: 'Revisión de la carga', exact: true });
  await expect(review).toBeVisible();
  await expect(review).toContainText('CA1');
  await expect(review).toContainText('0 hojas excluidas');
  await review.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Datos cargados · Versión 1', exact: true })).toBeVisible({ timeout: 20_000 });
}

test('V01/V14: real visual template and demo downloads, explicit import, blank/zero summary and browser refresh', async ({ page }, info) => {
  await createWorkspace(page);
  async function downloadWorkbook(button: string, expectedName: string) {
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: button, exact: true }).click();
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(expectedName);
    const location = info.outputPath(expectedName);
    await download.saveAs(location);
    return location;
  }
  const blank = await downloadWorkbook('Descargar plantilla COREP CA1', 'COREP-CA1.xlsx');
  const sheets = await readXlsxFile(blank, { trim: false });
  expect(sheets.find(sheet => sheet.sheet === 'CA1')!.data.slice(4)).toHaveLength(110);
  const populated = await downloadWorkbook('Descargar informe COREP', 'demo-corep-report.xlsx');
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve('assets/demos/demo-corep-catalog.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(populated);
  await inspectAndPublish(page);
  const header = page.locator('.workspace-context');
  await expect(header).toContainText('SYNTHETIC');
  await expect(header).toContainText('31/12/2025');
  await expect(header).toContainText('COREP_OF_4.0');
  await expect(header.getByRole('combobox')).toHaveCount(0);
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  const version = await page.locator('.workspace-context .workspace-meta dd').first().textContent();
  const published = await page.request.get(`/api/v1/workspaces/${bootstrap.activeWorkspaceId}/rules`, {
    headers: { 'X-CE-Session': bootstrap.sessionToken }, params: { versionId: version! },
  });
  expect(published.status()).toBe(200);
  const pageOfRules = await published.json();
  expect(pageOfRules.total).toBe(16);
  expect(pageOfRules.dataSummary).toMatchObject({ zeroValues: 1, explicitNulls: 0, implicitNulls: 95 });
  await expect(page.getByText('16 de 16 registros', { exact: true })).toBeVisible();
  const rule = page.locator('.rule-row').filter({ has: page.locator('summary').filter({ hasText: 'v0174_m' }) });
  await rule.locator('summary').click();
  await expect(rule.locator('pre').filter({ hasText: 'r0070' }).first()).toBeVisible();
  await page.screenshot({ path: info.outputPath('import-ui.png'), fullPage: true });
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.reload();
  await expect(page.locator('.workspace-context .workspace-meta dd').first()).toHaveText(version!);
  await expect(page.getByText('16 de 16 registros', { exact: true })).toBeVisible();
});

test('V04/V13: invalid and duplicate rules remain visible; an invalid COREP replacement preserves the version', async ({ page }) => {
  await createWorkspace(page);
  const source = await readXlsxFile(path.resolve('assets/demos/demo-corep-catalog.xlsx'), { parseNumber: text => text, trim: false });
  const rules = source.find(sheet => sheet.sheet === 'Reglas')!;
  const rows = rules.data.map(row => row.map(value => value === null ? null : String(value)));
  const invalid = [...rows[1]!];
  invalid[0] = 'SYNTHETIC_INVALID';
  invalid[6] = '1=1 @';
  rows.push([...rows[1]!], invalid);
  const catalog = await writeXlsxFile(rows.map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: rules.sheet }).toBuffer();
  const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  const report = path.resolve('assets/demos/demo-corep-report.xlsx');
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'mixed.xlsx', mimeType, buffer: catalog });
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(report);
  await inspectAndPublish(page);
  await expect(page.getByText('18 de 18 registros', { exact: true })).toBeVisible();
  const duplicate = page.locator('.rule-row').filter({ hasText: 'DUPLICATE_RULE' }).first();
  await duplicate.locator('summary').click();
  await expect(duplicate.getByText(/DUPLICATE_RULE:/)).not.toHaveClass(/error/);
  await page.getByLabel('Código de regla').fill('synthetic_invalid');
  await expect(page.getByText('1 de 1 registros', { exact: true })).toBeVisible();
  await page.locator('summary').filter({ hasText: 'SYNTHETIC_INVALID' }).click();
  await expect(page.getByText(/SYNTAX_ERROR:/).first()).toBeVisible();
  const version = await page.locator('.workspace-context .workspace-meta dd').first().textContent();
  const bad = zipBytes(changeXml(await readZipParts(report), 'xl/worksheets/sheet1.xml', xml =>
    replaceCell(xml, 'E7', '<c r="E7"><f>1+1</f><v>2</v></c>')));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles({ name: 'importe-invalido.xlsx', mimeType, buffer: bad });
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  const error = page.getByRole('alert').filter({ hasText: 'importe-invalido.xlsx' });
  await expect(error).toContainText(/CA1\s*·?\s*E7/, { timeout: 20_000 });
  await expect(error).toBeFocused();
  await expect(page.getByLabel('Informes (.xlsx)', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#reports-server-errors')).toContainText('CA1 E7');
  await expect(page.locator('.workspace-context .workspace-meta dd').first()).toHaveText(version!);
  await expect(page.getByText('1 de 1 registros', { exact: true })).toBeVisible();
});
test('production serves only the Angular build, protects API routes and supports SPA fallback', async ({ page }) => {
  await createWorkspace(page);
  expect((await page.request.get('/package.json')).status()).toBe(404); expect((await page.request.get('/.git/config')).status()).toBe(404);
  expect((await page.request.get('/api/v1/capabilities')).status()).toBe(403);
  const token = (await (await page.request.get('/api/v1/bootstrap')).json()).sessionToken as string;
  const missing = await page.request.get('/api/v1/missing', { headers: { 'X-CE-Session': token, accept: 'text/html' } });
  expect(missing.status()).toBe(404); expect(missing.headers()['content-type']).toContain('application/json');
  await page.goto('/conjunto'); await expect(page.getByRole('heading', { name: 'Cargar catálogo e informes' })).toBeVisible();
});
