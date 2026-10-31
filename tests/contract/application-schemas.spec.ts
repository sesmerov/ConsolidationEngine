import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { applicationRequestSchema, applyReceiptSchema, applyChangeSchema, applicationDetailSchema, comparisonPageSchema } from '../../packages/contracts/src/application.js';
import { previewSchema, reportedFactSchema } from '@ce/contracts';
const id = '00000000-0000-4000-8000-000000000062', other = '00000000-0000-4000-8000-000000000063', hash = 'a'.repeat(64);
const request = { baseVersionId: id, previewId: id, selectedIds: [id], closureHash: hash };
const receipt = { id, previewId: id, acceptedIds: [id], closureHash: hash, baseVersionId: id, newVersionId: other, beforeValidationRunId: id, validationRunId: other, appliedAt: '2026-10-31T00:00:00.000Z' };
const derivation = { receiptId: id, previewId: id, proposalId: id, baseVersionId: id };
const coordinate = { factKey: 'cell', contextId: 'demo', tableCode: 'T', sheetCode: '', rowCode: '0010', columnCode: '0010', dataType: 'number', unit: 'EUR', decimals: '2', axes: {}, sourceLocator: {} };
const change = { changed: true, receiptId: id, proposalId: id, directionId: hash, instanceId: hash, variantIds: [hash], code: 'SYNTHETIC', targetKey: 'cell',
  before: { factKey: 'cell', coordinate, presence: 'implicit_null', sourceLocator: {} },
  after: { normalizedValue: { numerator: '33', denominator: '100' }, originalText: '0.33', decimals: '2', unit: 'EUR' },
  exactNominal: { numerator: '1', denominator: '3' }, derivedInterval: { lo: { numerator: '1', denominator: '3' }, hi: { numerator: '1', denominator: '3' } }, policyId: 'half-even-v1',
  readKeys: [], predecessorIds: [], metadataReads: [], sources: [] };
const summary = { complete: true, rows: 1, variants: 1, applicableVariants: 1, instances: 1, duplicateRows: 0, byStatus: { pass: 0, fail: 1, error: 0, not_applicable: 0, not_evaluable: 0 } };
const result = { id: hash, runId: id, versionId: id, profileId: 'profile', code: 'SYNTHETIC', variantIds: [hash], sourceRecordIds: [hash], tables: ['T'], coverageOnly: false, instanceId: hash, binding: { contextId: 'demo' },
  status: 'fail', severity: 'warning', severityOriginal: 'Warning', expression: '1=2', values: {}, readKeys: [], factReads: [], metadataReads: [], sources: [], diagnostics: [] };
