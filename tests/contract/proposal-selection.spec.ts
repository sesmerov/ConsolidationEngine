import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { proposalSelectionEditSchema, proposalSelectionPrepareSchema, proposalSelectionRowsQuerySchema, proposalSelectionSummarySchema } from '../../packages/contracts/src/proposal-selection.js';
import { applicationRequestSchema, compactApplyReceiptSchema } from '../../packages/contracts/src/application.js';
const id = '00000000-0000-4000-8000-000000000001', hash = 'a'.repeat(64);
async function check(schema: object, payload: unknown) { const app = Fastify({ ajv: { customOptions: { coerceTypes: false, removeAdditional: false } } });
  app.post('/', { schema: { body: schema } }, async () => true); try { return (await app.inject({ method: 'POST', url: '/', payload })).statusCode; } finally { await app.close(); } }
it('closes edit and explicit preparation inputs, excluding hidden global IDs and duplicate set entries', async () => {
  const set = { op: 'set', proposalId: id, selected: true }, body = { selectionId: id, expectedRevision: 1, operations: [set] };
  expect(await check(proposalSelectionEditSchema, body)).toBe(200);
  for (const operations of [[], [set, set], [set, { op: 'clear' }], [{ op: 'selectMatching', filter: { secret: true } }]]) expect(await check(proposalSelectionEditSchema, { ...body, operations })).toBe(400);
  expect(await check(proposalSelectionPrepareSchema, { baseVersionId: id, seed: 'empty' })).toBe(200);
  expect(await check(proposalSelectionPrepareSchema, { baseVersionId: id, seed: 'available' })).toBe(400);
});
it('requires a complete projection for a positive revision and omits invented zero counts while preparing', async () => {
  const base = { id, workspaceId: id, previewId: id, baseVersionId: id, revision: 0, state: 'preparing' };
  expect(await check(proposalSelectionSummarySchema, base)).toBe(200);
  expect(await check(proposalSelectionSummarySchema, { ...base, availableCount: 0 })).toBe(400);
  expect(await check(proposalSelectionSummarySchema, { ...base, state: 'ready', revision: 1 })).toBe(400);
  expect(await check(proposalSelectionSummarySchema, { ...base, state: 'ready', revision: 1, availableCount: 2, selectedCount: 2, requiredCount: 0, complete: true, closureHash: hash })).toBe(200);
});
it('bounds pages and filters and accepts exactly one application representation', async () => {
  expect(await check(proposalSelectionRowsQuerySchema, { limit: '200', scope: 'missing', contextId: 'other-context' })).toBe(200);
  for (const query of [{ limit: '201' }, { contextId: 'bad/context' }, { code: 'a'.repeat(129) }]) expect(await check(proposalSelectionRowsQuerySchema, query)).toBe(400);
  const body = { baseVersionId: id, previewId: id, selectionRef: { id, revision: 1 }, closureHash: hash };
  expect(await check(applicationRequestSchema, body)).toBe(200);
  expect(await check(applicationRequestSchema, { ...body, selectedIds: [id] })).toBe(400);
  expect(await check(applicationRequestSchema, { ...body, selectionRef: { id, revision: 0 } })).toBe(400);
  const receipt = { id, previewId: id, baseVersionId: id, newVersionId: id, beforeValidationRunId: id, validationRunId: id, appliedAt: '2026-11-07T00:00:00.000Z', closureHash: hash, acceptedCount: 2 };
  expect(await check(compactApplyReceiptSchema, receipt)).toBe(200); expect(await check(compactApplyReceiptSchema, { ...receipt, acceptedIds: [id] })).toBe(400);
});
