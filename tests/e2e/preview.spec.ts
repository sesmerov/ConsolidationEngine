import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import writeXlsxFile from 'write-excel-file/node';
import { importLegacyFixture, navigateStage, openCalculation, openTechnical } from './workflow-helpers.js';
import { prepareDirections, saveDirections } from './direction-review-helpers.js';
const root = path.resolve('tests/fixtures/generated');
async function session(page: Page) { const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json(); return { id: bootstrap.activeWorkspaceId as string, headers: { 'X-CE-Session': bootstrap.sessionToken as string } }; }
async function catalog(expressions: readonly (readonly [string, string, string?])[]) {
  const source = (await readXlsxFile(path.join(root, 'eba-subset.xlsx'), { parseNumber: text => text, trim: false }))[0]!;
  const original = source.data.map(row => row.map(value => value === null ? null : String(value)));
  return writeXlsxFile([original[0]!, ...expressions.map(([code, expression, precondition]) => { const row = [...original[2]!]; row[0] = code; row[1] = 'SYNTHETIC_TEST'; row[6] = expression; row[7] = precondition ?? ''; return row; })]
    .map(row => row.map(value => value === null ? null : { type: String, value })), { sheet: source.sheet }).toBuffer();
}
async function validate(page: Page) {
  await navigateStage(page, 'validation');
  const response = page.waitForResponse(response => response.url().endsWith('/validations') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Validar informes', exact: true }).click();
  const job = await (await response).json(); await expect(page.locator('#validation-run')).toHaveValue(job.resultRef.id, { timeout: 15000 }); const connection = await session(page);
  return (await page.request.get(`/api/v1/workspaces/${connection.id}/runs/${job.resultRef.id}/results?limit=200`, { headers: connection.headers })).json();
}
async function configure(page: Page, expressions: readonly (readonly [string, string, string?])[], options: { facts?: Readonly<Record<string, string>>; legacyProducerConflict?: boolean } = {}) {
  const { facts } = options;
  let report: string | { name: string; buffer: Buffer } = path.join(root, 'report-42.xlsx');
  if (facts) {
    const sheets = (await readXlsxFile(path.join(root, 'report-42.xlsx'), { parseNumber: text => text, trim: false })).map(sheet => ({ sheet: sheet.sheet, data: sheet.data.map(row => row.map(value => value === null ? null : String(value))) }));
    const rows = sheets.find(sheet => sheet.sheet === 'Facts')!.data;
    for (const [rowCode, value] of Object.entries(facts)) { const row = rows.find(row => row[1] === 'C_01.00' && row[3] === rowCode); if (row) { row[5] = 'value'; row[6] = value; } else rows.push(['demo', 'C_01.00', '', rowCode, '0010', 'value', value]); }
    const buffer = await writeXlsxFile(sheets.map(sheet => ({ ...sheet, data: sheet.data.map(row => row.map(value => value === null ? null : { type: String, value })) }))).toBuffer();
    report = { name: 'synthetic-values.xlsx', buffer };
  }
  await importLegacyFixture(page, { name: 'synthetic-preview.xlsx', buffer: await catalog(expressions) }, [report]);
  const run = await validate(page);
  if (options.legacyProducerConflict) {
    // Seed the conflicting configuration accepted by the previous client to exercise the preview guard.
    const connection = await session(page), base = `/api/v1/workspaces/${connection.id}`;
    const current = await page.request.get(base, { headers: connection.headers });
    expect(current.status()).toBe(200);
    const directions = expressions.map(([code]) => {
      const instanceId = run.items.find((result: { code: string }) => result.code === code)?.instanceId;
      expect(instanceId).toBeTruthy();
      return { instanceId, targetSide: 'left' };
    });
    const configured = await page.request.put(base + '/directions', { headers: { ...connection.headers, 'If-Match': current.headers()['etag']! }, data: { directions } });
    expect(configured.status()).toBe(200);
    await page.reload();
    await expect(page.getByTestId('current-version-id')).toHaveText((await configured.json()).versionId);
  } else {
    const reviewId = await prepareDirections(page);
    await saveDirections(page, reviewId, expressions.length);
  }
  await navigateStage(page, 'recalculation');
  await expect(page.getByRole('button', { name: 'Simular recálculos', exact: true })).toBeEnabled(); const connection = await session(page);
  const current = await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers }); return { connection, workspace: await current.json(), etag: current.headers()['etag']!, run };
}
async function preview(page: Page) {
  await navigateStage(page, 'recalculation');
  const response = page.waitForResponse(response => response.url().endsWith('/previews') && response.request().method() === 'POST'); await page.getByRole('button', { name: 'Simular recálculos', exact: true }).click();
  const accepted = await (await response).json(), connection = await session(page); let id = '';
  await expect.poll(async () => { const job = await (await page.request.get(`/api/v1/workspaces/${connection.id}/jobs/${accepted.jobId}`, { headers: connection.headers })).json(); id = job.resultRef?.id ?? ''; return job.status; }).toBe('succeeded');
  await expect(page.locator('#preview-history')).toHaveValue(id); await expect(page.locator('.proposal-row')).not.toHaveCount(0);
  return { id, data: await (await page.request.get(`/api/v1/workspaces/${connection.id}/previews/${id}/proposals?limit=200`, { headers: connection.headers })).json() };
}
test.beforeEach(async ({ page }) => {
  const connection = await session(page); if (connection.id) { const current = await page.request.get(`/api/v1/workspaces/${connection.id}`, { headers: connection.headers }); await page.request.delete(`/api/v1/workspaces/${connection.id}`, { headers: { ...connection.headers, 'If-Match': current.headers()['etag']! } }); }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Recálculos SYNTHETIC'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Cargar catálogo e informes' })).toBeVisible();
});
test('V06-preview/V09: topological simulation re-evaluates a false guard, requires explicit closure and survives reload without changing facts', async ({ page }) => {
  test.setTimeout(60_000);
  const initial = await configure(page, [
    ['synthetic_Z_producer', 'with {tC_01.00,c0010,interval:false}: {r0230}={r0250}+{r0260}'],
    ['synthetic_A_consumer', 'with {tC_01.00,c0010,interval:false}: {r0270}={r0230}*2'],
    ['synthetic_guard', '{tC_05.01,r0090,c0060}=3', '{tC_01.00,r0270,c0010}=24'],
  ], { facts: { '0230': '11', '0250': '5', '0260': '7', '0270': '22' } });
  expect(initial.run.items.find((row: { code: string }) => row.code === 'synthetic_guard').status).toBe('not_applicable');
  const simulation = await preview(page); expect(simulation.data.items.map((row: { code: string }) => row.code)).toEqual(['synthetic_Z_producer', 'synthetic_A_consumer', 'synthetic_guard']);
  expect(simulation.data.items.map((row: { after: { originalText: string } }) => row.after.originalText)).toEqual(['12.00', '24.00', '3.00']);
  await page.getByLabel('Seleccionar synthetic_guard', { exact: true }).check(); await expect(page.getByText(/Faltan 2 predecesores/)).toBeVisible(); expect(await page.locator('ce-preview-page input[type="checkbox"]:checked').count()).toBe(1);
  await page.getByLabel('Seleccionar synthetic_Z_producer', { exact: true }).check(); await page.getByLabel('Seleccionar synthetic_A_consumer', { exact: true }).check();
  await expect(page.getByText('La selección contiene todos sus predecesores. Los datos del informe siguen sin cambios.')).toBeVisible();
  const unchanged = await (await page.request.get(`/api/v1/workspaces/${initial.connection.id}`, { headers: initial.connection.headers })).json(); expect(unchanged.currentVersionId).toBe(initial.workspace.currentVersionId); expect(unchanged.counts).toEqual(initial.workspace.counts);
  await page.locator('ce-preview-page').screenshot({ path: path.resolve('.cache/preview-ui.png') });
  await page.reload(); await navigateStage(page, 'recalculation'); await expect(page.locator('#preview-history')).toHaveValue(simulation.id); await expect(page.locator('.proposal-row')).toHaveCount(3);
  expect(await page.locator('ce-preview-page input[type="checkbox"]:checked').count()).toBe(0); // An uncommitted selection is intentionally not persisted.
  await navigateStage(page, 'validation'); await expect(page.locator('#validation-run')).toHaveValue(initial.run.run.id);
  const after = await validate(page); expect(after.items.map((row: { code: string; status: string; factReads: unknown }) => [row.code, row.status, row.factReads])).toEqual(initial.run.items.map((row: { code: string; status: string; factReads: unknown }) => [row.code, row.status, row.factReads]));
  await navigateStage(page, 'recalculation');
  await page.getByRole('button', { name: 'Descartar previsualización', exact: true }).click(); await page.getByRole('button', { name: 'Confirmar descarte', exact: true }).click(); await expect(page.getByText('Previsualización descartada. Sus propuestas se conservan para consulta.')).toBeVisible();
  await page.reload(); await navigateStage(page, 'recalculation'); await expect(page.getByText('Previsualización descartada. Sus propuestas se conservan para consulta.')).toBeVisible();
});
test('V09: equal-valued conflicting producers and their dependent proposal are blocked with explanations', async ({ page }) => {
  const initial = await configure(page, [['synthetic_P', '{tC_01.00,r0230,c0010}=1'], ['synthetic_Q', '{tC_01.00,r0230,c0010}=1'], ['synthetic_D', '{tC_01.00,r0250,c0010}={tC_01.00,r0230,c0010}+1']], { legacyProducerConflict: true });
  const simulation = await preview(page); expect(simulation.data.items.every((row: { state: string }) => row.state === 'blocked')).toBe(true);
  await expect(page.getByText('Hay productores incompatibles para un mismo destino. Consulta el detalle de las propuestas bloqueadas.', { exact: true })).toBeVisible(); await expect(page.locator('ce-preview-page input[type="checkbox"]:enabled')).toHaveCount(0);
  expect((await (await page.request.get(`/api/v1/workspaces/${initial.connection.id}`, { headers: initial.connection.headers })).json()).currentVersionId).toBe(initial.workspace.currentVersionId);
});
test('V08: a cycle blocks its descendants while an independent direction remains available', async ({ page }) => {
  await configure(page, [['synthetic_A', '{tC_01.00,r0230,c0010}={tC_01.00,r0250,c0010}+1'], ['synthetic_B', '{tC_01.00,r0250,c0010}={tC_01.00,r0230,c0010}-1'], ['synthetic_D', '{tC_01.00,r0270,c0010}={tC_01.00,r0230,c0010}+5'], ['synthetic_free', '{tC_01.00,r0260,c0010}=4'], ['synthetic_self', '{tC_05.01,r0090,c0060}=4', '{tC_05.01,r0090,c0060}=10']]);
  const simulation = await preview(page); expect(simulation.data.items.filter((row: { state: string }) => row.state === 'blocked')).toHaveLength(4);
  expect(simulation.data.items.find((row: { code: string }) => row.code === 'synthetic_free').state).toBe('available'); await expect(page.getByText(/^Ciclo de dependencias:/)).toHaveCount(2);
  await expect(page.getByLabel('Seleccionar synthetic_free', { exact: true })).toBeEnabled(); await expect(page.getByLabel('Seleccionar synthetic_D', { exact: true })).toBeDisabled();
});
test('V07: consumers read .33 at p2 and propose .99; a punctual 1/3 and its consumer stay blocked', async ({ page }) => {
  await configure(page, [
    ['synthetic_fraction', 'with {tC_01.00,c0010,interval:true}: {r0230}=1/3'],
    ['synthetic_tripled', 'with {tC_01.00,c0010,interval:true}: {r0250}={r0230}*3'],
    ['synthetic_point', 'with {tC_01.00,c0010,interval:false}: {r0270}=1/3'],
    ['synthetic_blocked_consumer', '{tC_05.01,r0090,c0060}={tC_01.00,r0270,c0010}*3'],
  ]);
  const simulation = await preview(page), find = (code: string) => simulation.data.items.find((row: { code: string }) => row.code === code);
  expect(find('synthetic_fraction').after.originalText).toBe('0.33'); expect(find('synthetic_fraction').exactNominal).toEqual({ numerator: '1', denominator: '3' });
  expect(find('synthetic_tripled').after.originalText).toBe('0.99'); expect(find('synthetic_tripled').exactNominal).toEqual({ numerator: '99', denominator: '100' });
  expect(find('synthetic_point').state).toBe('blocked'); expect(find('synthetic_point').diagnostics).toContainEqual(expect.objectContaining({ code: 'CANDIDATE_DOES_NOT_SATISFY_RULE' })); expect(find('synthetic_blocked_consumer').state).toBe('blocked');
  const fraction = page.locator('.proposal-row').filter({ has: page.getByRole('button', { name: 'Ver cálculo y origen de synthetic_fraction', exact: true }) }); await expect(fraction.getByText('Disponible', { exact: true })).toBeVisible();
  const detail = await openCalculation(page, fraction, 'synthetic_fraction'); await openTechnical(detail); await expect(detail).toContainText('Resultado exacto antes del redondeo: 1/3');
  await detail.getByRole('button', { name: 'Cerrar detalle', exact: true }).click();
  await expect(page.locator('.proposal-row').filter({ has: page.getByRole('button', { name: 'Ver cálculo y origen de synthetic_tripled', exact: true }) })).toContainText('0,99');
});
test('a real queued preview can be cancelled without publishing a partial preview or changing its snapshot', async ({ page }) => {
  const initial = await configure(page, [['synthetic_A', '{tC_01.00,r0230,c0010}=1']]);
  const response = await page.request.post(`/api/v1/workspaces/${initial.connection.id}/previews`, { headers: { ...initial.connection.headers, 'If-Match': initial.etag, 'Idempotency-Key': crypto.randomUUID() }, data: { baseVersionId: initial.workspace.currentVersionId } }); expect(response.status()).toBe(202); const accepted = await response.json();
  const cancelled = await page.request.delete(`/api/v1/workspaces/${initial.connection.id}/jobs/${accepted.jobId}`, { headers: initial.connection.headers }); expect((await cancelled.json()).status).toBe('cancelled');
  const history = await (await page.request.get(`/api/v1/workspaces/${initial.connection.id}/previews`, { headers: initial.connection.headers })).json(); expect(history.items).toEqual([]);
  const current = await (await page.request.get(`/api/v1/workspaces/${initial.connection.id}`, { headers: initial.connection.headers })).json(); expect(current.currentVersionId).toBe(initial.workspace.currentVersionId); expect(current.counts).toEqual(initial.workspace.counts);
});
