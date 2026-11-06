import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { configureCorepDemo } from './direction-review-helpers.js';
async function tabTo(page: Page, target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeEnabled();
  for (let step = 0; step < 320; step++) { if (await target.evaluate(element => element === document.activeElement)) return; await page.keyboard.press('Tab'); }
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
test('COREP analyst journey by keyboard: inspect, confirm, validate, apply five changes and export CA1', async ({ page }, info) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Saltar al contenido principal' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await tabTo(page, page.getByLabel('Nombre del conjunto'));
  await page.keyboard.type('Ejemplo COREP SYNTHETIC');
  await activate(page, page.getByRole('button', { name: 'Crear conjunto', exact: true }));

  const guide = page.getByRole('region', { name: 'Demostraciones guiadas', exact: true });
  await expect(guide).toBeVisible();
  await guide.screenshot({ path: info.outputPath('analyst-guide-desktop.png') });
  const locations: string[] = [];
  for (const [label, filename] of [['Descargar catálogo COREP', 'demo-corep-catalog.xlsx'], ['Descargar informe COREP', 'demo-corep-report.xlsx']] as const) {
    const downloading = page.waitForEvent('download');
    await activate(page, guide.getByRole('button', { name: label, exact: true }));
    const download = await downloading;
    expect(download.suggestedFilename()).toBe(filename);
    const location = info.outputPath(filename);
    await download.saveAs(location);
    const sheets = await readXlsxFile(location, { trim: false });
    expect(sheets.some(sheet => sheet.sheet === 'Instrucciones')).toBe(true);
    locations.push(location);
  }
  // Playwright's native file-input API replaces the operating-system file chooser.
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(locations[0]!);
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(locations[1]!);
  await expect(page.locator('#context-source')).toHaveValue('workbook');

  async function action(suffix: string, label: string) {
    const posting = page.waitForResponse(response => response.url().endsWith(suffix) && response.request().method() === 'POST');
    await activate(page, page.getByRole('button', { name: label, exact: true }));
    const response = await posting;
    expect(response.status()).toBe(202);
    return jobDone(page, (await response.json()).jobId);
  }
  async function stage(name: RegExp, title: string) {
    await activate(page, page.getByRole('button', { name }));
    await expect(page.locator(title)).toBeFocused();
  }
  async function selectProposal(code: string) {
    const checkbox = page.getByRole('checkbox', { name: 'Seleccionar ' + code, exact: true });
    await tabTo(page, checkbox);
    await page.keyboard.press('Space');
    await expect(checkbox).toBeChecked();
  }
  const inspected = await action('/import-inspections', 'Inspeccionar archivos');
  const review = page.getByRole('region', { name: 'Revisión de la carga', exact: true });
  await expect(review).toContainText('CA1');
  await expect(review).toContainText('SYNTHETIC');
  await expect(page.getByTestId('current-version-id')).toContainText('Pendiente');
  const imported = await action('/import-inspections/' + inspected.resultRef.id + '/commit', 'Confirmar carga');
  await expect(page.getByTestId('current-version-id')).toHaveText(imported.newVersionId);
  await expect(page.locator('.workspace-context')).toContainText('31/12/2025');

  await stage(/^2\. Validar\b/, '#validation-title');
  const validation = await action('/validations', 'Validar informes');
  await expect(page.locator('#validation-run')).toHaveValue(validation.resultRef.id);
  await expect(page.locator('.result-row').filter({ hasText: 'v0174_m' }).getByText('Falla', { exact: true })).toBeVisible();
  await expect(page.locator('.result-row').filter({ hasText: 'DEMO_IF_ELSE' }).getByText('Pasa', { exact: true })).toBeVisible();
  const official = ['v0172_m', 'v0173_m', 'v0174_m', 'v0175_m', 'v0176_m'];
  await configureCorepDemo(page, control => activate(page, control));
  await stage(/^3\. Recalcular\b/, '#preview-title');
  const preview = await action('/previews', 'Simular recálculos');
  await expect(page.locator('#preview-history')).toHaveValue(preview.resultRef.id);
  await expect(page.getByRole('heading', { name: 'Confirmar la aplicación' })).toHaveCount(0);
  await selectProposal('v0172_m');
  await expect(page.getByText(/Faltan 4 predecesores/)).toBeVisible();
  const acknowledgement = page.getByRole('checkbox', { name: 'He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.' });
  await expect(acknowledgement).toBeDisabled();
  for (const code of official.slice(1)) await selectProposal(code);
  await expect(acknowledgement).toBeEnabled();
  await tabTo(page, acknowledgement);
  await page.keyboard.press('Space');
  const application = await action('/applications', 'Aplicar cambios seleccionados');

  const comparison = page.locator('ce-comparison');
  await expect(comparison).toContainText('Valores modificados: 5');
  await expect(comparison.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Pasa', exact: true }) }).getByRole('cell')).toHaveText(['7', '14']);
  await expect(comparison.getByRole('row').filter({ has: page.getByRole('rowheader', { name: 'Falla', exact: true }) }).getByRole('cell')).toHaveText(['8', '1']);
  const detailButton = comparison.getByRole('button', { name: 'Ver cálculo y origen de v0174_m', exact: true });
  await activate(page, detailButton);
  const detail = page.getByRole('region', { name: 'Después', exact: true }).getByRole('region', { name: 'Cálculo y origen de v0174_m', exact: true });
  await expect(detail).toContainText('60');
  const color = await page.locator('.muted').first().evaluate(element => getComputedStyle(element).color);
  expect(contrast(color, 'rgb(255, 255, 255)')).toBeGreaterThanOrEqual(4.5);
  await comparison.screenshot({ path: info.outputPath('analyst-comparison-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await detail.screenshot({ path: info.outputPath('analyst-comparison-detail-mobile.png') });
  await activate(page, detail.getByRole('button', { name: 'Cerrar detalle', exact: true }));
  await expect(detailButton).toBeFocused();
  await comparison.screenshot({ path: info.outputPath('analyst-comparison-mobile.png') });
  await stage(/^1\. Cargar\b/, '#import-title');
  await guide.screenshot({ path: info.outputPath('analyst-guide-mobile.png') });

  await stage(/^4\. Descargar\b/, '#exports-title');
  await tabTo(page, page.locator('#export-version'));
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.locator('#export-version')).toHaveValue(application.newVersionId);
  await expect(page.locator('#export-kind')).toHaveValue('report');
  const downloading = page.waitForEvent('download');
  await activate(page, page.getByRole('button', { name: 'Preparar descarga', exact: true }));
  const artifact = await downloading;
  expect(artifact.suggestedFilename()).toBe('report.zip');
  const saved = info.outputPath('corep-recalculado.zip');
  await artifact.saveAs(saved);
  const entries = await readZipParts(saved);
  const log = JSON.parse(entries.find(entry => entry.name === 'changes.json')!.data.toString('utf8'));
  expect(log.versionId).toBe(application.newVersionId);
  expect(log.changes).toHaveLength(5);
  const reports = entries.filter(entry => /^reports\/[^/]+\.xlsx$/.test(entry.name));
  expect(reports).toHaveLength(1);
  const sheets = await readXlsxFile(reports[0]!.data, { trim: false, parseNumber: value => value });
  const rows = sheets.find(sheet => sheet.sheet === 'CA1')!.data;
  const expected = { '0070': '60', '0030': '185', '0150': '50', '0130': '100', '0020': '285' };
  for (const [rowCode, value] of Object.entries(expected)) {
    expect(String(rows.find(row => row[1] === rowCode)?.[4])).toMatch(new RegExp('^' + value + '(?:\\.00)?$'));
  }
  await activate(page, page.getByRole('button', { name: 'Cerrar conjunto', exact: true }));
  await expect(page.getByRole('button', { name: 'Cerrar y descartar', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Volver', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Cerrar conjunto', exact: true })).toBeFocused();
  await info.attach('automated-journey-evidence', {
    body: JSON.stringify({ actor: 'Playwright', profile: 'eba-corep-of-4.0-ca1-v1', rules: 16, changes: expected,
      before: { pass: 7, fail: 8, notApplicable: 1 }, after: { pass: 14, fail: 1, notApplicable: 1 },
      keyboard: ['download', 'inspect', 'publish', 'validate', 'configure', 'select', 'apply', 'compare', 'export'],
      automationAssistance: ['setInputFiles for native file chooser'], humanAcceptance: false }, null, 2), contentType: 'application/json',
  });
});
test('file errors are next to their fields and the compact layout remains usable at 320px', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 }); await page.getByLabel('Nombre del conjunto').fill('Errores SYNTHETIC'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'catalog.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
  await expect(page.getByLabel('Catálogo de reglas (.xlsx)')).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#catalog-error')).toHaveText('El catálogo debe ser un archivo .xlsx.');
  await expect(page.getByRole('button', { name: 'Inspeccionar archivos', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); await page.locator('ce-import-page').screenshot({ path: path.resolve('.cache/analyst-errors-mobile.png') });
});
