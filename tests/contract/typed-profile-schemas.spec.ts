import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import * as contracts from '@ce/contracts';
import type { Diagnostic, SnapshotContent } from '@ce/contracts';
import { canonicalHash, canonicalStateBytes } from '../../apps/api/src/session/canonical-state.js';
import { WorkspaceStore } from '../../apps/api/src/session/workspace-store.js';
import { content } from '../helpers/foundation.js';

const V1 = 'ce-dpmxl-0.9-closed-v1', V2 = 'ce-dpmxl-0.9-closed-v2';
const id = '00000000-0000-4000-8000-000000000001', hash = 'a'.repeat(64);
const identity = { factKey: 'typed-cell', contextId: 'demo', tableCode: 'DEMO_TYPES', sheetCode: '', rowCode: '0010', columnCode: '0010' };
const textCoordinate = { ...identity, dataType: 'text', unit: '', decimals: '', axes: {}, sourceLocator: { fileId: id, sheet: 'Datos', row: 4, column: 'B' } };
const textFact = { ...identity, presence: 'value', originalText: '', normalizedValue: { kind: 'text', value: '' }, sourceLocator: textCoordinate.sourceLocator };
const binding = { sourceFileId: id, contextIds: ['demo'], profileId: 'eba-corep-of-4.0-ca1-v1', mappingSha256: hash, selectedSheets: ['CA1'], excludedSheets: ['CA2'], scaleExponent: 3, displayDecimals: 2, contextOrigin: 'form' };

async function validator(schema: object, check: (post: (body: unknown) => Promise<number>) => Promise<void>): Promise<void> {
  const app = Fastify({ ajv: { customOptions: { removeAdditional: false, coerceTypes: false } } });
  app.post('/', { schema: { body: schema } }, async () => ({ valid: true }));
  try { await check(async payload => (await app.inject({ method: 'POST', url: '/', payload })).statusCode); } finally { await app.close(); }
}
function newSchema(name: string): object { const schema: unknown = Reflect.get(contracts, name); expect(schema).toBeTypeOf('object'); return schema as object; }
function profileIssues(value: SnapshotContent, check?: () => void): readonly Diagnostic[] {
  const validate = Reflect.get(contracts, 'validateProfileValues') as (input: SnapshotContent, options?: { check?: () => void }) => readonly Diagnostic[];
  expect(validate).toBeTypeOf('function'); return validate(value, check ? { check } : {});
}
function typedContent(profileId = V2): SnapshotContent {
  return { ...content(), profileId, coordinates: [textCoordinate], facts: [textFact] } as unknown as SnapshotContent;
}

