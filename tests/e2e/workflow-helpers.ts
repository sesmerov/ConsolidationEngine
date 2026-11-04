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
