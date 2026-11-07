import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { importLegacyFixture, navigateStage } from './workflow-helpers.js';

const fixturesRoot = path.resolve('tests/fixtures/generated');
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

test('Context in the workspace header: empty, single read-only and distinct choices with the same entity and date', async ({ page }) => {
  test.setTimeout(90_000);
  await page.getByLabel('Nombre del conjunto').fill('Prueba de contextos');
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  const header = page.getByRole('region', { name: 'Prueba de contextos', exact: true });
  const selector = header.getByRole('combobox', { name: 'Contexto', exact: true });
  await expect(header).toBeVisible();
  await expect(selector).toHaveCount(0);
  await expect(header).not.toContainText('SYNTHETIC');

  const catalog = path.join(fixturesRoot, 'eba-subset.xlsx');
  const report = path.join(fixturesRoot, 'report-42.xlsx');
  async function expectSingleContext() {
    await expect(selector).toHaveCount(0);
    for (const field of ['SYNTHETIC', '30/06/2026', 'COREP_OF_4.2']) {
      await expect(header).toContainText(field);
      expect((await header.innerText()).split(field).length - 1, field).toBe(1);
    }
  }
  const single = await importLegacyFixture(page, catalog, [report]);
  expect(single.workspace.contexts.map(context => context.contextId)).toEqual(['demo']);
  await expectSingleContext();

  // Both workbooks describe the same entity, date and module but different rows and context IDs.
  const sheets = (await readXlsxFile(report, { trim: false, parseNumber: value => value })).map(sheet => ({
    sheet: sheet.sheet, data: sheet.data.map(row => row.map(value => value === null ? null : String(value))),
  }));
  const extraId = 'contexto_adicional';
  sheets.find(sheet => sheet.sheet === 'Contexts')!.data[1]![1] = extraId;
  for (const sheetName of ['Coordinates', 'Facts']) {
    const sheet = sheets.find(entry => entry.sheet === sheetName)!;
    const otherRow = [...sheet.data[1]!];
    otherRow[0] = extraId;
    otherRow[3] = '9999';
    sheet.data = [sheet.data[0]!, otherRow];
  }
  const extra = await writeXlsxFile(sheets.map(sheet => ({
    sheet: sheet.sheet,
    data: sheet.data.map(row => row.map(value => value === null ? null : { type: String, value })),
  }))).toBuffer();
  const multiple = await importLegacyFixture(page, catalog, [report, { name: 'otro-contexto.xlsx', buffer: extra }]);
  const ids = multiple.workspace.contexts.map(context => context.contextId);
  expect([...ids].sort()).toEqual([extraId, 'demo'].sort());
  expect(multiple.workspace.contexts.every(context =>
    context.entityId === 'SYNTHETIC' && context.referenceDate === '2026-06-30' && context.moduleVersion === 'COREP_OF_4.2'
  )).toBe(true);
  await expect(selector).toHaveCount(1);
  await expect(selector.getByRole('option')).toHaveCount(2);
  expect(new Set(await selector.getByRole('option').allTextContents()).size).toBe(2);
  const secondId = await selector.locator('option').nth(1).getAttribute('value');
  expect(ids).toContain(secondId);
  await selector.focus();
  await page.keyboard.press('End');
  await expect(selector).toHaveValue(secondId!);

  await navigateStage(page, 'validation');
  const workspacePath = '/api/v1/workspaces/' + multiple.workspace.id;
  const refreshed = page.waitForResponse(async response => response.request().method() === 'GET'
    && new URL(response.url()).pathname === workspacePath && response.ok()
    && !(await response.json()).activeJobId);
  await page.getByRole('button', { name: 'Validar informes', exact: true }).click();
  await refreshed;
  await expect(page.getByRole('heading', { name: 'Ejecución terminada', exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(selector).toHaveValue(secondId!);
  await navigateStage(page, 'import');
  await expect(selector).toHaveValue(secondId!);

  await importLegacyFixture(page, catalog, [report]);
  await expectSingleContext();
  await header.getByRole('button', { name: 'Cerrar conjunto', exact: true }).click();
  await header.getByRole('button', { name: 'Cerrar y descartar', exact: true }).click();
  await page.getByLabel('Nombre del conjunto').fill('Conjunto vacío');
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  const emptyHeader = page.getByRole('region', { name: 'Conjunto vacío', exact: true });
  await expect(emptyHeader).toBeVisible();
  await expect(emptyHeader.getByRole('combobox')).toHaveCount(0);
  await expect(emptyHeader).not.toContainText('SYNTHETIC');
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
    await assertNoPageOverflow(page);
    const files = await chainFiles();
    const imported = await importLegacyFixture(page, { name: 'material-catalog.xlsx', buffer: files.catalog }, [
      { name: 'material-report.xlsx', buffer: files.report },
    ]);
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
    const confirmation = preview.getByRole('region', { name: 'Confirmar la aplicación', exact: true });
    const apply = preview.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true });
    await expect(preview.getByRole('heading', { name: 'Selección: 51 de 51 disponibles', exact: true })).toBeVisible();
    await expect(confirmation).toBeVisible();
    await expect(apply).toBeDisabled();
    await expect(page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.')).not.toBeChecked();
    await preview.getByRole('button', { name: 'Limpiar selección', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await preview.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await expect(table.getByRole('row')).toHaveCount(2);
    await page.getByLabel(`Seleccionar ${code(51)}`, { exact: true }).check();
    await expect(preview.getByText(/Faltan 50 antecedentes/)).toBeVisible();
    await expect(confirmation).toBeVisible();
    await expect(apply).toBeDisabled();
    // A new selection revision restarts cursors; return to the off-page consumer.
    await preview.getByRole('button', { name: 'Siguiente', exact: true }).click();
    await expect(table.getByRole('row')).toHaveCount(2);
    const dependency = table.getByRole('button', { name: '1 antecedente', exact: true });
    await dependency.click();
    const firstSelection = page.getByLabel(`Seleccionar antecedente ${code(50)}`, { exact: true });
    await expect(firstSelection).not.toBeChecked(); // Merely inspecting an off-page dependency grants no consent.
    await firstSelection.check();
    await expect(preview.getByRole('heading', { name: 'Antecedentes de la propuesta', exact: true })).toHaveCount(0); // The accepted edit closes the obsolete revision.
    const filterCode = preview.getByLabel('Código de propuesta', { exact: true });
    const filter = preview.getByRole('button', { name: 'Filtrar propuestas', exact: true });
    await filterCode.fill(code(12));
    await filter.click();
    await expect(table.getByRole('row')).toHaveCount(2);
    await expect(table).toContainText(code(12));
    await expect(preview.getByText('2 seleccionadas fuera de esta página.', { exact: true })).toBeVisible();
    await expect(confirmation).toContainText(/2 propuestas/);
    await expect(apply).toBeDisabled();
    await filterCode.fill('');
    await filter.click();
    await expect(table.getByRole('row')).toHaveCount(51);
    await preview.getByRole('button', { name: 'Limpiar selección', exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(apply).toHaveCount(0);
    await page.getByLabel('Seleccionar todas las disponibles de este filtro', { exact: true }).check();
    await expect(table.getByLabel(`Seleccionar ${code(1)}`, { exact: true })).toBeChecked();
    await expect(preview.getByText(/La selección contiene todos sus antecedentes/)).toBeVisible();
    await expect(preview.getByText('1 seleccionadas fuera de esta página.', { exact: true })).toBeVisible();
    await stage(page, '4. Descargar', '#exports-title');
    await page.locator('#export-version').selectOption(imported.newVersionId);
    await stage(page, '3. Recalcular', '#preview-title');
    await expect(table.getByLabel(`Seleccionar ${code(1)}`, { exact: true })).toBeChecked();
    const detailTrigger = table.getByRole('button', { name: `Ver cálculo y origen de ${code(2)}`, exact: true });
    await activateWithKeyboard(page, detailTrigger);
    const calculation = page.locator('ce-proposal-explanation');
    await expect(calculation).toContainText('11'); await expect(calculation).toContainText(/propuesta|recalculado/i);
    await expect(table).not.toContainText('["'); // Serialized keys are never rendered in the user workflow.
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
    const applicationBody = acceptedApplication.request().postDataJSON();
    expect(applicationBody.selectionRef).toEqual({ id: expect.any(String), revision: expect.any(Number) });
    expect(applicationBody).not.toHaveProperty('selectedIds');
    expect(Buffer.byteLength(JSON.stringify(applicationBody))).toBeLessThan(1024);
    const applied = await finishJob(page, (await acceptedApplication.json()).jobId);
    const comparison = page.locator('ce-comparison'); await expect(comparison).toContainText('Valores modificados: 51');
    await expect(confirmation).toHaveCount(0);
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