describe('typed report DTOs preserve explicit types and absence', () => {
  it('accepts typed coordinates and requires empty unit and precision for text/date', async () => {
    await validator(contracts.coordinateSchema, async post => {
      expect(await post(textCoordinate)).toBe(200);
      expect(await post({ ...textCoordinate, dataType: 'date' })).toBe(200);
      expect(await post({ ...textCoordinate, unit: 'EUR' })).toBe(400);
      expect(await post({ ...textCoordinate, decimals: '2' })).toBe(400);
      expect(await post({ ...textCoordinate, dataType: 'string' })).toBe(400);
      expect(await post({ ...textCoordinate, mapping: {} })).toBe(400);
    });
  });
  it('accepts an empty reported text, but never a normalized value on null', async () => {
    await validator(contracts.reportedFactSchema, async post => {
      expect(await post(textFact)).toBe(200);
      const { normalizedValue: _value, originalText: _text, ...empty } = textFact;
      expect(await post({ ...empty, presence: 'null' })).toBe(200);
      expect(await post({ ...textFact, presence: 'null' })).toBe(400);
      expect(await post({ ...empty, presence: 'value' })).toBe(400);
      expect(await post({ ...textFact, normalizedValue: '' })).toBe(400);
      expect(await post({ ...textFact, normalizedValue: { kind: 'text', value: 'x'.repeat(32_768) } })).toBe(400);
      expect(await post({ ...textFact, normalizedValue: { kind: 'text', value: 'Banco', expression: '1=1' } })).toBe(400);
    });
  });
  it('rejects a numeric value on explicit null even in the original numeric DTO', async () => {
    await validator(contracts.reportedFactSchema, async post => {
      expect(await post({ ...textFact, presence: 'null', normalizedValue: { numerator: '0', denominator: '1' } })).toBe(400);
    });
  });
  it('accepts only valid v2 civil dates in typed normalized values and leaves administrative v1 unchanged', async () => {
    await validator(contracts.reportedFactSchema, async post => {
      for (const value of ['0001-01-01', '2024-02-29', '9999-12-31']) expect(await post({ ...textFact, normalizedValue: { kind: 'date', value } })).toBe(200);
      for (const value of ['0000-01-01', '2025-02-29', '2024-04-31', '2024-01-00', '2024-13-01', '2024-02-29T00:00:00Z']) expect(await post({ ...textFact, normalizedValue: { kind: 'date', value } })).toBe(400);
    });
    expect(contracts.isCivilDate('0000-01-01')).toBe(true);
  });
  it('projects typed effective operands independently from original fact reads', async () => {
    await validator(contracts.validationValueSchema, async post => {
      expect(await post({ kind: 'text', value: 'Banco ', coordinate: textCoordinate })).toBe(200);
      expect(await post({ kind: 'date', value: '2024-02-29' })).toBe(200);
      expect(await post({ kind: 'null', presence: 'derived_null', dataType: 'text' })).toBe(200);
      expect(await post({ kind: 'null', presence: 'explicit_null', dataType: 'date', unit: 'EUR' })).toBe(400);
      expect(await post({ kind: 'text', value: 'Banco', ast: {} })).toBe(400);
    });
    await validator(contracts.factReadSchema, async post => {
      const read = { factKey: identity.factKey, coordinate: textCoordinate, presence: 'value', normalizedValue: textFact.normalizedValue, originalText: '', sourceLocator: textCoordinate.sourceLocator };
      expect(await post(read)).toBe(200);
      expect(await post({ ...read, presence: 'implicit_null' })).toBe(400);
    });
  });
});

describe('trusted profile values and bindings', () => {
  it('rejects all v2 coordinates and facts in v1, including unreferenced and disconnected values', () => {
    expect(profileIssues(typedContent(V1))).toContainEqual(expect.objectContaining({ code: 'PROFILE_MISMATCH' }));
    expect(profileIssues({ ...typedContent(V1), coordinates: [] })).toContainEqual(expect.objectContaining({ code: 'PROFILE_MISMATCH' }));
    expect(profileIssues({ ...typedContent(V1), facts: [] })).toContainEqual(expect.objectContaining({ code: 'PROFILE_MISMATCH' }));
    expect(profileIssues(typedContent())).toEqual([]);
  });
  it('checks type, unit, date, presence and actual values without coercion', () => {
    const base = typedContent();
    expect(profileIssues({ ...base, facts: [{ ...base.facts[0]!, normalizedValue: { numerator: '0', denominator: '1' } }] })).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    expect(profileIssues({ ...base, facts: [{ ...base.facts[0]!, presence: 'null' }] })).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    expect(profileIssues({ ...base, coordinates: [{ ...base.coordinates[0]!, unit: 'EUR' }] })).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    const date = { ...base, coordinates: [{ ...base.coordinates[0]!, dataType: 'date' }], facts: [{ ...base.facts[0]!, normalizedValue: { kind: 'date', value: '2025-02-29' } }] } as unknown as SnapshotContent;
    expect(profileIssues(date)).toContainEqual(expect.objectContaining({ code: 'INVALID_DATE' }));
    let calls = 0; expect(profileIssues(base, () => { calls++; })).toEqual([]); expect(calls).toBeGreaterThanOrEqual(2);
    expect(() => profileIssues(base, () => { throw new Error('cancelled'); })).toThrow('cancelled');
  });
  it('validates closed bindings without client executable mappings or synthetic source locators', async () => {
    await validator(newSchema('reportSourceBindingSchema'), async post => {
      expect(await post(binding)).toBe(200);
      expect(await post({ ...binding, scaleExponent: 2 })).toBe(400);
      expect(await post({ ...binding, displayDecimals: 19 })).toBe(400);
      expect(await post({ ...binding, displayDecimals: '2' })).toBe(400);
      expect(await post({ ...binding, displayDecimals: 'INF' })).toBe(200);
      expect(await post({ ...binding, contextOrigin: 'guess' })).toBe(400);
      expect(await post({ ...binding, contextIds: ['demo', 'demo'] })).toBe(400);
      expect(await post({ ...binding, mapping: { cell: 'E5' } })).toBe(400);
      expect(await post({ ...binding, localPath: 'private.xlsx' })).toBe(400);
    });
    await validator(contracts.directionsRequestSchema, async post => {
      expect(await post({ directions: [], profileId: V1 })).toBe(400);
    });
  });
  it('keeps classification separate from side eligibility in a closed policy schema', async () => {
    await validator(newSchema('recalculationPolicySchema'), async post => {
      expect(await post({ profileId: V2, mode: 'validation_only', reasons: ['CONDITIONAL', 'TEXT', 'DATE'] })).toBe(200);
      expect(await post({ profileId: V1, mode: 'standard', reasons: [] })).toBe(200);
      expect(await post({ profileId: V2, mode: 'undetermined', reasons: [] })).toBe(200);
      for (const reasons of [[], ['TEXT', 'TEXT'], ['DATE', 'TEXT'], ['UNKNOWN']]) expect(await post({ profileId: V2, mode: 'validation_only', reasons })).toBe(400);
      expect(await post({ profileId: V2, mode: 'standard', reasons: ['TEXT'] })).toBe(400);
      expect(await post({ profileId: V2, mode: 'standard', reasons: [], ast: {} })).toBe(400);
    });
  });
});

