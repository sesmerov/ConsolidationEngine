import path from 'node:path';
import { expect, test } from '@playwright/test';
import { createAnalystWorkspace as create, uploadDemo as upload, runAnalystAction as action, expectNoTechnicalText as noTechnicalText } from './useful-information-helpers.js';
import { chooseNativeOptionWithKeyboard, navigateStage } from './workflow-helpers.js';
import { configureCorepDemo } from './direction-review-helpers.js';

test('keeps useful evidence through real validation, proposal details, application, comparison and download', async ({ page }) => {
  test.setTimeout(150_000); await create(page); await upload(page);
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  await expect(page.getByRole('button', { name: '2. Validar', exact: true })).toHaveClass(/stage-recommended/);
  await noTechnicalText(page); await navigateStage(page, 'validation');
  await action(page, '/validations', 'Validar informes');
  await expect(page.getByRole('heading', { name: 'Ejecución terminada', exact: true })).toBeVisible();
  await expect(page.locator('.job-progress')).toHaveCount(0);
  await page.getByRole('button', { name: 'Ver cálculo y origen de DEMO_INTERVAL', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Cálculo y origen de DEMO_INTERVAL', exact: true });
  await expect(detail).toContainText('demo-corep-report.xlsx'); await expect(detail.getByRole('table', { name: 'Entradas utilizadas', exact: true })).toContainText('0,00');
  await detail.locator('summary').filter({ hasText: /^Cómo se obtiene este importe$/ }).click();
  await expect(detail.locator('.calculation-explanation')).toContainText('intervalo:'); await expect(detail.locator('.calculation-explanation')).toContainText('→');
  await noTechnicalText(page); await detail.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
  await configureCorepDemo(page); await expect(page.locator('.job-progress')).toHaveCount(0); await navigateStage(page, 'recalculation');
  await action(page, '/recalculation-operations', 'Simular recálculos');
  const table = page.getByRole('table', { name: 'Propuestas de recálculo', exact: true }); await expect(table.getByRole('row')).toHaveCount(6);
  await expect(table.getByLabel('Seleccionar v0172_m', { exact: true })).toBeChecked();
  await expect(page.locator('.job-progress')).toHaveCount(0); await noTechnicalText(page);
  await table.getByRole('button', { name: 'Ver cálculo y origen de v0172_m', exact: true }).click();
  const proposal = page.locator('ce-proposal-explanation'); await expect(proposal).toContainText('Resultado exacto antes del redondeo:');
  await expect(proposal.getByRole('table', { name: 'Entradas utilizadas', exact: true })).toContainText('185,00');
  await noTechnicalText(page); await proposal.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
  const selectionSummary=page.locator('.selection-review summary');await selectionSummary.focus();await page.keyboard.press('Enter');await expect(page.locator('.selected-changes')).toBeVisible();await expect(page.locator('.selected-changes')).toContainText('→');await selectionSummary.focus();await page.keyboard.press('Space');await expect(page.locator('.selected-changes')).toBeHidden();await selectionSummary.focus();await page.keyboard.press('Enter');await noTechnicalText(page);
  await page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.').check();
  await action(page, '/applications', 'Aplicar cambios seleccionados');
  await expect(page.locator('ce-comparison')).toContainText('Valores modificados: 5'); await noTechnicalText(page); await expect(page.locator('.job-progress')).toHaveCount(0);
  await navigateStage(page, 'download'); const downloadAction = page.locator('button[data-download-action]'); await expect(downloadAction).toBeEnabled(); await noTechnicalText(page);
  const downloading = page.waitForEvent('download'); await downloadAction.click(); expect((await downloading).suggestedFilename()).toBe('report.zip');
  await expect(page.getByText('Archivo preparado: report.zip', { exact: false })).toBeVisible(); await expect(page.locator('.job-progress')).toHaveCount(0); await noTechnicalText(page);
  await page.getByRole('button', { name: 'Cerrar conjunto', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirmar cierre' })).toContainText('descarta los datos temporales');
  await page.getByRole('button', { name: 'Volver', exact: true }).click();
  await navigateStage(page, 'import');
  await expect(page.locator('#reports-help')).toContainText('10 MiB');
});

test('expired inspection remains actionable without displaying raw expiry or internal identifiers', async ({ page }) => {
  test.setTimeout(60_000); await create(page); await upload(page);
  // Controlled terminal fixture: exercise the expired presentation without waiting 15 minutes or mutating the server clock.
  await page.route('**/import-inspections/*', async route => {
    const response = await route.fetch();
    if (route.request().method() !== 'GET' || !response.ok()) { await route.fulfill({ response }); return; }
    const body = await response.json(); await route.fulfill({ response, json: body.state === 'ready' ? { ...body, expiresAt: '2000-01-01T00:00:00.000Z' } : body });
  });
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  await expect(page.getByText('La inspección ha caducado.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirmar carga', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Inspeccionar archivos', exact: true })).toBeEnabled();
  await noTechnicalText(page); expect(await page.locator('main').innerText()).not.toContain('2000-01-01T');
  await expect(page.locator('.stage-recommended')).toHaveCount(0);
});

test('partial workbook coverage names excluded sheets and requires a deliberate acceptance', async ({ page }) => {
  test.setTimeout(120_000); await create(page); await upload(page);
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('tests/fixtures/eba/official-annexes-4.0.xlsx'));
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-source'),'form');
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-framework'),'finrep');await expect(page.getByLabel('¿Se presenta la tabla F_01.01?',{exact:true})).toBeVisible();
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-framework'),'corep');await page.locator('#context-entity').fill('SYNTHETIC_COVERAGE_004');
  await page.locator('#context-reference-date').fill('2025-12-31'); await page.locator('#context-submission-date').fill('2025-12-31');
  await page.locator('#context-currency').fill('EUR');await page.locator('#context-decimals').fill('2');
  const inspect=page.getByRole('button',{name:'Inspeccionar archivos',exact:true});
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-scale'),'6');await expect(inspect).toBeDisabled();
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-filing'),'false');await expect(inspect).toBeEnabled();
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-filing'),'');await expect(inspect).toBeDisabled();
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-filing'),'true');
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-scale'),'');await expect(inspect).toBeDisabled();
  await chooseNativeOptionWithKeyboard(page,page.locator('#context-scale'),'0');await expect(inspect).toBeEnabled();
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  await expect(inspect).toBeDisabled();await chooseNativeOptionWithKeyboard(page,page.locator('[data-profile-choice]'),'eba-corep-of-4.0-ca1-v1');await expect(inspect).toBeEnabled();
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  const review = page.getByRole('region', { name: 'Revisión de la carga', exact: true });
  await expect(review).toContainText('190 hojas excluidas', { timeout: 60_000 });const excluded=review.locator('.excluded-sheets summary');await excluded.focus();await page.keyboard.press('Enter');
  await expect(review.locator('.excluded-sheets li')).toHaveCount(190); await expect(review).toContainText('Estas hojas no se importarán ni se evaluarán.');
  await excluded.focus();await page.keyboard.press('Space');await expect(review.locator('.excluded-sheets ul')).toBeHidden();await expect(review.getByLabel('Acepto importar únicamente las hojas incluidas y excluir las demás')).toBeVisible();
  const confirm = page.getByRole('button', { name: 'Confirmar carga', exact: true }); await expect(confirm).toBeDisabled();
  await review.getByLabel('Acepto importar únicamente las hojas incluidas y excluir las demás').check(); await expect(confirm).toBeEnabled(); await noTechnicalText(page);
});
