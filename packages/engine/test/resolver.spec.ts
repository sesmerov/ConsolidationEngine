import { describe, expect, it } from 'vitest';
import { resolveSelection } from '../src/resolver/coordinates.js';
import { expandRuleInstances } from '../src/resolver/instances.js';
import { context, coordinate, fact, G113, operand, report, rule, scope, selection, twoSheetReport } from './helpers/report-fixture.js';

describe('closed coordinate resolution and scope', () => {
  it('inherits table, column and sheet for a partial reference in the same table', () => {
    const expected = coordinate({ table: 'T', row: '0020', column: '0060', sheet: '01' });
    const decoy = coordinate({ table: 'T', row: '0020', column: '0070', sheet: '01' });
    const result = resolveSelection(selection('{r0020}'), scope('{tT,r0010,c0060,s01,default:0,interval:true}'), report([decoy, expected]), { contextId: 'demo' });
    expect(result.diagnostics).toEqual([]); expect(result.coordinates.map(cell => cell.factKey)).toEqual([expected.factKey]);
  });
  it('also inherits coordinates when the local reference repeats the same table', () => {
    const expected = coordinate({ table: 'T', row: '0020', column: '0060', sheet: '01' });
    const result = resolveSelection(selection('{tT,r0020}'), scope('{tT,c0060,s01}'), report([expected]), { contextId: 'demo' });
    expect(result.coordinates).toEqual([expected]); expect(result.diagnostics).toEqual([]);
  });
  it('allows local axis overrides without changing other inherited axes', () => {
    const expected = coordinate({ table: 'T', row: '0020', column: '0070', sheet: '02' });
    const result = resolveSelection(selection('{r0020,c0070,s02}'), scope('{tT,r0010,c0060,s01}'), report([expected]), { contextId: 'demo' });
    expect(result.coordinates).toEqual([expected]); expect(result.diagnostics).toEqual([]);
  });
  it('drops all three inherited axes when the selected table changes', () => {
    const a = coordinate({ table: 'A', row: '0010', column: '0060', sheet: '01' });
    const b1 = coordinate({ table: 'B', row: '0020', column: '0070' });
    const b2 = coordinate({ table: 'B', row: '0030', column: '0080' });
    const result = resolveSelection(selection('{tB}'), scope('{tA,r0010,c0060,s01}'), report([a, b2, b1]), { contextId: 'demo' });
    expect(result.diagnostics).toEqual([]); expect(new Set(result.coordinates.map(cell => cell.factKey))).toEqual(new Set([b1.factKey, b2.factKey]));
  });
  it('uses inclusive ordinal ranges over existing codes, including gaps and letters', () => {
    const cells = ['B2', '0010', 'A', '2', '10', 'Z'].map(row => coordinate({ row }));
    const result = resolveSelection(selection('{tT,r10-B2,c0010}'), undefined, report(cells), { contextId: 'demo' });
    expect(result.diagnostics).toEqual([]); expect(result.coordinates.map(cell => cell.rowCode)).toEqual(['10', '2', 'A', 'B2']);
  });
  it('preserves leading zeroes and letter case in exact keys', () => {
    const cells = ['0010', '10', 'A', 'a'].map(row => coordinate({ row }));
    expect(resolveSelection(selection('{tT,r0010,c0010}'), undefined, report(cells), { contextId: 'demo' }).coordinates).toEqual([cells[0]]);
    expect(resolveSelection(selection('{tT,rA,c0010}'), undefined, report(cells), { contextId: 'demo' }).coordinates).toEqual([cells[2]]);
  });
  it('expands finite lists without constructing missing integers or a Cartesian catalog', () => {
    const cells = [coordinate({ row: '0010', column: '0010' }), coordinate({ row: '0030', column: '0030' })];
    const result = resolveSelection(selection('{tT,(r0010,r0030),(c0010,c0030)}'), undefined, report(cells), { contextId: 'demo' });
    expect(result.diagnostics).toEqual([]); expect(result.coordinates).toHaveLength(2);
    expect(new Set(result.coordinates.map(cell => cell.factKey))).toEqual(new Set(cells.map(cell => cell.factKey)));
  });
  it('returns an empty finite range in a known table, but no synthetic null coordinate', () => {
    const result = resolveSelection(selection('{tT,r0070-0080,c0010}'), undefined, report([coordinate()]), { contextId: 'demo' });
    expect(result.coordinates).toEqual([]); expect(result.diagnostics).toEqual([]);
  });
  it.each(['{tT,r0070,c0010}', '{tABSENT,r0070-0080,c0010}'])('diagnoses a missing single coordinate or table: %s', text => {
    const result = resolveSelection(selection(text), undefined, report([coordinate()]), { contextId: 'demo' });
    expect(result.coordinates).toEqual([]); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COORDINATE' }));
  });
  it('rejects ambiguous module matches regardless of input context order', () => {
    const first = context({ contextId: 'a', moduleVersion: 'MODULE_A' });
    const second = context({ contextId: 'b', moduleVersion: 'MODULE_B' });
    const cells = [coordinate({ context: first }), coordinate({ context: second })];
    for (const contexts of [[first, second], [second, first]]) {
      const result = resolveSelection(selection('{tT,r0010,c0010}'), undefined, report(cells, [], contexts), { contextIds: ['a', 'b'] });
      expect(result.coordinates).toEqual([]); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'AMBIGUOUS_REFERENCE' }));
    }
  });
  it('resolves an explicitly selected context without taking a neighboring module', () => {
    const first = context({ contextId: 'a', moduleVersion: 'MODULE_A' });
    const second = context({ contextId: 'b', moduleVersion: 'MODULE_B' });
    const a = coordinate({ context: first }); const b = coordinate({ context: second });
    const result = resolveSelection(selection('{tT,r0010,c0010}'), undefined, report([a, b], [], [first, second]), { contextId: 'b' });
    expect(result.coordinates).toEqual([b]); expect(result.diagnostics).toEqual([]);
  });
  it('does not choose the first element when a scalar expression resolves to several cells', async () => {
    const { evaluate } = await import('../src/evaluator/evaluate.js');
    const cells = [coordinate({ row: '0010' }), coordinate({ row: '0020' })];
    const result = evaluate(rule('{tT,r0010-0020,c0010} = 1'), { report: report(cells, cells.map(cell => fact(cell, '1'))), binding: { contextId: 'demo' } });
    expect(result.value).toBeUndefined(); expect(result.diagnostics.length).toBeGreaterThan(0);
  });
});

