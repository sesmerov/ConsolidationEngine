import fs from 'node:fs/promises';
import path from 'node:path';
import { fork } from 'node:child_process';
import { expect, test } from '@playwright/test';
const directory = process.env['BENCH_DIR']!, output = process.env['BENCH_OUTPUT']!;
const count = process.env['BENCH_PILOT'] === '1' ? 1 : 10;
for (let trial = 1; trial <= count; trial++) test(`SC006 trial ${trial}`, async ({ page }, testInfo) => {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  const samples: unknown[] = [], errors: string[] = []; let t0: number | undefined, importId = '', elapsedMs: number | undefined, auditPassed = false, diagnosticVisible = false;
  const server = fork(path.resolve('scripts/benchmark.mjs'), ['--server'], { execPath: process.execPath, silent: true, env: { ...process.env, PORT: '3317', NODE_ENV: 'production' } });
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
    await expect.poll(async () => { try { return (await page.request.get('/api/v1/bootstrap')).status(); } catch { return 0; } }, { timeout: 30000 }).toBe(200);
    await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('SYNTHETIC SC006 ' + trial); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
    await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.join(directory, 'catalog.xlsx'));
    await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.join(directory, 'report.xlsx'));
    const acceptedImport = page.waitForResponse(r => r.url().endsWith('/imports') && r.request().method() === 'POST');
    const loadStart = performance.now(); await page.getByRole('button', { name: 'Cargar archivos', exact: true }).click(); importId = (await (await acceptedImport).json()).jobId;
    await expect.poll(() => t0 !== undefined, { timeout: 70000, intervals: [100] }).toBe(true); stages['loadMs'] = t0! - loadStart;
    const acceptedValidation = page.waitForResponse(r => r.url().endsWith('/validations') && r.request().method() === 'POST');
    await page.getByRole('button', { name: 'Validar informes', exact: true }).click({ timeout: 65000 }); stages['clickedMs'] = performance.now() - t0!;
    const accepted = await (await acceptedValidation).json(); stages['acceptedMs'] = performance.now() - t0!;
    await expect(page.getByRole('heading', { name: 'Ejecución terminada', exact: true })).toBeVisible({ timeout: 65000 });
    await expect(page.locator('#validation-run')).toHaveValue(accepted.resultRef.id);
    const summary = page.locator('.validation-summary');
    for (const label of ['Filas importadas', 'Variantes', 'Instancias expandidas']) await expect(summary.locator('div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')).toHaveText('500');
    await expect(summary.locator('div').filter({ has: page.getByText('Duplicadas', { exact: true }) }).locator('dd')).toHaveText('0');
    await expect(page.locator('.result-row')).toHaveCount(50);
    await expect(page.getByText('50 de 500 resultados', { exact: true })).toBeVisible();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); elapsedMs = performance.now() - t0!;
    server.send({ phase: 'audit' }); await fs.writeFile(path.join(output, `trial-${trial}-visible.json`), JSON.stringify({ elapsedMs, stages }, null, 2)); await page.screenshot({ path: path.join(output, `trial-${trial}.png`) });
    const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json(); const headers = { 'X-CE-Session': bootstrap.sessionToken };
    const workspace = await (await page.request.get(`/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, { headers })).json(); expect(workspace.counts.facts).toBe(100000); expect(workspace.counts.coordinates).toBe(100000);
    const expected = new Map(manifest.rules.map((rule: { code: string; status: string }) => [rule.code, rule])); const keys = new Set<string>(), codes = new Set<string>(); let cursor: string | null = null, reads = 0;
    do {
      const response = await page.request.get(`/api/v1/workspaces/${bootstrap.activeWorkspaceId}/runs/${accepted.resultRef.id}/results?limit=50${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`, { headers }); expect(response.status()).toBe(200); const bundle = await response.json();
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
    server.kill('SIGTERM'); await new Promise(resolve => { server.once('exit', resolve); setTimeout(() => { server.kill('SIGKILL'); resolve(null); }, 5000).unref(); });
  }
});
