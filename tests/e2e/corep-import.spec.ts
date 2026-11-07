import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import sax from 'sax';
import { readZipParts, textCell, zipBytes } from '../helpers/xlsx-fixtures.js';
import type { ZipPart } from '../helpers/xlsx-fixtures.js';

const official = path.resolve('tests/fixtures/eba/official-annexes-4.0.xlsx');
const generated = path.resolve('tests/fixtures/generated');
const officialHash = 'f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7';
const mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const acceptanceLabel = 'Acepto importar únicamente las hojas incluidas y excluir las demás';
async function connection(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { id: bootstrap.activeWorkspaceId as string, headers: { 'X-CE-Session': bootstrap.sessionToken as string } };
}
async function jobDone(page: Page, id: string, expected = 'succeeded') {
  const session = await connection(page); let job: any;
  await expect.poll(async () => {
    job = await (await page.request.get(`/api/v1/workspaces/${session.id}/jobs/${id}`, { headers: session.headers })).json();
    return job.status;
  }, { timeout: 60_000 }).toMatch(/succeeded|failed|cancelled|timed_out/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe(expected); return job;
}
async function current(page: Page) {
  const session = await connection(page), response = await page.request.get(`/api/v1/workspaces/${session.id}`, { headers: session.headers });
  return { ...session, etag: response.headers()['etag']!, data: await response.json() };
}
async function seedPreviousVersion(page: Page) {
  const previous = await current(page);
  const response = await page.request.post(`/api/v1/workspaces/${previous.id}/imports`, {
    headers: { ...previous.headers, 'If-Match': previous.etag, 'Idempotency-Key': randomUUID() },
    multipart: {
      catalog: { name: 'previous-catalog.xlsx', mimeType, buffer: await readFile(path.join(generated, 'eba-subset.xlsx')) },
      reports: { name: 'previous-report.xlsx', mimeType, buffer: await readFile(path.join(generated, 'report-42.xlsx')) },
    },
  });
  expect(response.status()).toBe(202); await jobDone(page, (await response.json()).jobId); await page.reload();
  return current(page);
}
async function manualContext(page: Page, entity = 'SYNTHETIC_COREP') {
  await page.locator('#context-source').selectOption('form');
  await page.locator('#context-entity').fill(entity);
  await page.locator('#context-reference-date').fill('2025-12-31');
  await page.locator('#context-submission-date').fill('2025-12-31');
  await page.locator('#context-currency').fill('EUR');
  await page.locator('#context-scale').selectOption('0');
  await page.locator('#context-decimals').fill('2');
  await page.locator('#context-filing').selectOption('true');
}
async function inspect(page: Page, expected = 'succeeded') {
  const posting = page.waitForResponse(response => response.url().endsWith('/import-inspections') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  const response = await posting; expect(response.status()).toBe(202);
  return jobDone(page, (await response.json()).jobId, expected);
}
async function inspectFullCorep(page: Page) {
  const ambiguous = await inspect(page, 'failed');
  expect(ambiguous.diagnostics).toContainEqual(expect.objectContaining({ code: 'REPORT_PROFILE_REQUIRED' }));
  await page.locator('[data-profile-choice]').selectOption('eba-corep-of-4.0-ca1-v1');
  return inspect(page);
}
async function readyInspection(page: Page, id: string) {
  const session = await connection(page);
  const response = await page.request.get(`/api/v1/workspaces/${session.id}/import-inspections/${id}`, { headers: session.headers });
  expect(response.status()).toBe(200); return response.json();
}
/** Test-only fixture editing; formulas are deliberately invalid input. */
function sheetPart(parts: readonly ZipPart[], name: string) {
  const attr = (tag: string, key: string) => new RegExp('\\b' + key + '="([^"]+)"').exec(tag)?.[1];
  const workbook = parts.find(part => part.name === 'xl/workbook.xml')!.data.toString('utf8');
  const sheet = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map(match => match[0]).find(tag => attr(tag, 'name') === name);
  if (!sheet) throw new Error('Fixture sheet missing: ' + name);
  const rid = attr(sheet, 'r:id');
  const rels = parts.find(part => part.name === 'xl/_rels/workbook.xml.rels')!.data.toString('utf8');
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/g)].map(match => match[0]).find(tag => attr(tag, 'Id') === rid);
  const target = rel && attr(rel, 'Target'); if (!target) throw new Error('Fixture relationship missing');
  return target.startsWith('/') ? target.slice(1) : path.posix.normalize('xl/' + target);
}
function patchCell(parts: readonly ZipPart[], sheet: string, address: string, cell: string): ZipPart[] {
  const target = sheetPart(parts, sheet);
  return parts.map(part => {
    if (part.name !== target) return part;
    const original = part.data.toString('utf8'); let xml = original;
    sax.parser(true).write(original).close();
    // Keep the two entire alternatives separate: a greedy attribute match before the
    // alternative can consume the slash in <c .../> and then swallow the next cell.
    const pattern = new RegExp('<c\\b(?=[^>]*\\br="' + address + '")(?:[^>]*\\/>|[^>]*>[\\s\\S]*?</c>)');
    expect([...original.matchAll(new RegExp(pattern.source, 'g'))].length).toBeLessThanOrEqual(1);
    if (pattern.test(xml)) xml = xml.replace(pattern, cell);
    else {
      const row = /\d+$/.exec(address)![0], rowPattern = new RegExp('(<row\\b[^>]*\\br="' + row + '"[^>]*>[\\s\\S]*?)(</row>)');
      if (!rowPattern.test(xml)) throw new Error('Fixture row missing: ' + address);
      xml = xml.replace(rowPattern, (_, start: string, end: string) => start + cell + end);
    }
    sax.parser(true).write(xml).close();
    expect([...xml.matchAll(new RegExp(pattern.source, 'g'))]).toHaveLength(1);
    expect(xml.replace(pattern, '')).toBe(original.replace(pattern, ''));
    return { ...part, data: Buffer.from(xml) };
  });
}
async function oneRuleCatalog() {
  const source = (await readXlsxFile(path.join(generated, 'eba-subset.xlsx'), { trim: false, parseNumber: value => value }))[0]!;
  const rows = source.data.map(row => row.map(value => value === null ? '' : String(value))), rule = [...rows[2]!];
  rule[0] = 'SYNTHETIC_COREP_SCALE'; rule[1] = 'SYNTHETIC_E2E'; rule[2] = 'COREP'; rule[3] = 'COREP_OF_4.0'; rule[5] = 'C_01.00';
  rule[6] = 'with {interval:false}: {tC_01.00,r0010,c0010}=12340'; rule[7] = ''; rule[8] = 'Importe en unidades base';
  rule[10] = '2025-01-01'; rule[11] = '2026-12-31'; rule[13] = '';
  return writeXlsxFile([rows[0]!, rule].map(row => row.map(value => ({ type: String, value }))), { sheet: source.sheet }).toBuffer();
}

