import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { expect, test } from '@playwright/test';
import type { APIResponse } from '@playwright/test';
const directory = process.env['BENCH_DIR']!, output = process.env['BENCH_OUTPUT']!;
const count = process.env['BENCH_PILOT'] === '1' ? 1 : 10;
for (let trial = 1; trial <= count; trial++) test(`SC007 legacy trial ${trial}`, async ({ page }, testInfo) => {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const samples: unknown[] = [], errors: string[] = []; let t0: number | undefined, importId = '', elapsedMs: number | undefined, auditPassed = false, diagnosticVisible = false;
  const server = fork(path.resolve('scripts/benchmark.mjs'), ['--server'], { execPath: process.execPath, silent: true, env: { ...process.env, PORT: '3317', NODE_ENV: 'production' } });
  // An HTTP response alone could come from another process already occupying 3317.
  // Wait for this child's successful listen before sending any request to that port.
  const ownServerReady = new Promise<void>((resolve, reject) => {
    let startupOutput = '';
    const complete = (error?: Error) => {
      clearTimeout(timer);
      server.stdout?.off('data', onData);
      server.off('error', onError);
      server.off('exit', onExit);
      if (error) reject(error); else resolve();
    };
    const onData = (chunk: Buffer) => {
      startupOutput = (startupOutput + String(chunk)).slice(-4096);
      if (startupOutput.includes('ConsolidationEngine API: http://127.0.0.1:3317')) complete();
    };
    const onError = (error: Error) => complete(error);
    const onExit = (code: number | null) => complete(new Error(`Benchmark server exited before listening (${code}); no existing server will be reused.`));
    const timer = setTimeout(() => complete(new Error('Benchmark-owned server did not start within 30 seconds.')), 30000);
    server.stdout?.on('data', onData);
    server.once('error', onError);
    server.once('exit', onExit);
  });
  server.stdout?.resume(); server.stderr?.on('data', chunk => errors.push(String(chunk))); server.on('message', message => samples.push(message));
  const stages: Record<string, unknown> = {};
  page.on('pageerror', error => errors.push(error.message));
  page.on('response', async response => {
    const received = performance.now();
    if (importId && response.url().endsWith('/jobs/' + importId)) {
      const job = await response.json().catch(() => null);
      if (job?.status === 'succeeded' && t0 === undefined) { t0 = received; stages['importEndedAt'] = job.endedAt; server.send({ phase: 'validation' }); }
    }
  });
  try {
    await ownServerReady;
    await expect.poll(async () => { try { return (await page.request.get('/api/v1/bootstrap')).status(); } catch { return 0; } }, { timeout: 30000 }).toBe(200);
    await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('SYNTHETIC SC007 legacy ' + trial); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
    await page.locator('summary').filter({ hasText: /^Formato anterior ce-report-1$/ }).click();
    await page.getByRole('checkbox', { name: 'Usar formato anterior ce-report-1', exact: true }).check();
    await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.join(directory, 'catalog.xlsx'));
    await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.join(directory, 'report.xlsx'));
    const acceptedImport = page.waitForResponse(r => r.url().endsWith('/imports') && r.request().method() === 'POST');
    server.send({ phase: 'import' }); const loadStart = performance.now(); await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click(); importId = (await (await acceptedImport).json()).jobId;
    await expect.poll(() => t0 !== undefined, { timeout: 70000, intervals: [100] }).toBe(true); stages['loadMs'] = t0! - loadStart;
    await expect(page.getByRole('heading', { name: 'Datos cargados · Versión 1', exact: true })).toBeVisible();
    await expect(page.locator('.data-summary')).toContainText('100000 coordenadas · 100000 hechos');
    const importedCoverage = page.locator('[aria-labelledby="coverage-title"]');
    for (const label of ['Filas del catálogo', 'Variantes']) await expect(importedCoverage.locator('.workspace-meta div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText('500');
    stages['coverageReadyMs'] = performance.now() - t0!;
    await page.getByRole('button', { name: '2. Validar', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Validación y explicación', exact: true })).toBeVisible(); stages['navigationMs'] = performance.now() - t0!;
    const acceptedValidation = page.waitForResponse(r => r.url().endsWith('/validations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Validar informes', exact: true }).click({ timeout: 65000 }); stages['clickedMs'] = performance.now() - t0!;
    const accepted = await (await acceptedValidation).json(); stages['acceptedMs'] = performance.now() - t0!;
    await expect(page.getByRole('heading', { name: 'Ejecución terminada', exact: true })).toBeVisible({ timeout: 65000 });
    await expect(page.locator('#validation-run')).toHaveValue(accepted.resultRef.id);
    const summary = page.locator('.validation-summary');
    for (const label of ['Pasa', 'Falla']) await expect(summary.locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText('250');
    for (const label of ['No aplica', 'No evaluable', 'Error']) await expect(summary.locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText('0');
    const coverageDetails = page.locator('details').filter({ has: page.locator('summary').filter({ hasText: /^Cobertura y trazabilidad de la ejecución$/ }) });
    await coverageDetails.locator('summary').click();
    await expect(coverageDetails).toContainText('500 filas · 500 variantes · 500 instancias · 0 duplicadas');
    await expect(page.locator('.result-row')).toHaveCount(50);
    await expect(page.getByText('50 de 500 resultados', { exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); elapsedMs = performance.now() - t0!;
    server.send({ phase: 'audit' }); await fs.writeFile(path.join(output, `trial-${trial}-visible.json`), JSON.stringify({ elapsedMs, stages }, null, 2)); await page.screenshot({ path: path.join(output, `trial-${trial}.png`) });
    const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json(); const headers = { 'X-CE-Session': bootstrap.sessionToken };
    const workspace = await (await page.request.get(`/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, { headers })).json(); expect(workspace.counts.facts).toBe(100000); expect(workspace.counts.coordinates).toBe(100000);
    const expected = new Map(manifest.rules.map((rule: { code: string; status: string }) => [rule.code, rule])); const keys = new Set<string>(), codes = new Set<string>(); let cursor: string | null = null, reads = 0;
    do {
      const response: APIResponse = await page.request.get(`/api/v1/workspaces/${bootstrap.activeWorkspaceId}/runs/${accepted.resultRef.id}/results?limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { headers }); expect(response.status()).toBe(200); const bundle = await response.json();
      expect(bundle.run.status).toBe('completed'); expect(bundle.run.summary).toMatchObject({ complete: true, rows: 500, variants: 500, instances: 500, duplicateRows: 0, byStatus: { pass: 250, fail: 250, error: 0, not_evaluable: 0, not_applicable: 0 } }); stages['run'] = bundle.run;
      for (const row of bundle.items) { const rule = expected.get(row.code) as { status: string; first: number; last: number; sum: string; expression: string };
        if (!rule || row.status !== rule.status || codes.has(row.code) || row.factReads.length !== 200 || row.readKeys.length !== 200 || row.coverageOnly || !row.instanceId || row.expression !== rule.expression) throw new Error('Unexpected or duplicated rule result: ' + row.code); codes.add(row.code);
        const expectedSum = BigInt(rule.sum.replace('.', '')), expectedRight = expectedSum + (rule.status === 'fail' ? 1n : 0n);
        if (row.values.left.kind !== 'number' || row.values.left.unit !== 'EUR' || BigInt(row.values.left.nominal.numerator) * 100n !== expectedSum * BigInt(row.values.left.nominal.denominator)
          || BigInt(row.values.right.nominal.numerator) * 100n !== expectedRight * BigInt(row.values.right.nominal.denominator)) throw new Error('Unexpected aggregate operands: ' + row.code);
        for (const read of row.factReads) {
          const ordinal = Number(read.coordinate.rowCode), cents = BigInt((ordinal * 37) % 10007 - 5003), absolute = cents < 0n ? -cents : cents;
          const text = `${cents < 0n ? '-' : ''}${absolute / 100n}.${String(absolute % 100n).padStart(2, '0')}`;
          if (keys.has(read.factKey) || ordinal < rule.first || ordinal > rule.last || read.presence !== 'value' || read.originalText !== text
            || read.coordinate.unit !== 'EUR' || read.coordinate.decimals !== '2' || read.sourceLocator.sheet !== 'Facts' || read.sourceLocator.row !== ordinal + 1 || read.sourceLocator.column !== 'G'
            || BigInt(read.normalizedValue.numerator) * 100n !== cents * BigInt(read.normalizedValue.denominator)) throw new Error('Unexpected identity/value/provenance: ' + read.factKey);
          keys.add(read.factKey); reads++;
        }
      } cursor = bundle.nextCursor;
    } while (cursor);
    expect(codes.size).toBe(500); expect(keys.size).toBe(100000); expect(reads).toBe(100000); auditPassed = true;
    expect(elapsedMs).toBeLessThanOrEqual(60000);
  } catch (error) {
    elapsedMs ??= t0 === undefined ? undefined : performance.now() - t0;
    diagnosticVisible = await page.getByRole('heading', { name: 'Ejecución incompleta', exact: true }).isVisible().catch(() => false)
      || await page.getByRole('alert').filter({ hasText: /superó|cuota|falló|no se pudo/i }).first().isVisible().catch(() => false);
    errors.push(String(error)); throw error;
  } finally {
    await fs.writeFile(path.join(output, `trial-${trial}.json`), JSON.stringify({ trial, elapsedMs, auditPassed, diagnosticVisible, stages, errors, samples, testStatus: testInfo.status }, null, 2));
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM'); await new Promise(resolve => { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(null); }, 5000).unref(); });
    }
  }
});
