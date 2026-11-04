import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { enableLegacyFormat } from './workflow-helpers.js';

const fixturesRoot = path.resolve('tests/fixtures/generated');
const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const code = (index: number) => `SYNTHETIC_MATERIAL_${String(index).padStart(3, '0')}`;
async function connection(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { id: bootstrap.activeWorkspaceId as string, headers: { 'X-CE-Session': bootstrap.sessionToken as string } };
}
async function finishJob(page: Page, jobId: string) {
  const session = await connection(page); let job: any;
  await expect.poll(async () => {
    job = await (await page.request.get(`/api/v1/workspaces/${session.id}/jobs/${jobId}`, { headers: session.headers })).json();
    return job.status;
  }, { timeout: 30_000 }).toMatch(/succeeded|failed|cancelled|timed_out/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
  return job;
}
async function activateWithKeyboard(page: Page, control: Locator) {
  await control.focus(); await expect(control).toBeFocused(); await page.keyboard.press('Enter');
}
async function stage(page: Page, name: string, title: string) {
  await activateWithKeyboard(page, page.getByRole('button', { name, exact: true }));
  await expect(page.locator(title)).toBeFocused();
}
async function assertNoPageOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
}
async function chainFiles() {
  const catalogSource = (await readXlsxFile(path.join(fixturesRoot, 'eba-subset.xlsx'), { trim: false, parseNumber: value => value }))[0]!;
  const original = catalogSource.data.map(row => row.map(value => value === null ? null : String(value)));
  const rows = Array.from({ length: 51 }, (_, offset) => {
    const index = offset + 1, row = [...original[2]!];
    row[0] = code(index); row[1] = 'SYNTHETIC_MATERIAL';
    row[6] = `with {tC_01.00,c0010,interval:false}: {r${1000 + index}}={r${999 + index}}+1`;
    row[7] = ''; row[8] = `${code(index)} · cálculo secuencial <b>literal</b>`; return row;
  });
  const catalog = await writeXlsxFile([original[0]!, ...rows].map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: catalogSource.sheet }).toBuffer();
  const sheets = (await readXlsxFile(path.join(fixturesRoot, 'report-42.xlsx'), { trim: false, parseNumber: value => value }))
    .map(sheet => ({ sheet: sheet.sheet, data: sheet.data.map(row => row.map(value => value === null ? null : String(value))) }));
  const coordinates = sheets.find(sheet => sheet.sheet === 'Coordinates')!, facts = sheets.find(sheet => sheet.sheet === 'Facts')!;
  coordinates.data = [coordinates.data[0]!, ...Array.from({ length: 52 }, (_, index) => ['demo', 'C_01.00', '', String(1000 + index), '0010', 'number', 'EUR', '2', '{}'])];
  facts.data = [facts.data[0]!, ...Array.from({ length: 52 }, (_, index) => ['demo', 'C_01.00', '', String(1000 + index), '0010', 'value', index === 0 ? '10' : '0'])];
  const report = await writeXlsxFile(sheets.map(sheet => ({ ...sheet, data: sheet.data.map(row => row.map(value => value === null ? null : { type: String, value })) }))).toBuffer();
  return { catalog, report };
}

test.beforeEach(async ({ page }) => {
  const session = await connection(page);
  if (session.id) {
    const current = await page.request.get(`/api/v1/workspaces/${session.id}`, { headers: session.headers });
    expect((await page.request.delete(`/api/v1/workspaces/${session.id}`, { headers: { ...session.headers, 'If-Match': current.headers()['etag']! } })).ok()).toBe(true);
  }
  await page.goto('/');
});

