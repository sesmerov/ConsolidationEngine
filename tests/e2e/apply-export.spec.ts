import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { enableLegacyFormat, navigateStage, openCalculation } from './workflow-helpers.js';
const root = path.resolve('tests/fixtures/generated'), mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const exact = '123456789012345678901234567890.123456789';
const hashes = new Map<string, string>();
const selectedCodes = ['synthetic_A', 'synthetic_D', 'synthetic_fraction', 'synthetic_boolean'];
async function session(page: Page) { const response = await (await page.request.get('/api/v1/bootstrap')).json(); return { id: response.activeWorkspaceId as string, headers: { 'X-CE-Session': response.sessionToken as string } }; }
async function poll(page: Page, jobId: string) { const connection = await session(page); let job: any; await expect.poll(async () => { job = await (await page.request.get(`/api/v1/workspaces/${connection.id}/jobs/${jobId}`, { headers: connection.headers })).json(); return job.status; }, { timeout: 15000 }).toMatch(/succeeded|failed|cancelled|timed_out/); return job; }
async function fixtures() {
  const source = (await readXlsxFile(path.join(root, 'eba-subset.xlsx'), { parseNumber: value => value, trim: false }))[0]!;
  const rows = source.data.map(row => row.map(value => value === null ? null : String(value)));
  const expressions = [
    ['synthetic_A', 'with {tC_01.00,c0010,interval:false}: {r0230}={r0250}+{r0260}'],
    ['synthetic_D', 'with {tC_01.00,c0010,interval:false}: {r0270}={r0230}*2'],
    ['synthetic_fraction', 'with {interval:true}: {tC_05.01,r0090,c0060}=1/3'],
    ['synthetic_boolean', '{tC_01.00,r0430,c0010}=true'],
    ['synthetic_remaining_fail', '1=2'], ['synthetic_arithmetic_error', '1/0=1'],
    ['synthetic_nulls', 'isnull({tC_01.00,r0400,c0010}) and isnull({tC_01.00,r0410,c0010})'],
    ['synthetic_precision', '{tC_01.00,r0240,c0010}={tC_01.00,r0240,c0010}'], ['synthetic_zero', '{tC_01.00,r0420,c0010}=0'],
  ];
  const catalog = await writeXlsxFile([rows[0]!, ...expressions.map(([code, expression]) => { const row = [...rows[2]!]; row[0] = code!; row[1] = 'SYNTHETIC_APPLICATION'; row[6] = expression!; row[7] = ''; return row; })].map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: source.sheet }).toBuffer();
  const sheets = (await readXlsxFile(path.join(root, 'report-42.xlsx'), { parseNumber: value => value, trim: false })).map(sheet => ({ sheet: sheet.sheet, data: sheet.data.map(row => row.map(value => value === null ? null : String(value))) }));
  const facts = sheets.find(sheet => sheet.sheet === 'Facts')!.data, coordinates = sheets.find(sheet => sheet.sheet === 'Coordinates')!.data;
  for (const [row, value] of Object.entries({ '0230': '11', '0250': '5', '0260': '7', '0270': '22' })) { const entry = facts.find(entry => entry[1] === 'C_01.00' && entry[3] === row); if (entry) { entry[5] = 'value'; entry[6] = value; } else facts.push(['demo', 'C_01.00', '', row, '0010', 'value', value]); }
  for (const row of ['0400', '0410', '0420']) coordinates.push(['demo', 'C_01.00', '', row, '0010', 'number', 'EUR', '2', '{}']);
  coordinates.push(['demo', 'C_01.00', '', '0430', '0010', 'boolean', '', '', '{}']);
  facts.push(['demo', 'C_01.00', '', '0400', '0010', 'null', ''], ['demo', 'C_01.00', '', '0420', '0010', 'value', '0'], ['demo', 'C_01.00', '', '0430', '0010', 'value', 'false']);
  const report = await writeXlsxFile(sheets.map(sheet => ({ ...sheet, data: sheet.data.map(row => row.map(value => value === null ? null : { type: String, value })) }))).toBuffer();
  return { catalog, report };
}
async function upload(page: Page, catalog: Buffer, reports: { name: string; buffer: Buffer }[]) {
  await navigateStage(page, 'import');
  await enableLegacyFormat(page);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'synthetic-apply-catalog.xlsx', mimeType, buffer: catalog });
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(reports.map(report => ({ ...report, mimeType })));
  const response = page.waitForResponse(response => response.url().endsWith('/imports') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click();
  const accepted = await (await response).json(), job = await poll(page, accepted.jobId); expect(job.status).toBe('succeeded'); await expect(page.getByTestId('current-version-id')).toHaveText(job.newVersionId); return job.newVersionId as string;
}
async function validate(page: Page) {
  await navigateStage(page, 'validation');
  const response = page.waitForResponse(response => response.url().endsWith('/validations') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Validar informes', exact: true }).click(); const accepted = await (await response).json(); expect((await poll(page, accepted.jobId)).status).toBe('succeeded');
  await expect(page.locator('#validation-run')).toHaveValue(accepted.resultRef.id); const connection = await session(page); return (await page.request.get(`/api/v1/workspaces/${connection.id}/runs/${accepted.resultRef.id}/results?limit=200`, { headers: connection.headers })).json();
}
async function prepare(page: Page) {
  const files = await fixtures(), originalVersion = await upload(page, files.catalog, [{ name: 'synthetic-original.xlsx', buffer: files.report }]), initial = await validate(page);
  for (const code of selectedCodes) await page.getByLabel(code + ' · Destino', { exact: true }).selectOption('left');
  await page.getByRole('button', { name: 'Guardar configuración', exact: true }).click(); await expect(page.getByText(/Configuración guardada/)).toBeVisible();
  await navigateStage(page, 'recalculation');
  const connection = await session(page), response = await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers }), workspace = await response.json(), etag = response.headers()['etag']!;
  const previewResponse = page.waitForResponse(response => response.url().endsWith('/previews') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Simular recálculos', exact: true }).click(); const job = await poll(page, (await (await previewResponse).json()).jobId); expect(job.status).toBe('succeeded');
  await expect(page.locator('#preview-history')).toHaveValue(job.resultRef.id); await expect(page.locator('.proposal-row')).toHaveCount(4);
  const proposals = (await (await page.request.get(`/api/v1/workspaces/${connection.id}/previews/${job.resultRef.id}/proposals?limit=200`, { headers: connection.headers })).json()).items;
  return { ...files, connection, workspace, etag, previewId: job.resultRef.id as string, proposals, originalVersion, initial };
}
async function download(page: Page, version: string, filename: string, location: string, runId?: string) {
  await navigateStage(page, 'download');
  await page.locator('#export-version').selectOption(version); await page.locator('#export-kind').selectOption(runId ? 'results' : 'report');
  if (runId) { await page.getByRole('button', { name: 'Actualizar ejecuciones exportables', exact: true }).click(); await expect(page.locator('#export-run option[value="' + runId + '"]')).toHaveCount(1); await page.locator('#export-run').selectOption(runId); }
  const downloading = page.waitForEvent('download'); await page.getByRole('button', { name: 'Preparar descarga', exact: true }).click(); const artifact = await downloading; expect(artifact.suggestedFilename()).toBe(filename); await artifact.saveAs(location); return readZipParts(location);
}
test.beforeAll(async () => {
  const manifest = JSON.parse(await readFile(path.resolve('tests/fixtures/source-manifest.json'), 'utf8')); hashes.set(manifest.sourceName, manifest.sha256); hashes.set('grammar/dpm_xlLexer-v0.9.g4', manifest.grammarHashes.lexer); hashes.set('grammar/dpm_xlParser-v0.9.g4', manifest.grammarHashes.parser);
  for (const [file, hash] of hashes) expect(createHash('sha256').update(await readFile(path.resolve(file))).digest('hex')).toBe(hash);
});
test.afterAll(async () => { for (const [file, hash] of hashes) expect(createHash('sha256').update(await readFile(path.resolve(file))).digest('hex')).toBe(hash); });
test.beforeEach(async ({ page }) => {
  const connection = await session(page); if (connection.id) { const workspace = await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers }); await page.request.delete(`/api/v1/workspaces/${connection.id}`, { headers: { ...connection.headers, 'If-Match': workspace.headers()['etag']! } }); }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Aplicación y exportación SYNTHETIC'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Cargar catálogo e informes' })).toBeVisible();
});
test('V06/V10/V14/V16: explicit application, complete comparison, historic exports, exact reimport and close preserve originals', async ({ page }) => {
  test.setTimeout(120_000); const prepared = await prepare(page), { connection } = prepared;
  for (const code of selectedCodes) await page.getByLabel('Seleccionar ' + code, { exact: true }).check();
  const confirmation = page.locator('ce-apply'); await expect(confirmation.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true })).toBeDisabled();
  await confirmation.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.').check();
  const applying = page.waitForResponse(response => response.url().endsWith('/applications') && response.request().method() === 'POST'); await confirmation.getByRole('button', { name: 'Aplicar cambios seleccionados', exact: true }).click();
  const response = await applying, accepted = await response.json(), body = response.request().postDataJSON(), key = response.request().headers()['idempotency-key']!; expect(body.selectedIds.slice().sort()).toEqual(prepared.proposals.map((proposal: { id: string }) => proposal.id).sort());
  const job = await poll(page, accepted.jobId); expect(job.status).toBe('succeeded'); const receipt = (await (await page.request.get(`/api/v1/workspaces/${connection.id}/applications/${job.resultRef.id}`, { headers: connection.headers })).json()).receipt;
  const comparison = page.locator('ce-comparison'); await expect(comparison).toContainText('Valores modificados: 4');
  await comparison.getByRole('button', { name: 'Ver todos los resultados', exact: true }).click();
  await expect(comparison).toContainText('synthetic_remaining_fail'); await expect(comparison).toContainText('synthetic_arithmetic_error');
  const changed = comparison.getByRole('row').filter({ has: page.getByRole('button', { name: 'Ver cálculo y origen de synthetic_A', exact: true }) });
  const detail = await openCalculation(page, changed, 'synthetic_A', 'Después'); await expect(detail).toContainText('Recalculado en una aplicación anterior'); await expect(detail).toContainText('Este valor recalculado no estaba escrito en el informe original');
  const after = await (await page.request.get(`/api/v1/workspaces/${connection.id}/runs/${receipt.validationRunId}/results?limit=200`, { headers: connection.headers })).json(); expect(after.run.summary.byStatus).toMatchObject({ pass: 7, fail: 1, error: 1 });
  const find = (code: string) => after.items.find((row: { code: string }) => row.code === code); expect(find('synthetic_A').values.left.nominal).toEqual({ numerator: '12', denominator: '1' }); expect(find('synthetic_D').values.left.nominal).toEqual({ numerator: '24', denominator: '1' }); expect(find('synthetic_fraction').values.left.nominal).toEqual({ numerator: '33', denominator: '100' });
  const replay = await page.request.post(`/api/v1/workspaces/${connection.id}/applications`, { headers: { ...connection.headers, 'If-Match': prepared.etag, 'Idempotency-Key': key }, data: body }); expect(replay.status()).toBe(202); expect((await replay.json()).jobId).toBe(job.jobId);
  const latest = await (await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers })).json(); expect(latest.versionIds.filter((id: string) => id === receipt.newVersionId)).toHaveLength(1);
  const lateCancel = await page.request.delete(`/api/v1/workspaces/${connection.id}/jobs/${job.jobId}`, { headers: connection.headers }); expect((await lateCancel.json()).status).toBe('succeeded');
  await page.reload(); await navigateStage(page, 'recalculation'); await expect(page.locator('#preview-history')).toHaveValue(prepared.previewId); await expect(page.locator('ce-comparison')).toContainText('Aplicación completada');
  await openCalculation(page, page.locator('ce-comparison').getByRole('row').filter({ has: page.getByRole('button', { name: 'Ver cálculo y origen de synthetic_A', exact: true }) }), 'synthetic_A', 'Después'); await page.locator('ce-comparison').screenshot({ path: path.resolve('.cache/apply-export-ui.png') });
  const saved = path.resolve('.cache/applied-report.zip'), entries = await download(page, receipt.newVersionId, 'report.zip', saved), log = JSON.parse(entries.find(entry => entry.name === 'changes.json')!.data.toString('utf8'));
  expect(log.receipts.map((entry: { id: string }) => entry.id)).toEqual([receipt.id]); expect(log.changes).toHaveLength(4); expect(log.changes.find((change: { code: string }) => change.code === 'synthetic_fraction').exactNominal).toEqual({ numerator: '1', denominator: '3' });
  const results = await download(page, receipt.newVersionId, 'results.zip', path.resolve('.cache/applied-results.zip'), receipt.validationRunId); expect(JSON.parse(results.find(entry => entry.name === 'results.json')!.data.toString('utf8')).run.summary).toEqual(after.run.summary);
  const historical = await download(page, prepared.originalVersion, 'report.zip', path.resolve('.cache/historical-report.zip')); expect(JSON.parse(historical.find(entry => entry.name === 'changes.json')!.data.toString('utf8')).changes).toEqual([]);
  const reports = entries.filter(entry => entry.name.startsWith('reports/')).map(entry => ({ name: path.basename(entry.name), buffer: entry.data })); const reimported = await upload(page, prepared.catalog, reports); expect(reimported).not.toBe(receipt.newVersionId); const checked = await validate(page);
  const semantics = (rows: any[]) => rows.map(row => [row.code, row.status, row.values.left?.nominal ?? row.values.left?.value, row.values.right?.nominal ?? row.values.right?.value]); expect(semantics(checked.items)).toEqual(semantics(after.items));
  const precision = checked.items.find((row: { code: string }) => row.code === 'synthetic_precision'); expect(precision.factReads[0].originalText).toBe(exact); expect(precision.factReads[0].coordinate.rowCode).toBe('0240'); expect(precision.factReads[0].coordinate.decimals).toBe('INF');
  expect(checked.items.find((row: { code: string }) => row.code === 'synthetic_nulls').factReads.map((read: { presence: string }) => read.presence).sort()).toEqual(['explicit_null', 'implicit_null']); expect(checked.items.find((row: { code: string }) => row.code === 'synthetic_zero').factReads[0].originalText).toBe('0');
  const savedHash = createHash('sha256').update(await readFile(saved)).digest('hex'); await page.getByRole('button', { name: 'Cerrar conjunto', exact: true }).click(); await expect(page.getByText(/Las descargas guardadas permanecen en tu equipo/)).toBeVisible(); await page.getByRole('button', { name: 'Cerrar y descartar', exact: true }).click(); await expect(page.getByLabel('Nombre del conjunto')).toBeVisible();
  expect((await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers })).status()).toBe(404); expect(createHash('sha256').update(await readFile(saved)).digest('hex')).toBe(savedHash); expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
});
test('V10/V11: stale previews and a cancelled real application never publish changes', async ({ page }) => {
  test.setTimeout(60_000); const prepared = await prepare(page), { connection } = prepared, selectedIds = prepared.proposals.map((proposal: { id: string }) => proposal.id);
  const selection = await (await page.request.post(`/api/v1/workspaces/${connection.id}/previews/${prepared.previewId}/selection`, { headers: connection.headers, data: { selectedIds } })).json(), body = { baseVersionId: prepared.workspace.currentVersionId, previewId: prepared.previewId, selectedIds, closureHash: selection.closureHash };
  const accepted = await page.request.post(`/api/v1/workspaces/${connection.id}/applications`, { headers: { ...connection.headers, 'If-Match': prepared.etag, 'Idempotency-Key': randomUUID() }, data: body }); expect(accepted.status()).toBe(202); const jobId = (await accepted.json()).jobId;
  const cancelled = await page.request.delete(`/api/v1/workspaces/${connection.id}/jobs/${jobId}`, { headers: connection.headers }); expect((await cancelled.json()).status).toBe('cancelled');
  const unchanged = await (await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers })).json(); expect(unchanged.currentVersionId).toBe(prepared.workspace.currentVersionId); expect(unchanged.versionIds).toEqual(prepared.workspace.versionIds);
  await validate(page); // Configuration edits require a complete run of this exact base version.
  const configure = await page.request.put(`/api/v1/workspaces/${connection.id}/directions`, { headers: { ...connection.headers, 'If-Match': prepared.etag }, data: { directions: [] } }); expect(configure.status()).toBe(200);
  const stale = await page.request.post(`/api/v1/workspaces/${connection.id}/applications`, { headers: { ...connection.headers, 'If-Match': prepared.etag, 'Idempotency-Key': randomUUID() }, data: body }); expect(stale.status()).toBe(412); expect((await stale.json()).error.code).toBe('STALE_VERSION');
  await page.reload(); await navigateStage(page, 'recalculation'); await expect(page.getByText(/Previsualización obsoleta:/)).toBeVisible(); await expect(page.locator('ce-apply button').filter({ hasText: 'Aplicar cambios seleccionados' })).toBeDisabled();
});
