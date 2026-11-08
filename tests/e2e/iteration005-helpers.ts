import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { JobDTO, WorkspaceDTO } from '@ce/contracts';
import { isTerminalJob } from '@ce/contracts';

/** The harness supplies private credentials; never obtain a hosted visitor from global bootstrap. */
export interface Iteration005Connection {
  readonly apiOrigin: string;
  readonly sessionToken: string;
  readonly workspaceId: string;
}

function workspaceUrl(connection: Iteration005Connection, suffix = ''): string {
  const origin = new URL(connection.apiOrigin);
  if (origin.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(origin.hostname)
    || !['3318', '3351', '3352'].includes(origin.port) || origin.pathname !== '/' || origin.search || origin.hash
    || origin.username || origin.password) throw new Error('Use an explicit test-owned API origin (3318/3351/3352), never the analyst server');
  return `${origin.origin}/api/v1/workspaces/${encodeURIComponent(connection.workspaceId)}${suffix}`;
}

/** Works for either instance when both share the same session authority; no browser URL changes. */
export async function waitFor005Job(page: Page, connection: Iteration005Connection, jobId: string,
  expected: JobDTO['status'] = 'succeeded'): Promise<JobDTO> {
  let job!: JobDTO;
  await expect.poll(async () => {
    const response = await page.request.get(workspaceUrl(connection, '/jobs/' + encodeURIComponent(jobId)), {
      headers: { 'X-CE-Session': connection.sessionToken },
    });
    expect(response.status()).toBe(200);
    job = await response.json();
    return isTerminalJob(job.status);
  }, { timeout: 70_000 }).toBe(true);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe(expected);
  return job;
}

/** Check confirmed API identity and the public label rather than a store-only assertion. */
export async function expect005PublishedVersion(page: Page, connection: Iteration005Connection, versionId: string): Promise<WorkspaceDTO> {
  let workspace!: WorkspaceDTO;
  await expect.poll(async () => {
    const response = await page.request.get(workspaceUrl(connection), { headers: { 'X-CE-Session': connection.sessionToken } });
    expect(response.status()).toBe(200);
    workspace = await response.json();
    return workspace.currentVersionId;
  }).toBe(versionId);
  const index = workspace.versionIds.indexOf(versionId);
  expect(index).toBeGreaterThanOrEqual(0);
  await expect(page.locator('.workspace-context')).toContainText('Versión ' + (index + 1));
  return workspace;
}

export async function activate005WithKeyboard(control: Locator): Promise<void> {
  await control.focus();
  await expect(control).toBeFocused();
  await control.press('Enter');
}

/** Use native select APIs and then verify its actual visible DOM value; never set selectedIndex. */
export async function select005Value(control: Locator, value: string): Promise<void> {
  await control.selectOption(value);
  await expect(control).toHaveValue(value);
}

/** Only the single stage CTA may prepare, transfer or retry; Cancelar remains a distinct action. */
export async function expect005SingleDownloadAction(page: Page, name: string | RegExp): Promise<Locator> {
  const scope = page.locator('ce-exports');
  await expect(scope).toBeVisible();
  const actions = scope.getByRole('button', { name: /^(Descargar|Preparando…|Descargando…|Reintentar descarga)$/ });
  await expect(actions).toHaveCount(1);
  await expect(actions).toHaveAccessibleName(name);
  await expect(scope.getByRole('button', { name: /^(Preparar descarga|Descargar paquete de nuevo|Descargar informes aplicados)/ })).toHaveCount(0);
  return actions;
}
