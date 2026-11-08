import path from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

export async function createAnalystWorkspace(page: Page) {
  const boot = await (await page.request.get('/api/v1/bootstrap')).json();
  if (boot.activeWorkspaceId) {
    const url = '/api/v1/workspaces/' + boot.activeWorkspaceId, headers = { 'X-CE-Session': boot.sessionToken };
    const current = await page.request.get(url, { headers });
    await page.request.delete(url, { headers: { ...headers, 'If-Match': current.headers()['etag']! } });
  }
  await page.goto('/'); await expect(page.getByText('La sesión es temporal.', { exact: false })).toBeVisible();
  await page.getByLabel('Nombre del conjunto').fill('Información útil 004'); await page.getByRole('button', { name: 'Crear conjunto', exact: true }).click();
}
export async function uploadDemo(page: Page, kind: 'corep'|'finrep'|'types' = 'corep') {
  await page.getByLabel('Catálogo de reglas (.xlsx)').setInputFiles(path.resolve('assets/demos/demo-' + kind + '-catalog.xlsx'));
  await page.getByLabel('Informes (.xlsx)', { exact: true }).setInputFiles(path.resolve('assets/demos/demo-' + kind + '-report.xlsx'));
}
export async function runAnalystAction(page: Page, suffix: string, label: string) {
  const response = page.waitForResponse(r => r.url().endsWith(suffix) && r.request().method() === 'POST');
  await page.getByRole('button', { name: label, exact: true }).click(); const accepted = await response; expect(accepted.status()).toBe(202);
  const initial = await accepted.json(), boot = await (await page.request.get('/api/v1/bootstrap')).json();
  let job: any;
  await expect.poll(async () => { job = await (await page.request.get('/api/v1/workspaces/' + boot.activeWorkspaceId + '/jobs/' + initial.jobId, { headers: { 'X-CE-Session': boot.sessionToken } })).json(); return job.status; }, { timeout: 60_000 }).toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded'); return job;
}
export async function expectNoTechnicalText(page: Page) {
  const boot = await (await page.request.get('/api/v1/bootstrap')).json();
  const workspace = await (await page.request.get('/api/v1/workspaces/' + boot.activeWorkspaceId, { headers: { 'X-CE-Session': boot.sessionToken } })).json();
  const visible = await page.locator('main').innerText();
  for (const value of [boot.sessionToken, workspace.id, ...workspace.versionIds]) expect(visible).not.toContain(value);
  expect(visible).not.toMatch(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b|\b[0-9a-f]{64}\b/i);
  for (const label of ['Información técnica', 'Detalle técnico', 'Identificadores y política de cálculo', 'Procedencia y lecturas']) expect(visible).not.toContain(label);
  expect(visible).not.toContain('["');
}

