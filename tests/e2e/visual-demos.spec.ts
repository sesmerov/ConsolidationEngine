import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page, TestInfo } from '@playwright/test';

// Independent, frozen expectations belong to tests, never to the shipped evaluator.
const corpus = JSON.parse(await readFile(path.resolve('specs/002-ui-eba-demo/contracts/demo-corpus.json'), 'utf8'));
const officialCodes = ['v0172_m', 'v0173_m', 'v0174_m', 'v0175_m', 'v0176_m'];
const changes: Record<string, [string, string]> = { v0174_m: ['5', '60'], v0173_m: ['100', '185'], v0176_m: ['10', '50'], v0175_m: ['20', '100'], v0172_m: ['1000', '285'] };
async function connection(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { base: `/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, id: bootstrap.activeWorkspaceId, headers: { 'X-CE-Session': bootstrap.sessionToken as string } };
}
async function get(page: Page, suffix: string) {
  const session = await connection(page), response = await page.request.get(session.base + suffix, { headers: session.headers });
  expect(response.status()).toBe(200); return response.json();
}
async function jobDone(page: Page, id: string) {
  let job: any;
  await expect.poll(async () => { job = await get(page, `/jobs/${id}`); return job.status; }, { timeout: 60_000 }).toMatch(/succeeded|failed|cancelled|timed_out/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return job;
}
async function runAction(page: Page, suffix: string, button: string) {
  const posting = page.waitForResponse(response => response.url().endsWith(suffix) && response.request().method() === 'POST');
  await page.getByRole('button', { name: button, exact: true }).click(); const response = await posting;
  expect(response.status()).toBe(202); return jobDone(page, (await response.json()).jobId);
}
async function stage(page: Page, name: string, title: string) {
  const control = page.getByRole('button', { name, exact: true }); await control.focus(); await page.keyboard.press('Enter');
  await expect(page.locator(title)).toBeFocused();
}
async function noPageOverflow(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true); }
async function loadDemo(page: Page, kind: 'corep' | 'types', info: TestInfo) {
  const guide = page.getByRole('region', { name: 'Demostraciones guiadas', exact: true });
  await expect(guide).toBeVisible(); await page.locator('#demo-selector').selectOption(kind);
  const files: string[] = [];
  for (const artifact of ['catalog', 'report'] as const) {
    const artifactLabel = artifact === 'catalog' ? 'catálogo' : 'informe', kindLabel = kind === 'corep' ? 'COREP' : 'de texto y fechas';
    const downloading = page.waitForEvent('download');
    await guide.getByRole('button', { name: `Descargar ${artifactLabel} ${kindLabel}`, exact: true }).click();
    const downloaded = await downloading; expect(downloaded.suggestedFilename()).toBe(`demo-${kind}-${artifact}.xlsx`);
    const location = info.outputPath(downloaded.suggestedFilename()); await downloaded.saveAs(location); files.push(location);
  }
  // Downloading and changing the guide never import data or select recalculation directions.
  expect((await get(page, '')).versionIds).toHaveLength(0);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(files[0]!);
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(files[1]!);
  await page.locator('#context-source').selectOption('workbook');
  const inspection = await runAction(page, '/import-inspections', 'Inspeccionar archivos');
  const review = page.getByRole('region', { name: 'Revisión de la carga', exact: true }); await expect(review).toBeVisible();
  const inspected = await get(page, `/import-inspections/${inspection.resultRef.id}`);
  expect(inspected.requiresPartialCoverageAcceptance).toBe(false);
  expect(inspected.reports[0].coordinates).toBe(kind === 'corep' ? 110 : 6);
  expect(inspected.reports[0].values).toBe(kind === 'corep' ? 15 : 6);
  expect(inspected.context[0].declaration.referenceDate).toBe('2025-12-31');
  await expect(review).toContainText('SYNTHETIC'); await noPageOverflow(page);
  const imported = await runAction(page, `/import-inspections/${inspection.resultRef.id}/commit`, 'Confirmar carga');
  await expect(page.getByTestId('current-version-id')).toHaveText(imported.newVersionId); return imported;
}
async function validateDemo(page: Page, kind: 'corep' | 'types') {
  await stage(page, '2. Validar', '#validation-title');
  const job = await runAction(page, '/validations', 'Validar informes');
  const results = await get(page, `/runs/${job.resultRef.id}/results?limit=200`), oracle = kind === 'corep' ? corpus.corep : corpus.typed;
  expect(results.total).toBe(oracle.rules.length);
  expect(results.run.summary.byStatus).toMatchObject({ ...oracle.expectedInitialCounts, not_evaluable: 0, error: 0 });
  for (const rule of oracle.rules) {
    const actual = results.items.find((item: any) => item.code === rule.code); expect(actual, rule.code).toBeDefined();
    expect(actual.status, rule.code).toBe(rule.expectedInitial);
    expect(actual.recalculation.policy, rule.code).toMatchObject(rule.expectedRecalculation.policy);
    if (rule.expectedRecalculation.policy.mode === 'validation_only') {
      const row = page.getByRole('table', { name: 'Resultados de validación', exact: true }).getByRole('row').filter({ has: page.locator('.rule-code').filter({ hasText: new RegExp(`^${rule.code}$`) }) });
      await expect(row).toContainText('Solo validación');
      await expect(page.getByLabel(`${rule.code} · Destino`, { exact: true })).toHaveCount(0);
      expect(actual.recalculation.left.eligible).toBe(false); expect(actual.recalculation.right.eligible).toBe(false);
    }
  }
  await noPageOverflow(page); return results;
}
async function rejectForcedDirection(page: Page, instanceId: string) {
  const session = await connection(page), before = await page.request.get(session.base, { headers: session.headers });
  const response = await page.request.put(session.base + '/directions', { headers: { ...session.headers, 'If-Match': before.headers()['etag']! }, data: { directions: [{ instanceId, targetSide: 'left' }] } });
  expect(response.status()).toBe(422); expect(JSON.stringify(await response.json())).toContain('RULE_VALIDATION_ONLY');
  const after = await page.request.get(session.base, { headers: session.headers }); expect(after.headers()['etag']).toBe(before.headers()['etag']);
}

test.beforeEach(async ({ page }) => {
  const session = await connection(page);
  if (session.id) {
    const current = await page.request.get(session.base, { headers: session.headers });
    expect((await page.request.delete(session.base, { headers: { ...session.headers, 'If-Match': current.headers()['etag']! } })).ok()).toBe(true);
  }
  await page.goto('/');
});

for (const width of [320, 390, 1440]) {
  test(`COREP demo ${width}px: real downloads, 16 rule oracle and five explicit dependent changes`, async ({ page }, info) => {
    test.setTimeout(180_000); await page.setViewportSize({ width, height: 1000 });
    await page.getByLabel('Nombre del conjunto').fill(`Demo COREP ${width} SYNTHETIC`);
    await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
    await loadDemo(page, 'corep', info); const results = await validateDemo(page, 'corep');
    const excluded = results.items.filter((item: any) => item.recalculation.policy.mode === 'validation_only'); expect(excluded).toHaveLength(2);
    await rejectForcedDirection(page, excluded[0].instanceId);
    // Only the analyst's five choices enter the configuration; the guide does not configure them.
    for (const code of officialCodes) {
      const select = page.getByLabel(`${code} · Destino`, { exact: true }); await expect(select).toHaveValue(''); await select.selectOption('left');
    }
    const configuring = page.waitForResponse(response => response.url().endsWith('/directions') && response.request().method() === 'PUT');
    await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click(); const configured = await configuring;
    expect(configured.status()).toBe(200); expect(configured.request().postDataJSON().directions).toHaveLength(5);
    await stage(page, '3. Recalcular', '#preview-title'); const simulated = await runAction(page, '/previews', 'Simular recálculos');
    const proposals = await get(page, `/previews/${simulated.resultRef.id}/proposals?limit=200`);
    expect(proposals.items.map((item: any) => item.code).sort()).toEqual(officialCodes);
    for (const proposal of proposals.items) {
      const [before, after] = changes[proposal.code]!;
      expect(proposal.before.normalizedValue).toEqual({ numerator: before, denominator: '1' });
      expect(proposal.after.normalizedValue).toEqual({ numerator: after, denominator: '1' }); expect(proposal.state).toBe('available');
    }
    const positions = new Map(proposals.items.map((item: any, index: number) => [item.code, index]));
    for (const [producer, consumer] of corpus.corep.expectedEdges) expect(positions.get(producer)).toBeLessThan(positions.get(consumer) as number);
    const table = page.getByRole('table', { name: 'Propuestas de recálculo', exact: true }); await expect(table.getByRole('row')).toHaveCount(6);
    await table.getByLabel('Seleccionar v0172_m', { exact: true }).check(); await expect(page.getByText(/Faltan 4 predecesores/)).toBeVisible();
    const acknowledgement = page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.'); await expect(acknowledgement).toBeDisabled();
    for (const code of officialCodes.slice(1)) { const checkbox = table.getByLabel(`Seleccionar ${code}`, { exact: true }); await expect(checkbox).not.toBeChecked(); await checkbox.check(); }
    await stage(page, '2. Validar', '#validation-title'); await stage(page, '3. Recalcular', '#preview-title');
    for (const code of officialCodes) await expect(table.getByLabel(`Seleccionar ${code}`, { exact: true })).toBeChecked();
    await expect(page.getByText(/La selección contiene todos sus predecesores/)).toBeVisible(); await expect(acknowledgement).toBeEnabled();
    await expect(table).not.toContainText('["'); await expect(table).toContainText('→'); await noPageOverflow(page);
    await table.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`demo-corep-proposals-${width}.png`) });
    await acknowledgement.focus(); await page.keyboard.press('Space'); const applied = await runAction(page, '/applications', 'Aplicar cambios seleccionados');
    const comparison = page.locator('ce-comparison'); await expect(comparison).toContainText('Valores modificados: 5'); await expect(acknowledgement).toHaveCount(0);
    const application = await get(page, `/applications/${applied.resultRef.id}/comparison?limit=200`);
    expect(application.afterSummary.byStatus).toMatchObject({ ...corpus.corep.expectedAfterCounts, not_evaluable: 0, error: 0 });
    for (const rule of corpus.corep.rules) expect(application.items.find((item: any) => item.after.code === rule.code)?.after.status, rule.code).toBe(rule.expectedAfter);
    const summary = comparison.getByRole('table', { name: 'Resumen de resultados', exact: true });
    await expect(summary.getByRole('row').filter({ hasText: /^Pasa/ })).toContainText('14');
    await noPageOverflow(page); await comparison.scrollIntoViewIfNeeded(); await page.screenshot({ path: info.outputPath(`demo-corep-comparison-${width}.png`) });
    await info.attach('demo-evidence', { body: JSON.stringify({ actor: 'Playwright automation', width, rules: 16, validationOnly: 2, changes: 5, before: application.beforeSummary, after: application.afterSummary, humanAcceptance: false }), contentType: 'application/json' });
  });

  test(`Typed demo ${width}px: eight rules and no recalculation controls or proposals`, async ({ page }, info) => {
    test.setTimeout(120_000); await page.setViewportSize({ width, height: 1000 });
    await page.getByLabel('Nombre del conjunto').fill(`Demo tipos ${width} SYNTHETIC`);
    await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
    await loadDemo(page, 'types', info); const results = await validateDemo(page, 'types');
    expect(results.items.every((item: any) => item.recalculation.policy.mode === 'validation_only')).toBe(true);
    await rejectForcedDirection(page, results.items[0].instanceId);
    await expect(page.getByRole('table', { name: 'Destinos de recálculo', exact: true }).getByRole('combobox')).toHaveCount(0);
    await page.getByRole('table', { name: 'Resultados de validación', exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath(`demo-types-results-${width}.png`) });
    await stage(page, '3. Recalcular', '#preview-title'); const simulated = await runAction(page, '/previews', 'Simular recálculos');
    const proposals = await get(page, `/previews/${simulated.resultRef.id}/proposals?limit=200`); expect(proposals.total).toBe(0);
    await expect(page.getByText('No hay direcciones guardadas.', { exact: false })).toBeVisible();
    const apply = page.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true }); if (await apply.count()) await expect(apply).toBeDisabled();
    await noPageOverflow(page);
  });
}