describe('typed values and bindings retain canonical state guarantees', () => {
  it('hashes actual typed data and binding context while preserving immutable branches across versions', () => {
    const store = new WorkspaceStore(), workspace = store.create('Typed contract test');
    const base = typedContent();
    const bound = { ...base, reportSourceBindings: [binding] } as unknown as SnapshotContent;
    expect(canonicalHash(bound)).not.toBe(canonicalHash(base));
    expect(canonicalHash(bound)).not.toBe(canonicalHash({ ...bound, reportSourceBindings: [{ ...binding, scaleExponent: 0 }] }));
    expect(canonicalHash(bound)).not.toBe(canonicalHash({ ...bound, facts: [{ ...textFact, normalizedValue: { kind: 'text', value: ' ' } }] }));
    const first = store.publish(workspace.id, undefined, bound), bytes = store.bytes;
    const second = store.publish(workspace.id, first.versionId, { ...first.content, configVersion: 'another-configuration' });
    expect(Reflect.get(second.content, 'reportSourceBindings')).toBe(Reflect.get(first.content, 'reportSourceBindings'));
    expect(second.content.facts).toBe(first.content.facts);
    expect(Object.isFrozen(Reflect.get(first.content, 'reportSourceBindings'))).toBe(true);
    expect(store.bytes).toBeGreaterThan(bytes);
    expect(canonicalStateBytes([first, second])).toBeLessThan(canonicalStateBytes([structuredClone(first), structuredClone(second)]));
    expect(first.contentHash).toBe(canonicalHash(bound));
    const legacy = new WorkspaceStore(), legacyWorkspace = legacy.create('Legacy without binding');
    expect(Reflect.get(legacy.publish(legacyWorkspace.id, undefined, content()).content, 'reportSourceBindings')).toBeUndefined();
  });
  it('counts oversized bindings before publication and leaves the prior version unchanged', () => {
    const store = new WorkspaceStore({ maxBytes: 12_000 }), workspace = store.create('Binding quota');
    const first = store.publish(workspace.id, undefined, content()), before = store.bytes;
    const tooLarge = { ...first.content, reportSourceBindings: [{ ...binding, excludedSheets: Array.from({ length: 1000 }, () => randomUUID()) }] } as unknown as SnapshotContent;
    expect(() => store.publish(workspace.id, first.versionId, tooLarge)).toThrowError(expect.objectContaining({ code: 'SESSION_LIMIT' }));
    expect(store.current(workspace.id)).toBe(first); expect(store.bytes).toBe(before);
  });
});

