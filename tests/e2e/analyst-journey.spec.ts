import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
async function tabTo(page: Page, target: Locator) {
  for (let step = 0; step < 160; step++) { if (await target.evaluate(element => element === document.activeElement)) return; await page.keyboard.press('Tab'); }
  throw new Error('Keyboard focus could not reach ' + await target.textContent());
}
async function activate(page: Page, target: Locator) { await tabTo(page, target); await page.keyboard.press('Enter'); }
async function connection(page: Page) { const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json(); return { id: bootstrap.activeWorkspaceId as string, headers: { 'X-CE-Session': bootstrap.sessionToken as string } }; }
async function jobDone(page: Page, jobId: string) { const session = await connection(page); let job: any; await expect.poll(async () => { job = await (await page.request.get(`/api/v1/workspaces/${session.id}/jobs/${jobId}`, { headers: session.headers })).json(); return job.status; }, { timeout: 15000 }).toBe('succeeded'); return job; }
function contrast(a: string, b: string): number {
  const luminance = (rgb: string) => { const values = rgb.match(/[\d.]+/g)!.slice(0, 3).map(value => Number(value) / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4); return .2126 * values[0]! + .7152 * values[1]! + .0722 * values[2]!; };
  const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0]! + .05) / (values[1]! + .05);
}
test.beforeEach(async ({ page }) => {
  const session = await connection(page); if (session.id) { const current = await page.request.get(`/api/v1/workspaces/${session.id}`, { headers: session.headers }); await page.request.delete(`/api/v1/workspaces/${session.id}`, { headers: { ...session.headers, 'If-Match': current.headers()['etag']! } }); }
  await page.goto('/');
});
test('automated analyst journey: provided workbooks, keyboard confirmation, responsive comparison and retained civil date', async ({ page }, testInfo) => {
  test.setTimeout(120_000); await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('Tab'); await expect(page.getByRole('link', { name: 'Saltar al contenido principal' })).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('#main-content')).toBeFocused();
  await tabTo(page, page.getByLabel('Nombre del conjunto')); await page.keyboard.type('Ejemplo guiado SYNTHETIC'); await activate(page, page.getByRole('button', { name: 'Crear conjunto', exact: true }));
  await expect(page.locator('.guided-example')).toBeVisible(); await activate(page, page.locator('.guided-example > summary')); await expect(page.getByRole('button', { name: 'Descargar catálogo del ejemplo', exact: true })).toBeVisible();
  await page.locator('ce-import-page > section').first().screenshot({ path: path.resolve('.cache/analyst-guide-desktop.png') });
  const locations: string[] = [];
  for (const [label, filename] of [['Descargar catálogo del ejemplo', 'ejemplo-catalogo.xlsx'], ['Descargar informe del ejemplo', 'ejemplo-informe.xlsx']]) {
    const downloading = page.waitForEvent('download'); await activate(page, page.getByRole('button', { name: label, exact: true })); const file = await downloading; expect(file.suggestedFilename()).toBe(filename);
    const location = path.resolve('.cache', filename!); locations.push(location); await file.saveAs(location); const sheets = await readXlsxFile(location, { trim: false }); expect(sheets.find(sheet => sheet.sheet === 'Instructions')!.data.flat().join(' ')).toContain('No necesitas editar ninguno');
  }
  // Playwright selects the downloaded files through its native file-input API; no workbook is edited.
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(locations[0]!); await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(locations[1]!);
  const importing = page.waitForResponse(response => response.url().endsWith('/imports') && response.request().method() === 'POST'); await activate(page, page.getByRole('button', { name: 'Cargar archivos', exact: true })); const imported = await jobDone(page, (await (await importing).json()).jobId);
  await expect(page.getByTestId('current-version-id')).toHaveText(imported.newVersionId); await expect(page.locator('.workspace-meta').first()).toContainText('30/06/2026');
  await activate(page, page.getByRole('link', { name: '2. Validar y configurar', exact: true })); await expect(page.locator('#validation-title')).toBeFocused();
  const validating = page.waitForResponse(response => response.url().endsWith('/validations') && response.request().method() === 'POST'); await activate(page, page.getByRole('button', { name: 'Validar informes', exact: true })); const validation = await jobDone(page, (await (await validating).json()).jobId); await expect(page.locator('#validation-run')).toHaveValue(validation.resultRef.id);
  await expect(page.locator('.result-row > summary').filter({ hasText: /^SYNTHETIC_A · Falla/ })).toBeVisible(); await expect(page.locator('.result-row > summary').filter({ hasText: /^SYNTHETIC_D · Pasa/ })).toBeVisible();
  for (const code of ['SYNTHETIC_A', 'SYNTHETIC_D']) { const select = page.getByLabel(code + ' · Destino', { exact: true }); await tabTo(page, select); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await expect(select).toHaveValue('left'); }
  await activate(page, page.getByRole('button', { name: 'Guardar configuración', exact: true })); await expect(page.getByText(/Configuración guardada/)).toBeVisible();
  const previewing = page.waitForResponse(response => response.url().endsWith('/previews') && response.request().method() === 'POST'); await activate(page, page.getByRole('button', { name: 'Simular recálculos', exact: true })); const preview = await jobDone(page, (await (await previewing).json()).jobId); await expect(page.locator('#preview-history')).toHaveValue(preview.resultRef.id);
  await tabTo(page, page.getByLabel('Seleccionar SYNTHETIC_D', { exact: true })); await page.keyboard.press('Space'); await expect(page.getByText(/Faltan 1 predecesores/)).toBeVisible();
  await tabTo(page, page.getByLabel('Seleccionar SYNTHETIC_A', { exact: true })); await page.keyboard.press('Space'); const ack = page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.'); await expect(ack).toBeEnabled(); await tabTo(page, ack); await page.keyboard.press('Space');
  const applying = page.waitForResponse(response => response.url().endsWith('/applications') && response.request().method() === 'POST'); await activate(page, page.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true })); const application = await jobDone(page, (await (await applying).json()).jobId);
  const comparison = page.locator('ce-comparison'); await expect(comparison).toContainText('Valores modificados: 2');
  const passing = comparison.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Pasa', exact: true }) }); await expect(passing.getByRole('cell')).toHaveText(['1', '2']);
  const failing = comparison.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Falla', exact: true }) }); await expect(failing.getByRole('cell')).toHaveText(['1', '0']);
  await activate(page, comparison.locator('summary').filter({ hasText: /^SYNTHETIC_A ·/ })); await expect(comparison).toContainText('12.00'); await expect(comparison.locator('.comparison-columns').first()).toHaveCSS('grid-template-columns', /\d+px \d+px/);
  const color = await page.locator('.muted').first().evaluate(element => getComputedStyle(element).color); expect(contrast(color, 'rgb(255, 255, 255)')).toBeGreaterThanOrEqual(4.5);
  await comparison.screenshot({ path: path.resolve('.cache/analyst-comparison-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await expect(comparison.locator('.comparison-columns').first()).toHaveCSS('grid-template-columns', /^\d+(?:\.\d+)?px$/); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await comparison.locator('.rule-row[open] .comparison-side').last().screenshot({ path: path.resolve('.cache/analyst-comparison-detail-mobile.png') });
  await activate(page, comparison.locator('summary').filter({ hasText: /^SYNTHETIC_A ·/ })); await comparison.screenshot({ path: path.resolve('.cache/analyst-comparison-mobile.png') });
  await page.locator('.guided-example').screenshot({ path: path.resolve('.cache/analyst-guide-mobile.png') });
  await activate(page, page.getByRole('link', { name: '4. Guardar', exact: true })); await expect(page.locator('#exports-title')).toBeFocused();
  await tabTo(page, page.locator('#export-version')); await page.keyboard.press('End'); await page.keyboard.press('Enter'); await expect(page.locator('#export-version')).toHaveValue(application.newVersionId); await expect(page.locator('#export-kind')).toHaveValue('report');
  const downloading = page.waitForEvent('download'); await activate(page, page.getByRole('button', { name: 'Preparar y descargar ZIP', exact: true })); const artifact = await downloading; expect(artifact.suggestedFilename()).toBe('report.zip');
  const saved = path.resolve('.cache/ejemplo-recalculado.zip'); await artifact.saveAs(saved); const entries = await readZipParts(saved);
  const log = JSON.parse(entries.find(entry => entry.name === 'changes.json')!.data.toString('utf8')); expect(log.changes.map((change: { after: { originalText: string } }) => change.after.originalText).sort()).toEqual(['12.00', '24.00']);
  const report = await readXlsxFile(entries.find(entry => entry.name === 'reports/report-001.xlsx')!.data, { trim: false }); expect(report.find(sheet => sheet.sheet === 'Facts')!.data.slice(1).map(row => row[6])).toEqual(['12.00', '5', '7', '24.00']);
  await activate(page, page.getByRole('button', { name: 'Cerrar conjunto', exact: true })); await expect(page.getByRole('button', { name: 'Cerrar y descartar', exact: true })).toBeFocused(); await page.keyboard.press('Tab'); await expect(page.getByRole('button', { name: 'Volver', exact: true })).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.getByRole('button', { name: 'Cerrar conjunto', exact: true })).toBeFocused();
  expect(application.status).toBe('succeeded');
  await testInfo.attach('automated-journey-evidence', { body: JSON.stringify({ actor: 'Playwright automation, not a human analyst', files: ['ejemplo-catalogo.xlsx', 'ejemplo-informe.xlsx'], steps: ['download instructions and files', 'import unchanged files', 'validate: 1 pass/1 fail', 'choose both left targets', 'simulate', 'select D then A explicitly', 'acknowledge and apply', 'compare: 2 pass/0 fail', 'save report.zip with exact 12.00/24.00', 'inspect desktop/mobile and close/back focus'], automationAssistance: ['setInputFiles replaces the native operating-system file chooser'], humanSC007: 'pending' }, null, 2), contentType: 'application/json' });
});
test('file errors are next to their fields and the compact layout remains usable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await page.getByLabel('Nombre del conjunto').fill('Errores SYNTHETIC'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'catalog.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') }); await expect(page.getByLabel('Catálogo de reglas (.xlsx)')).toHaveAttribute('aria-invalid', 'true'); await expect(page.locator('#catalog-error')).toHaveText('El catálogo debe ser un archivo .xlsx.'); await expect(page.getByRole('button', { name: 'Cargar archivos', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.locator('ce-import-page').screenshot({ path: path.resolve('.cache/analyst-errors-mobile.png') });
});
