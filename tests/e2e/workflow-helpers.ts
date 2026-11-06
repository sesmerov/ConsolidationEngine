import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { isTerminalJob } from '@ce/contracts';
import type { BootstrapDTO, JobDTO, WorkspaceDTO } from '@ce/contracts';

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

type FixtureWorkbook = string | { name: string; buffer: Buffer };

/** Seed a v1-only scenario through the production API in Playwright's private server. */
export async function importLegacyFixture(page: Page, catalog: FixtureWorkbook, reports: readonly FixtureWorkbook[]) {
  const origin = new URL(page.url()).origin;
  expect(origin, 'Fixture imports must use the Playwright-owned server').toBe('http://127.0.0.1:3318');
  await expect(page.locator('ce-workspace-shell')).toBeVisible();
  const bootstrapResponse = await page.request.get(origin + '/api/v1/bootstrap');
  expect(bootstrapResponse.status()).toBe(200);
  const bootstrap: BootstrapDTO = await bootstrapResponse.json();
  expect(bootstrap.activeWorkspaceId, 'Create a test workspace before importing').toBeTruthy();
  const base = origin + '/api/v1/workspaces/' + bootstrap.activeWorkspaceId;
  const headers = { 'X-CE-Session': bootstrap.sessionToken };
  const current = await page.request.get(base, { headers });
  expect(current.status()).toBe(200);
  const previous: WorkspaceDTO = await current.json();
  const etag = current.headers()['etag'];
  if (!etag) throw new Error('Missing workspace ETag before fixture import');

  const multipart = new FormData();
  for (const [index, source] of [catalog, ...reports].entries()) {
    const file = typeof source === 'string' ? { name: path.basename(source), buffer: await readFile(source) } : source;
    const blob = new Blob([Uint8Array.from(file.buffer)], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    multipart.append(index === 0 ? 'catalog' : 'reports', blob, file.name);
  }
  const accepted = await page.request.post(base + '/imports', {
    headers: { ...headers, 'If-Match': etag, 'Idempotency-Key': randomUUID() },
    multipart,
  });
  expect(accepted.status(), await accepted.text()).toBe(202);
  let job: JobDTO = await accepted.json();
  const jobId = job.jobId;
  await expect.poll(async () => {
    const response = await page.request.get(base + '/jobs/' + jobId, { headers });
    expect(response.status()).toBe(200);
    job = await response.json();
    return isTerminalJob(job.status);
  }, { timeout: 70_000 }).toBe(true);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
  const newVersionId = job.newVersionId;
  if (!newVersionId) throw new Error('Successful fixture import did not publish a version');

  const published = await page.request.get(base, { headers });
  expect(published.status()).toBe(200);
  const workspace: WorkspaceDTO = await published.json();
  expect(workspace.currentVersionId).toBe(newVersionId);
  expect(workspace.versionIds).toEqual([...previous.versionIds, newVersionId]);
  await page.reload();
  await expect(page.getByTestId('current-version-id')).toHaveText(newVersionId);
  return { newVersionId, workspace, jobId };
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
