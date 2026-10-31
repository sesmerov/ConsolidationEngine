import { describe, expect, it } from 'vitest';
import type { ImportedReport, RawRuleRecord, RuleVariant, Snapshot } from '@ce/contracts';
import { runValidation } from '../src/validation/run.js';
import { parseRule } from '../src/parser/parse-rule.js';
import { context, coordinate, fact, G113, report, twoSheetReport } from './helpers/report-fixture.js';
const PROFILE = 'ce-dpmxl-0.9-closed-v1';
const OPTIONS = { runId: 'run-a', startedAt: '2026-10-31T00:00:00.000Z', now: () => 0 };
function variant(code: string, expression = 'true', overrides: Partial<RuleVariant> = {}): RuleVariant {
  return { variantId: code, code, framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: ['T'], expression,
    active: true, referenceWindow: {}, severityOriginal: 'Warning', severity: 'warning', sourceRecords: [code + '-row'], sourceLocators: [{ sheet: 'Sheet1', row: 2 }], ...overrides };
}
function snapshot(variants: readonly RuleVariant[], input: ImportedReport = report([]), extraRows: readonly RawRuleRecord[] = []): Snapshot {
  const records = variants.flatMap(item => item.sourceRecords.map((id, index) => ({ id, code: item.code, variantId: item.variantId, sourceLocator: item.sourceLocators[index] ?? {}, originalFields: {}, diagnostics: [] })));
  const analyses = variants.map(item => { const parsed = parseRule(item.expression); return { variantId: item.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId: PROFILE, ...parsed }; });
  return { versionId: 'snapshot-a', contentHash: 'snapshot-hash', createdAt: OPTIONS.startedAt, content: { catalogVersion: 'catalog', reportVersion: 'report', configVersion: 'config', profileId: PROFILE,
    contexts: input.contexts, coordinates: input.coordinates, facts: input.facts, directions: [], sources: [],
    catalog: { records: [...records, ...extraRows], variants, analyses, coverage: { rows: records.length + extraRows.length, variants: variants.length, applicableVariants: variants.length, supportedVariants: analyses.length, invalidRows: extraRows.length, duplicateRows: variants.reduce((n, item) => n + item.sourceRecords.length - 1, 0), conflictingVariants: 0 } } } };
}
function g169(right: string) {
  const ctx = context({ filingIndicators: { 'C_01.00': true, 'C_05.01': true } });
  const a = coordinate({ context: ctx, table: 'C_01.00', row: '0230', column: '0010', unit: 'EUR', decimals: '2' });
  const b = coordinate({ context: ctx, table: 'C_05.01', row: '0090', column: '0060', unit: 'EUR', decimals: '2' });
  return snapshot([variant('v0190_m', 'with {default: 0, interval: true}: {tC_01.00, r0230, c0010} = {tC_05.01, r0090, c0060}', {
    tables: ['C_01.00', 'C_05.01'], precondition: '{v_C_01.00} and {v_C_05.01}' })], report([a, b], [fact(a, '10'), fact(b, right)], [ctx]));
}
describe('pure versioned validation runs', () => {
  it.each([['10.01', 'pass'], ['10.02', 'fail']] as const)('G169 interval boundary %s is %s with exact operands and metadata', (right, status) => {
    const input = g169(right); const before = JSON.stringify(input); const output = runValidation(input, OPTIONS); const result = output.results[0]!;
    expect(output.run.status).toBe('completed'); expect(output.run.summary.instances).toBe(1); expect(result.status).toBe(status);
    expect(result.values.left).toMatchObject({ nominal: { numerator: '10', denominator: '1' }, interval: { lo: { numerator: '1999', denominator: '200' }, hi: { numerator: '2001', denominator: '200' } }, unit: 'EUR' });
    expect(result.metadataReads).toHaveLength(2); expect(result.sources).toContainEqual(expect.objectContaining({ sheet: 'Facts', row: 2, column: 'G' }));
    expect(result.expression).toContain('interval: true'); expect(result.precondition).toBe('{v_C_01.00} and {v_C_05.01}');
    expect(JSON.stringify(output)).not.toContain('"ast"'); expect(JSON.stringify(input)).toBe(before);
  });
  it('G113 yields two real independent sheet instances, not two copies of coverage', () => {
    const input = snapshot([variant('G113', G113, { modules: ['COREP_OF_4.0'], precondition: '{v_C_18.00}', tables: ['C_18.00'] })], twoSheetReport());
    const output = runValidation(input, OPTIONS); expect(output.results.map(result => result.status)).toEqual(['pass', 'pass']);
    expect(output.run.summary.instances).toBe(2); expect(new Set(output.results.map(result => result.instanceId)).size).toBe(2);
    expect(output.results.every(result => !result.coverageOnly && result.readKeys.length === 3)).toBe(true);
  });
  it.each(['1/0=1', '1=1 @', 'abs(1)=1'])('a false precondition prevents body %s from being executed or overriding applicability', expression => {
    const result = runValidation(snapshot([variant('false-precondition', expression, { precondition: 'false' })]), OPTIONS).results[0]!;
    expect(result.status).toBe('not_applicable'); expect(result.readKeys).toEqual([]); expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
    expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'SYNTAX_ERROR' }));
  });
  it('applies inactivity and inclusive contextual windows before invalid body syntax', () => {
    const variants = [variant('inactive', '1=1 @', { active: false }), variant('past', '1=1 @', { referenceWindow: { to: '2026-06-29' } }),
      variant('future', '1=1 @', { referenceWindow: { from: '2026-07-01' } }), variant('boundary', 'true', { referenceWindow: { from: '2026-06-30', to: '2026-06-30' } })];
    const output = runValidation(snapshot(variants), OPTIONS); expect(output.results.find(result => result.code === 'boundary')!.status).toBe('pass');
    expect(output.results.filter(result => result.code !== 'boundary').every(result => result.status === 'not_applicable' && result.coverageOnly)).toBe(true);
  });
  it('does not invent a required submission date', () => {
    const { submissionDate: _submission, ...ctx } = context();
    const result = runValidation(snapshot([variant('submission', 'true', { submissionFrom: '2026-01-01' })], report([], [], [ctx])), OPTIONS).results[0]!;
    expect(result.status).toBe('not_evaluable'); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_SUBMISSION_DATE' }));
  });
  it.each([['{v_MISSING}', 'not_evaluable'], ['false and {v_MISSING}', 'not_applicable'], ['true or {v_MISSING}', 'pass']] as const)('evaluates precondition %s as %s without losing missing metadata', (precondition, status) => {
    const result = runValidation(snapshot([variant('metadata', 'true', { precondition })]), OPTIONS).results[0]!;
    expect(result.status).toBe(status); expect(result.metadataReads).toContainEqual(expect.objectContaining({ code: 'MISSING', presence: 'missing' }));
    expect(result.diagnostics.some(item => item.code === 'MISSING_FILING_INDICATOR')).toBe(status === 'not_evaluable');
  });
  it('keeps division errors, unsupported and syntax-invalid rows visible while completing the job', () => {
    const output = runValidation(snapshot([variant('arithmetic', '1/0=1'), variant('syntax', '1=1 @'), variant('unsupported', 'abs(1)=1')]), OPTIONS);
    expect(output.run.status).toBe('completed'); expect(output.results.find(result => result.code === 'arithmetic')!.diagnostics).toContainEqual(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
    expect(output.results.find(result => result.code === 'syntax')).toMatchObject({ status: 'error', coverageOnly: true });
    expect(output.results.find(result => result.code === 'unsupported')).toMatchObject({ status: 'not_evaluable', coverageOnly: true });
    expect(output.run.summary.instances).toBe(1);
  });
  it('counts only real instances and reconciles invalid, duplicate and empty-expansion coverage', () => {
    const duplicate = variant('ok', 'true', { sourceRecords: ['row-a', 'row-b'], sourceLocators: [{ row: 3 }, { row: 4 }] });
    const invalid: RawRuleRecord = { id: 'invalid-row', code: '', sourceLocator: { row: 9 }, originalFields: {}, diagnostics: [{ code: 'INVALID_RULE_METADATA', message: 'bad row', severity: 'error' }] };
    const input = snapshot([duplicate, variant('empty', 'with {tT,s*,c0010}: {r0010}=0')], report([coordinate()]), [invalid]);
    const output = runValidation(input, OPTIONS); expect(output.run.summary).toMatchObject({ rows: 4, variants: 2, duplicateRows: 1, instances: 1, complete: true });
    expect(output.results).toHaveLength(3); expect(Object.values(output.run.summary.byStatus).reduce((a, b) => a + b, 0)).toBe(3);
    const empty = output.results.find(result => result.code === 'empty')!; expect(empty.coverageOnly).toBe(true); expect(empty.instanceId).toBeUndefined(); expect(empty.binding).toBeUndefined();
  });
  it('coalesces equal effective content across overlapping variant windows but keeps all provenance', () => {
    const a = variant('same', 'true', { variantId: 'a', sourceRecords: ['a'] }); const b = variant('same', 'true', { variantId: 'b', sourceRecords: ['b'], referenceWindow: { from: '2026-01-01' } });
    const output = runValidation(snapshot([a, b]), OPTIONS); expect(output.results).toHaveLength(1); expect(output.results[0]!.variantIds).toEqual(['a', 'b']);
    expect(output.run.summary).toMatchObject({ rows: 2, variants: 2, applicableVariants: 2, instances: 1 });
  });
  it('diagnoses incompatible active variants without a first-match execution', () => {
    const a = variant('same', 'true', { variantId: 'a' }); const b = variant('same', 'false', { variantId: 'b' });
    for (const variants of [[a, b], [b, a]]) { const output = runValidation(snapshot(variants), OPTIONS);
      expect(output.run.summary.instances).toBe(0); expect(output.results.every(result => result.status === 'not_evaluable' && result.coverageOnly)).toBe(true);
      expect(output.results.flatMap(result => result.diagnostics)).toContainEqual(expect.objectContaining({ code: 'CONFLICTING_VARIANTS' })); }
  });
  it('preserves instance/result identity under row permutation and scopes results to run ID', () => {
    const input = g169('10.01'); const permuted = { ...input, content: { ...input.content, coordinates: [...input.content.coordinates].reverse(), facts: [...input.content.facts].reverse(), catalog: { ...input.content.catalog, records: [...input.content.catalog.records].reverse() } } };
    const first = runValidation(input, OPTIONS).results[0]!, second = runValidation(permuted, OPTIONS).results[0]!, otherRun = runValidation(input, { ...OPTIONS, runId: 'run-b' }).results[0]!;
    expect(first.id).toBe(second.id); expect(first.instanceId).toBe(second.instanceId); expect(otherRun.instanceId).toBe(first.instanceId); expect(otherRun.id).not.toBe(first.id);
  });
  it.each([{ limits: { reads: 1 } }, { limits: { instances: 0 } }, { cancelled: () => true }, { limits: { milliseconds: 0 } }])('makes work termination incomplete, never an ordinary rule error: %j', override => {
    const output = runValidation(g169('10.01'), { ...OPTIONS, ...override }); expect(output.run.status).toBe('incomplete'); expect(output.run.summary.complete).toBe(false);
    expect(output.run.diagnostics.some(item => ['RESOURCE_LIMIT', 'CANCELLED', 'DEADLINE_EXCEEDED'].includes(item.code))).toBe(true);
    expect(output.results).toEqual([]); expect(output.run.summary.instances).toBe(0);
  });
  it('keeps explicit null operands available in the public non-evaluable result', () => {
    const cell = coordinate(); const output = runValidation(snapshot([variant('null', '{tT,r0010,c0010}=1')], report([cell], [fact(cell, null)])), OPTIONS);
    expect(output.results[0]).toMatchObject({ status: 'not_evaluable', values: { left: { kind: 'null', presence: 'explicit_null', coordinate: { factKey: cell.factKey } } } });
  });
  it('uses only declared compatible modules for cross-module reads and never merges filing maps', () => {
    const a = context({ contextId: 'a', moduleVersion: 'A', filingIndicators: { READY: true } }), b = context({ contextId: 'b', moduleVersion: 'B', filingIndicators: { READY: false } });
    const cellA = coordinate({ context: a, table: 'A' }), cellB = coordinate({ context: b, table: 'B' });
    const v = variant('cross', '{tA,r0010,c0010}={tB,r0010,c0010}', { modules: ['A', 'B'], crossModule: true, precondition: '{v_READY}', tables: ['A', 'B'] });
    const run = (contexts: typeof a[]) => runValidation(snapshot([v], report([cellA, cellB], [fact(cellA, '1'), fact(cellB, '1')], contexts)), OPTIONS);
    const first = run([a, b]), second = run([b, a]); expect(first.results.map(result => [result.id, result.status])).toEqual(second.results.map(result => [result.id, result.status]));
    expect(first.results.find(result => result.contextId === 'a')!.status).toBe('pass'); expect(first.results.find(result => result.contextId === 'b')!.status).toBe('not_applicable');
    expect(first.results.find(result => result.contextId === 'a')!.metadataReads).toEqual([expect.objectContaining({ contextId: 'a', code: 'READY', value: true })]);
  });
  it('rejects a table present in two compatible modules instead of selecting the first', () => {
    const a = context({ contextId: 'a', moduleVersion: 'A' }), b = context({ contextId: 'b', moduleVersion: 'B' });
    const cells = [coordinate({ context: a }), coordinate({ context: b })];
    const input = snapshot([variant('ambiguous', '{tT,r0010,c0010}=1', { modules: ['A', 'B'], crossModule: true })], report(cells, cells.map(cell => fact(cell, '1')), [a, b]));
    const output = runValidation(input, OPTIONS); expect(output.results).toHaveLength(2);
    expect(output.results.every(result => result.status === 'error' && result.diagnostics.some(item => item.code === 'AMBIGUOUS_REFERENCE'))).toBe(true);
  });
  it('preserves semantic IDs when only context aliases change', () => {
    const input = g169('10.01'); const renamed = { ...input, content: { ...input.content, contexts: input.content.contexts.map(ctx => ({ ...ctx, contextId: 'renamed' })),
      coordinates: input.content.coordinates.map(cell => ({ ...cell, contextId: 'renamed' })), facts: input.content.facts.map(value => ({ ...value, contextId: 'renamed' })) } };
    const before = runValidation(input, OPTIONS).results[0]!, after = runValidation(renamed, OPTIONS).results[0]!;
    expect(after.instanceId).toBe(before.instanceId); expect(after.id).toBe(before.id); expect(after.contextId).toBe('renamed');
  });
  it('includes the compatible logical-context set in the semantic instance identity', () => {
    const a = context({ contextId: 'a', moduleVersion: 'A' }), b = context({ contextId: 'b', moduleVersion: 'B' }), c = context({ contextId: 'c', moduleVersion: 'C' });
    const first = runValidation(snapshot([variant('compatible', 'true', { modules: ['A', 'B'], crossModule: true })], report([], [], [a, b, c])), OPTIONS);
    const second = runValidation(snapshot([variant('compatible', 'true', { modules: ['A', 'C'], crossModule: true })], report([], [], [a, b, c])), OPTIONS);
    expect(first.results.find(result => result.contextId === 'a')!.instanceId).not.toBe(second.results.find(result => result.contextId === 'a')!.instanceId);
  });
  it('uses compatible alias fragments without treating them as different modules', () => {
    const a = context({ contextId: 'a' }), b = context({ contextId: 'b' });
    const cell = coordinate({ context: b }); const output = runValidation(snapshot([variant('alias-fragment', '{tT,r0010,c0010}=1')], report([cell], [fact(cell, '1')], [a, b])), OPTIONS);
    expect(output.results).toHaveLength(1); expect(output.results[0]!.status).toBe('pass');
  });
  it('retains completed partial results but never calls their summary complete after a later quota', () => {
    const output = runValidation(snapshot([variant('first'), variant('second')]), { ...OPTIONS, limits: { instances: 1 } });
    expect(output.run.status).toBe('incomplete'); expect(output.run.summary.complete).toBe(false); expect(output.results).toHaveLength(1);
    expect(output.run.summary.instances).toBe(1); expect(output.run.summary.byStatus.pass).toBe(1);
  });
  it('does not execute a snapshot from another language profile', () => {
    const input = snapshot([variant('profile')]); const output = runValidation({ ...input, content: { ...input.content, profileId: 'other-profile' } }, OPTIONS);
    expect(output.run.status).toBe('incomplete'); expect(output.results).toEqual([]); expect(output.run.diagnostics).toContainEqual(expect.objectContaining({ code: 'PROFILE_MISMATCH' }));
  });
  it('explains every original input of B+C separately from the derived right operand', () => {
    const input = snapshot([variant('G113', G113, { modules: ['COREP_OF_4.0'], tables: ['C_18.00'] })], twoSheetReport());
    const output = runValidation(input, OPTIONS);
    for (const result of output.results) {
      expect(result.values.right).toMatchObject({ nominal: { numerator: '12', denominator: '1' } });
      expect(result.factReads.map(read => read.factKey)).toEqual(result.readKeys);
      expect(result.factReads).toHaveLength(3);
      expect(result.factReads.find(read => read.coordinate.rowCode === '0020')).toMatchObject({ presence: 'value', originalText: '5', normalizedValue: { numerator: '5', denominator: '1' },
        coordinate: { sheetCode: result.binding!.sheetCode, decimals: '2', unit: 'EUR', sourceLocator: { sheet: 'Coordinates' } }, sourceLocator: { sheet: 'Facts', column: 'G' } });
      expect(result.factReads.find(read => read.coordinate.rowCode === '0210')).toMatchObject({ presence: 'value', normalizedValue: { numerator: '7', denominator: '1' } });
    }
    expect(JSON.stringify(output)).not.toMatch(/"ast"|"n":|"d":/);
  });
  it('preserves explicit and implicit absence in factReads even when default supplies effective zeroes', () => {
    const total = coordinate({ row: '0010', sourceRow: 11 }), explicit = coordinate({ row: '0020', sourceRow: 12 }), implicit = coordinate({ row: '0030', sourceRow: 13 });
    const input = snapshot([variant('null-inputs', 'with {tT,c0010,default:0}: {r0010}={r0020}+{r0030}')], report([implicit, total, explicit], [fact(explicit, null, 22), fact(total, '0', 21)]));
    const result = runValidation(input, OPTIONS).results[0]!;
    expect(result.status).toBe('pass'); expect(result.values.right).toMatchObject({ nominal: { numerator: '0', denominator: '1' } });
    expect(result.factReads.find(read => read.factKey === explicit.factKey)).toMatchObject({ presence: 'explicit_null', coordinate: explicit, sourceLocator: { sheet: 'Facts', row: 22 } });
    expect(result.factReads.find(read => read.factKey === implicit.factKey)).toMatchObject({ presence: 'implicit_null', coordinate: implicit, sourceLocator: { sheet: 'Coordinates', row: 13 } });
    expect(result.factReads.filter(read => read.presence !== 'value').every(read => read.normalizedValue === undefined)).toBe(true);
  });
  it.each([[false, 'not_applicable'], [null, 'not_evaluable']] as const)('keeps a structural equality instance when a factual precondition changes from %s to true', (initial, status) => {
    const condition = coordinate({ row: '0090', dataType: 'boolean' }), left = coordinate({ row: '0010' }), right = coordinate({ row: '0020' });
    const v = variant('conditional-equality', '{tT,r0010,c0010}={tT,r0020,c0010}', { precondition: '{tT,r0090,c0010}' });
    const before = runValidation(snapshot([v], report([condition, left, right], [fact(condition, initial), fact(left, '1'), fact(right, '1')])), OPTIONS).results[0]!;
    const after = runValidation(snapshot([v], report([condition, left, right], [fact(condition, true), fact(left, '1'), fact(right, '1')])), OPTIONS).results[0]!;
    expect(before).toMatchObject({ status, coverageOnly: false, binding: { contextId: 'demo' } });
    expect(before.instanceId).toBeDefined(); expect(before.instanceId).toBe(after.instanceId); expect(after.status).toBe('pass');
    expect(before.readKeys).toEqual([condition.factKey]); expect(before.factReads).toHaveLength(1);
  });
  it('retains structural instances for unknown preconditions without executing a dangerous body', () => {
    const result = runValidation(snapshot([variant('unknown-before-body', '1/0=1', { precondition: '{v_MISSING}' })]), OPTIONS).results[0]!;
    expect(result).toMatchObject({ status: 'not_evaluable', coverageOnly: false }); expect(result.instanceId).toBeDefined();
    expect(result.factReads).toEqual([]); expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
  });
});
