import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { importLegacyFixture, navigateStage } from './workflow-helpers.js';
import { chooseConflict, prepareDirections, saveDirections } from './direction-review-helpers.js';

async function create(page: Page) {
  const boot = await (await page.request.get('/api/v1/bootstrap')).json();
  if (boot.activeWorkspaceId) {
    const url = '/api/v1/workspaces/' + boot.activeWorkspaceId, headers = { 'X-CE-Session': boot.sessionToken };
    const current = await page.request.get(url, { headers }); await page.request.delete(url, { headers: { ...headers, 'If-Match': current.headers()['etag']! } });
  }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Conflictos 004'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
}
async function validate(page: Page) {
  await navigateStage(page, 'validation'); await page.getByRole('button', { name: 'Validar informes', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Ejecución terminada', exact: true })).toBeVisible({ timeout: 60_000 });
}
async function data(page: Page) {
  const boot = await (await page.request.get('/api/v1/bootstrap')).json(), headers = { 'X-CE-Session': boot.sessionToken };
  const workspace = await (await page.request.get('/api/v1/workspaces/' + boot.activeWorkspaceId, { headers })).json();
  return { boot, headers, workspace };
}
test('COREP choices remain editable, keyboard arrows are local, and no fact version is written by a choice', async ({ page }, info) => {
  test.setTimeout(120_000); await create(page);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve('assets/demos/demo-corep-catalog.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('assets/demos/demo-corep-report.xlsx'));
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click(); await page.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  await expect(page.getByRole('button', { name: '2. Validar', exact: true })).toHaveClass(/stage-recommended/); await validate(page);
  const before = await data(page), reviewId = await prepareDirections(page), group = page.getByRole('group', { name: /r0070/ });
  await expect(group).toBeVisible();
  if (!await group.getByRole('radiogroup').count()) await group.getByRole('button', { name: 'Elegir regla', exact: true }).click();
  const edits: string[] = []; page.on('request', request => { if (request.method() === 'PATCH' && request.url().endsWith('/direction-reviews/' + reviewId)) edits.push(request.postData() ?? ''); });
  const radio = group.getByRole('radio').first(); await radio.focus(); await page.keyboard.press('ArrowDown');
  await expect(group.getByRole('button', { name: 'Confirmar elección', exact: true })).toBeEnabled();
  expect(edits).toHaveLength(0); await expect(page.getByRole('button', { name: 'Guardar configuración', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '3. Recalcular', exact: true }).click(); await expect(page.locator('ce-validation-page')).toBeVisible();
  await group.getByRole('button', { name: 'Cancelar', exact: true }).click(); expect(edits).toHaveLength(0);
  await chooseConflict(page, reviewId, group, 'DEMO_RANGE'); await expect(group).toContainText('Regla elegida: DEMO_RANGE');
  await chooseConflict(page, reviewId, group, 'v0174_m'); await expect(group).toContainText('Regla elegida: v0174_m');
  await chooseConflict(page, reviewId, page.getByRole('group', { name: /r0200/ }), null);
  expect(edits).toHaveLength(3); expect((await data(page)).workspace.versionIds).toEqual(before.workspace.versionIds);
  await expect(page.getByRole('button', { name: /^Conservar / })).toHaveCount(0);
  await page.locator('ce-directions').screenshot({ path: info.outputPath('conflicts-editable.png') });
  await saveDirections(page, reviewId, 5);
  await expect(page.getByRole('button', { name: '3. Recalcular', exact: true })).toHaveClass(/stage-recommended/);
});

test('candidate 51 survives page changes, resolution, omission and re-editing', async ({ page }) => {
  test.setTimeout(120_000); await create(page);
  const sheets = await readXlsxFile(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), { trim: false, parseNumber: value => value });
  const original = sheets[0]!.data.map(row => row.map(value => value === null ? null : String(value)));
  const definitions = Array.from({ length: 51 }, (_, index) => {
    const row = [...original[2]!]; row[0] = 'RULE_' + String(index + 1).padStart(3, '0'); row[1] = 'SYNTHETIC_004';
    row[6] = `{tC_01.00,r0230,c0010}=${index + 1}`; row[7] = ''; row[8] = 'Productor sintético ' + (index + 1); return row;
  });
  const buffer = await writeXlsxFile([original[0]!, ...definitions].map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: sheets[0]!.sheet }).toBuffer();
  await importLegacyFixture(page, { name: 'conflictos-51.xlsx', buffer }, [path.resolve('tests/fixtures/generated/report-42.xlsx')]);
  await validate(page); const reviewId = await prepareDirections(page), group = page.getByRole('group', { name: /r0230/ });
  await expect(group).toContainText('51 reglas');
  const pagination = group.getByLabel('Páginas de reglas candidatas');
  await pagination.getByRole('button', { name: 'Siguiente', exact: true }).click();
  await group.getByRole('radio', { name: /^RULE_051/ }).check();
  await pagination.getByRole('button', { name: 'Anterior', exact: true }).click();
  await expect(group).toContainText('La regla elegida está en otra página: RULE_051');
  const patched = page.waitForResponse(r => r.request().method() === 'PATCH' && r.url().endsWith('/direction-reviews/' + reviewId));
  await group.getByRole('button', { name: 'Confirmar elección', exact: true }).click(); expect((await patched).status()).toBe(200);
  await expect(group).toContainText('Regla elegida: RULE_051');
  await chooseConflict(page, reviewId, group, null); await expect(group).toContainText('Omitida');
  await chooseConflict(page, reviewId, group, 'RULE_001'); await expect(group).toContainText('Regla elegida: RULE_001');
  await saveDirections(page, reviewId, 1);
});
