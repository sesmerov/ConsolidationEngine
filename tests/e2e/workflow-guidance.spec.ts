import path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

async function create(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  if (bootstrap.activeWorkspaceId) {
    const url = '/api/v1/workspaces/' + bootstrap.activeWorkspaceId, headers = { 'X-CE-Session': bootstrap.sessionToken };
    const current = await page.request.get(url, { headers });
    expect((await page.request.delete(url, { headers: { ...headers, 'If-Match': current.headers()['etag']! } })).ok()).toBe(true);
  }
  await page.goto('/'); await page.getByLabel('Nombre del conjunto').fill('Guía 004');
  await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
}
async function contrast(button: Locator) {
  return button.evaluate(element => {
    const css = getComputedStyle(element);
    let rendered = css.backgroundColor.match(/[\d.]+/g)!.slice(0, 3).map(Number);
    // Include Material's actual state-layer pseudo-element over the container.
    for (const child of element.querySelectorAll('*')) {
      const layer = getComputedStyle(child, '::before'), channels = layer.backgroundColor.match(/[\d.]+/g)?.map(Number);
      if (!channels || channels.length < 3 || !['""', "''"].includes(layer.content)) continue;
      const alpha = (channels[3] ?? 1) * Number(layer.opacity) * Number(getComputedStyle(child).opacity);
      rendered = rendered.map((value, index) => Math.round(value * (1 - alpha) + channels[index]! * alpha));
    }
    const luminance = (color: string) => {
      const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map(n => n / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
      return .2126 * channels[0]! + .7152 * channels[1]! + .0722 * channels[2]!;
    };
    const background = `rgb(${rendered.join(',')})`, a = luminance(css.color), b = luminance(background);
    return { ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), background, color: css.color };
  });
}
for (const width of [320, 390, 1440]) test(`visible guidance and primary action at ${width}px`, async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width, height: 900 }); await create(page);
  const inspect = page.getByRole('button', { name: 'Inspeccionar archivos', exact: true });
  await expect(inspect).toBeDisabled(); expect((await contrast(inspect)).ratio).toBeGreaterThanOrEqual(4.5);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve('assets/demos/demo-corep-catalog.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('assets/demos/demo-corep-report.xlsx'));
  await expect(inspect).toHaveClass(/ce-primary-action/);
  expect((await contrast(inspect)).ratio).toBeGreaterThanOrEqual(4.5);
  await inspect.hover(); expect((await contrast(inspect)).ratio).toBeGreaterThanOrEqual(4.5);
  await page.mouse.down(); expect((await contrast(inspect)).ratio).toBeGreaterThanOrEqual(4.5); await page.mouse.move(1, 1); await page.mouse.up();
  await page.keyboard.press('Tab'); await inspect.focus(); expect(await inspect.evaluate(e => getComputedStyle(e).outlineWidth)).toBe('3px');
  await page.keyboard.press('Enter'); await expect(page.getByRole('button', { name: 'Confirmar carga', exact: true })).toBeEnabled();
  await expect(page.locator('button.ce-primary-action:enabled')).toHaveCount(1);
  const current = page.getByRole('button', { name: '1. Cargar', exact: true });
  await page.route('**/import-inspections/*/commit', async route => { const response = await route.fetch(); await current.focus(); await route.fulfill({ response }); }, { times: 1 });
  await page.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  const next = page.getByRole('button', { name: '2. Validar', exact: true });
  await expect(next).toHaveClass(/stage-recommended/); await expect(current).toBeFocused();
  await expect(current).toHaveAttribute('aria-current', 'step');
  await expect(page.getByText('Siguiente paso', { exact: true })).toHaveCount(0);
  const announcement = page.locator('.stage-announcement');
  await expect(announcement).toHaveText('Etapa recomendada: Validar');
  const liveBounds = await announcement.boundingBox(); expect(liveBounds?.width).toBeLessThanOrEqual(1); expect(liveBounds?.height).toBeLessThanOrEqual(1);
  expect(await announcement.evaluate(e => getComputedStyle(e).clipPath)).toBe('inset(50%)');
  const pulse = next.locator('.stage-pulse'); await expect(pulse).toHaveCount(1);
  const timing = await pulse.evaluate(e => { const s = getComputedStyle(e); return { duration: s.animationDuration, iterations: s.animationIterationCount }; });
  expect(timing).toEqual({ duration: '1.5s', iterations: '3' });
  expect(await pulse.evaluate(e => e.getAnimations().map(animation => animation.effect?.getComputedTiming().activeDuration))).toEqual([4500]);
  await page.screenshot({ path: info.outputPath(`guidance-${width}.png`), fullPage: true });
  await expect(pulse).toHaveCount(0, { timeout: 5_000 }); await expect(next).toHaveClass(/stage-recommended/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await next.focus(); await page.keyboard.press('Enter'); await expect(page.locator('#validation-title')).toBeFocused();
  await expect(next).not.toHaveClass(/stage-recommended/);
});

test('reduced motion keeps the static signal and a failed inspection never advances', async ({ page }) => {
  test.setTimeout(90_000); await page.emulateMedia({ reducedMotion: 'reduce' }); await create(page);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles({ name: 'invalid.xlsx', buffer: Buffer.from('invalid archive') });
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('assets/demos/demo-corep-report.xlsx'));
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  await expect(page.locator('ce-import-page [role=alert]').filter({ hasText: /./ }).first()).toBeVisible();
  await expect(page.locator('.stage-recommended')).toHaveCount(0);
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve('assets/demos/demo-corep-catalog.xlsx'));
  await page.getByRole('button', { name: 'Inspeccionar archivos', exact: true }).click();
  await page.getByRole('button', { name: 'Confirmar carga', exact: true }).click();
  const next = page.getByRole('button', { name: '2. Validar', exact: true }); await expect(next).toHaveClass(/stage-recommended/);
  expect(await next.evaluate(e => e.getAnimations({ subtree: true }).filter(a => a instanceof CSSAnimation && a.animationName === 'stage-emphasis').length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'active' });
  const forced = await next.evaluate(e => { const css = getComputedStyle(e); return { width: css.borderTopWidth, border: css.borderTopColor, background: css.backgroundColor }; });
  expect(forced.width).toBe('3px'); expect(forced.border).not.toBe(forced.background);
});
