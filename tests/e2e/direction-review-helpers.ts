import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { DirectionReviewMutationResponseDTO, DirectionReviewSummaryDTO, JobDTO } from '@ce/contracts';

type Activate = (control: Locator) => Promise<void>;
const click: Activate = control => control.click();

async function getSession(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { base: `/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, headers: { 'X-CE-Session': String(bootstrap.sessionToken) } };
}

async function finishJob(page: Page, jobId: string) {
  const session = await getSession(page);
  let job!: JobDTO;
  await expect.poll(async () => {
    const response = await page.request.get(`${session.base}/jobs/${jobId}`, { headers: session.headers });
    expect(response.status()).toBe(200);
    job = await response.json();
    return job.status;
  }, { timeout: 60_000 }).toMatch(/^(succeeded|failed|cancelled|timed_out)$/);
  expect(job.status, JSON.stringify(job.diagnostics)).toBe('succeeded');
  return job;
}

export async function prepareDirections(page: Page, activate: Activate = click) {
  const posting = page.waitForResponse(r => r.url().endsWith('/direction-reviews') && r.request().method() === 'POST');
  await activate(page.getByRole('button', { name: 'Preparar revisión de destinos', exact: true }));
  const accepted = await posting;
  expect(accepted.status()).toBe(202);
  const job = await finishJob(page, (await accepted.json()).jobId);
  expect(job.resultRef?.type).toBe('direction-review');
  return job.resultRef!.id;
}

async function editReview(page: Page, reviewId: string, control: Locator, activate: Activate) {
  const patch = page.waitForResponse(r => r.url().endsWith('/direction-reviews/' + reviewId) && r.request().method() === 'PATCH');
  await activate(control);
  const response = await patch;
  expect(response.status()).toBe(200);
  return (await response.json() as DirectionReviewMutationResponseDTO).summary;
}

export async function saveDirections(page: Page, reviewId: string, expectedCount: number, activate: Activate = click) {
  const posting = page.waitForResponse(r => r.url().endsWith(`/direction-reviews/${reviewId}/commit`) && r.request().method() === 'POST');
  await activate(page.getByRole('button', { name: 'Guardar configuración', exact: true }));
  const response = await posting;
  expect(response.status()).toBe(202);
  const job = await finishJob(page, (await response.json()).jobId);
  expect(job.newVersionId).toBeTruthy();
  await expect(page.getByTestId('current-version-id')).toHaveText(job.newVersionId!);
  const session = await getSession(page);
  const saved: DirectionReviewSummaryDTO = await (await page.request.get(`${session.base}/direction-reviews/${reviewId}`, { headers: session.headers })).json();
  expect(saved.receipt).toMatchObject({ reviewId, newVersionId: job.newVersionId, included: expectedCount });
  return job.newVersionId!;
}

/** The analyst must make both producer decisions for the unmodified COREP demo. */
export async function configureCorepDemo(page: Page, activate: Activate = click, beforeDecision?: () => Promise<void>) {
  const reviewId = await prepareDirections(page, activate);
  const keep = page.getByRole('group', { name: /r0070/ });
  await expect(keep).toContainText('DEMO_RANGE');
  await expect(keep).toContainText('DEMO_PRECONDITION');
  await beforeDecision?.();
  await editReview(page, reviewId, keep.getByRole('button', { name: 'Conservar v0174_m', exact: true }), activate);
  const omit = page.getByRole('group', { name: /r0200/ });
  await expect(omit).toContainText('DEMO_ZERO');
  await expect(omit).toContainText('DEMO_INTERVAL');
  const summary = await editReview(page, reviewId, omit.getByRole('button', { name: 'Omitir grupo', exact: true }), activate);
  expect(summary.counts).toMatchObject({ totalRows: 16, included: 5, omitted: 4, excluded: 7, pending: 0, conflicted: 0, undetermined: 0 });
  return saveDirections(page, reviewId, 5, activate);
}