describe('finite rule instances', () => {
  it('binds G113 to exactly the two catalog sheets in ordinal order', () => {
    const result = expandRuleInstances(rule(G113), twoSheetReport(), { contextId: 'demo', ruleKey: 'effective-G113' });
    expect(result.diagnostics).toEqual([]); expect(result.instances.map(instance => instance.binding.sheetCode)).toEqual(['0001', '0002']);
    expect(new Set(result.instances.map(instance => instance.instanceId)).size).toBe(2);
  });
  it('evaluates the two G113 instances independently using their complete binding', async () => {
    const { evaluate } = await import('../src/evaluator/evaluate.js');
    const input = twoSheetReport(); const ast = rule(G113);
    const result = expandRuleInstances(ast, input, { contextId: 'demo', ruleKey: 'effective-G113' });
    for (const instance of result.instances) {
      const value = evaluate(ast, { report: input, binding: instance.binding });
      expect(value.value).toMatchObject({ kind: 'boolean', value: true }); expect(value.readKeys).toHaveLength(3);
    }
  });
  it('does not couple another sheet when one total fails', async () => {
    const { evaluate } = await import('../src/evaluator/evaluate.js');
    const input = twoSheetReport(); const bad = input.coordinates.find(cell => cell.sheetCode === '0002' && cell.rowCode === '0011')!;
    const changed = { ...input, facts: input.facts.map(value => value.factKey === bad.factKey ? fact(bad, '11') : value) };
    const ast = rule(G113); const expanded = expandRuleInstances(ast, changed, { contextId: 'demo', ruleKey: 'effective-G113' });
    const values = expanded.instances.map(instance => evaluate(ast, { report: changed, binding: instance.binding }).value);
    expect(values).toMatchObject([{ kind: 'boolean', value: true }, { kind: 'boolean', value: false }]);
  });
  it('keeps instance IDs and bindings stable when source rows and input order change', () => {
    const input = twoSheetReport(); const ast = rule(G113);
    const permuted = { ...input, contexts: [...input.contexts].reverse(),
      coordinates: [...input.coordinates].reverse().map((cell, i) => ({ ...cell, sourceLocator: { ...cell.sourceLocator, row: i + 20 } })),
      facts: [...input.facts].reverse().map((value, i) => ({ ...value, sourceLocator: { ...value.sourceLocator, row: i + 40 } })) };
    const identify = (value: typeof input) => expandRuleInstances(ast, value, { contextId: 'demo', ruleKey: 'effective-G113' }).instances
      .map(instance => ({ instanceId: instance.instanceId, binding: instance.binding }));
    expect(identify(permuted)).toEqual(identify(input));
  });
  it('includes effective rule content identity in instance IDs', () => {
    const input = twoSheetReport(); const ast = rule(G113);
    const first = expandRuleInstances(ast, input, { contextId: 'demo', ruleKey: 'content-one' }).instances;
    const second = expandRuleInstances(ast, input, { contextId: 'demo', ruleKey: 'content-two' }).instances;
    expect(first.map(instance => instance.instanceId)).not.toEqual(second.map(instance => instance.instanceId));
  });
  it('keeps diagnostics when s* has no sheet binding, so validation cannot silently lose the rule', () => {
    const ast = rule('with {tT,s*,c0010}: {r0010}=0');
    const result = expandRuleInstances(ast, report([coordinate()]), { contextId: 'demo', ruleKey: 'empty-binding' });
    expect(result.instances).toEqual([]); expect(result.diagnostics.length).toBeGreaterThan(0);
  });
  it('preserves interval/default options across a different table and honors local overrides', async () => {
    const { evaluate } = await import('../src/evaluator/evaluate.js');
    const cell = coordinate({ table: 'B', row: '0020', column: '0070', unit: 'EUR', decimals: '2' });
    const sourceCell = coordinate({ table: 'A', row: '0010', column: '0060', sheet: '01' });
    const input = report([sourceCell, cell]);
    const inherited = evaluate(rule('with {tA,r0010,c0060,s01,default:0,interval:true}: {tB,r0020,c0070}=0'), { report: input, binding: { contextId: 'demo' } });
    expect(inherited.value).toMatchObject({ kind: 'boolean', value: true });
    const overridden = evaluate(rule('with {tA,default:0}: isnull({tB,r0020,c0070,default:null})'), { report: input, binding: { contextId: 'demo' } });
    expect(overridden.value).toMatchObject({ kind: 'boolean', value: true });
    const point = evaluate(operand('{tB,r0020,c0070,interval:false}'), { report: report([cell], [fact(cell, '10')]), binding: { contextId: 'demo' }, scope: scope('{tA,interval:true}') });
    expect(point.value).toMatchObject({ kind: 'number', nominal: { n: 10n, d: 1n }, lo: { n: 10n, d: 1n }, hi: { n: 10n, d: 1n } });
  });
});
