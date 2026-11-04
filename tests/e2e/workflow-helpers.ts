import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

const stages = {
  import: { name: '1. Cargar', component: 'ce-import-page' },
  validation: { name: '2. Validar', component: 'ce-validation-page' },
  recalculation: { name: '3. Recalcular', component: 'ce-preview-page' },
  download: { name: '4. Descargar', component: 'ce-exports' },
} as const;

/** Work through the public workspace navigation; only its active stage is mounted. */
export async function navigateStage(page: Page, stage: keyof typeof stages): Promise<void> {
  await page.getByRole('button', { name: stages[stage].name, exact: true }).click();
  await expect(page.locator(stages[stage].component)).toBeVisible();
}

/** Legacy fixtures deliberately opt into the advanced direct-import flow. */
export async function enableLegacyFormat(page: Page, options: { keyboard?: boolean } = {}): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: /^Formato anterior ce-report-1$/ });
  const checkbox = page.getByRole('checkbox', { name: 'Usar formato anterior ce-report-1', exact: true });
  async function keyboardActivate(target: Locator, key: 'Enter' | 'Space'): Promise<void> {
    for (let step = 0; step < 160; step++) {
      if (await target.evaluate(element => element === document.activeElement)) { await page.keyboard.press(key); return; }
      await page.keyboard.press('Tab');
    }
    throw new Error('Keyboard focus could not reach the legacy format option');
  }
  await expect(summary).toBeVisible();
  if (!(await summary.evaluate(element => element.parentElement?.hasAttribute('open')))) {
    if (options.keyboard) await keyboardActivate(summary, 'Enter'); else await summary.click();
  }
  if (!(await checkbox.isChecked())) {
    if (options.keyboard) await keyboardActivate(checkbox, 'Space'); else await checkbox.check();
  }
  await expect(checkbox).toBeChecked();
}

export async function openCalculation(page: Page, row: Locator, code: string, comparisonSide?: 'Antes' | 'Después'): Promise<Locator> {
  await row.getByRole('button', { name: 'Ver cálculo y origen de ' + code, exact: true }).click();
  const scope = comparisonSide ? page.getByRole('region', { name: comparisonSide, exact: true }) : page;
  const detail = scope.getByRole('region', { name: 'Cálculo y origen de ' + code, exact: true });
  await expect(detail).toBeVisible();
  return detail;
}

export async function openTechnical(detail: Locator): Promise<Locator> {
  await detail.locator('summary').filter({ hasText: /^Detalle técnico$/ }).click();
  const technical = detail.locator('[data-technical] pre');
  await expect(technical).toBeVisible();
  return technical;
}
