import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import type { DirectionReviewMutationResponseDTO, DirectionReviewSummaryDTO } from '@ce/contracts';


type Activate = (control: Locator) => Promise<void>;
const click: Activate = control => control.click();

async function getSession(page: Page) {
  const bootstrap = await (await page.request.get('/api/v1/bootstrap')).json();
  return { base: `/api/v1/workspaces/${bootstrap.activeWorkspaceId}`, headers: { 'X-CE-Session': String(bootstrap.sessionToken) } };
}

export async function prepareDirections(page: Page, activate: Activate = click) {
  await activate(page.getByRole('button', {name:'3. Recalcular',exact:true}));
  await expect(page.getByRole('heading',{name:'Elegir qué celdas recalcular',exact:true})).toBeVisible();
  const session=await getSession(page); let review:DirectionReviewSummaryDTO|undefined, stateName='';
  await expect.poll(async()=>{const state=await(await page.request.get(session.base+'/recalculation-state',{headers:session.headers})).json();review=state.review;stateName=state.state;return review?.state;},{timeout:60000}).toBe('ready');
  if(stateName!=='no_candidates') await expect(page.getByRole('button',{name:'Revisar decisiones',exact:true})).toBeEnabled();
  return review!.id;
}

async function editReview(page: Page, reviewId: string, control: Locator, activate: Activate) {
  const patch = page.waitForResponse(r => r.url().endsWith('/recalculation-reviews/' + reviewId) && r.request().method() === 'PATCH');
  await activate(control);
  const response = await patch;
  expect(response.status()).toBe(200);
  return (await response.json() as DirectionReviewMutationResponseDTO).summary;
}

export async function chooseConflict(page: Page, reviewId: string, group: Locator, code: string | null, activate: Activate = click) {
  await expect(group).toBeVisible();
  const editor = group.getByRole('radiogroup');
  if (!await editor.count()) await activate(group.getByRole('button', { name: /^(Cambiar elección|Elegir regla)$/ }));
  const radio = code === null ? group.getByRole('radio', { name: 'No recalcular esta celda', exact: true })
    : group.getByRole('radio', { name: new RegExp('^' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:\\s|$)') });
  // Space activates a radio for both mouse and keyboard journeys; changing it remains a local draft.
  await radio.focus(); await page.keyboard.press('Space'); await expect(radio).toBeChecked();
  return editReview(page, reviewId, group.getByRole('button', { name: 'Confirmar elección', exact: true }), activate);
}

/** Choices remain a draft; only Simular publishes configuration together with its preview. */
export async function ensureDirectionsReady(page: Page, reviewId: string, expectedCount: number, _activate: Activate = click) {
  const session=await getSession(page);
  const review:DirectionReviewSummaryDTO=await(await page.request.get(session.base+'/recalculation-reviews/'+reviewId,{headers:session.headers})).json();
  expect(review.counts?.included).toBe(expectedCount);expect(review.counts?.pending).toBe(0);expect(review.conflictGroupCount).toBe(0);
  await expect(page.getByRole('button',{name:'Simular recálculos',exact:true})).toBeEnabled();
  return (await(await page.request.get(session.base,{headers:session.headers})).json()).currentVersionId as string;
}

/** The analyst must make both producer decisions for the unmodified COREP demo. */
export async function configureCorepDemo(page: Page, activate: Activate = click, beforeDecision?: () => Promise<void>) {
  const reviewId = await prepareDirections(page, activate);
  const keep = page.getByRole('group', { name: /r0070/ });
  await expect(keep).toBeVisible();
  if (!await keep.getByRole('radiogroup').count()) await activate(keep.getByRole('button', { name: 'Elegir regla', exact: true }));
  await expect(keep).toContainText('DEMO_RANGE');
  await expect(keep).toContainText('DEMO_PRECONDITION');
  await beforeDecision?.();
  await chooseConflict(page, reviewId, keep, 'v0174_m', activate);
  const omit = page.getByRole('group', { name: /r0200/ });
  await expect(omit).toBeVisible();
  if (!await omit.getByRole('radiogroup').count()) await activate(omit.getByRole('button', { name: 'Elegir regla', exact: true }));
  await expect(omit).toContainText('DEMO_ZERO');
  await expect(omit).toContainText('DEMO_INTERVAL');
  const summary = await chooseConflict(page, reviewId, omit, null, activate);
  expect(summary.counts).toMatchObject({ totalRows: 16, included: 5, omitted: 4, excluded: 7, pending: 0, conflicted: 0, undetermined: 0 });
  return ensureDirectionsReady(page, reviewId, 5, activate);
}