test.beforeAll(async () => { expect(createHash('sha256').update(await readFile(official)).digest('hex')).toBe(officialHash); });
test.afterAll(async () => { expect(createHash('sha256').update(await readFile(official)).digest('hex')).toBe(officialHash); });
test.beforeEach(async ({ page }) => {
  const session = await connection(page);
  if (session.id) {
    const previous = await current(page);
    expect((await page.request.delete(`/api/v1/workspaces/${session.id}`, { headers: { ...session.headers, 'If-Match': previous.etag } })).ok()).toBe(true);
  }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('COREP inspección SYNTHETIC');
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Inspeccionar archivos', exact: true })).toBeVisible();
});

test('full COREP: review is recoverable, explicit exclusions and edits precede atomic confirmation', async ({ page }, testInfo) => {
  test.setTimeout(180_000); const previous = await seedPreviousVersion(page);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.join(generated, 'eba-subset.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(official); await manualContext(page);
  const inspected = await inspectFullCorep(page), id = inspected.resultRef.id, dto = await readyInspection(page, id);
  expect(dto.state).toBe('ready'); expect(dto.requiresPartialCoverageAcceptance).toBe(true);
  expect(dto.reports).toHaveLength(1); expect(dto.reports[0].excludedSheets).toHaveLength(190);
  expect((await current(page)).etag).toBe(previous.etag);
  const review = page.getByRole('region', { name: 'Revisión de la carga', exact: true });
  await expect(review).toContainText('110'); await expect(review).toContainText('190'); await expect(review).toContainText('SYNTHETIC_COREP');
  await expect(review.getByLabel(acceptanceLabel)).not.toBeChecked();
  await expect(review.getByRole('button', { name: 'Confirmar carga', exact: true })).toBeDisabled();
  const denied = await page.request.post(`/api/v1/workspaces/${previous.id}/import-inspections/${id}/commit`, {
    headers: { ...previous.headers, 'If-Match': previous.etag, 'Idempotency-Key': randomUUID() }, data: { inspectionHash: dto.inspectionHash, acceptedExcludedSheets: false },
  });
  expect(denied.status()).toBe(409); expect((await denied.json()).error.code).toBe('PARTIAL_COVERAGE_NOT_ACCEPTED');
  await page.getByRole('button', { name: '2. Validar', exact: true }).click(); await page.getByRole('button', { name: '1. Cargar', exact: true }).click();
  await expect(review).toContainText('190'); await page.reload(); await expect(review).toContainText('190');
  expect((await readyInspection(page, id)).expiresAt).toBe(dto.expiresAt);
  await page.locator('#context-entity').fill('SYNTHETIC_EDITED');
  await expect(page.getByText('Descarta la inspección y vuelve a inspeccionar', { exact: false })).toBeVisible();
  await expect(review.getByRole('button', { name: 'Confirmar carga', exact: true })).toBeDisabled();
  expect((await readyInspection(page, id)).state).toBe('ready'); // Editing does not silently discard the retained candidate.
  await review.getByRole('button', { name: 'Descartar inspección', exact: true }).click();
  expect((await readyInspection(page, id)).state).toBe('discarded'); expect((await current(page)).etag).toBe(previous.etag);
  await expect(page.locator('#context-entity')).toHaveValue('SYNTHETIC_EDITED');
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.join(generated, 'eba-subset.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(official); await manualContext(page);
  const second = await inspectFullCorep(page); await expect(review.getByLabel(acceptanceLabel)).not.toBeChecked();
  await review.getByLabel(acceptanceLabel).check(); await page.screenshot({ path: testInfo.outputPath('corep-full-review.png'), fullPage: true });
  const posting = page.waitForResponse(response => response.url().endsWith(`/import-inspections/${second.resultRef.id}/commit`) && response.request().method() === 'POST');
  await review.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  const response = await posting, body = response.request().postDataJSON(), headers = response.request().headers();
  expect(body.acceptedExcludedSheets).toBe(true); const applied = await jobDone(page, (await response.json()).jobId);
  const after = await current(page); expect(after.data.currentVersionId).toBe(applied.newVersionId); expect(after.data.versionIds).toHaveLength(previous.data.versionIds.length + 1);
  const replay = await page.request.post(response.url(), { headers: { ...previous.headers, 'If-Match': headers['if-match']!, 'Idempotency-Key': headers['idempotency-key']! }, data: body });
  expect(replay.status()).toBe(202); expect((await replay.json()).jobId).toBe(applied.jobId);
  expect((await current(page)).data.versionIds).toEqual(after.data.versionIds);
});

test('downloaded CA1 with workbook context imports exact scaled values and validates numerically', async ({ page }, testInfo) => {
  test.setTimeout(120_000); const session = await connection(page);
  const template = await page.request.get('/api/v1/templates/corep-ca1', { headers: session.headers }); expect(template.status()).toBe(200);
  const sourcePath = testInfo.outputPath('downloaded-corep-ca1.xlsx');
  const { writeFile } = await import('node:fs/promises'); await writeFile(sourcePath, await template.body());
  let parts = await readZipParts(sourcePath);
  for (const [address, value] of Object.entries({ B5: 'SYNTHETIC_SCALE', B6: '2025-12-31', B7: '2025-12-31', B8: 'EUR', B9: '3', B10: '2', B11: 'true' })) parts = patchCell(parts, 'Contexto', address, textCell(address, value));
  parts = patchCell(parts, 'CA1', 'E5', textCell('E5', '12.34'));
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'synthetic-scale-catalog.xlsx', mimeType, buffer: await oneRuleCatalog() });
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles({ name: 'synthetic-corep-scale.xlsx', mimeType, buffer: zipBytes(parts) });
  await page.locator('#context-source').selectOption('workbook');
  const inspected = await inspect(page), dto = await readyInspection(page, inspected.resultRef.id);
  expect(dto.requiresPartialCoverageAcceptance).toBe(false); expect(dto.reports[0].excludedSheets).toEqual([]);
  const review = page.getByRole('region', { name: 'Revisión de la carga', exact: true }); await expect(review).toContainText('SYNTHETIC_SCALE');
  const posting = page.waitForResponse(response => response.url().endsWith('/commit') && response.request().method() === 'POST');
  await review.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  const response = await posting; expect(response.request().postDataJSON().acceptedExcludedSheets).toBe(false);
  await jobDone(page, (await response.json()).jobId); await page.getByRole('button', { name: '2. Validar', exact: true }).click();
  const validating = page.waitForResponse(response => response.url().endsWith('/validations') && response.request().method() === 'POST');
  await page.getByRole('button', { name: 'Validar informes', exact: true }).click(); const validated = await jobDone(page, (await (await validating).json()).jobId);
  const result = await (await page.request.get(`/api/v1/workspaces/${session.id}/runs/${validated.resultRef.id}/results`, { headers: session.headers })).json();
  expect(result.run.summary.byStatus.pass).toBe(1); expect(result.items[0].factReads[0].normalizedValue).toEqual({ numerator: '12340', denominator: '1' });
  expect(result.items[0].presentation.conceptLabel).toBe('OWN FUNDS');
  expect(result.items[0].factReads[0].originalText).toBe('12.34'); expect(result.items[0].factReads[0].coordinate.decimals).toBe('-1');
  await page.getByRole('button', { name: 'Ver cálculo y origen de SYNTHETIC_COREP_SCALE', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Cálculo y origen de SYNTHETIC_COREP_SCALE', exact: true })).toContainText('12.340');
  await page.screenshot({ path: testInfo.outputPath('corep-scaled-value.png'), fullPage: true });
});

test('a formula in CA1 is localizable and leaves the previous version intact', async ({ page }) => {
  test.setTimeout(120_000); const previous = await seedPreviousVersion(page);
  const parts = patchCell(await readZipParts(official), 'CA1', 'E5', '<c r="E5"><f>1+1</f><v>2</v></c>');
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.join(generated, 'eba-subset.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles({ name: 'synthetic-formula.xlsx', mimeType, buffer: zipBytes(parts) }); await manualContext(page);
  const failed = await inspect(page, 'failed');
  expect(failed.diagnostics).toContainEqual(expect.objectContaining({ locator: expect.objectContaining({ sheet: 'CA1', row: 5, column: 'E' }) }));
  await expect(page.getByRole('alert').filter({ hasText: 'synthetic-formula.xlsx' })).toContainText('CA1');
  expect((await current(page)).etag).toBe(previous.etag); expect((await current(page)).data.versionIds).toEqual(previous.data.versionIds);
  await expect(page.locator('#context-entity')).toHaveValue('SYNTHETIC_COREP');
});
