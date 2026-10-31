import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Coordinate, ImportedReport, Rational, RuleVariant, Snapshot } from '@ce/contracts';
import { parseRule } from '../src/parser/parse-rule.js';
import { rational, rationalToDTO } from '../src/numeric/rational.js';
import { stableId } from '../src/resolver/instances.js';
import { runValidation } from '../src/validation/run.js';
import { evaluateCandidate } from '../src/recalculation/candidate.js';
import { WorkBudget } from '../src/execution/budget.js';
import { context, coordinate, fact, ref, report } from './helpers/report-fixture.js';

let quantizer: typeof import('../src/recalculation/quantize.js');
let simulator: typeof import('../src/recalculation/simulate.js');
interface Cases {
  profileId: string; policyId: string;
  rounding: { id: string; n: string; d: string; decimals: string; text: string; after: Rational }[];
  scenarios: { integerChain: { beforeA: string; beforeD: string; b: string; c: string; afterA: string; afterD: string };
    quantizedChain: { afterA: string; afterD: string; exactA: Rational; exactD: Rational; derivedD: { lo: Rational; hi: Rational } } };
}
const cases = JSON.parse(readFileSync(new URL('../../../tests/fixtures/recalculation-cases.json', import.meta.url), 'utf8')) as Cases;
const startedAt = '2026-10-31T00:00:00.000Z';
const simulationOptions = { previewId: '00000000-0000-4000-8000-000000000047', now: () => 0 };
function variant(code: string, expression: string, overrides: Partial<RuleVariant> = {}): RuleVariant {
  return { variantId: stableId([code, expression, overrides.precondition ?? null]), code, framework: 'COREP', modules: ['COREP_OF_4.2'],
    crossModule: false, tables: ['T'], expression, active: true, referenceWindow: {}, severityOriginal: 'Error', severity: 'error',
    sourceRecords: [code + '-record'], sourceLocators: [{ sheet: 'Rules', row: 2, column: 'G' }], ...overrides };
}
function snapshot(variants: readonly RuleVariant[], input: ImportedReport): Snapshot {
  const records = variants.map(item => ({ id: item.sourceRecords[0]!, code: item.code, variantId: item.variantId,
    sourceLocator: item.sourceLocators[0]!, originalFields: { Expression: item.expression, ...(item.precondition ? { Precondtion: item.precondition } : {}) }, diagnostics: [] }));
  const analyses = variants.map(item => ({ variantId: item.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId: cases.profileId, ...parseRule(item.expression) }));
  return { versionId: '00000000-0000-4000-8000-000000000048', contentHash: 'a'.repeat(64), createdAt: startedAt,
    content: { catalogVersion: 'catalog-47', reportVersion: 'report-47', configVersion: 'config-47', profileId: cases.profileId,
      contexts: input.contexts, coordinates: input.coordinates, facts: input.facts, sources: [], directions: [],
      catalog: { records, variants, analyses, coverage: { rows: records.length, variants: variants.length, applicableVariants: variants.length,
        supportedVariants: analyses.filter(item => item.supportStatus === 'supported').length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } } };
}
interface Choice { code: string; target: Coordinate; side?: 'left' | 'right' }
function configured(base: Snapshot, choices: readonly Choice[]): Snapshot {
  const run = runValidation(base, { runId: 'initial-run', startedAt, now: () => 0 });
  const directions = choices.map(choice => {
    const result = run.results.find(item => item.code === choice.code && item.instanceId && item.binding);
    if (!result?.instanceId || !result.binding) throw new Error('Fixture needs a real structural rule instance: ' + choice.code);
    const targetSide = choice.side ?? 'left';
    return { id: stableId([result.instanceId, targetSide, choice.target.factKey]), instanceId: result.instanceId, variantIds: result.variantIds,
      binding: result.binding, targetSide, targetKey: choice.target.factKey };
  });
  return { ...base, content: { ...base.content, directions: directions as unknown as Snapshot['content']['directions'] } };
}
function frozen<T>(input: T): T {
  if (input && typeof input === 'object') { for (const child of Object.values(input)) frozen(child); Object.freeze(input); }
  return input;
}
function simulate(input: Snapshot) {
  const before = JSON.stringify(input); const result = simulator.simulate(frozen(input), simulationOptions);
  expect(JSON.stringify(input)).toBe(before); return result;
}
function findProposal(result: ReturnType<typeof simulate>, target: Coordinate) {
  const proposal = result.proposals.find(item => item.targetKey === target.factKey); expect(proposal).toBeDefined(); return proposal!;
}
function chain(fractional = false, interval = true) {
  const a = coordinate({ row: '0010', unit: 'EUR', decimals: '2' }), b = coordinate({ row: '0020', unit: 'EUR', decimals: '2' });
  const c = coordinate({ row: '0030', unit: 'EUR', decimals: '2' }), d = coordinate({ row: '0040', unit: 'EUR', decimals: '2' });
  const settings = `with {interval:${interval ? 'true' : 'false'}}: `;
  const aRule = variant('A', settings + ref(a) + ' = ' + (fractional ? '1/3' : ref(b) + ' + ' + ref(c)));
  const dRule = variant('D', settings + ref(d) + ' = ' + ref(a) + ' * ' + (fractional ? '3' : '2'));
  const base = snapshot([dRule, aRule], report([d, c, b, a], [fact(a, cases.scenarios.integerChain.beforeA), fact(d, cases.scenarios.integerChain.beforeD), fact(b, '5'), fact(c, '7')]));
  return { a, b, c, d, base, input: configured(base, [{ code: 'D', target: d }, { code: 'A', target: a }]) };
}

describe('recalculation fixture prerequisites', () => {
  it('uses supported rules and real structural instances, including ineligible destinations', () => {
    const { input } = chain(true);
    expect(input.content.directions).toHaveLength(2);
    expect(input.content.catalog.analyses.every(analysis => analysis.supportStatus === 'supported')).toBe(true);
    const ctx = context({ filingIndicators: { C_INDICATOR: true } });
    const target = coordinate({ context: ctx, row: '0090', dataType: 'boolean' });
    for (const expression of [ref(target) + '=true', ref(target) + '={v_MISSING}', '{v_C_INDICATOR}=false',
      '{tT,r0010,c0010}>1', '{tT,r0010,c0010}+1=2', '{tT,r0010,c0010}={tT,r0010,c0010}+1']) {
      expect(parseRule(expression).supportStatus, expression).toBe('supported');
      const input = snapshot([variant('fixture', expression)], report([target, coordinate({ context: ctx })], [fact(target, false)], [ctx]));
      expect(configured(input, [{ code: 'fixture', target }]).content.directions).toHaveLength(1);
    }
  });
  it('retains a selectable structural instance when its initial precondition is false', () => {
    const a = coordinate({ row: '0010' }), d = coordinate({ row: '0040' });
    const input = snapshot([variant('D', ref(d) + '=' + ref(a) + '+1', { precondition: ref(a) + '>0' })], report([a, d], [fact(a, '0'), fact(d, '9')]));
    const initial = runValidation(input, { runId: 'fixture', startedAt, now: () => 0 }).results.find(result => result.code === 'D');
    expect(initial).toMatchObject({ status: 'not_applicable', coverageOnly: false });
    expect(configured(input, [{ code: 'D', target: d }]).content.directions).toHaveLength(1);
  });
});

describe('quantization to the destination precision', () => {
  beforeAll(async () => { quantizer = await import('../src/recalculation/quantize.js'); });
  it.each(cases.rounding)('$id', (sample) => {
    const result = quantizer.quantize(rational(BigInt(sample.n), BigInt(sample.d)), sample.decimals);
    expect(result).toMatchObject({ text: sample.text, decimals: sample.decimals, policyId: cases.policyId });
    expect(rationalToDTO(result.value)).toEqual(sample.after);
  });
  it.each([[1n, 3n], [-1n, 6n], [2n, 7n]] as const)('rejects a repeating decimal at INF (%s/%s)', (n, d) => {
    expect(() => quantizer.quantize(rational(n, d), 'INF')).toThrowError(expect.objectContaining({ code: 'NON_TERMINATING_DECIMAL' }));
  });
  it('checks ce-report output limits after rounding and for finite INF output', () => {
    expect(() => quantizer.quantize(rational(10n ** 128n), '0')).toThrowError(expect.objectContaining({ code: 'OUTPUT_VALUE_LIMIT' }));
    expect(() => quantizer.quantize(rational(2n * 10n ** 128n - 1n, 2n), '0')).toThrowError(expect.objectContaining({ code: 'OUTPUT_VALUE_LIMIT' }));
    expect(() => quantizer.quantize(rational(1n, 2n ** 129n), 'INF')).toThrowError(expect.objectContaining({ code: 'OUTPUT_VALUE_LIMIT' }));
    expect(quantizer.quantize(rational(10n ** 128n - 1n), '0').text).toBe('9'.repeat(128));
    expect(quantizer.quantize(rational(1n, 2n ** 128n), 'INF').text.split('.')[1]).toHaveLength(128);
  });
  it.each(['', '19', '-19', '02', '+2', '2.0', '-0'])('rejects an invalid destination precision %s', (precision) => {
    expect(() => quantizer.quantize(rational(1n), precision)).toThrowError(expect.objectContaining({ code: 'INVALID_PRECISION' }));
  });
  it('enforces output digits including the required destination scale', () => {
    expect(() => quantizer.quantize(rational(10n ** 127n), '2')).toThrowError(expect.objectContaining({ code: 'OUTPUT_VALUE_LIMIT' }));
    expect(quantizer.quantize(rational(1n, 10n ** 18n), '18').text).toBe('0.000000000000000001');
    expect(quantizer.quantize(rational(5n * 10n ** 17n), '-18').text).toBe('0');
  });
});

describe('single recalculation candidate', () => {
  function candidate(input: Snapshot, index = 0) {
    const serialized = JSON.stringify(input);
    const output = evaluateCandidate(frozen(input), input.content.directions[index]!, { budget: new WorkBudget({ now: () => 0 }) });
    expect(JSON.stringify(input)).toBe(serialized); return output;
  }
  function one(target: Coordinate, rhs: string, options: { expression?: string; facts?: ImportedReport['facts']; other?: Coordinate[]; precondition?: string } = {}) {
    const base = snapshot([variant('candidate', options.expression ?? ref(target) + '=' + rhs, options.precondition ? { precondition: options.precondition } : {})],
      report([target, ...(options.other ?? [])], options.facts ?? [fact(target, target.dataType === 'number' ? '0' : false)]));
    return configured(base, [{ code: 'candidate', target }]);
  }
  it('returns the revalidated quantized EUR fact while preserving exact derivation and base data', () => {
    const target = coordinate({ unit: 'EUR', decimals: '2' });
    const output = candidate(one(target, '', { expression: 'with {interval:true}: ' + ref(target) + '=1/3' }));
    expect(output).toMatchObject({ state: 'available', before: { presence: 'value', originalText: '0' }, exactNominal: { numerator: '1', denominator: '3' },
      derivedInterval: { lo: { numerator: '1', denominator: '3' }, hi: { numerator: '1', denominator: '3' } },
      after: { originalText: '0.33', normalizedValue: { numerator: '33', denominator: '100' }, decimals: '2', unit: 'EUR' },
      fact: { factKey: target.factKey, presence: 'value', originalText: '0.33', normalizedValue: { numerator: '33', denominator: '100' } } });
    expect(output.fact?.sourceLocator).toEqual(output.before?.sourceLocator);
    expect(output.readKeys).toEqual([]);
  });
  it('makes a consumer read the exported amount and destination interval', () => {
    const { input, a, d } = chain(true);
    const producer = evaluateCandidate(input, input.content.directions.find(direction => direction.targetKey === a.factKey)!);
    expect(producer.state).toBe('available'); expect(producer.fact).toBeDefined();
    const current = { ...input, content: { ...input.content, facts: [...input.content.facts.filter(item => item.factKey !== a.factKey), producer.fact!] } };
    const output = evaluateCandidate(frozen(current), input.content.directions.find(direction => direction.targetKey === d.factKey)!);
    expect(output).toMatchObject({ state: 'available', exactNominal: cases.scenarios.quantizedChain.exactD,
      derivedInterval: cases.scenarios.quantizedChain.derivedD, after: { originalText: '0.99' } });
    expect(output.readKeys).toEqual([a.factKey]);
  });
  it('rejects the quantized value when the original point equality fails', () => {
    const target = coordinate({ decimals: '2' }), output = candidate(one(target, '1/3'));
    expect(output.state).toBe('blocked'); expect(output.after).toBeUndefined(); expect(output.fact).toBeUndefined();
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ code: 'CANDIDATE_DOES_NOT_SATISFY_RULE' }));
  });
  it('revalidates an explicitly selected right side with the original default scope', () => {
    const target = coordinate(), source = coordinate({ row: '0020' });
    const base = snapshot([variant('right', 'with {default:2}: ' + ref(source) + '+1=' + ref(target))], report([target, source], [fact(target, '9'), fact(source, null)]));
    const output = candidate(configured(base, [{ code: 'right', target, side: 'right' }]));
    expect(output).toMatchObject({ state: 'available', after: { originalText: '3' } }); expect(output.readKeys).toEqual([source.factKey]);
  });
  it.each(['explicit', 'implicit'])('keeps the old %s absence separate from a known zero candidate', (absence) => {
    const target = coordinate(), output = candidate(one(target, '0', { facts: absence === 'explicit' ? [fact(target, null)] : [] }));
    expect(output).toMatchObject({ state: 'available', before: { presence: absence + '_null' }, after: { originalText: '0', normalizedValue: { numerator: '0', denominator: '1' } } });
    expect(output.before?.originalText).toBeUndefined();
  });
  it('handles booleans without numeric fields', () => {
    const target = coordinate({ dataType: 'boolean' }), output = candidate(one(target, 'true'));
    expect(output).toMatchObject({ state: 'available', after: { originalText: 'true', normalizedValue: true }, fact: { normalizedValue: true } });
    expect(output.exactNominal).toBeUndefined(); expect(output.derivedInterval).toBeUndefined(); expect(output.after).not.toHaveProperty('decimals');
  });
  it.each(['number', 'boolean'] as const)('blocks a mismatched %s destination type', (dataType) => {
    const target = coordinate({ dataType }), output = candidate(one(target, dataType === 'number' ? 'true' : '1'));
    expect(output.state).toBe('blocked'); expect(output.fact).toBeUndefined();
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
  });
  it.each(['pure', 'USD'])('does not promote a nonliteral %s fact to EUR', (unit) => {
    const target = coordinate({ unit: 'EUR' }), source = coordinate({ row: '0020', unit });
    const output = candidate(one(target, ref(source), { other: [source], facts: [fact(target, '0'), fact(source, '1')] }));
    expect(output.state).toBe('blocked'); expect(output.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNIT_MISMATCH' }));
  });
  it.each(['number', 'boolean'] as const)('does not coerce a null %s RHS', (dataType) => {
    const target = coordinate({ dataType }), source = coordinate({ row: '0020', dataType });
    const output = candidate(one(target, ref(source), { other: [source], facts: [fact(source, null)] }));
    expect(output.state).toBe('blocked'); expect(output.fact).toBeUndefined(); expect(output.diagnostics.length).toBeGreaterThan(0);
  });
  it('preserves missing metadata diagnostics and metadata provenance', () => {
    const target = coordinate({ dataType: 'boolean' }), output = candidate(one(target, '{v_MISSING}'));
    expect(output.state).toBe('blocked'); expect(output.metadataReads).toContainEqual(expect.objectContaining({ code: 'MISSING', presence: 'missing' }));
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_FILING_INDICATOR' }));
  });
  it.each(['false', '{v_MISSING}'])('evaluates precondition %s before executing an erroneous RHS', (precondition) => {
    const output = candidate(one(coordinate(), '1/0', { precondition }));
    expect(output.state).toBe('blocked'); expect(output.diagnostics).not.toContainEqual(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
    expect(output.diagnostics.length).toBeGreaterThan(0);
  });
  it('checks the precondition again on the proposed value', () => {
    const target = coordinate(); const output = candidate(one(target, '0', { precondition: ref(target) + '>0', facts: [fact(target, '1')] }));
    expect(output.state).toBe('blocked'); expect(output.fact).toBeUndefined();
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ code: 'CANDIDATE_DOES_NOT_SATISFY_RULE' }));
  });
  it.each([['1/0', 'DIVISION_BY_ZERO'], ['1/3', 'NON_TERMINATING_DECIMAL'], ['1' + '0'.repeat(128), 'OUTPUT_VALUE_LIMIT']])('blocks RHS %s with its concrete diagnostic', (rhs, code) => {
    const output = candidate(one(coordinate(), rhs!));
    expect(output.state).toBe('blocked'); expect(output.after).toBeUndefined(); expect(output.fact).toBeUndefined();
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ code }));
  });
  it('propagates job cancellation and read limits instead of turning them into business blocks', () => {
    const input = one(coordinate(), '1');
    expect(() => evaluateCandidate(input, input.content.directions[0]!, { budget: new WorkBudget({ cancelled: () => true }) })).toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
    expect(() => evaluateCandidate(input, input.content.directions[0]!, { budget: new WorkBudget({ limits: { reads: 0 } }) })).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    expect(() => evaluateCandidate(input, input.content.directions[0]!, { budget: new WorkBudget({ limits: { milliseconds: 0 } }) })).toThrowError(expect.objectContaining({ code: 'DEADLINE_EXCEEDED' }));
  });
  it('propagates the rational arithmetic quota and rejects a forged destination', () => {
    const target = coordinate(), ready = coordinate({ row: '0090', dataType: 'boolean' });
    const initial = one(target, ((1n << 4095n) - 1n).toString() + '*4', { precondition: ref(ready), other: [ready], facts: [fact(target, '0'), fact(ready, false)] });
    const overflow = { ...initial, content: { ...initial.content, facts: [fact(target, '0'), fact(ready, true)] } };
    expect(() => evaluateCandidate(overflow, overflow.content.directions[0]!)).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    const normal = one(target, '1');
    const output = evaluateCandidate(normal, { ...normal.content.directions[0]!, targetKey: 'forged' });
    expect(output.state).toBe('blocked'); expect(output.fact).toBeUndefined();
    expect(output.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_DIRECTION' }));
  });
});

