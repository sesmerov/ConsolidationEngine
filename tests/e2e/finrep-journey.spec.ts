import { writeFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { navigateStage } from './workflow-helpers.js';
import { prepareDirections, ensureDirectionsReady } from './direction-review-helpers.js';

async function session(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { base: `/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, id: bootstrap.activeWorkspaceId, headers: { 'X-CE-Session': bootstrap.sessionToken as string } };
}
async function get(page: Page, suffix: string) {
  const current = await session(page), response = await page.request.get(current.base + suffix, { headers: current.headers });
  expect(response.status()).toBe(200); return response.json();
}
async function action(page: Page, suffix: string, label: string | RegExp) {
  const posted = page.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === 'POST');
  await page.getByRole('button', { name: label, exact: true }).click();
  const response = await posted; expect(response.status(), await response.text()).toBe(202);
  const id = (await response.json()).jobId; let job: any;
  await expect.poll(async () => { job = await get(page, `/jobs/${id}`); return job.status; }, { timeout: 65_000 }).toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return job;
}
async function freshWorkspace(page: Page, name: string) {
  const current = await session(page);
  if (current.id) {
    const workspace = await page.request.get(current.base, { headers: current.headers });
    expect((await page.request.delete(current.base, { headers: { ...current.headers, 'If-Match': workspace.headers()['etag']! } })).ok()).toBe(true);
  }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill(name);
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await expect(page.locator('ce-import-page')).toBeVisible();
}
async function load(page: Page, catalog: string, report: string) {
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(catalog);
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(report);
  await page.locator('#context-source').selectOption('workbook');
  const inspected = await action(page, '/import-inspections', 'Inspeccionar archivos');
  const review = await get(page, `/import-inspections/${inspected.resultRef.id}`);
  expect(review.reports[0]).toMatchObject({ profileId: 'eba-finrep-4.0-f0101-v1', coordinates: 38, values: 38 });
  const imported = await action(page, `/import-inspections/${inspected.resultRef.id}/commit`, 'Confirmar carga');
  await expect(page.getByRole('button', { name: '2. Validar', exact: true })).toHaveClass(/stage-recommended/);
  return imported;
}

for (const width of [320, 390, 1440]) test(`FINREP F 01.01 ${width}px: downloadable demo, dependent changes and Excel return`, async ({ page }, info) => {
  test.setTimeout(180_000); await page.setViewportSize({ width, height: 1000 });
  await freshWorkspace(page, `FINREP ${width} SYNTHETIC`);
  await page.locator('#demo-selector').selectOption('finrep');
  const paths: string[] = [];
  for (const [artifact, label] of [['catalog', 'catálogo'], ['report', 'informe']] as const) {
    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: `Descargar ${label} FINREP`, exact: true }).click();
    const download = await downloading; expect(download.suggestedFilename()).toBe(`demo-finrep-${artifact}.xlsx`);
    const location = info.outputPath(download.suggestedFilename()); await download.saveAs(location); paths.push(location);
  }
  const imported = await load(page, paths[0]!, paths[1]!);
  await navigateStage(page, 'validation');
  const validated = await action(page, '/validations', 'Validar informes');
  const results = await get(page, `/runs/${validated.resultRef.id}/results`);
  expect(results.total).toBe(5); expect(results.run.summary.byStatus).toMatchObject({ pass: 2, fail: 3, error: 0 });
  const reviewId = await prepareDirections(page); await ensureDirectionsReady(page, reviewId, 2);
  await expect(page.getByRole('button', { name: '3. Recalcular', exact: true })).toHaveAttribute('aria-current','step');
  await navigateStage(page, 'recalculation');
  const simulated = await action(page, '/recalculation-operations', 'Simular recálculos');
  const selection = await get(page, `/previews/${simulated.resultRef.id}/selection-state`);
  expect(selection).toMatchObject({ selectedCount: 2, requiredCount: 0, revision: 1 });
  const table = page.getByRole('table', { name: 'Propuestas de recálculo', exact: true });
  for (const [code, before, after] of [['FIN_TOTAL_CASH', '90', '100'], ['FIN_TOTAL_ASSETS_DEMO', '105', '120']]) {
    const row = table.getByRole('row').filter({ has: page.locator('.rule-code').filter({ hasText: new RegExp(`^${code}$`) }) });
    await expect(row.getByLabel(`Seleccionar ${code}`, { exact: true })).toBeChecked();
    await expect(row.locator('.value-change')).toContainText(before!); await expect(row.locator('.value-change')).toContainText(after!);
  }
  await page.getByRole('button', { name: 'Ver cálculo y origen de FIN_TOTAL_ASSETS_DEMO', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Cálculo y origen de FIN_TOTAL_ASSETS_DEMO', exact: true });
  const inputs = detail.getByRole('table', { name: 'Entradas utilizadas', exact: true });
  await expect(inputs).toContainText('100'); await expect(inputs).toContainText('20'); await expect(detail).toContainText('120');
  await info.attach('FINREP-dependent-inputs', { body: await inputs.innerText(), contentType: 'text/plain' });
  await detail.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
  const consent = page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.', { exact: true });
  await expect(consent).not.toBeChecked(); await consent.check();
  const applicationRequest = page.waitForRequest(r => r.url().endsWith('/applications') && r.method() === 'POST');
  const applied = await action(page, '/applications', 'Aplicar cambios seleccionados');
  const body = (await applicationRequest).postDataJSON(); expect(body.selectionRef).toBeDefined(); expect(body.selectedIds).toBeUndefined();
  const application = await get(page, `/applications/${applied.resultRef.id}?includeAcceptedIds=false`);
  expect(application.afterSummary.byStatus).toMatchObject({ pass: 4, fail: 1 });
  await expect(page.getByRole('button', { name: '4. Descargar', exact: true })).toHaveClass(/stage-recommended/);
  await expect(page.getByRole('heading', { name: 'Aplicación completada · comparación de validaciones', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: info.outputPath(`finrep-applied-${width}.png`), fullPage: true });
  await navigateStage(page, 'download'); await page.locator('#export-version').selectOption(imported.newVersionId);
  await expect(page.locator('#export-version')).toHaveValue(imported.newVersionId);
  await page.locator('#export-version').selectOption(applied.newVersionId);
  const downloading = page.waitForEvent('download');
  const exporting=page.waitForResponse(response=>response.url().endsWith('/exports')&&response.request().method()==='POST');
  await page.locator('[data-download-action]').click();const exportRequest=await exporting;expect(exportRequest.request().postDataJSON().versionId).toBe(applied.newVersionId);
  const download = await downloading, zip = info.outputPath('finrep-applied.zip'); await download.saveAs(zip);
  const report = (await readZipParts(zip)).find(part => part.name === 'reports/report-001.xlsx'); expect(report).toBeDefined();
  const restoredPath = info.outputPath('finrep-restored.xlsx'); await writeFile(restoredPath, report!.data);
  await freshWorkspace(page, `FINREP returned ${width} SYNTHETIC`); await load(page, paths[0]!, restoredPath);
  await navigateStage(page, 'validation'); const restored = await action(page, '/validations', 'Validar informes');
  expect((await get(page, `/runs/${restored.resultRef.id}/results`)).run.summary.byStatus).toMatchObject({ pass: 4, fail: 1, error: 0 });
  await info.attach('FINREP-journey-evidence', { body: JSON.stringify({ actor: 'Playwright', width, coordinates: 38, before: { pass: 2, fail: 3 }, after: { pass: 4, fail: 1 }, changes: ['90 → 100', '105 → 120'], roundtrip: true, humanAcceptance: false }), contentType: 'application/json' });
});