async function validate(schema: object, check: (post: (body: unknown) => Promise<number>) => Promise<void>) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } }); app.post('/', { schema: { body: schema } }, async () => ({ valid: true }));
  try { await check(async payload => (await app.inject({ method: 'POST', url: '/', payload })).statusCode); } finally { await app.close(); }
}
it('closes application input to a nonempty explicit UUID selection and a fixed closure hash', async () => {
  await validate(applicationRequestSchema, async post => {
    expect(await post(request)).toBe(200); expect(await post({ ...request, selectedIds: [] })).toBe(400); expect(await post({ ...request, selectedIds: [id, id] })).toBe(400);
    expect(await post({ ...request, closureHash: 'bad' })).toBe(400); expect(await post({ ...request, expression: '1=1' })).toBe(400); expect(await post({ ...request, accepted: true })).toBe(400);
  });
});
it('requires both complete-run references in a closed published receipt, never an accepted candidate status', async () => {
  await validate(applyReceiptSchema, async post => {
    expect(await post(receipt)).toBe(200); const { beforeValidationRunId: _before, ...missing } = receipt; expect(await post(missing)).toBe(400);
    expect(await post({ ...receipt, acceptedIds: [] })).toBe(400); expect(await post({ ...receipt, state: 'accepted' })).toBe(400); expect(await post({ ...receipt, appliedAt: 'not-a-date' })).toBe(400);
  });
});
it('keeps exact numeric change evidence distinct from boolean changes without quantization', async () => {
  await validate(applyChangeSchema, async post => {
    expect(await post(change)).toBe(200); const { exactNominal: _exact, derivedInterval: _interval, policyId: _policy, ...base } = change;
    expect(await post({ ...change, changed: false })).toBe(200); const { changed: _changed, ...missing } = change; expect(await post(missing)).toBe(400);
    const boolean = { ...base, before: { ...base.before, coordinate: { ...coordinate, dataType: 'boolean', unit: '', decimals: '' } }, after: { normalizedValue: true, originalText: 'true' } };
    expect(await post(boolean)).toBe(200); expect(await post({ ...boolean, policyId: 'half-even-v1' })).toBe(400); expect(await post({ ...boolean, exactNominal: change.exactNominal })).toBe(400);
    expect(await post({ ...change, exactNominal: { numerator: 1, denominator: 3 } })).toBe(400); expect(await post({ ...change, before: { ...change.before, presence: 'value', normalizedValue: change.after.normalizedValue, originalText: '0.33', derivation } })).toBe(200);
    expect(await post({ ...change, executable: 'anything' })).toBe(400);
  });
});
it('closes comparison rows and summaries while allowing unchanged failures and derived fact provenance', async () => {
  const detail = { receipt, changeCount: 1, beforeSummary: summary, afterSummary: summary };
  await validate(applicationDetailSchema, async post => { expect(await post(detail)).toBe(200); expect(await post({ ...detail, changeCount: 0 })).toBe(200); expect(await post({ ...detail, changeCount: -1 })).toBe(400); expect(await post({ ...detail, snapshot: {} })).toBe(400); });
  const page = { receipt, beforeSummary: summary, afterSummary: summary, items: [{ key: 'stable', before: result, after: { ...result, runId: other, versionId: other } }], total: 1, nextCursor: null };
  await validate(comparisonPageSchema, async post => {
    expect(await post(page)).toBe(200); expect(await post({ ...page, items: [{ key: 'empty' }] })).toBe(400); expect(await post({ ...page, items: [{ key: 'bad', after: { ...result, ast: {} } }] })).toBe(400);
    expect(await post({ ...page, afterSummary: { ...summary, byStatus: { ...summary.byStatus, unknown: 1 } } })).toBe(400);
    expect(await post({ ...page, items: [{ key: 'derived', after: { ...result, factReads: [{ ...change.before, presence: 'value', normalizedValue: change.after.normalizedValue, originalText: '0.33', derivation }] } }] })).toBe(200);
  });
});
it('links an applied preview and derived fact to their receipt without changing the source locator', async () => {
  const preview = { id, baseVersionId: id, profileId: 'profile', policyId: 'half-even-v1', createdAt: receipt.appliedAt, state: 'applied', appliedReceiptId: id, proposalIds: [id], graphSummary: { nodes: 1, edges: 0, order: [], cycles: [], conflicts: [], blocked: 0 }, diagnostics: [] };
  await validate(previewSchema, async post => { expect(await post(preview)).toBe(200); expect(await post({ ...preview, state: 'ready' })).toBe(400); const { appliedReceiptId: _id, ...missing } = preview; expect(await post(missing)).toBe(400); });
  const fact = { factKey: 'cell', contextId: 'demo', tableCode: 'T', sheetCode: '', rowCode: '0010', columnCode: '0010', presence: 'value', originalText: '0.33', normalizedValue: change.after.normalizedValue, sourceLocator: { sheet: 'Facts', row: 2, column: 'G' }, derivation };
  await validate(reportedFactSchema, async post => { expect(await post(fact)).toBe(200); expect(await post({ ...fact, derivation: { ...derivation, path: 'private' } })).toBe(400); });
});