describe('recalculation preview consumes explicit directions without changing the base', () => {
  beforeAll(async () => { simulator = await import('../src/recalculation/simulate.js'); });
  it('does not infer any destination merely because equalities fail', () => {
    const { base } = chain(); const output = simulate(base);
    expect(output.proposals).toEqual([]); expect(output.preview.baseVersionId).toBe(base.versionId); expect(output.preview.state).toBe('ready');
  });
  it('honors the explicitly selected side when both equality sides are cells', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' });
    const base = snapshot([variant('copy', ref(a) + '=' + ref(b))], report([a, b], [fact(a, '10'), fact(b, '12')]));
    const left = simulate(configured(base, [{ code: 'copy', target: a, side: 'left' }]));
    const right = simulate(configured(base, [{ code: 'copy', target: b, side: 'right' }]));
    expect(left.proposals).toHaveLength(1); expect(right.proposals).toHaveLength(1);
    expect(findProposal(left, a)).toMatchObject({ state: 'available', before: { originalText: '10' }, after: { originalText: '12', normalizedValue: { numerator: '12', denominator: '1' } } });
    expect(findProposal(right, b)).toMatchObject({ state: 'available', before: { originalText: '12' }, after: { originalText: '10', normalizedValue: { numerator: '10', denominator: '1' } } });
  });
  it('simulates the dependent integer chain A=12 and D=24 on a copy', () => {
    const { input, a, d } = chain(); const output = simulate(input);
    const first = findProposal(output, a), second = findProposal(output, d);
    expect(first).toMatchObject({ state: 'available', before: { originalText: '10' }, after: { originalText: cases.scenarios.integerChain.afterA, decimals: '2', unit: 'EUR' } });
    expect(second).toMatchObject({ state: 'available', before: { originalText: '20' }, after: { originalText: cases.scenarios.integerChain.afterD } });
    expect(second.predecessorIds).toContain(first.id); expect(second.readKeys).toContain(a.factKey);
    expect(output.preview).toMatchObject({ baseVersionId: input.versionId, profileId: cases.profileId, policyId: cases.policyId, state: 'ready' });
    expect(output.preview.proposalIds).toEqual(expect.arrayContaining([first.id, second.id]));
  });
  it('lets a EUR destination adopt a literal unit and makes consumers use the quantized 0.33, producing 0.99', () => {
    const { input, a, d } = chain(true); const output = simulate(input), expected = cases.scenarios.quantizedChain;
    const first = findProposal(output, a), second = findProposal(output, d);
    expect(first).toMatchObject({ state: 'available', exactNominal: expected.exactA, derivedInterval: { lo: expected.exactA, hi: expected.exactA },
      after: { originalText: expected.afterA, normalizedValue: { numerator: '33', denominator: '100' }, decimals: '2', unit: 'EUR' } });
    expect(second).toMatchObject({ state: 'available', exactNominal: expected.exactD, derivedInterval: expected.derivedD,
      after: { originalText: expected.afterD, normalizedValue: expected.exactD, decimals: '2', unit: 'EUR' } });
    expect(second.predecessorIds).toContain(first.id);
  });
  it('keeps output values and semantic proposal identities stable when source arrays are permuted', () => {
    const { input } = chain(true); const permuted: Snapshot = { ...input, content: { ...input.content,
      coordinates: [...input.content.coordinates].reverse().map((cell, index) => ({ ...cell, sourceLocator: { ...cell.sourceLocator, row: index + 40 } })),
      facts: [...input.content.facts].reverse().map((value, index) => ({ ...value, sourceLocator: { ...value.sourceLocator, row: index + 70 } })), directions: [...input.content.directions].reverse(),
      catalog: { ...input.content.catalog, records: [...input.content.catalog.records].reverse(), variants: [...input.content.catalog.variants].reverse() } } };
    const original = simulate(input), reordered = simulate(permuted);
    const material = (output: ReturnType<typeof simulate>) => output.proposals.map(({ id, targetKey, state, after, predecessorIds }) => ({ id, targetKey, state, after, predecessorIds: [...predecessorIds].sort() })).sort((a, b) => a.targetKey.localeCompare(b.targetKey));
    expect(material(reordered)).toEqual(material(original));
  });
  it('rejects a rounded candidate that cannot satisfy the original point equality, then blocks its consumer', () => {
    const { input, a, d } = chain(true, false); const output = simulate(input);
    expect(findProposal(output, a)).toMatchObject({ state: 'blocked' });
    expect(findProposal(output, a).diagnostics).toContainEqual(expect.objectContaining({ code: 'CANDIDATE_DOES_NOT_SATISFY_RULE' }));
    expect(findProposal(output, d)).toMatchObject({ state: 'blocked' }); expect(findProposal(output, d).after).toBeUndefined();
  });
  it.each(['1/0', '{tT,r0020,c0010}'])('does not fall back to an old producer value after RHS %s fails or is null', (rhs) => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' }), d = coordinate({ row: '0040' }), independent = coordinate({ row: '0050' });
    const base = snapshot([variant('A', ref(a) + '=' + rhs), variant('D', ref(d) + '=' + ref(a) + '*2'), variant('E', ref(independent) + '=7')],
      report([a, b, d, independent], [fact(a, '123'), fact(b, null), fact(d, '246'), fact(independent, '0')]));
    const output = simulate(configured(base, [{ code: 'A', target: a }, { code: 'D', target: d }, { code: 'E', target: independent }]));
    expect(findProposal(output, a).state).toBe('blocked'); expect(findProposal(output, a).diagnostics.length).toBeGreaterThan(0);
    expect(findProposal(output, d).state).toBe('blocked'); expect(findProposal(output, d).after).toBeUndefined();
    expect(findProposal(output, independent)).toMatchObject({ state: 'available', after: { originalText: '7' } });
  });
  it('reevaluates a false precondition after its producer makes it true', () => {
    const a = coordinate({ row: '0010' }), d = coordinate({ row: '0040' });
    const base = snapshot([variant('A', ref(a) + '=1'), variant('D', ref(d) + '=' + ref(a) + '+1', { precondition: ref(a) + '>0' })], report([a, d], [fact(a, '0'), fact(d, '9')]));
    const initial = runValidation(base, { runId: 'initial', startedAt, now: () => 0 }).results.find(result => result.code === 'D');
    expect(initial).toMatchObject({ status: 'not_applicable', coverageOnly: false }); expect(initial?.instanceId).toBeDefined();
    const output = simulate(configured(base, [{ code: 'D', target: d }, { code: 'A', target: a }]));
    expect(findProposal(output, a)).toMatchObject({ state: 'available', after: { originalText: '1' } });
    expect(findProposal(output, d)).toMatchObject({ state: 'available', after: { originalText: '2' } });
    expect(findProposal(output, d).predecessorIds).toContain(findProposal(output, a).id);
  });
  it('blocks a producer with a still-false precondition and all consumers expecting its change', () => {
    const a = coordinate({ row: '0010' }), d = coordinate({ row: '0040' });
    const base = snapshot([variant('A', ref(a) + '=1', { precondition: 'false' }), variant('D', ref(d) + '=' + ref(a) + '+1')], report([a, d], [fact(a, '8'), fact(d, '9')]));
    const output = simulate(configured(base, [{ code: 'A', target: a }, { code: 'D', target: d }]));
    for (const proposal of output.proposals) { expect(proposal.state).toBe('blocked'); expect(proposal.after).toBeUndefined(); expect(proposal.diagnostics.length).toBeGreaterThan(0); }
  });
  it('offers a known boolean RHS without numeric quantization', () => {
    const target = coordinate({ row: '0090', dataType: 'boolean' });
    const base = snapshot([variant('B', ref(target) + '=true')], report([target], [fact(target, false)]));
    const proposal = findProposal(simulate(configured(base, [{ code: 'B', target }])), target);
    expect(proposal).toMatchObject({ state: 'available', before: { presence: 'value', normalizedValue: false }, after: { originalText: 'true', normalizedValue: true } });
    expect(proposal.exactNominal).toBeUndefined(); expect(proposal.derivedInterval).toBeUndefined(); expect(proposal.after?.decimals).toBeUndefined();
  });
  it.each(['number', 'boolean'] as const)('rejects an incompatible RHS type for a %s destination', (dataType) => {
    const target = coordinate({ row: '0090', dataType });
    const base = snapshot([variant('mismatch', ref(target) + '=' + (dataType === 'number' ? 'true' : '1'))], report([target], [fact(target, dataType === 'number' ? '0' : false)]));
    const proposal = findProposal(simulate(configured(base, [{ code: 'mismatch', target }])), target);
    expect(proposal.state).toBe('blocked'); expect(proposal.after).toBeUndefined(); expect(proposal.diagnostics).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
  });
  it.each(['pure', 'USD'])('rejects a nonliteral %s fact assigned to a EUR destination', (unit) => {
    const target = coordinate({ row: '0010', unit: 'EUR' }), source = coordinate({ row: '0020', unit });
    const base = snapshot([variant('units', ref(target) + '=' + ref(source))], report([target, source], [fact(target, '0'), fact(source, '1')]));
    const proposal = findProposal(simulate(configured(base, [{ code: 'units', target }])), target);
    expect(proposal.state).toBe('blocked'); expect(proposal.after).toBeUndefined(); expect(proposal.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNIT_MISMATCH' }));
  });
  it('does not propose an unknown boolean result from an undeclared filing indicator', () => {
    const target = coordinate({ row: '0090', dataType: 'boolean' });
    const base = snapshot([variant('unknown', ref(target) + '={v_MISSING}')], report([target], [fact(target, false)]));
    const proposal = findProposal(simulate(configured(base, [{ code: 'unknown', target }])), target);
    expect(proposal.state).toBe('blocked'); expect(proposal.after).toBeUndefined();
    expect(proposal.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_FILING_INDICATOR' }));
  });
  it('keeps filing indicators read-only even when a caller supplies a fact key as a destination', () => {
    const ctx = context({ filingIndicators: { C_INDICATOR: true } }), target = coordinate({ context: ctx, row: '0090', dataType: 'boolean' });
    const base = snapshot([variant('readonly', '{v_C_INDICATOR}=false')], report([target], [fact(target, false)], [ctx]));
    const proposal = findProposal(simulate(configured(base, [{ code: 'readonly', target }])), target);
    expect(proposal.state).toBe('blocked'); expect(proposal.after).toBeUndefined(); expect(proposal.diagnostics.length).toBeGreaterThan(0);
  });
  it.each(['{tT,r0010,c0010}>1', '{tT,r0010,c0010}+1=2', '{tT,r0010,c0010}={tT,r0010,c0010}+1'])('does not solve an inequality, a compound destination or a self-dependent equality: %s', (expression) => {
    const target = coordinate({ row: '0010' });
    const base = snapshot([variant('ineligible', expression)], report([target], [fact(target, '0')]));
    const proposal = findProposal(simulate(configured(base, [{ code: 'ineligible', target }])), target);
    expect(proposal.state).toBe('blocked'); expect(proposal.after).toBeUndefined(); expect(proposal.diagnostics.length).toBeGreaterThan(0);
  });
  it('blocks a periodic INF value and a value outside the exportable range even when internal arithmetic fits', () => {
    const a = coordinate({ row: '0010' }), d = coordinate({ row: '0040' });
    const huge = '1' + '0'.repeat(128);
    const base = snapshot([variant('periodic', ref(a) + '=1/3'), variant('tooLarge', ref(d) + '=' + huge)], report([a, d], [fact(a, '0'), fact(d, '0')]));
    const output = simulate(configured(base, [{ code: 'periodic', target: a }, { code: 'tooLarge', target: d }]));
    expect(findProposal(output, a).state).toBe('blocked'); expect(findProposal(output, a).diagnostics).toContainEqual(expect.objectContaining({ code: 'NON_TERMINATING_DECIMAL' }));
    expect(findProposal(output, d).state).toBe('blocked'); expect(findProposal(output, d).diagnostics).toContainEqual(expect.objectContaining({ code: 'OUTPUT_VALUE_LIMIT' }));
  });
});

