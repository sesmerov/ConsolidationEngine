import { expectSelectedHistory } from './workflow-helpers.js';
import { expectPublishedVersion } from './workflow-helpers.js';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { configureCorepDemo } from './direction-review-helpers.js';
import type { Locator, Page, TestInfo } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import type { ZipPart } from '../helpers/xlsx-fixtures.js';
import { navigateStage } from './workflow-helpers.js';

const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const corpus = JSON.parse(await readFile(path.resolve('specs/002-ui-eba-demo/contracts/demo-corpus.json'), 'utf8'));
const sourceHashes = new Map<string, string>();
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function session(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { id: bootstrap.activeWorkspaceId, base: `/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, headers: { 'X-CE-Session': bootstrap.sessionToken as string } };
}
async function get(page: Page, suffix: string) {
  const connection = await session(page), response = await page.request.get(connection.base + suffix, { headers: connection.headers });
  expect(response.status()).toBe(200); return response.json();
}
async function finish(page: Page, jobId: string) {
  let job: any; await expect.poll(async () => { job = await get(page, `/jobs/${jobId}`); return job.status; }, { timeout: 60_000 }).toMatch(/succeeded|failed|cancelled|timed_out/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return job;
}
async function action(page: Page, suffix: string, label: string) {
  const response = page.waitForResponse(value => value.url().endsWith(suffix) && value.request().method() === 'POST');
  await page.getByRole('button', { name: label, exact: true }).click(); const accepted = await response;
  expect(accepted.status()).toBe(202); return finish(page, (await accepted.json()).jobId);
}
async function freshWorkspace(page: Page, name: string) {
  const connection = await session(page);
  if (connection.id) {
    const current = await page.request.get(connection.base, { headers: connection.headers });
    expect((await page.request.delete(connection.base, { headers: { ...connection.headers, 'If-Match': current.headers()['etag']! } })).ok()).toBe(true);
  }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill(name);
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspeccionar archivos', exact: true })).toBeVisible();
}
async function demo(page: Page, kind: 'corep' | 'types') {
  const connection = await session(page), files: Buffer[] = [];
  for (const artifact of ['catalog', 'report']) {
    const response = await page.request.get(`/api/v1/templates/demos/${kind}/${artifact}`, { headers: connection.headers }); expect(response.status()).toBe(200); files.push(await response.body());
  }
  return { catalog: files[0]!, report: files[1]! };
}
async function upload(page: Page, catalog: Buffer, report: Buffer, prefix: string) {
  await navigateStage(page, 'import');
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: `${prefix}-catalog.xlsx`, mimeType, buffer: catalog });
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles({ name: `${prefix}-report.xlsx`, mimeType, buffer: report });
  await page.locator('#context-source').selectOption('workbook');
  const inspected = await action(page, '/import-inspections', 'Inspeccionar archivos');
  const imported = await action(page, `/import-inspections/${inspected.resultRef.id}/commit`, 'Confirmar carga');
  await expectPublishedVersion(page, imported.newVersionId); return imported.newVersionId as string;
}
async function validate(page: Page) {
  await navigateStage(page, 'validation'); const job = await action(page, '/validations', 'Validar informes');
  await expectSelectedHistory(page, 'validation', job.resultRef.id); return get(page, `/runs/${job.resultRef.id}/results?limit=200`);
}
async function download(page: Page, _trigger: string | Locator, info: TestInfo, name: string, expected: { versionId: string; kind: 'report' | 'results'; runId?: string }) {
  if (expected.kind === 'results' && await page.locator('ce-validation-page').count()) await page.getByRole('button', { name: 'Ir a Descargar resultados', exact: true }).click();
  else if (!await page.locator('ce-exports').count()) await navigateStage(page, 'download');
  await expect(page.locator('ce-exports')).toBeVisible();
  if (await page.locator('#export-version').count()) await page.locator('#export-version').selectOption(expected.versionId);
  await page.locator('#export-kind').selectOption(expected.kind);
  if (expected.runId && await page.locator('#export-run').count()) await page.locator('#export-run').selectOption(expected.runId);
  const submitted: unknown[] = [], listener = (request: import('@playwright/test').Request) => { if (request.url().endsWith('/exports') && request.method() === 'POST') submitted.push(request.postDataJSON()); };
  page.on('request', listener); const downloading = page.waitForEvent('download'); await page.locator('[data-download-action]').click();
  const artifact = await downloading; expect(artifact.suggestedFilename()).toBe(`${expected.kind}.zip`);
  page.off('request', listener); if (submitted.length) expect(submitted).toEqual([expected]);
  const location = info.outputPath(name); await artifact.saveAs(location); const parts = await readZipParts(location), identity = JSON.parse(parts.find(part => part.name === (expected.kind === 'results' ? 'results.json' : 'changes.json'))!.data.toString('utf8'));
  expect(expected.kind === 'results' ? identity.run.versionId : identity.versionId).toBe(expected.versionId); if (expected.runId) expect(identity.run.id).toBe(expected.runId); return parts;
}
function reportBytes(parts: readonly ZipPart[]): Buffer {
  const reports = parts.filter(part => /^reports\/[^/]+\.xlsx$/.test(part.name)); expect(reports).toHaveLength(1); return reports[0]!.data;
}
async function assertSafeVisual(bytes: Buffer, expectedSheets: string[], info: TestInfo, name: string) {
  const location = info.outputPath(name); await writeFile(location, bytes); const parts = await readZipParts(location);
  expect(parts.some(part => /externalLinks|vbaProject|activeX|connections|queryTables/i.test(part.name))).toBe(false);
  for (const part of parts.filter(part => /^xl\/worksheets\/[^/]+\.xml$/.test(part.name))) expect(part.data.toString('utf8')).not.toMatch(/<(?:\w+:)?f(?:\s|>)/);
  const sheets = await readXlsxFile(bytes, { trim: false, parseNumber: value => value }); expect(sheets.map(sheet => sheet.sheet).sort()).toEqual([...expectedSheets].sort()); return sheets;
}
function cents(value: unknown): bigint {
  const match = /^(-?)(\d+)(?:\.(\d{0,2}))?$/.exec(String(value)); if (!match) throw new Error('Unexpected corpus decimal: ' + value);
  return (match[1] ? -1n : 1n) * (BigInt(match[2]!) * 100n + BigInt((match[3] ?? '').padEnd(2, '0')));
}
async function assertCorep(bytes: Buffer, after: boolean, info: TestInfo, name: string) {
  const sheets = await assertSafeVisual(bytes, ['CA1', 'Contexto', 'Instrucciones'], info, name), ca1 = sheets.find(sheet => sheet.sheet === 'CA1')!;
  for (const input of corpus.corep.inputs) {
    const actual = ca1.data[Number(input.valueCell.slice(1)) - 1]?.[4], expected = after ? input.expectedAfter : input.value;
    if (expected === null) expect(actual ?? null, input.valueCell).toBeNull(); else expect(cents(actual), input.valueCell).toBe(cents(expected));
  }
  const context = sheets.find(sheet => sheet.sheet === 'Contexto')!.data;
  expect(context[4]?.[1]).toBe('SYNTHETIC'); expect(context[5]?.[1]).toBe('2025-12-31'); expect(context[7]?.[1]).toBe('EUR');
  expect(context[8]?.[1]).toBe('0'); expect(context[9]?.[1]).toBe('2');
}
function semantics(rows: any[]) {
  // Reimportation deliberately creates new file locators; values, types and uncertainty must agree.
  const value = (entry: any) => { if (!entry) return entry; const { coordinate, sourceLocator, ...business } = entry; return business; };
  return rows.map(row => ({ code: row.code, status: row.status, values: Object.fromEntries(Object.entries(row.values).map(([key, entry]) => [key, value(entry)])), reads: row.factReads.map((read: any) => ({ row: read.coordinate.rowCode, dataType: read.coordinate.dataType, unit: read.coordinate.unit, decimals: read.coordinate.decimals, presence: read.presence, normalizedValue: read.normalizedValue })) })).sort((a, b) => a.code.localeCompare(b.code));
}

test.beforeAll(async () => { for (const kind of ['corep', 'types']) for (const artifact of ['catalog', 'report']) { const name = `assets/demos/demo-${kind}-${artifact}.xlsx`; sourceHashes.set(name, digest(await readFile(name))); } });
test.afterAll(async () => { for (const [name, hash] of sourceHashes) expect(digest(await readFile(name))).toBe(hash); });
test.beforeEach(async ({ page }) => { await page.setViewportSize({ width: 1440, height: 1000 }); await freshWorkspace(page, 'Exportación visual SYNTHETIC'); });

test('COREP exports the receipt and historical version, preserves selection across profiles, and reimports 110 values', async ({ page }, info) => {
  test.setTimeout(180_000); const files = await demo(page, 'corep'), originalVersion = await upload(page, files.catalog, files.report, 'corep');
  const initial = await validate(page);
  await configureCorepDemo(page);
  await navigateStage(page, 'recalculation');
  await action(page, '/recalculation-operations', 'Simular recálculos');
  for (const code of ['v0172_m', 'v0173_m', 'v0174_m', 'v0175_m', 'v0176_m']) await page.getByLabel(`Seleccionar ${code}`, { exact: true }).check();
  await navigateStage(page, 'download');
  await page.locator('#export-version').selectOption(originalVersion);
  await navigateStage(page, 'recalculation');
  await page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.').check();
  const applied = await action(page, '/applications', 'Aplicar cambios seleccionados'), comparison = await get(page, `/applications/${applied.resultRef.id}/comparison?limit=200`);
  await expect(page.getByRole('button', { name: 'Descargar esta versión', exact: true })).toHaveCount(0);
  const next = page.getByRole('button', { name: '4. Descargar', exact: true });
  await expect(next).toHaveClass(/stage-recommended/);
  await next.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#exports-title')).toBeFocused();
  await expect(page.locator('.stage-recommended')).toHaveCount(0);
  await expect(page.locator('#export-version')).toHaveValue(originalVersion);
  const summary = page.getByRole('region', { name: 'Contenido de la versión elegida', exact: true }); await expect(summary).toContainText('COREP'); await expect(summary).toContainText('histórica');
  await expect(page.locator('button[data-applied-download]')).toHaveCount(0);
  const appliedZip = await download(page, 'Descargar', info, 'applied-corep.zip', { versionId: applied.newVersionId, kind: 'report' });
  const appliedReport = reportBytes(appliedZip); await assertCorep(appliedReport, true, info, 'applied-corep.xlsx');
  const changeLog = JSON.parse(appliedZip.find(part => part.name === 'changes.json')!.data.toString('utf8')); expect(changeLog.versionId).toBe(applied.newVersionId); expect(changeLog.changes).toHaveLength(5);
  await expect(page.locator('#export-version')).toHaveValue(applied.newVersionId);
  const historicalZip = await download(page, 'Descargar', info, 'historical-corep.zip', { versionId: originalVersion, kind: 'report' });
  await assertCorep(reportBytes(historicalZip), false, info, 'historical-corep.xlsx');
  expect(JSON.parse(historicalZip.find(part => part.name === 'changes.json')!.data.toString('utf8')).changes).toEqual([]);
  // The current version now has a different profile; the historical summary must remain COREP.
  const typed = await demo(page, 'types'); await upload(page, typed.catalog, typed.report, 'types');
  await navigateStage(page, 'download'); await page.locator('#export-version').selectOption(originalVersion);
  await expect(summary).toContainText('COREP'); await expect(summary).not.toContainText('Demostración de texto y fechas');
  await summary.getByText('Ver informes y contexto', { exact: true }).click();
  await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('historical-corep-summary.png') });
  await freshWorkspace(page, 'Reimportación COREP SYNTHETIC'); await upload(page, files.catalog, appliedReport, 'reimport-corep'); const checked = await validate(page);
  expect(semantics(checked.items)).toEqual(semantics(comparison.items.map((row: any) => row.after)));
  expect(checked.sourceFiles.filter((file: any) => file.kind === 'report').map((file: any) => file.id)).not.toEqual(initial.sourceFiles.filter((file: any) => file.kind === 'report').map((file: any) => file.id));
  expect((await get(page, '')).versionIds).toHaveLength(1); expect(checked.items.every((row: any) => row.factReads.every((read: any) => !read.derivation))).toBe(true);
});

test('typed visual report and results preserve all six values and never repeat an unrelated artifact', async ({ page }, info) => {
  test.setTimeout(120_000); const files = await demo(page, 'types'), version = await upload(page, files.catalog, files.report, 'types'), initial = await validate(page);
  const resultsZip = await download(page, 'Descargar', info, 'typed-results.zip', { versionId: version, kind: 'results', runId: initial.run.id });
  const json = JSON.parse(resultsZip.find(part => part.name === 'results.json')!.data.toString('utf8')); expect(semantics(json.results)).toEqual(semantics(initial.items));
  const resultsSheets = await readXlsxFile(resultsZip.find(part => part.name === 'results.xlsx')!.data, { trim: false, parseNumber: value => value });
  const facts = resultsSheets.find(sheet => sheet.sheet === 'Facts')!; expect(facts.data[0]).toContain('dataType'); expect(facts.data.flat()).toContain('Banco '); expect(facts.data.flat()).toContain('2024-02-29');
  await navigateStage(page, 'download'); if (await page.locator('#export-version').count()) await page.locator('#export-version').selectOption(version);
  const summary = page.getByRole('region', { name: 'Contenido de la versión elegida', exact: true }); await expect(summary).toContainText('Demostración de texto y fechas');
  const reportZip = await download(page, 'Descargar', info, 'typed-report.zip', { versionId: version, kind: 'report' }), report = reportBytes(reportZip);
  const sheets = await assertSafeVisual(report, ['Instrucciones', 'Datos', 'Contexto'], info, 'typed-report.xlsx'), data = sheets.find(sheet => sheet.sheet === 'Datos')!.data;
  expect(data.slice(3, 9).map(row => row[1] ?? '')).toEqual(['Banco', 'banco', 'Banco ', '', '2024-02-29', '2025-12-31']);
  expect(data.slice(3, 9).map(row => row[2])).toEqual(Array(6).fill('Informado'));
  await page.setViewportSize({ width: 320, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await summary.getByText('Ver informes y contexto', { exact: true }).click();
  await expect(summary.getByText('Desplaza la tabla horizontalmente para ver todas las columnas.', { exact: true })).toBeVisible();
  const reportTable = summary.getByRole('region', { name: 'Detalle de los informes incluidos', exact: true });
  await reportTable.focus(); await expect(reportTable).toBeFocused(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => reportTable.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
  await summary.scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('typed-export-mobile.png') });
  await navigateStage(page, 'validation'); await expect(page.locator('ce-results-export').getByRole('button', { name: /de nuevo/i })).toHaveCount(0);
  const repeated = await download(page, 'Descargar', info, 'typed-results-after-report.zip', { versionId: version, kind: 'results', runId: initial.run.id });
  expect(repeated.some(part => part.name === 'results.json')).toBe(true); expect(repeated.some(part => part.name.startsWith('reports/'))).toBe(false);
  await freshWorkspace(page, 'Reimportación tipada SYNTHETIC'); await upload(page, files.catalog, report, 'reimport-types'); const checked = await validate(page);
  expect(semantics(checked.items)).toEqual(semantics(initial.items)); expect(checked.run.summary.byStatus).toMatchObject({ pass: 6, fail: 2, not_evaluable: 0, error: 0 });
  expect((await get(page, '')).versionIds).toHaveLength(1);
});
