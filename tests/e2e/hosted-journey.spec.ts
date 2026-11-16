import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, test, type APIRequestContext, type Page, type TestInfo } from '@playwright/test';
import readXlsxFile from 'read-excel-file/node';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { chooseConflict } from './direction-review-helpers.js';

const api = 'http://127.0.0.1:3351', frontend = 'http://127.0.0.1:3350', controlOrigin = 'http://127.0.0.1:3354';
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
async function control(request: APIRequestContext, route: string, data?: object) {
  const headers = { 'X-CE-Test-Control': process.env['CE_E2E_CONTROL_TOKEN']! };
  const response = data === undefined ? await request.get(controlOrigin + route, { headers }) : await request.post(controlOrigin + route, { headers, data });
  expect(response.ok()).toBe(true); return response.json();
}
interface Identity { token: string; workspaceId: string; sessionId: string }
async function identity(page: Page): Promise<Identity> {
  const saved = await page.evaluate(() => {
    const key = Object.keys(sessionStorage).find(key => key.startsWith('ce.demo-session.v1:'));
    return key ? JSON.parse(sessionStorage.getItem(key)!) : null;
  });
  expect(Boolean(saved?.token && saved.workspaceId && saved.sessionId)).toBe(true); return saved;
}
async function get(page: Page, suffix: string) {
  const saved = await identity(page), response = await page.request.get(`${api}/api/v1/workspaces/${saved.workspaceId}${suffix}`, { headers: { 'X-CE-Session': saved.token } });
  expect(response.status(), await response.text()).toBe(200); return response.json();
}
async function action(page: Page, suffix: string, label: string) {
  await expect(page.getByRole('button', { name: label, exact: true })).toBeEnabled({ timeout: 70_000 });
  const posted = page.waitForResponse(response => response.url().split('?')[0]!.endsWith(suffix) && response.request().method() === 'POST');
  const [response] = await Promise.all([posted, page.getByRole('button', { name: label, exact: true }).click()]);
  expect(response.status(), await response.text()).toBe(202);
  const accepted = await response.json(); let job: any;
  await expect.poll(async () => { job = await get(page, '/jobs/' + accepted.jobId); return job.status; }, { timeout: 70_000, intervals: [500, 1000, 2000] }).toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return job;
}
async function start(page: Page, name: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Iniciar o recuperar demo', exact: true }).click();
  await page.getByLabel('Nombre del conjunto').fill(name); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await expect(page.locator('ce-import-page')).toBeVisible(); return identity(page);
}
async function uploadDemo(page: Page, demo: 'corep'|'types') {
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve(`tests/fixtures/generated/demo-${demo}-catalog.xlsx`));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve(`tests/fixtures/generated/demo-${demo}-report.xlsx`));
  await page.locator('#context-source').selectOption('workbook');
  const inspected = await action(page, '/import-inspections', 'Inspeccionar archivos');
  return action(page, `/import-inspections/${inspected.resultRef.id}/commit`, 'Confirmar carga');
}
async function downloadChecked(page: Page, info: TestInfo, versionId: string, name: string) {
  const who = await identity(page);
  await page.getByRole('button', { name: '4. Descargar', exact: true }).click();
  if (await page.locator('#export-version').count()) await page.locator('#export-version').selectOption(versionId);
  else expect((await get(page, '?compact=true')).currentVersionId).toBe(versionId);
  await expect(page.locator('[data-download-action]')).toBeEnabled();
  const manifestResponse = page.waitForResponse(response => response.request().method() === 'GET'
    && response.url().startsWith(`${api}/api/v1/workspaces/${who.workspaceId}/exports/`) && response.url().endsWith('/manifest'), { timeout: 80_000 });
  const downloading = page.waitForEvent('download', { timeout: 80_000 });
  const [downloaded, response] = await Promise.all([downloading, manifestResponse, page.locator('[data-download-action]').click()]);
  const saved = info.outputPath(name); expect(downloaded.suggestedFilename()).toBe('report.zip'); await downloaded.saveAs(saved);
  const manifest = await response.json(), bytes = await readFile(saved);
  expect(manifest.intent).toEqual({ workspaceId: who.workspaceId, versionId, kind: 'report' });
  expect(digest(bytes)).toBe(manifest.sha256); expect(bytes.length).toBe(manifest.byteLength);
  return readZipParts(saved);
}
async function closeVisitor(page: Page) {
  await page.getByRole('button', { name: 'Cerrar conjunto', exact: true }).click();
  await page.getByRole('button', { name: 'Cerrar y descartar', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Iniciar o recuperar demo', exact: true })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
}
async function chooseReadyConflict(page: Page, reviewId: string, row: string, code: string|null) {
  const group = page.getByRole('group', { name: new RegExp(row) });
  await expect(group).toBeVisible();
  if (!await group.getByRole('radiogroup').count()) await group.getByRole('button', { name: /^(Cambiar elección|Elegir regla)$/ }).click();
  const radio = group.getByRole('radio', { name: code === null ? 'No recalcular esta celda' : new RegExp('^' + code + '(?:\\s|$)'), exact: code === null });
  // The compact candidate page hydrates asynchronously; keyboard focus alone does not wait for enabled controls.
  await expect(radio).toBeEnabled(); return chooseConflict(page, reviewId, group, code);
}

test.afterEach(async ({ request }) => { await control(request, '/drop-response/clear', {}); await control(request, '/balance', { instance: 'auto' }); await control(request, '/queue', { paused: false }); });

test('orígenes: navegador real, dos procesos con una URL, errores CORS y visitantes aislados', async ({ browser, request }) => {
  const first = await browser.newContext(), second = await browser.newContext(), third = await browser.newContext();
  const a = await first.newPage(), b = await second.newPage(), outsider = await third.newPage();
  try {
    await a.goto('/'); await b.goto('/');
    const create = async (page: Page) => page.evaluate(async endpoint => {
      const secret = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
      const token = secret(), headers = { 'Content-Type': 'application/json', 'X-CE-Session': token };
      const response = await fetch(endpoint + '/api/v1/sessions', { method: 'POST', headers, body: JSON.stringify({ creationNonce: secret() }) });
      const body = await response.json(); return { status: response.status, token, id: body.id };
    }, api);
    await control(request, '/balance', { instance: 'api1' }); const owner = await create(a); expect(owner.status).toBe(201);
    await control(request, '/balance', { instance: 'api2' }); const stranger = await create(b); expect(stranger.status).toBe(201); expect(owner.id).not.toBe(stranger.id);
    const created = await a.evaluate(async ({ api, token, key }) => {
      const response = await fetch(api + '/api/v1/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CE-Session': token, 'Idempotency-Key': key }, body: JSON.stringify({ name: 'Synthetic cross-instance authority' }) });
      return { status: response.status, etag: response.headers.get('ETag'), body: await response.json() };
    }, { api, token: owner.token, key: randomUUID() });
    expect(created.status).toBe(201); expect(created.etag).toBeTruthy();
    await control(request, '/balance', { instance: 'api1' });
    const read = async (page: Page, token: string) => page.evaluate(async ({ api, token, id }) => {
      const response = await fetch(`${api}/api/v1/workspaces/${id}?compact=true`, { headers: { 'X-CE-Session': token } });
      return { status: response.status, body: await response.json() };
    }, { api, token, id: created.body.id });
    expect((await read(a, owner.token)).body.id).toBe(created.body.id); expect((await read(b, stranger.token)).status).toBe(404);
    const invalid = await a.evaluate(async ({ api, token }) => {
      const response = await fetch(api + '/api/v1/workspaces', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CE-Session': token, 'Idempotency-Key': crypto.randomUUID() }, body: '{' });
      return { status: response.status, body: await response.json() };
    }, { api, token: owner.token });
    expect(invalid.status).toBe(400); expect(invalid.body.error).toBeDefined(); // Readable by the allowed browser origin even on parser errors.
    const state = await control(request, '/state'); expect(state.instances).toHaveLength(2); expect(new Set(state.instances.map((row: any) => row.pid)).size).toBe(2); expect(state.instances.every((row: any) => row.alive)).toBe(true);
    expect(new Set(state.requests.filter((row: any) => row.path.includes('/workspaces')).map((row: any) => row.instance))).toEqual(new Set(['api1','api2']));
    await outsider.goto(controlOrigin);
    expect(await outsider.evaluate(async endpoint => { try { await fetch(endpoint + '/api/v1/bootstrap'); return 'allowed'; } catch { return 'blocked'; } }, api)).toBe('blocked');
    const denied = await request.get(api + '/api/v1/bootstrap', { headers: { Origin: controlOrigin } }); expect(denied.status()).toBe(403); expect(denied.headers()['access-control-allow-origin']).toBeUndefined();
    const deep = await request.get(frontend + '/workspace/download', { headers: { Accept: 'text/html' } }); expect(deep.status()).toBe(200); expect(await deep.text()).toContain('ce-public-config');
    const missing = await request.get(frontend + '/missing-asset.js', { headers: { Accept: 'text/html' } }); expect(missing.status()).toBe(404); expect(missing.headers()['content-type']).not.toContain('text/html');
    const close = async (token: string) => request.delete(api + '/api/v1/session', { headers: { Origin: frontend, 'X-CE-Session': token, 'Idempotency-Key': randomUUID() } });
    expect((await close(owner.token)).status()).toBe(204);
    expect((await request.get(api + '/api/v1/session', { headers: { Origin: frontend, 'X-CE-Session': stranger.token } })).status()).toBe(200);
    expect((await read(a, owner.token)).status).toBe(410); expect((await close(stranger.token)).status()).toBe(204);
    expect(await a.evaluate(() => sessionStorage.length)).toBe(0); expect(await b.evaluate(() => sessionStorage.length)).toBe(0);
  } finally { await first.close(); await second.close(); await third.close(); }
});

test('FINREP: dos visitantes completan el flujo; recarga y ACK perdido recuperan la descarga exacta entre instancias', async ({ browser, request }, info) => {
  test.setTimeout(420_000);
  const contexts = [await browser.newContext(), await browser.newContext()], pages = [await contexts[0]!.newPage(), await contexts[1]!.newPage()];
  const visitors: { identity: Identity; versionId: string; saved: string; hash: string }[] = [];
  try {
    for (const [index, page] of pages.entries()) {
      let exportRequestsBeforeRecovery = 0;
      await control(request, '/balance', { instance: index ? 'api2' : 'api1' });
      const who = await start(page, `FINREP visitor ${index + 1} SYNTHETIC`);
      if (visitors.length) { expect(who.sessionId).not.toBe(visitors[0]!.identity.sessionId); expect(who.workspaceId).not.toBe(visitors[0]!.identity.workspaceId); expect(who.token === visitors[0]!.identity.token).toBe(false); }
      await control(request, '/balance', { instance: 'auto' });
      await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve('tests/fixtures/generated/demo-finrep-catalog.xlsx'));
      await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('tests/fixtures/generated/demo-finrep-report.xlsx'));
      await page.locator('#context-source').selectOption('workbook');
      const inspected = await action(page, '/import-inspections', 'Inspeccionar archivos');
      const inspection = await get(page, `/import-inspections/${inspected.resultRef.id}?compact=true`); expect(inspection.reportCount).toBe(1); expect(inspection.contextCount).toBe(1);
      await action(page, `/import-inspections/${inspected.resultRef.id}/commit`, 'Confirmar carga');
      await page.getByRole('button', { name: '2. Validar', exact: true }).click();
      const validated = await action(page, '/validations', 'Validar informes');
      expect((await get(page, `/runs/${validated.resultRef.id}/results?compact=true`)).run.summary.byStatus).toMatchObject({ pass: 2, fail: 3 });
      await page.getByRole('button', { name: '3. Recalcular', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Simular recálculos', exact: true })).toBeEnabled({ timeout: 70_000 });
      const simulated = await action(page, '/recalculation-operations', 'Simular recálculos');
      expect((await get(page, `/previews/${simulated.resultRef.id}/selection-state`)).selectedCount).toBe(2);
      for (const code of ['FIN_TOTAL_CASH','FIN_TOTAL_ASSETS_DEMO']) await expect(page.getByLabel('Seleccionar ' + code, { exact: true })).toBeChecked();
      await page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.', { exact: true }).check();
      const applied = await action(page, '/applications', 'Aplicar cambios seleccionados');
      expect((await get(page, `/applications/${applied.resultRef.id}?includeAcceptedIds=false`)).afterSummary.byStatus).toMatchObject({ pass: 4, fail: 1 });
      await page.getByRole('button', { name: '4. Descargar', exact: true }).click();
      await expect(page.locator('[data-download-action]')).toHaveCount(1); await expect(page.locator('[data-download-action]')).toBeEnabled();
      await page.locator('#export-version').selectOption(applied.newVersionId);
      // Keep the same public URL and profile while a later browser request lands in another process.
      await control(request, '/balance', { instance: index ? 'api1' : 'api2' });
      await page.goto('/workspace/download'); await expect(page.locator('ce-exports')).toBeVisible();
      expect((await identity(page)).workspaceId).toBe(who.workspaceId); await expect(page.locator('#export-version')).toHaveValue(applied.newVersionId);
      if (index === 1) {
        await control(request, '/queue', { paused: true }); await control(request, '/drop-response', { method: 'POST', pathEndsWith: '/exports' });
        await page.locator('[data-download-action]').click();
        await expect(page.locator('[data-download-action]')).toHaveText('Reintentar descarga');
        const lostAckState = await control(request, '/state'), attempts = lostAckState.requests.filter((row: any) => row.method === 'POST' && row.path === `/api/v1/workspaces/${who.workspaceId}/exports`);
        exportRequestsBeforeRecovery = attempts.length; expect(attempts.length).toBeGreaterThanOrEqual(1);
        expect(attempts[0].operationKey).toMatch(/^[a-f0-9-]{36}$/);
        expect(new Set(attempts.map((row: any) => row.operationKey)).size).toBe(1);
        expect(lostAckState.jobCounts.find((row: any) => row.workspaceId === who.workspaceId && row.kind === 'export')?.count).toBe(1);
        await control(request, '/drop-response/clear', {});
        await control(request, '/balance', { instance: 'api2' });
        const recovery = page.waitForResponse(response => response.request().method() === 'GET'
          && response.url().includes('/api/v1/operation-receipts/') && response.status() === 200);
        await page.reload(); await expect(page.locator('ce-exports')).toBeVisible();
        const receipt = await (await recovery).json(); expect(receipt.workspaceId).toBe(who.workspaceId); expect(receipt.reservation.kind).toBe('export');
        await control(request, '/queue', { paused: false });
        let recoveredJob: any; await expect.poll(async () => { recoveredJob = await get(page, '/jobs/' + receipt.jobId); return recoveredJob.status; }, { timeout: 70_000 }).toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
        expect(recoveredJob.status, JSON.stringify(recoveredJob.diagnostics)).toBe('succeeded');
        await expect(page.locator('[data-download-action]')).toHaveText('Descargar', { timeout: 70_000 });
        await expect(page.locator('[data-download-action]')).toBeEnabled({ timeout: 70_000 });
      }
      const manifestResponse = page.waitForResponse(response => response.request().method() === 'GET'
        && response.url().startsWith(`${api}/api/v1/workspaces/${who.workspaceId}/exports/`) && response.url().endsWith('/manifest'), { timeout: 80_000 });
      const downloading = page.waitForEvent('download', { timeout: 80_000 }); await page.locator('[data-download-action]').click();
      const [downloaded, transferResponse] = await Promise.all([downloading, manifestResponse]), saved = info.outputPath(`visitor-${index + 1}-report.zip`);
      expect(downloaded.suggestedFilename()).toBe('report.zip'); await downloaded.saveAs(saved);
      const manifest = await transferResponse.json(), downloadedBytes = await readFile(saved);
      expect(manifest.intent).toEqual({ workspaceId: who.workspaceId, versionId: applied.newVersionId, kind: 'report' });
      expect(digest(downloadedBytes)).toBe(manifest.sha256); expect(downloadedBytes.length).toBe(manifest.byteLength);
      const entries = await readZipParts(saved), changes = JSON.parse(entries.find(entry => entry.name === 'changes.json')!.data.toString('utf8'));
      expect(changes.changes).toHaveLength(2); expect(new Set(changes.changes.map((row: any) => row.code))).toEqual(new Set(['FIN_TOTAL_CASH','FIN_TOTAL_ASSETS_DEMO']));
      const workbook = entries.find(entry => entry.name === 'reports/report-001.xlsx')!; expect(workbook).toBeDefined();
      const parsed = await readXlsxFile(workbook.data, { parseNumber: value => value, trim: false });
      const assets = parsed.find(sheet => sheet.sheet === '1.1')!.data;
      expect(assets[7]![5]).toBe('100'); expect(assets[44]![5]).toBe('120');
      expect(assets[8]![5]).toBe('40'); expect(assets[9]![5]).toBe('35'); expect(assets[10]![5]).toBe('25');
      expect(changes.receipts.at(-1).newVersionId).toBe(applied.newVersionId);
      if (index === 1) {
        const recoveredState = await control(request, '/state');
        expect(recoveredState.requests.filter((row: any) => row.method === 'POST' && row.path === `/api/v1/workspaces/${who.workspaceId}/exports`)).toHaveLength(exportRequestsBeforeRecovery);
        expect(recoveredState.jobCounts.find((row: any) => row.workspaceId === who.workspaceId && row.kind === 'export')?.count).toBe(1);
      }
      visitors.push({ identity: who, versionId: applied.newVersionId, saved, hash: digest(await readFile(saved)) });
    }
    const first = visitors[0]!, second = visitors[1]!;
    const foreign = await request.get(`${api}/api/v1/workspaces/${first.identity.workspaceId}?compact=true`, { headers: { Origin: frontend, 'X-CE-Session': second.identity.token } }); expect(foreign.status()).toBe(404);
    await pages[0]!.getByRole('button', { name: 'Cerrar conjunto', exact: true }).click(); await pages[0]!.getByRole('button', { name: 'Cerrar y descartar', exact: true }).click();
    await expect(pages[0]!.getByRole('button', { name: 'Iniciar o recuperar demo', exact: true })).toBeVisible();
    expect(await pages[0]!.evaluate(() => sessionStorage.length)).toBe(0); expect((await get(pages[1]!, '?compact=true')).currentVersionId).toBe(second.versionId);
    await pages[1]!.reload(); await expect(pages[1]!.locator('ce-exports')).toBeVisible(); expect((await identity(pages[1]!)).sessionId).toBe(second.identity.sessionId);
    await pages[1]!.getByRole('button', { name: 'Cerrar conjunto', exact: true }).click(); await pages[1]!.getByRole('button', { name: 'Cerrar y descartar', exact: true }).click();
    await expect(pages[1]!.getByRole('button', { name: 'Iniciar o recuperar demo', exact: true })).toBeVisible();
    for (const visitor of visitors) expect(digest(await readFile(visitor.saved))).toBe(visitor.hash);
    const evidence = await control(request, '/state'); expect(evidence.deliveries.length).toBeGreaterThanOrEqual(16); expect(evidence.deliveries.every((row: any) => row.status === 200)).toBe(true);
    await info.attach('hosted-controlled-evidence', { contentType: 'application/json', body: JSON.stringify({ actor: 'Playwright', visitors: 2, processes: 2, publicApiUrl: api, providers: 'controlled queue/signature/private objects; real PostgreSQL and CPU workers', stages: ['import','validation','recalculation','download'], recoveredLostExportAck: true, humanAcceptance: false }) });
  } finally { await control(request, '/queue', { paused: false }); for (const context of contexts) await context.close(); }
});

test('COREP hosted: decisiones, cinco cambios, resultado 14/1/1 y XLSX verificado', async ({ page }, info) => {
  await start(page, 'COREP hosted SYNTHETIC'); await uploadDemo(page, 'corep');
  await page.getByRole('button', { name: '2. Validar', exact: true }).click();
  const validated = await action(page, '/validations', 'Validar informes');
  expect((await get(page, `/runs/${validated.resultRef.id}/results?compact=true`)).run.summary.byStatus).toMatchObject({ pass: 7, fail: 8, not_applicable: 1, error: 0 });
  await page.getByRole('button', { name: '3. Recalcular', exact: true }).click();
  let state: any; await expect.poll(async () => { state = await get(page, '/recalculation-state'); return state.review?.state; }, { timeout: 70_000 }).toBe('ready');
  await chooseReadyConflict(page, state.review.id, 'r0070', 'v0174_m');
  const review = await chooseReadyConflict(page, state.review.id, 'r0200', null);
  expect(review.counts).toMatchObject({ included: 5, pending: 0, conflicted: 0 });
  await action(page, '/recalculation-operations', 'Simular recálculos');
  for (const code of ['v0172_m','v0173_m','v0174_m','v0175_m','v0176_m']) await expect(page.getByLabel('Seleccionar ' + code, { exact: true })).toBeChecked();
  await page.getByLabel('He revisado cada propuesta y acepto aplicar el conjunto completo mostrado.', { exact: true }).check();
  const applied = await action(page, '/applications', 'Aplicar cambios seleccionados');
  const receipt = await get(page, `/applications/${applied.resultRef.id}?includeAcceptedIds=false`);
  expect(receipt.changeCount).toBe(5); expect(receipt.afterSummary.byStatus).toMatchObject({ pass: 14, fail: 1, not_applicable: 1, error: 0 });
  const entries = await downloadChecked(page, info, applied.newVersionId, 'corep-hosted-report.zip');
  const changes = JSON.parse(entries.find(entry => entry.name === 'changes.json')!.data.toString('utf8')); expect(changes.changes).toHaveLength(5);
  const sheets = await readXlsxFile(entries.find(entry => entry.name === 'reports/report-001.xlsx')!.data, { trim: false, parseNumber: value => value });
  const rows = sheets.find(sheet => sheet.sheet === 'CA1')!.data;
  for (const [code, value] of Object.entries({ '0070': '60', '0030': '185', '0150': '50', '0130': '100', '0020': '285' }))
    expect(String(rows.find(row => row[1] === code)?.[4])).toMatch(new RegExp('^' + value + '(?:\\.00)?$'));
  await closeVisitor(page);
});

test('tipos hosted: resultado 6/2, sin recálculos y seis valores conservados en XLSX', async ({ page }, info) => {
  await start(page, 'Tipos hosted SYNTHETIC'); const imported = await uploadDemo(page, 'types');
  await page.getByRole('button', { name: '2. Validar', exact: true }).click();
  const validated = await action(page, '/validations', 'Validar informes');
  expect((await get(page, `/runs/${validated.resultRef.id}/results?compact=true`)).run.summary.byStatus).toMatchObject({ pass: 6, fail: 2, not_applicable: 0, error: 0 });
  await page.getByRole('button', { name: '3. Recalcular', exact: true }).click();
  await expect(page.getByText('No hay recálculos disponibles', { exact: true })).toBeVisible({ timeout: 70_000 });
  await expect(page.getByRole('button', { name: 'Simular recálculos', exact: true })).toBeDisabled();
  const entries = await downloadChecked(page, info, imported.newVersionId, 'types-hosted-report.zip');
  const changes = JSON.parse(entries.find(entry => entry.name === 'changes.json')!.data.toString('utf8')); expect(changes.changes).toEqual([]);
  const sheets = await readXlsxFile(entries.find(entry => entry.name === 'reports/report-001.xlsx')!.data, { trim: false, parseNumber: value => value });
  const data = sheets.find(sheet => sheet.sheet === 'Datos')!.data;
  expect(data.slice(3, 9).map(row => row[1] ?? '')).toEqual(['Banco', 'banco', 'Banco ', '', '2024-02-29', '2025-12-31']);
  expect(data.slice(3, 9).map(row => row[2])).toEqual(Array(6).fill('Informado'));
  await closeVisitor(page);
});
