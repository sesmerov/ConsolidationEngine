import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { enableLegacyFormat, navigateStage } from './workflow-helpers.js';

const fixturesRoot = path.resolve('tests/fixtures/generated');
const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const ruleCode = 'SYNTHETIC_LONG_VALUES';
const before = '1234567890123456789012345678900.123456789';
const after = '1234567890123456789012345678901.123456789';
// Independent display oracle: never format expected values through the application's formatter.
const beforeDisplayed = '1.234.567.890.123.456.789.012.345.678.900,123456789';
const afterDisplayed = '1.234.567.890.123.456.789.012.345.678.901,123456789';
const description = '<b>texto</b> · Comprobación sintética de un importe con treinta y un dígitos enteros y nueve decimales. '
  + 'La descripción completa debe poder leerse en el detalle y conservar los signos literales, sin interpretar etiquetas como HTML. '
  + 'El valor exacto debe conservar todos sus dígitos, también en una pantalla estrecha. Fin de la descripción larga.';

async function connection(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { id: bootstrap.activeWorkspaceId as string, headers: { 'X-CE-Session': bootstrap.sessionToken as string } };
}

async function finishJob(page: Page, jobId: string) {
  const session = await connection(page);
  let job: any;
  await expect.poll(async () => {
    job = await (await page.request.get(`/api/v1/workspaces/${session.id}/jobs/${jobId}`, { headers: session.headers })).json();
    return job.status;
  }, { timeout: 30_000 }).toMatch(/succeeded|failed|cancelled|timed_out/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
  return job;
}

async function longValueFiles() {
  // Keep the versioned demo corpus untouched; this fixture only exists in this test's upload buffers.
  const catalogSource = (await readXlsxFile(path.join(fixturesRoot, 'eba-subset.xlsx'), { trim: false, parseNumber: value => value }))[0]!;
  const catalogRows = catalogSource.data.map(row => row.map(value => value === null ? null : String(value)));
  const rule = [...catalogRows[2]!];
  rule[0] = ruleCode;
  rule[1] = 'SYNTHETIC_LONG_VALUES';
  rule[6] = `with {tC_01.00,c0010,interval:false}: {r0230}=${after}`;
  rule[7] = '';
  rule[8] = description;
  const catalog = await writeXlsxFile([catalogRows[0]!, rule].map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: catalogSource.sheet }).toBuffer();
  const sheets = (await readXlsxFile(path.join(fixturesRoot, 'report-42.xlsx'), { trim: false, parseNumber: value => value }))
    .map(sheet => ({ sheet: sheet.sheet, data: sheet.data.map(row => row.map(value => value === null ? null : String(value))) }));
  const coordinates = sheets.find(sheet => sheet.sheet === 'Coordinates')!;
  const facts = sheets.find(sheet => sheet.sheet === 'Facts')!;
  coordinates.data = [coordinates.data[0]!, ['demo', 'C_01.00', '', '0230', '0010', 'number', 'EUR', 'INF', '{}']];
  facts.data = [facts.data[0]!, ['demo', 'C_01.00', '', '0230', '0010', 'value', before]];
  const report = await writeXlsxFile(sheets.map(sheet => ({ ...sheet, data: sheet.data.map(row => row.map(value => value === null ? null : { type: String, value })) }))).toBuffer();
  return { catalog, report };
}

async function noPageOverflow(page: Page) {
  expect(await page.evaluate(() => ({ viewport: window.innerWidth, page: document.documentElement.scrollWidth })))
    .toEqual({ viewport: page.viewportSize()!.width, page: page.viewportSize()!.width });
}

