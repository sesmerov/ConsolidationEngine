import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { directionSchema, previewSchema, proposalSchema } from '@ce/contracts';
const id = '00000000-0000-5000-8000-000000000049', hash = 'a'.repeat(64);
const coordinate = { factKey: 'cell', contextId: 'demo', tableCode: 'T', sheetCode: '', rowCode: '0010', columnCode: '0010', dataType: 'number', unit: 'EUR', decimals: '2', axes: {}, sourceLocator: {} };
const proposal = { id, previewId: id, directionId: hash, instanceId: hash, variantIds: [hash], binding: { contextId: 'demo' }, code: 'SYNTHETIC', targetKey: 'cell',
  before: { factKey: 'cell', coordinate, presence: 'explicit_null', sourceLocator: {} }, exactNominal: { numerator: '1', denominator: '3' },
  derivedInterval: { lo: { numerator: '1', denominator: '3' }, hi: { numerator: '1', denominator: '3' } },
  after: { normalizedValue: { numerator: '33', denominator: '100' }, originalText: '0.33', decimals: '2', unit: 'EUR' },
  readKeys: [], predecessorIds: [], metadataReads: [], sources: [], state: 'available', diagnostics: [] };
async function validator(schema: object, check: (post: (body: unknown) => Promise<number>) => Promise<void>) {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.post('/', { schema: { body: schema } }, async () => ({ valid: true }));
  try { await check(async (payload) => (await app.inject({ method: 'POST', url: '/', payload })).statusCode); } finally { await app.close(); }
}
it('keeps exact numeric and boolean proposal DTOs distinct, including null provenance and blocked state', async () => {
  await validator(proposalSchema, async (post) => {
    expect(await post(proposal)).toBe(200);
    const { exactNominal: _nominal, derivedInterval: _interval, after: _after, ...base } = proposal;
    const boolean = { ...base, before: { ...base.before, coordinate: { ...coordinate, dataType: 'boolean', unit: '', decimals: '' }, presence: 'value', normalizedValue: false, originalText: 'false' }, after: { normalizedValue: true, originalText: 'true' } };
    expect(await post(boolean)).toBe(200); expect(await post({ ...boolean, exactNominal: proposal.exactNominal })).toBe(400);
    expect(await post({ ...boolean, after: { normalizedValue: true, originalText: 'false' } })).toBe(400);
    expect(await post({ ...boolean, after: { ...boolean.after, decimals: '2' } })).toBe(400);
    expect(await post({ ...base, state: 'blocked' })).toBe(200); expect(await post({ ...proposal, state: 'blocked' })).toBe(400);
    expect(await post(base)).toBe(400); expect(await post({ ...proposal, before: { ...proposal.before, normalizedValue: { numerator: '0', denominator: '1' } } })).toBe(400);
    expect(await post({ ...proposal, after: { ...proposal.after, normalizedValue: { numerator: 33, denominator: 100 } } })).toBe(400);
    expect(await post({ ...proposal, after: { ...proposal.after, decimals: '19' } })).toBe(400);
    expect(await post({ ...proposal, expression: '1=1' })).toBe(400);
  });
});
it('closes normalized directions and preview graph data to uploaded AST or executable fields', async () => {
  const direction = { id: hash, instanceId: hash, variantIds: [hash], binding: { contextId: 'demo' }, targetSide: 'left', targetKey: 'cell' };
  await validator(directionSchema, async (post) => {
    expect(await post(direction)).toBe(200); expect(await post({ ...direction, ast: { kind: 'rule' } })).toBe(400);
    expect(await post({ ...direction, binding: { ...direction.binding, expression: '1=1' } })).toBe(400);
  });
  const preview = { id, baseVersionId: id, profileId: 'ce-dpmxl-0.9-closed-v1', policyId: 'half-even-v1', createdAt: '2026-10-31T10:00:00.000Z', state: 'ready', proposalIds: [id],
    graphSummary: { nodes: 1, edges: 0, order: [hash], conflicts: [], cycles: [], blocked: 0 }, diagnostics: [] };
  await validator(previewSchema, async (post) => {
    expect(await post(preview)).toBe(200); expect(await post({ ...preview, graphSummary: { ...preview.graphSummary, execute: 'anything' } })).toBe(400);
  });
});
