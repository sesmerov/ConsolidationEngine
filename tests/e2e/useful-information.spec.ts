import path from 'node:path';
import { expect, test } from '@playwright/test';
import { navigateStage } from './workflow-helpers.js';

test('keeps useful messages and removes technical disclosure across all stages', async ({ page }) => {
  test.setTimeout(90_000);
  const boot = await (await page.request.get('/api/v1/bootstrap')).json();
  if (boot.activeWorkspaceId) {
    const url = '/api/v1/workspaces/' + boot.activeWorkspaceId, headers = { 'X-CE-Session': boot.sessionToken };
    const current = await page.request.get(url, { headers });
    await page.request.delete(url, { headers: { ...headers, 'If-Match': current.headers()['etag']! } });
  }
  await page.goto('/'); await expect(page.getByText('La sesión es temporal.', { exact: false })).toBeVisible();
  await page.getByLabel('Nombre del conjunto').fill('Información útil 004'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve('assets/demos/demo-corep-catalog.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('assets/demos/demo-corep-report.xlsx'));
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  await expect(page.getByRole('button', { name: '2. Validar', exact: true })).toHaveClass(/stage-recommended/);
  const connected = await (await page.request.get('/api/v1/bootstrap')).json();
  const workspace = await (await page.request.get('/api/v1/workspaces/' + connected.activeWorkspaceId, { headers: { 'X-CE-Session': connected.sessionToken } })).json();
  const forbidden = [connected.sessionToken, workspace.id, ...workspace.versionIds];
  for (const stage of ['import', 'validation', 'recalculation', 'download'] as const) {
    await navigateStage(page, stage);
    const text = await page.locator('main').innerText();
    for (const value of forbidden) expect(text).not.toContain(value);
    for (const label of ['Información técnica', 'Detalle técnico', 'Identificadores y política de cálculo']) expect(text).not.toContain(label);
  }
  await page.getByRole('button', { name: 'Cerrar conjunto', exact: true }).click();
  await expect(page.getByRole('group', { name: 'Confirmar cierre' })).toContainText('descarta los datos temporales');
  await page.getByRole('button', { name: 'Volver', exact: true }).click();
  await navigateStage(page, 'import');
  await expect(page.locator('#reports-help')).toContainText('10 MiB');
});