describe('preview identities, blocking evidence and job boundaries', () => {
  beforeAll(async () => { simulator = await import('../src/recalculation/simulate.js'); });
  it('matches the RFC 9562 Appendix A.4 UUIDv5 vector', () => {
    // https://www.rfc-editor.org/rfc/rfc9562.html#appendix-A.4
    expect(simulator.uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
  it('derives proposal UUIDs from preview namespace and semantic direction identity', () => {
    const { input } = chain(); const first = simulate(input);
    const second = simulator.simulate(input, { ...simulationOptions, previewId: '00000000-0000-4000-8000-000000000049' });
    for (const proposal of first.proposals) {
      expect(proposal.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(proposal.id).toBe(simulator.uuidV5(simulationOptions.previewId, proposal.directionId));
      expect(second.proposals.find(other => other.directionId === proposal.directionId)!.id).not.toBe(proposal.id);
    }
    expect(new Set(first.proposals.map(proposal => proposal.id)).size).toBe(first.proposals.length);
  });
  it('captures the preview creation time at the start without making it part of proposal identity', () => {
    const { input } = chain(); let time = Date.parse(startedAt);
    const first = simulator.simulate(input, { ...simulationOptions, now: () => time, progress: () => { time += 1000; } });
    expect(first.preview.createdAt).toBe(startedAt);
    const later = simulator.simulate(input, { ...simulationOptions, now: () => time });
    expect(later.preview.createdAt).not.toBe(first.preview.createdAt); expect(later.preview.proposalIds).toEqual(first.preview.proposalIds);
  });
  it('does not publish a partial ready bundle after work limits, cancellation or deadline', () => {
    const { input } = chain(); const before = JSON.stringify(input);
    for (const [extra, code] of [[{ limits: { reads: 0 } }, 'RESOURCE_LIMIT'], [{ limits: { edges: 0 } }, 'RESOURCE_LIMIT'],
      [{ cancelled: () => true }, 'CANCELLED'], [{ limits: { milliseconds: 0 } }, 'DEADLINE_EXCEEDED']] as const) {
      expect(() => simulator.simulate(input, { ...simulationOptions, ...extra })).toThrowError(expect.objectContaining({ code }));
    }
    expect(JSON.stringify(input)).toBe(before);
  });
  it('can cancel after one candidate without exposing its simulated fact in the base', () => {
    const { input } = chain(); const before = JSON.stringify(input); let cancel = false;
    expect(() => simulator.simulate(input, { ...simulationOptions, cancelled: () => cancel, progress: completed => { if (completed >= 1) cancel = true; } }))
      .toThrowError(expect.objectContaining({ code: 'CANCELLED' }));
    expect(JSON.stringify(input)).toBe(before);
  });
  it('shares one read quota across candidates and reuses unchanged structural expansions', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' });
    const base = snapshot([variant('A', ref(a) + '=1'), variant('B', ref(b) + '=2')], report([a, b], [fact(a, '0'), fact(b, '0')]));
    const input = configured(base, [{ code: 'A', target: a }, { code: 'B', target: b }]);
    // Each original equality revalidation reads its own target once. The second must exhaust
    // a shared one-read budget; structural expansion remains two instances across the job.
    expect(() => simulator.simulate(input, { ...simulationOptions, limits: { reads: 1 } })).toThrowError(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
    const complete = simulator.simulate(input, { ...simulationOptions, limits: { reads: 2, instances: 2 } });
    expect(complete.proposals.map(proposal => proposal.state)).toEqual(['available', 'available']);
  });
  it('keeps conflict evidence and blocks every consumer while preserving a free branch', () => {
    const a = coordinate({ row: '0010' }), d = coordinate({ row: '0020' }), e = coordinate({ row: '0030' });
    const base = snapshot([variant('A1', ref(a) + '=1'), variant('A2', ref(a) + '=1'), variant('D', ref(d) + '=' + ref(a) + '*2'), variant('E', ref(e) + '=7')],
      report([a, d, e], [fact(a, '100'), fact(d, '200'), fact(e, '0')]));
    const output = simulate(configured(base, [{ code: 'A1', target: a }, { code: 'A2', target: a }, { code: 'D', target: d }, { code: 'E', target: e }]));
    expect(output.preview.graphSummary.conflicts).toHaveLength(1); expect(output.preview.graphSummary.blocked).toBe(3);
    expect(output.proposals.filter(proposal => proposal.targetKey === a.factKey).every(proposal => proposal.state === 'blocked' && !proposal.after)).toBe(true);
    expect(findProposal(output, d)).toMatchObject({ state: 'blocked', before: { originalText: '200' } });
    expect(findProposal(output, d).predecessorIds).toHaveLength(2); expect(findProposal(output, d).diagnostics).toContainEqual(expect.objectContaining({ code: 'BLOCKED_DEPENDENCY' }));
    expect(findProposal(output, e)).toMatchObject({ state: 'available', after: { originalText: '7' } });
  });
  it('explains cycles separately from downstream blocks without evaluating either branch', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' }), d = coordinate({ row: '0030' }), e = coordinate({ row: '0040' });
    const base = snapshot([variant('A', ref(a) + '=' + ref(b) + '+1'), variant('B', ref(b) + '=' + ref(a) + '+1'), variant('D', ref(d) + '=' + ref(b) + '*2'), variant('E', ref(e) + '=7')],
      report([a, b, d, e], [fact(a, '100'), fact(b, '200'), fact(d, '400'), fact(e, '0')]));
    const output = simulate(configured(base, [{ code: 'A', target: a }, { code: 'B', target: b }, { code: 'D', target: d }, { code: 'E', target: e }]));
    expect(output.preview.graphSummary.cycles).toHaveLength(1); expect(output.preview.graphSummary.cycles[0]).toHaveLength(2);
    for (const target of [a, b]) expect(findProposal(output, target).diagnostics).toContainEqual(expect.objectContaining({ code: 'DEPENDENCY_CYCLE' }));
    expect(findProposal(output, d).diagnostics).toContainEqual(expect.objectContaining({ code: 'BLOCKED_DEPENDENCY' }));
    expect(findProposal(output, d).diagnostics).not.toContainEqual(expect.objectContaining({ code: 'DEPENDENCY_CYCLE' }));
    expect(findProposal(output, e).state).toBe('available');
  });
  it('retains an implicit before value and Contexts metadata on a statically blocked proposal', () => {
    const ctx = context({ filingIndicators: { READY: true } }), a = coordinate({ context: ctx });
    const base = snapshot([variant('self', ref(a) + '=1', { precondition: ref(a) + '>0 and {v_READY}' })], report([a], [], [ctx]));
    const proposal = findProposal(simulate(configured(base, [{ code: 'self', target: a }])), a);
    expect(proposal).toMatchObject({ state: 'blocked', before: { presence: 'implicit_null', coordinate: a } });
    expect(proposal.metadataReads).toContainEqual(expect.objectContaining({ code: 'READY', presence: 'declared', value: true }));
    expect(proposal.sources).toContainEqual(expect.objectContaining({ sheet: 'Contexts' }));
    expect(proposal.predecessorIds).toEqual([proposal.id]);
  });
  it('rejects another profile or an invalid preview namespace before producing a preview', () => {
    const { input } = chain();
    expect(() => simulator.simulate({ ...input, content: { ...input.content, profileId: 'unsupported-profile' } }, simulationOptions))
      .toThrowError(expect.objectContaining({ code: 'PROFILE_MISMATCH' }));
    expect(() => simulator.simulate(input, { ...simulationOptions, previewId: 'not-a-uuid' })).toThrowError();
  });
  it.each(['1', '1/0'])('enumerates producer before consumer for RHS %s despite adverse target order, then static blocks', (rhs) => {
    const consumer = coordinate({ row: '0010' }), producer = coordinate({ row: '0090' }), self = coordinate({ row: '0005' });
    const base = snapshot([variant('consumer', ref(consumer) + '=' + ref(producer) + '+1'), variant('producer', ref(producer) + '=' + rhs),
      variant('self', ref(self) + '=1', { precondition: ref(self) + '>0' })], report([consumer, producer, self], [fact(consumer, '0'), fact(producer, '0'), fact(self, '0')]));
    const input = configured(base, [{ code: 'consumer', target: consumer }, { code: 'self', target: self }, { code: 'producer', target: producer }]);
    const first = simulate(input), second = simulator.simulate(input, { ...simulationOptions, previewId: '00000000-0000-4000-8000-000000000049' });
    expect(first.proposals.map(proposal => proposal.code)).toEqual(['producer', 'consumer', 'self']);
    expect(second.proposals.map(proposal => proposal.directionId)).toEqual(first.proposals.map(proposal => proposal.directionId));
    expect(first.preview.graphSummary.order).toEqual(first.proposals.slice(0, 2).map(proposal => proposal.directionId));
    expect(first.preview.proposalIds).toEqual(first.proposals.map(proposal => proposal.id));
    if (rhs === '1/0') expect(first.proposals.every(proposal => proposal.state === 'blocked')).toBe(true);
  });
  it('orders predecessor and blocking-cause identities before mapping them to preview-specific UUIDs', () => {
    const a = coordinate({ row: '0020' }), b = coordinate({ row: '0030' }), consumer = coordinate({ row: '0010' });
    const base = snapshot([variant('A', ref(a) + '=1/0'), variant('B', ref(b) + '=1/0'), variant('consumer', ref(consumer) + '=' + ref(a) + '+' + ref(b))],
      report([a, b, consumer], [fact(a, '1'), fact(b, '2'), fact(consumer, '3')]));
    const input = configured(base, [{ code: 'consumer', target: consumer }, { code: 'B', target: b }, { code: 'A', target: a }]);
    const expected = input.content.directions.filter(direction => direction.targetKey !== consumer.factKey).map(direction => direction.id).sort();
    for (const previewId of [simulationOptions.previewId, '00000000-0000-4000-8000-000000000049']) {
      const output = simulator.simulate(input, { ...simulationOptions, previewId }); const result = findProposal(output, consumer);
      const directionOf = (id: string) => output.proposals.find(proposal => proposal.id === id)!.directionId;
      expect(result.predecessorIds.map(directionOf)).toEqual(expected);
      const issue = result.diagnostics.find(item => item.code === 'BLOCKED_DEPENDENCY')!;
      const causeIds = issue.message.match(/[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g)!;
      expect(causeIds.map(directionOf)).toEqual(expected);
    }
  });
});
