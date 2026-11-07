import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { importLegacyFixture, navigateStage } from './workflow-helpers.js';

const fixtureRoot = path.resolve('tests/fixtures/generated');
const code = (n: number) => `BULK_${String(n).padStart(3, '0')}`;
async function connection(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { base: `/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, headers: { 'X-CE-Session': String(bootstrap.sessionToken) } };
}
async function finish(page: Page, jobId: string) {
  const c = await connection(page); let job: any;
  await expect.poll(async () => { job = await (await page.request.get(c.base + '/jobs/' + jobId, { headers: c.headers })).json(); return job.status; }, { timeout: 60_000 }).toMatch(/^(succeeded|failed|timed_out|cancelled)$/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return job;
}
async function seed51(page: Page) {
  const catalogSheet = (await readXlsxFile(path.join(fixtureRoot, 'eba-subset.xlsx'), { trim: false, parseNumber: x => x }))[0]!;
  const original = catalogSheet.data.map(row => row.map(x => x === null ? null : String(x)));
  const rules = Array.from({ length: 51 }, (_, i) => { const row = [...original[2]!]; row[0] = code(i + 1); row[1] = 'SYNTHETIC_004'; row[6] = `with {tC_01.00,c0010,interval:false}: {r${1001 + i}}={r${1000 + i}}+1`; row[7] = ''; return row; });
  const catalog = await writeXlsxFile([original[0]!, ...rules].map(row => row.map(x => x === null ? null : { type: String, value: x })), { sheet: catalogSheet.sheet }).toBuffer();
  const sheets = (await readXlsxFile(path.join(fixtureRoot, 'report-42.xlsx'), { trim: false, parseNumber: x => x })).map(sheet => ({ ...sheet, data: sheet.data.map(row => row.map(x => x === null ? null : String(x))) }));
  const coordinates = sheets.find(s => s.sheet === 'Coordinates')!, facts = sheets.find(s => s.sheet === 'Facts')!;
  coordinates.data = [coordinates.data[0]!, ...Array.from({ length: 52 }, (_, i) => ['demo', 'C_01.00', '', String(1000 + i), '0010', 'number', 'EUR', '2', '{}'])];
  facts.data = [facts.data[0]!, ...Array.from({ length: 52 }, (_, i) => ['demo', 'C_01.00', '', String(1000 + i), '0010', 'value', i === 0 ? '10' : '0'])];
  const report = await writeXlsxFile(sheets.map(s => ({ ...s, data: s.data.map(row => row.map(x => x === null ? null : { type: String, value: x })) }))).toBuffer();
  await importLegacyFixture(page, { name: 'bulk-synthetic-catalog.xlsx', buffer: catalog }, [{ name: 'bulk-synthetic-report.xlsx', buffer: report }]);
  const c = await connection(page), current = await page.request.get(c.base, { headers: c.headers });
  const job = await page.request.post(c.base + '/validations', { headers: { ...c.headers, 'If-Match': current.headers()['etag']!, 'Idempotency-Key': crypto.randomUUID() }, data: { baseVersionId: (await current.json()).currentVersionId } });
  const validated = await finish(page, (await job.json()).jobId);
  const results = await (await page.request.get(c.base + '/runs/' + validated.resultRef.id + '/results?limit=200', { headers: c.headers })).json();
  const fresh = await page.request.get(c.base, { headers: c.headers });
  expect((await page.request.put(c.base + '/directions', { headers: { ...c.headers, 'If-Match': fresh.headers()['etag']! }, data: { directions: results.items.map((r: any) => ({ instanceId: r.instanceId, targetSide: 'left' })) } })).status()).toBe(200);
  await page.reload(); await navigateStage(page, 'recalculation');
  const posting = page.waitForResponse(r => r.url().endsWith('/previews') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Simular recálculos', exact: true }).click();
  const preview = await finish(page, (await (await posting).json()).jobId);
  await expect(page.locator('#preview-history')).toHaveValue(preview.resultRef.id);
  return { ...c, previewId: preview.resultRef.id as string };
}
test.beforeEach(async ({ page }) => {
  const c = await connection(page); const previous = await page.request.get(c.base, { headers: c.headers });
  if (previous.ok()) await page.request.delete(c.base, { headers: { ...c.headers, 'If-Match': previous.headers()['etag']! } });
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Selección 004 sintética');
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
});

test('51 proposals: global preselection, persisted deselection, filter scope, explicit closure and immutable apply reference', async ({ page }) => {
  test.setTimeout(150_000); const c = await seed51(page);
  const table = page.getByRole('table', { name: 'Propuestas de recálculo', exact: true });
  await expect(table.getByLabel('Seleccionar BULK_001', { exact: true })).toBeChecked();
  const all = page.getByLabel('Seleccionar todas las disponibles de este filtro', { exact: true }); await expect(all).toBeChecked();
  const acceptance = page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.');
  await expect(acceptance).not.toBeChecked();
  await table.getByLabel('Seleccionar BULK_001', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true })).toBeDisabled();
  await expect(page.getByText(/Faltan 1 antecedente/)).toBeVisible();
  await page.reload(); await navigateStage(page, 'recalculation');
  await expect(table.getByLabel('Seleccionar BULK_001', { exact: true })).not.toBeChecked();
  await page.getByLabel('Código de propuesta', { exact: true }).fill('BULK_051'); await page.getByRole('button', { name: 'Filtrar propuestas', exact: true }).click();
  await expect(table.getByLabel('Seleccionar BULK_051', { exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Limpiar selección', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Confirmar la aplicación', exact: true })).toHaveCount(0);
  await all.check(); await expect(page.getByText(/Faltan 50 antecedentes/)).toBeVisible();
  await page.getByLabel('Código de propuesta', { exact: true }).fill(''); await page.getByRole('button', { name: 'Filtrar propuestas', exact: true }).click();
  await all.check(); await expect(page.getByText(/La selección contiene todos sus antecedentes/)).toBeVisible();
  await acceptance.check(); await table.getByLabel('Seleccionar BULK_001', { exact: true }).uncheck();
  await table.getByLabel('Seleccionar BULK_001', { exact: true }).check(); await expect(acceptance).not.toBeChecked();
  await acceptance.check(); const posting = page.waitForResponse(r => r.url().endsWith('/applications') && r.request().method() === 'POST');
  await page.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true }).click();
  const application = await posting, body = application.request().postDataJSON(); expect(body.selectionRef).toBeDefined(); expect(body).not.toHaveProperty('selectedIds');
  expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(1024);
  const applied = await finish(page, (await application.json()).jobId);
  await expect(page.locator('ce-comparison')).toContainText('Valores modificados: 51');
  const compact = await (await page.request.get(c.base + '/applications/' + applied.resultRef.id + '?includeAcceptedIds=false', { headers: c.headers })).json();
  expect(compact.receipt.acceptedCount).toBe(51); expect(compact.receipt).not.toHaveProperty('acceptedIds');
  await expect(table.locator('input[type=checkbox]:enabled')).toHaveCount(0);
});

test('uncertain selection response preserves the command and blocks additional mutations until retry', async ({ page }) => {
  test.setTimeout(100_000); await seed51(page); let lost: string | null = null, retried: string | null = null;
  await page.route('**/selection-state/edits', async route => { const raw = route.request().postData(); if (lost === null) { lost = raw; await route.abort(); } else { retried = raw; await route.continue(); } });
  await page.getByLabel('Seleccionar BULK_001', { exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Limpiar selección', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Reintentar misma selección', exact: true }).click();
  await expect.poll(() => retried).toBe(lost); await expect(page.getByLabel('Seleccionar BULK_001', { exact: true })).not.toBeChecked();
});
