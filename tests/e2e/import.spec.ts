import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { changeXml, readZipParts, replaceCell, zipBytes } from '../helpers/xlsx-fixtures.js';
import { enableLegacyFormat } from './workflow-helpers.js';
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
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Carga SYNTHETIC'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Cargar catálogo e informes' })).toBeVisible();
  await expect(page.getByRole('button', { name: '1. Cargar', exact: true })).toBeVisible();
  await expect(page.locator('ce-validation-page, ce-preview-page, ce-exports')).toHaveCount(0);
  await enableLegacyFormat(page);
});
test('V01/V14: real template download, exact import, null/zero summary and browser refresh', async ({ page }) => {
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Descargar plantilla Excel anterior', exact: true }).click();
  const download = await downloadPromise; expect(download.suggestedFilename()).toBe('ce-report-1.xlsx');
  const template = path.resolve('.cache/e2e-ce-report-1.xlsx'); await download.saveAs(template);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(catalogPath); await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(template);
  await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Carga y cobertura' })).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.data-summary')).toHaveText('6 coordenadas · 5 hechos · 1 ceros · 1 nulos explícitos · 1 nulos implícitos');
  await expect(page.getByText('3 de 3 registros', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Contexto', { exact: true })).toHaveText(/SYNTHETIC.*30\/06\/2026.*COREP_OF_4.2/);
  await page.locator('summary').filter({ hasText: /^v0190_m · Aplicable$/ }).click();
  await expect(page.locator('.rule-row[open] pre').filter({ hasText: '{v_C_01.00} and {v_C_05.01}' })).toBeVisible();
  await expect(page.getByText('Este panel describe la carga y el soporte de las reglas. El cumplimiento se consulta en Validación y explicación.')).toBeVisible();
  await page.screenshot({ path: path.resolve('.cache/import-ui.png'), fullPage: true });
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.reload(); await enableLegacyFormat(page); await expect(page.getByText('3 de 3 registros', { exact: true })).toBeVisible();
});
test('V04/V13: invalid and duplicate rules remain visible; a rejected replacement preserves the version', async ({ page }) => {
  const sheet = (await readXlsxFile(catalogPath, { parseNumber: (text) => text, trim: false }))[0]!;
  const rows = sheet.data.map((row) => row.map((value) => value === null ? null : String(value)));
  const invalid = [...rows[2]!]; invalid[0] = 'synthetic_invalid'; invalid[6] = '1=1 @'; rows.push([...rows[2]!], invalid);
  const catalog = await writeXlsxFile(rows.map((row) => row.map((value) => value === null ? null : { type: String, value })), { sheet: sheet.sheet }).toBuffer();
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'mixed.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: catalog });
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(reportPath); await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click();
  await expect(page.getByText('5 de 5 registros', { exact: true })).toBeVisible({ timeout: 15000 });
  const duplicate = page.locator('.rule-row').filter({ hasText: 'DUPLICATE_RULE' }); await duplicate.locator('summary').click();
  await expect(duplicate.getByText(/DUPLICATE_RULE:/)).not.toHaveClass(/error/);
  await page.getByLabel('Código de regla').fill('synthetic_invalid'); await page.getByRole('button', { name: 'Filtrar reglas' }).click();
  await expect(page.getByText('1 de 1 registros', { exact: true })).toBeVisible(); await page.locator('summary').filter({ hasText: 'synthetic_invalid' }).click();
  await expect(page.getByText(/SYNTAX_ERROR:/).first()).toBeVisible();
  const version = await page.getByTestId('current-version-id').textContent();
  const bad = zipBytes(changeXml(await readZipParts(reportPath), 'xl/worksheets/sheet4.xml', (xml) => replaceCell(xml, 'G2', '<c r="G2"><v>12345678901234567890</v></c>')));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles({ name: 'importe-invalido.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bad });
  await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'importe-invalido.xlsx' })).toContainText(/Facts\s*·?\s*G2/, { timeout: 15000 });
  await expect(page.getByRole('alert').filter({ hasText: 'importe-invalido.xlsx' })).toContainText('texto');
  await expect(page.getByRole('alert').filter({ hasText: 'importe-invalido.xlsx' })).toBeFocused();
  await expect(page.getByLabel('Informes (.xlsx)', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#reports-server-errors')).toContainText('Facts G2');
  await expect(page.getByTestId('current-version-id')).toHaveText(version!); await expect(page.getByText('1 de 1 registros', { exact: true })).toBeVisible();
});
test('production serves only the Angular build, protects API routes and supports SPA fallback', async ({ page }) => {
  expect((await page.request.get('/package.json')).status()).toBe(404); expect((await page.request.get('/.git/config')).status()).toBe(404);
  expect((await page.request.get('/api/v1/capabilities')).status()).toBe(403);
  const token = (await (await page.request.get('/api/v1/bootstrap')).json()).sessionToken as string;
  const missing = await page.request.get('/api/v1/missing', { headers: { 'X-CE-Session': token, accept: 'text/html' } });
  expect(missing.status()).toBe(404); expect(missing.headers()['content-type']).toContain('application/json');
  await page.goto('/conjunto'); await expect(page.getByRole('heading', { name: 'Cargar catálogo e informes' })).toBeVisible();
});