for (const width of [320, 390, 1440]) {
  test(`Material workflow ${width}px: explicit off-page dependencies, preserved state and receipt download`, async ({ page }, testInfo) => {
    test.setTimeout(180_000); await page.setViewportSize({ width, height: 1000 });
    await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Saltar al contenido principal' })).toBeFocused();
    await page.keyboard.press('Enter'); await expect(page.locator('#main-content')).toBeFocused();
    await page.getByLabel('Nombre del conjunto').fill(`Material ${width} SYNTHETIC`);
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Crear conjunto', exact: true }));
    // The baseline renders all stages together and has anchor links; the new shell has an active stage.
    await expect(page.getByRole('button', { name: '2. Validar', exact: true })).toBeVisible();
    await expect(page.locator('ce-import-page')).toBeVisible(); await expect(page.locator('ce-validation-page')).toHaveCount(0);
    await enableLegacyFormat(page);
    await assertNoPageOverflow(page);
    const files = await chainFiles();
    await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'material-catalog.xlsx', mimeType, buffer: files.catalog });
    await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles({ name: 'material-report.xlsx', mimeType, buffer: files.report });
    const importing = page.waitForResponse(response => response.url().endsWith('/imports') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click();
    const imported = await finishJob(page, (await (await importing).json()).jobId);
    await expect(page.getByTestId('current-version-id')).toHaveText(imported.newVersionId);
    await stage(page, '2. Validar', '#validation-title');
    const validating = page.waitForResponse(response => response.url().endsWith('/validations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Validar informes', exact: true }).click();
    const validated = await finishJob(page, (await (await validating).json()).jobId);
    const session = await connection(page), base = `/api/v1/workspaces/${session.id}`;
    const results = await (await page.request.get(`${base}/runs/${validated.resultRef.id}/results?limit=200`, { headers: session.headers })).json();
    expect(results.total).toBe(51); expect(results.run.summary.byStatus.fail).toBe(51);
    const resultsTable = page.getByRole('table', { name: 'Resultados de validación', exact: true });
    await expect(resultsTable.getByRole('row')).toHaveCount(51);
    await expect(resultsTable.getByText(`${code(1)} · cálculo secuencial <b>literal</b>`, { exact: true })).toBeVisible();
    await expect(resultsTable.locator('b')).toHaveCount(0);
    await assertNoPageOverflow(page);
    // Configure the fixture through the real API; all subsequent selection and application use the UI.
    const current = await page.request.get(base, { headers: session.headers });
    const configured = await page.request.put(`${base}/directions`, { headers: { ...session.headers, 'If-Match': current.headers()['etag']! }, data: { directions: results.items.map((result: { instanceId: string }) => ({ instanceId: result.instanceId, targetSide: 'left' })) } });
    expect(configured.status()).toBe(200);
    await page.reload(); await stage(page, '3. Recalcular', '#preview-title');
    const previewing = page.waitForResponse(response => response.url().endsWith('/previews') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Simular recálculos', exact: true }).click();
    const previewJob = await finishJob(page, (await (await previewing).json()).jobId);
    const proposals = await (await page.request.get(`${base}/previews/${previewJob.resultRef.id}/proposals?limit=200`, { headers: session.headers })).json();
    expect(proposals.items.map((proposal: { code: string }) => proposal.code)).toEqual(Array.from({ length: 51 }, (_, index) => code(index + 1)));
    const preview = page.locator('ce-preview-page'), table = preview.getByRole('table', { name: 'Propuestas de recálculo', exact: true });
    await expect(table.getByRole('row')).toHaveCount(51);
    await preview.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await expect(table.getByRole('row')).toHaveCount(2);
    await page.getByLabel(`Seleccionar ${code(51)}`, { exact: true }).check();
    await expect(preview.getByText(/Faltan 50 predecesores/)).toBeVisible();
    const dependency = preview.getByRole('button', { name: `Consultar ${code(1)}`, exact: true });
    await dependency.click();
    const firstSelection = page.getByLabel(`Seleccionar ${code(1)}`, { exact: true });
    await expect(firstSelection).not.toBeChecked(); // Merely inspecting an off-page dependency grants no consent.
    await firstSelection.check();
    await preview.getByRole('button', { name: 'Anterior', exact: true }).click();
    for (let index = 2; index <= 50; index++) await table.getByLabel(`Seleccionar ${code(index)}`, { exact: true }).check();
    await expect(table.getByLabel(`Seleccionar ${code(1)}`, { exact: true })).toBeChecked();
    await expect(preview.getByText(/La selección contiene todos sus predecesores/)).toBeVisible();
    await expect(preview.getByText(/1 propuesta.*fuera de esta página/)).toBeVisible();
    await stage(page, '4. Descargar', '#exports-title');
    await page.locator('#export-version').selectOption(imported.newVersionId);
    await stage(page, '3. Recalcular', '#preview-title');
    await expect(table.getByLabel(`Seleccionar ${code(1)}`, { exact: true })).toBeChecked();
    const detailTrigger = table.getByRole('button', { name: `Ver cálculo y origen de ${code(2)}`, exact: true });
    await activateWithKeyboard(page, detailTrigger);
    const calculation = page.locator('ce-calculation-detail');
    await expect(calculation).toContainText('11'); await expect(calculation).toContainText(/propuesta|recalculado/i);
    await expect(table).not.toContainText('["'); // Serialized keys belong only in the optional technical detail.
    const closeDetail = calculation.getByRole('button', { name: /Cerrar/ });
    await closeDetail.click(); await expect(detailTrigger).toBeFocused();
    await assertNoPageOverflow(page);
    if (width < 500) {
      const scrollRegion = page.getByRole('region', { name: 'Tabla de propuestas', exact: true });
      await scrollRegion.evaluate(element => { element.scrollLeft = 0; });
      await scrollRegion.focus(); await page.keyboard.press('ArrowRight');
      await expect.poll(() => scrollRegion.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      await table.locator('.value-change').first().scrollIntoViewIfNeeded();
    }
    await table.getByRole('row').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`material-proposals-${width}.png`) });
    const acknowledgement = page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.');
    await expect(acknowledgement).toBeEnabled(); await acknowledgement.focus(); await page.keyboard.press('Space');
    const applying = page.waitForResponse(response => response.url().endsWith('/applications') && response.request().method() === 'POST');
    await activateWithKeyboard(page, page.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true }));
    const acceptedApplication = await applying;
    expect(acceptedApplication.request().postDataJSON().selectedIds.slice().sort()).toEqual(proposals.items.map((proposal: { id: string }) => proposal.id).sort());
    const applied = await finishJob(page, (await acceptedApplication.json()).jobId);
    const comparison = page.locator('ce-comparison'); await expect(comparison).toContainText('Valores modificados: 51');
    await expect(acknowledgement).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true })).toHaveCount(0);
    await expect(comparison).toContainText('Antes'); await expect(comparison).toContainText('Después');
    await assertNoPageOverflow(page);
    await comparison.getByRole('table', { name: 'Comparación de resultados', exact: true }).getByRole('row').first().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`material-comparison-${width}.png`) });
    const request = page.waitForRequest(request => request.url().endsWith('/exports') && request.method() === 'POST');
    const downloading = page.waitForEvent('download'); await comparison.getByRole('button', { name: 'Descargar esta versión', exact: true }).click();
    expect((await request).postDataJSON().versionId).toBe(applied.newVersionId);
    const saved = testInfo.outputPath('applied.zip'); await (await downloading).saveAs(saved);
    const entries = await readZipParts(saved), changes = JSON.parse(entries.find(entry => entry.name === 'changes.json')!.data.toString('utf8'));
    expect(changes.changes).toHaveLength(51);
    expect(changes.changes.map((change: { after: { originalText: string } }) => change.after.originalText).sort()).toEqual(Array.from({ length: 51 }, (_, offset) => `${offset + 11}.00`).sort());
    await stage(page, '4. Descargar', '#exports-title'); await expect(page.locator('#export-version')).toHaveValue(imported.newVersionId);
    await testInfo.attach('verification', { body: JSON.stringify({ actor: 'Playwright automation', width, selectedExplicitly: 51, originalVersion: imported.newVersionId, appliedVersion: applied.newVersionId, humanAcceptance: false, isolationPort: 3318, fixture: randomUUID() }), contentType: 'application/json' });
  });
}
