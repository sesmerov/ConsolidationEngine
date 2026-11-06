import { createHash } from 'node:crypto';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EBA_HEADERS } from '@ce/contracts';
import { deterministicZip, workbookParts } from '../../scripts/lib/visual-xlsx.mjs';

const codes = Array.from({ length: 500 }, (_, i) => 'CUSTOM_FIND_' + String(i).padStart(3, '0'));
const catalog = deterministicZip(workbookParts([{ name: 'Custom rules', rows: [
  EBA_HEADERS, ...codes.map(code => [code, 'SYNTHETIC', 'COREP', 'COREP_OF_4.0', 'No', 'C_01.00',
    'with {tC_01.00,c0010,interval:false}: {r0020}>=0', '', 'Regla de búsqueda sintética',
    'Active', '2025-01-01', '', 'Error', '', 'No']),
] }]));

async function loadCatalog(page: Page) {
  await page.goto('/');
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  if (bootstrap.activeWorkspaceId) {
    expect(new URL(page.url()).origin).toBe('http://127.0.0.1:3318');
    const url = '/api/v1/workspaces/' + bootstrap.activeWorkspaceId, headers = { 'X-CE-Session': bootstrap.sessionToken };
    const current = await page.request.get(url, { headers });
    expect((await page.request.delete(url, { headers: { ...headers, 'If-Match': current.headers()['etag']! } })).ok()).toBe(true);
    await page.reload();
  }
  await page.getByLabel('Nombre del conjunto').fill('Catálogo sintético de 500 entradas');
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({
    name: 'catalogo-busqueda.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: catalog,
  });
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('assets/demos/demo-corep-report.xlsx'));
  await page.locator('#context-source').selectOption('workbook');
  await page.getByRole('button', { name: 'Inspeccionar archivos' }).click();
  await page.getByRole('button', { name: 'Confirmar carga' }).click();
  await expect(page.getByText('50 de 500 registros', { exact: true })).toBeVisible();
}

// Install the observer before the gesture. Both timestamps use Chromium's clock.
async function sample(page: Page, value: string, gesture: 'escritura' | 'pegado' | 'borrado') {
  const field = page.getByLabel('Código de regla', { exact: true });
  const matches = codes.filter(code => code.toLowerCase().includes(value.toLowerCase()));
  const visible = matches.slice(0, 50);
  await field.focus();
  await field.evaluate((input, oracle) => {
    input.removeAttribute('data-render-ms');
    function onInput() {
      if ((input as HTMLInputElement).value !== oracle.value) return;
      input.removeEventListener('input', onInput);
      const start = performance.now();
      function matchesPage() {
        const rendered = Array.from(document.querySelectorAll('.rule-row summary strong'), node => node.textContent?.trim());
        return JSON.stringify(rendered) === JSON.stringify(oracle.visible)
          && Array.from(document.querySelectorAll('[role="status"], [aria-live]')).some(node => node.textContent?.trim().split(' · ')[0] === oracle.totalText)
          && document.activeElement === input;
      }
      function tick() {
        if (performance.now() - start > 4000) return;
        if (matchesPage()) requestAnimationFrame(() => requestAnimationFrame(() => {
          if (matchesPage()) input.setAttribute('data-render-ms', String(performance.now() - start));
          else tick();
        }));
        else requestAnimationFrame(tick);
      }
      requestAnimationFrame(tick);
    }
    input.addEventListener('input', onInput);
  }, { value, visible, totalText: visible.length + ' de ' + matches.length + ' registros' });
  await field.press('ControlOrMeta+a');
  if (gesture === 'pegado') {
    await page.evaluate(text => navigator.clipboard.writeText(text), value);
    await field.press('ControlOrMeta+v');
  } else if (gesture === 'borrado') await field.press('Backspace');
  else await field.pressSequentially(value);
  await expect(field, gesture + ' → ' + (value || 'todo el catálogo')).toHaveAttribute('data-render-ms', /\d/, { timeout: 5000 });
  return { gesture, query: value, matches: matches.length, ms: Number(await field.getAttribute('data-render-ms')) };
}

test('buscar en 500 reglas con escritura, pegado y borrado contra la API real', async ({ page, context, browser }, info) => {
  test.setTimeout(120_000);
  await loadCatalog(page);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
  const measurements = [
    await sample(page, 'cUsToM_fInD_49', 'escritura'),
    await sample(page, 'find_377', 'pegado'),
    await sample(page, 'SIN_COINCIDENCIAS', 'escritura'),
    await sample(page, '', 'borrado'),
  ];
  const evidence = { browser: browser.version(), catalogSha256: createHash('sha256').update(catalog).digest('hex'), measurements };
  console.log('SC-002 ' + JSON.stringify(evidence));
  await info.attach('sc002-real-api', { body: JSON.stringify(evidence), contentType: 'application/json' });
  for (const measurement of measurements) expect(measurement.ms, JSON.stringify(measurement)).toBeLessThanOrEqual(1000);
});

test('una respuesta retrasada no repone filas anteriores ni mueve el foco', async ({ page }) => {
  test.setTimeout(120_000);
  await loadCatalog(page);
  let release!: () => void, intercepted!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const captured = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route('**/rules?**', async route => {
    if (new URL(route.request().url()).searchParams.get('code') !== 'find_377') return route.continue();
    const response = await route.fetch();
    intercepted(); await hold;
    await route.fulfill({ response });
  });
  const field = page.getByLabel('Código de regla', { exact: true });
  await field.fill('find_377');
  await captured;
  await field.fill('find_499');
  await field.evaluate(input => {
    const observer = new MutationObserver(() => {
      if (Array.from(document.querySelectorAll('.rule-row summary strong')).some(row => row.textContent?.trim() === 'CUSTOM_FIND_377')) {
        input.setAttribute('data-stale-result', 'true');
      }
      if (document.querySelector('.rule-row summary strong')?.textContent?.trim() === 'CUSTOM_FIND_499') observer.disconnect();
    });
    observer.observe(document.querySelector('ce-import-page')!, { childList: true, subtree: true, characterData: true });
  });
  release();
  await expect(page.locator('.rule-row summary strong')).toHaveText(['CUSTOM_FIND_499']);
  await expect(page.getByText('1 de 1 registros', { exact: true })).toBeVisible();
  await expect(field).toBeFocused();
  await expect(field).not.toHaveAttribute('data-stale-result', 'true');
  await page.getByLabel('Estado', { exact: true }).selectOption('applicable');
  await page.getByLabel('Tabla', { exact: true }).fill('C_01.00');
  await field.fill('');
  await expect(page.getByText('50 de 500 registros', { exact: true })).toBeVisible();
  await page.getByLabel('Tabla', { exact: true }).fill('F_01.01');
  await expect(page.getByRole('status').filter({ hasText: 'Sin coincidencias' })).toContainText('0 de 0');
});