describe('result projection uses a server policy and a closed wire shape', () => {
  async function page(profileId: string, expression: string, exhaustBudget = false) {
    const { registerResults } = await import('../../apps/api/src/routes/results.js');
    const { LocalPublicViews } = await import('../../apps/api/src/local/local-public-views.js');
    const { WorkBudget, WorkLimitError } = await import('@ce/engine');
    const app = Fastify(), store = new WorkspaceStore(), workspace = store.create('Closed results');
    app.decorate('ce', { store,adapters:{publicViews:new LocalPublicViews(store)} });
    const variant = { variantId: hash, code: 'SYNTHETIC', expression, framework: 'COREP', modules: ['COREP_OF_4.0'], crossModule: false,
      tables: [], active: true, referenceWindow: {}, severityOriginal: 'Error', severity: 'error', sourceRecords: [hash], sourceLocators: [] };
    const snapshot = store.publish(workspace.id, undefined, { ...content(), profileId, facts: [], coordinates: [], catalog: {
      ...content().catalog, variants: [variant],
    } } as SnapshotContent);
    const runId = randomUUID(), resultId = 'b'.repeat(64);
    store.putInternalRecord(`validation:${workspace.id}:${runId}`, {
      run: { id: runId, versionId: snapshot.versionId, profileId, status: 'completed', startedAt: '2026-11-04T00:00:00.000Z',
        summary: { complete: true, rows: 1, variants: 1, applicableVariants: 1, instances: 0, duplicateRows: 0, byStatus: { pass: 1, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0 } },
        resultIds: [resultId], diagnostics: [], privatePath: 'internal-sentinel' },
      results: [{ id: resultId, runId, versionId: snapshot.versionId, profileId, coverageOnly: true, code: 'SYNTHETIC', variantIds: [hash], sourceRecordIds: [hash], tables: [],
        status: 'pass', severity: 'error', severityOriginal: 'Error', expression, values: { result: { kind: 'boolean', value: true, privatePath: 'internal-sentinel' } },
        readKeys: [], factReads: [], metadataReads: [], sources: [{ sheet: 'Datos', privatePath: 'internal-sentinel' }], diagnostics: [], ast: { source: 'internal-sentinel' } }],
    });
    registerResults(app);
    const check = exhaustBudget ? vi.spyOn(WorkBudget.prototype, 'check').mockImplementation(() => { throw new WorkLimitError('RESOURCE_LIMIT', 'Controlled exhausted query budget'); }) : undefined;
    try { return await app.inject({ url: `/api/v1/workspaces/${workspace.id}/runs/${runId}/results` }); }
    finally { check?.mockRestore(); await app.close(); }
  }
  it.each([V1, V2])('projects policy for %s while removing internal fields at every DTO boundary', async profileId => {
    const response = await page(profileId, '1=1'); expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0].recalculation.policy).toEqual({ profileId, mode: 'standard', reasons: [] });
    expect(response.body).not.toContain('internal-sentinel'); expect(response.json().items[0].ast).toBeUndefined();
    expect(response.json().items[0].values.result).toEqual({ kind: 'boolean', value: true });
    expect(response.json().items[0].sources).toEqual([{ sheet: 'Datos' }]);
  });
  it.each([V1, V2])('fails closed for unclassified results in %s', async profileId => {
    for (const [expression, exhausted] of [['abs(1)=1', false], ['1=1', true]] as const) {
      const response = await page(profileId, expression, exhausted); expect(response.statusCode, response.body).toBe(200);
      const recalculation = response.json().items[0].recalculation;
      expect(recalculation.policy).toEqual({ profileId, mode: 'undetermined', reasons: [] });
      for (const side of [recalculation.left, recalculation.right]) { expect(side.eligible).toBe(false); expect(side.target).toBeUndefined(); expect(side.diagnostics.length).toBeGreaterThan(0); }
    }
  });
});