async function keyboardScroll(page: Page, region: Locator, width: number, requireMobileOverflow = true) {
  await region.evaluate(element => { element.scrollLeft = 0; });
  await region.focus();
  await expect(region).toBeFocused();
  const geometry = await region.evaluate(element => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
  }));
  expect(geometry.overflowX).toBe('auto');
  if (width < 500 && requireMobileOverflow) expect(geometry.scrollWidth).toBeGreaterThan(geometry.clientWidth);
  await page.keyboard.press('ArrowRight');
  if (geometry.scrollWidth > geometry.clientWidth) {
    await expect.poll(() => region.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  }
  await noPageOverflow(page);
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
  test(`Material long values ${width}px: exact amounts, literal descriptions and keyboard table scrolling`, async ({ page }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 1000 });
    await page.getByLabel('Nombre del conjunto').fill(`Importes largos ${width} SYNTHETIC`);
    await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
    await enableLegacyFormat(page);
    const files = await longValueFiles();
    await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'synthetic-long-values-catalog.xlsx', mimeType, buffer: files.catalog });
    await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles({ name: 'synthetic-long-values-report.xlsx', mimeType, buffer: files.report });
    const importing = page.waitForResponse(response => response.url().endsWith('/imports') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click();
    const imported = await finishJob(page, (await (await importing).json()).jobId);
    await expect(page.getByTestId('current-version-id')).toHaveText(imported.newVersionId);
    await navigateStage(page, 'validation');
    const validating = page.waitForResponse(response => response.url().endsWith('/validations') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Validar informes', exact: true }).click();
    const validated = await finishJob(page, (await (await validating).json()).jobId);
    const session = await connection(page);
    const results = await (await page.request.get(`/api/v1/workspaces/${session.id}/runs/${validated.resultRef.id}/results`, { headers: session.headers })).json();
    expect(results.total).toBe(1);
    expect(results.items[0]).toMatchObject({ code: ruleCode, status: 'fail', presentation: { description } });
    expect(results.items[0].values.left.nominal).toEqual({ numerator: before.replace('.', ''), denominator: '1000000000' });
    expect(results.items[0].values.right.nominal).toEqual({ numerator: after.replace('.', ''), denominator: '1000000000' });
    expect(results.items[0].values.right.unit).toBe('pure');
    const resultRow = page.locator('.result-row');
    await expect(resultRow.locator('.rule-description')).toHaveText(description);
    await expect(resultRow.locator('b')).toHaveCount(0);
    await keyboardScroll(page, page.getByRole('region', { name: 'Tabla de resultados', exact: true }), width);
    const detailTrigger = resultRow.getByRole('button', { name: `Ver cálculo y origen de ${ruleCode}`, exact: true });
    await detailTrigger.focus();
    await page.keyboard.press('Enter');
    const detail = page.getByRole('region', { name: `Cálculo y origen de ${ruleCode}`, exact: true });
    await expect(detail.getByRole('heading', { name: `Cálculo y origen de ${ruleCode}`, exact: true })).toBeFocused();
    const fullDescription = detail.getByText(description, { exact: true });
    await expect(fullDescription).toBeVisible();
    expect(await fullDescription.evaluate(element => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await expect(detail.locator('b')).toHaveCount(0);
    await expect(detail.locator('.expression')).toContainText(after);
    const operands = detail.locator('.detail-grid dd');
    await expect(operands).toHaveCount(3);
    await expect(operands.nth(0)).toHaveText(`${beforeDisplayed} EUR`);
    await expect(operands.nth(1)).toHaveText(`${afterDisplayed} sin unidad`);
    await expect(operands.nth(2)).toHaveText('Falso');
    const reads = detail.getByRole('table', { name: 'Entradas utilizadas', exact: true });
    await expect(reads.locator('.exact-value')).toHaveText(beforeDisplayed);
    await expect(reads.locator('.unit-label')).toHaveText('EUR');
    const unitSpacing = await reads.locator('.exact-value').evaluate(element => {
      const unit = element.nextElementSibling!;
      const amountText = document.createRange();
      amountText.selectNodeContents(element);
      const unitText = document.createRange();
      unitText.selectNodeContents(unit);
      const amountRect = Array.from(amountText.getClientRects()).at(-1)!;
      const unitRect = Array.from(unitText.getClientRects())[0]!;
      return { nextLine: unitRect.top >= amountRect.bottom, inlineGap: unitRect.left - amountRect.right };
    });
    expect(unitSpacing.nextLine || unitSpacing.inlineGap >= 3).toBe(true);
    await keyboardScroll(page, detail.getByRole('region', { name: 'Tabla de entradas utilizadas', exact: true }), width, false);
    await operands.first().scrollIntoViewIfNeeded();
    await noPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`material-long-values-detail-${width}.png`) });
    await detail.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
    await expect(detailTrigger).toBeFocused();

    // A single simulation exposes the exact amount in the main table; application is covered elsewhere.
    await page.getByLabel(`${ruleCode} · Destino`, { exact: true }).selectOption('left');
    await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click();
    await expect(page.getByText(/Configuración guardada/)).toBeVisible();
    await navigateStage(page, 'recalculation');
    const previewing = page.waitForResponse(response => response.url().endsWith('/previews') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Simular recálculos', exact: true }).click();
    await finishJob(page, (await (await previewing).json()).jobId);
    const proposal = page.locator('.proposal-row');
    await expect(proposal).toHaveCount(1);
    await expect(proposal.locator('.value-change .exact-value')).toHaveText([beforeDisplayed, afterDisplayed]);
    await expect(proposal).not.toContainText('Redondeado');
    await expect(proposal.locator('b')).toHaveCount(0);
    await keyboardScroll(page, page.getByRole('region', { name: 'Tabla de propuestas', exact: true }), width);
    await proposal.locator('.value-change').scrollIntoViewIfNeeded();
    await noPageOverflow(page);
    await page.screenshot({ path: testInfo.outputPath(`material-long-values-proposal-${width}.png`) });
    await testInfo.attach('long-values-verification', {
      body: JSON.stringify({ actor: 'Playwright automation', humanAcceptance: false, width, before, after, beforeDisplayed, afterDisplayed, description, applied: false }),
      contentType: 'application/json',
    });
  });
}
