import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { enableLegacyFormat, navigateStage, openCalculation, openTechnical } from './workflow-helpers.js';
const root = path.resolve('tests/fixtures/generated'), catalogPath = path.join(root, 'eba-subset.xlsx');
async function session(page: Page) { const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json(); return { id: bootstrap.activeWorkspaceId as string, headers: { 'X-CE-Session': bootstrap.sessionToken as string } }; }
async function editedWorkbook(name: string, change: (sheets: { sheet: string; data: (string | null)[][] }[]) => void): Promise<Buffer> {
  const sheets = (await readXlsxFile(path.join(root, name), { parseNumber: (text) => text, trim: false })).map((sheet) => ({ sheet: sheet.sheet, data: sheet.data.map((row) => row.map((value) => value === null ? null : String(value))) }));
  change(sheets); return writeXlsxFile(sheets.map((sheet) => ({ ...sheet, data: sheet.data.map((row) => row.map((value) => value === null ? null : { type: String, value })) }))).toBuffer();
}
async function upload(page: Page, report: string | Buffer, catalog?: Buffer) {
  await navigateStage(page, 'import');
  await enableLegacyFormat(page);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(catalog ? { name: 'synthetic-catalog.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: catalog } : catalogPath);
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(typeof report === 'string' ? path.join(root, report) : { name: 'synthetic-report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: report });
  const response = page.waitForResponse((response) => response.url().endsWith('/imports') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click();
  const accepted = await (await response).json(); const connection = await session(page); let version: string | undefined;
  await expect.poll(async () => { const job = await (await page.request.get(`/api/v1/workspaces/${connection.id}/jobs/${accepted.jobId}`, { headers: connection.headers })).json(); version = job.newVersionId; return job.status; }).toBe('succeeded');
  await expect(page.getByTestId('current-version-id')).toHaveText(version!); return version!;
}
async function validate(page: Page) {
  await navigateStage(page, 'validation');
  const response = page.waitForResponse((response) => response.url().endsWith('/validations') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Validar informes', exact: true }).click();
  const accepted = await (await response).json(); expect(accepted.resultRef.type).toBe('validation'); await expect(page.locator('#validation-run')).toHaveValue(accepted.resultRef.id, { timeout: 15000 });
  const connection = await session(page); return (await page.request.get(`/api/v1/workspaces/${connection.id}/runs/${accepted.resultRef.id}/results?limit=200`, { headers: connection.headers })).json();
}
test.beforeEach(async ({ page }) => {
  const connection = await session(page); if (connection.id) { const current = await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers }); await page.request.delete(`/api/v1/workspaces/${connection.id}`, { headers: { ...connection.headers, 'If-Match': current.headers()['etag']! } }); }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Validación SYNTHETIC'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Cargar catálogo e informes' })).toBeVisible();
});
test('V02/V04/V15: G169 passes at the interval boundary, fails beyond it, and preserves historical results', async ({ page }) => {
  test.setTimeout(60_000);
  await upload(page, 'report-42.xlsx'); const original = await validate(page); const applicable = original.items.find((row: { code: string; status: string }) => row.code === 'v0190_m' && row.status === 'pass');
  expect(applicable.severity).toBe('warning'); expect(applicable.factReads).toHaveLength(2); expect(original.run.summary.byStatus).toMatchObject({ pass: 1, not_applicable: 2 });
  const boundary = await editedWorkbook('report-42.xlsx', (sheets) => { sheets.find((sheet) => sheet.sheet === 'Facts')!.data[2]![6] = '10.01'; });
  await upload(page, boundary); await navigateStage(page, 'validation'); await expect(page.getByText(/Resultado histórico:/)).toBeVisible(); const touching = await validate(page); expect(touching.items.find((row: { status: string }) => row.status === 'pass').values.right.nominal).toEqual({ numerator: '1001', denominator: '100' });
  const outside = await editedWorkbook('report-42.xlsx', (sheets) => { sheets.find((sheet) => sheet.sheet === 'Facts')!.data[2]![6] = '10.02'; });
  await upload(page, outside); const failed = await validate(page); expect(failed.run.summary.byStatus.fail).toBe(1);
  const result = page.locator('.result-row').filter({ hasText: 'v0190_m' }).filter({ has: page.getByText('Falla', { exact: true }) });
  await expect(result.getByText('Advertencia', { exact: true })).toBeVisible();
  const detail = await openCalculation(page, result, 'v0190_m');
  await expect(detail).toContainText('10,02'); await expect(detail).toContainText('Facts · G3');
  const technical = JSON.parse(await (await openTechnical(detail)).textContent() ?? '{}');
  expect(technical.factReads.find((read: { sourceLocator: { row: number; column: string } }) => read.sourceLocator.row === 3 && read.sourceLocator.column === 'G').coordinate.decimals).toBe('2');
  await page.locator('ce-validation-page').screenshot({ path: path.resolve('.cache/validation-ui.png') });
  await page.locator('#validation-run').selectOption(original.run.id); await expect(page.getByText(/Resultado histórico:/)).toBeVisible();
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Exportar resultados (ZIP)' }).click(); const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('results.zip'); const location = path.resolve('.cache/validation-results.zip'); await download.saveAs(location); const parts = await readZipParts(location);
  expect(parts.map((part) => part.name)).toEqual(['results.json', 'results.xlsx']); const exported = JSON.parse(parts[0]!.data.toString('utf8')); expect(exported.versionId).toBe(original.versionId); expect(exported.run.summary).toEqual(original.run.summary); expect(exported.results.find((row: { instanceId?: string }) => row.instanceId === applicable.instanceId).values.left.nominal).toEqual({ numerator: '10', denominator: '1' });
});
test('V03: G113 creates two finite-sheet instances and explains all three inputs independently', async ({ page }) => {
  await upload(page, 'report-40.xlsx'); const initial = await validate(page); const instances = initial.items.filter((row: { code: string }) => row.code === 'v0002_h');
  expect(instances).toHaveLength(2); expect(instances.every((row: { status: string }) => row.status === 'pass')).toBe(true);
  expect(instances.map((row: { binding: { sheetCode: string } }) => row.binding.sheetCode).sort()).toEqual(['001', '002']);
  expect(instances.every((row: { factReads: unknown[] }) => row.factReads.length === 3)).toBe(true);
  const changed = await editedWorkbook('report-40.xlsx', (sheets) => { sheets.find((sheet) => sheet.sheet === 'Facts')!.data[1]![6] = '11'; });
  await upload(page, changed); const next = await validate(page); expect(next.items.filter((row: { code: string; status: string }) => row.code === 'v0002_h' && row.status === 'fail')).toHaveLength(1); expect(next.items.filter((row: { code: string; status: string }) => row.code === 'v0002_h' && row.status === 'pass')).toHaveLength(1);
  const row = page.locator('.result-row').filter({ hasText: 'v0002_h' }).filter({ has: page.getByText('Falla', { exact: true }) });
  const detail = await openCalculation(page, row, 'v0002_h'); const reads = detail.getByRole('table', { name: 'Entradas utilizadas', exact: true });
  await expect(reads.getByRole('row')).toHaveCount(4); await expect(reads.getByRole('cell', { name: /^5,00\s*EUR$/ })).toBeVisible(); await expect(reads.getByRole('cell', { name: /^7,00\s*EUR$/ })).toBeVisible();
});
test('V05/V12/V15: null provenance, unsupported syntax and arithmetic errors stay distinct and export exact fractions', async ({ page }) => {
  const catalog = await editedWorkbook('eba-subset.xlsx', (sheets) => {
    const rows = sheets[0]!.data;
    for (const [code, expression] of [
      ['synthetic_nulls', '{tC_01.00,r0260,c0010}={tC_01.00,r0270,c0010}'], ['synthetic_zero', 'not(isnull({tC_01.00,r0250,c0010}))'],
      ['synthetic_nvl', 'nvl({tC_01.00,r0260,c0010},0)=0'], ['synthetic_sum_null', 'isnull(sum({tC_01.00,r0260-0270,c0010}))'],
      ['synthetic_fraction', '1/3=1/3'], ['synthetic_negative', '((-3)*4)=(-12)'], ['synthetic_divide', '1/0=1'],
      ['synthetic_syntax', '1=1 @'], ['synthetic_group', 'sum({tC_01.00,r0230,c0010} group by r)=1'], ['synthetic_time', 'time_shift({tC_01.00,r0230,c0010},A,1)=1'],
    ]) { const row = [...rows[2]!]; row[0] = code!; row[1] = 'SYNTHETIC_TEST'; row[6] = expression!; row[7] = ''; rows.push(row); }
  });
  await upload(page, 'report-42.xlsx', catalog); const pageData = await validate(page); const result = (code: string) => pageData.items.find((row: { code: string }) => row.code === code);
  expect(result('synthetic_nulls').status).toBe('not_evaluable'); expect(result('synthetic_nulls').factReads.map((read: { presence: string }) => read.presence).sort()).toEqual(['explicit_null', 'implicit_null']);
  for (const code of ['synthetic_zero', 'synthetic_nvl', 'synthetic_sum_null', 'synthetic_fraction', 'synthetic_negative']) expect(result(code).status).toBe('pass');
  expect(result('synthetic_sum_null').diagnostics).toContainEqual(expect.objectContaining({ code: 'EMPTY_AGGREGATION' })); expect(result('synthetic_fraction').values.left.nominal).toEqual({ numerator: '1', denominator: '3' });
  expect(result('synthetic_divide').status).toBe('error'); expect(result('synthetic_syntax').status).toBe('error'); expect(result('synthetic_group').status).toBe('not_evaluable'); expect(result('synthetic_time').status).toBe('not_evaluable');
  await page.getByLabel('Código del resultado').fill('synthetic_nulls'); await page.getByRole('button', { name: 'Filtrar resultados' }).click(); await expect(page.getByText('1 de 1 resultados', { exact: true })).toBeVisible();
  const detail = await openCalculation(page, page.locator('.result-row'), 'synthetic_nulls'); await expect(detail.getByRole('table', { name: 'Entradas utilizadas', exact: true }).getByText('Sin dato', { exact: true })).toHaveCount(2);
  const technical = JSON.parse(await (await openTechnical(detail)).textContent() ?? '{}'); expect(technical.factReads.map((read: { presence: string }) => read.presence).sort()).toEqual(['explicit_null', 'implicit_null']);
  const downloadPromise = page.waitForEvent('download'); await page.getByRole('button', { name: 'Exportar resultados (ZIP)' }).click(); const downloaded = await downloadPromise; const location = path.resolve('.cache/validation-exact.zip'); await downloaded.saveAs(location);
  const entries = await readZipParts(location), json = JSON.parse(entries[0]!.data.toString('utf8')); expect(json.results).toHaveLength(pageData.total); expect(json.results.find((row: { code: string }) => row.code === 'synthetic_fraction').values.left.nominal).toEqual({ numerator: '1', denominator: '3' });
});
test('V04: permuting catalog and fact rows preserves semantic instance identities and outcomes', async ({ page }) => {
  await upload(page, 'report-42.xlsx'); const original = await validate(page);
  const catalog = await editedWorkbook('eba-subset.xlsx', (sheets) => { const rows = sheets[0]!.data; sheets[0]!.data = [rows[0]!, ...rows.slice(1).reverse()]; });
  const report = await editedWorkbook('report-42.xlsx', (sheets) => { for (const sheet of sheets.filter((item) => ['Facts', 'Coordinates'].includes(item.sheet))) sheet.data = [sheet.data[0]!, ...sheet.data.slice(1).reverse()]; });
  await upload(page, report, catalog); const permuted = await validate(page);
  const signature = (result: typeof original) => result.items.map((row: { code: string; instanceId?: string; status: string; coverageOnly: boolean; values: { left?: { nominal?: unknown }; right?: { nominal?: unknown } } }) => JSON.stringify([row.code, row.instanceId ?? null, row.status, row.coverageOnly, row.values.left?.nominal ?? null, row.values.right?.nominal ?? null])).sort();
  expect(signature(permuted)).toEqual(signature(original)); expect(permuted.run.summary).toEqual(original.run.summary);
});
