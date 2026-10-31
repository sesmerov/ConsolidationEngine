import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { NumericError, add, compare, divide, multiply, negate, parseDecimal, parseLanguageNumber, rational, rationalToDTO, subtract } from '../src/numeric/rational.js';
import type { ExactRational } from '../src/numeric/rational.js';
let intervals: typeof import('../src/numeric/interval.js');
const loadIntervals = async () => { intervals = await import('../src/numeric/interval.js'); };
import type { NumericValue } from '../src/numeric/interval.js';

type Pair = readonly [string, string];
type Operation = '+' | '-' | '*' | '/';
interface FixtureValue { nominal: Pair; lo: Pair; hi: Pair }
interface Fixtures {
  profileId: string; basis: string;
  rationalCases: { id: string; op: Operation; left: Pair; right: Pair; expected: Pair }[];
  intervalCases: { id: string; op: Operation; left: FixtureValue; right: FixtureValue; expected: FixtureValue }[];
  precisionCases: { id: string; nominal: Pair; precision: string; enabled: boolean; expected: FixtureValue }[];
}
const cases = JSON.parse(readFileSync(new URL('../../../tests/fixtures/numeric-cases.json', import.meta.url), 'utf8')) as Fixtures;
const pair = ([n, d]: Pair): ExactRational => rational(BigInt(n), BigInt(d));
const value = (input: FixtureValue): NumericValue => ({ nominal: pair(input.nominal), lo: pair(input.lo), hi: pair(input.hi) });
const point = (n: bigint, d = 1n): NumericValue => intervals.fromPrecision(rational(n, d), 'INF', true);
const range = (lo: bigint, hi: bigint, n = lo, d = 1n): NumericValue => ({ nominal: rational(n, d), lo: rational(lo), hi: rational(hi) });
const operations = { '+': add, '-': subtract, '*': multiply, '/': divide };
function expectPair(actual: ExactRational, expected: Pair): void {
  expect(actual).toEqual({ n: BigInt(expected[0]), d: BigInt(expected[1]) });
  expect(rationalToDTO(actual)).toEqual({ numerator: expected[0], denominator: expected[1] });
}
function expectValue(actual: NumericValue, expected: FixtureValue): void {
  expectPair(actual.nominal, expected.nominal); expectPair(actual.lo, expected.lo); expectPair(actual.hi, expected.hi);
}
function numericFailure(action: () => unknown, code: string): void {
  let failure: unknown;
  try { action(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(NumericError); expect(failure).toMatchObject({ code });
}

describe('exact rational arithmetic under the local 4096-bit profile', () => {
  it.each(cases.rationalCases)('$id', (sample) => {
    expectPair(operations[sample.op](pair(sample.left), pair(sample.right)), sample.expected);
  });
  it('keeps decimal tenths exact and a repeating intermediate unrounded', () => {
    expectPair(add(parseDecimal('0.1'), parseDecimal('0.2')), ['3', '10']);
    const third = divide(rational(1n), rational(3n));
    expectPair(third, ['1', '3']); expectPair(multiply(third, rational(3n)), ['1', '1']);
    expectPair(add(add(third, third), third), ['1', '1']);
  });
  it.each([[14n, -21n, '-2', '3'], [-14n, -21n, '2', '3'], [0n, -9n, '0', '1'], [42n, 56n, '3', '4']] as const)('normalizes signs, common factors and zero (%s/%s)', (n, d, expectedN, expectedD) => {
    expectPair(rational(n, d), [expectedN, expectedD]);
  });
  it('normalizes unary minus without changing the denominator or creating negative zero', () => {
    expectPair(negate(rational(-7n, 9n)), ['7', '9']); expectPair(negate(rational(0n)), ['0', '1']);
  });
  it('serializes exact integer strings, including values beyond IEEE-754 precision', () => {
    const result = rationalToDTO(rational(9007199254740993n, 7n));
    expect(result).toEqual({ numerator: '9007199254740993', denominator: '7' });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
  it('rejects zero denominators and exact division by zero', () => {
    numericFailure(() => rational(1n, 0n), 'DIVISION_BY_ZERO');
    numericFailure(() => divide(rational(1n), rational(0n)), 'DIVISION_BY_ZERO');
  });
  it('compares signed and equivalent fractions exactly', () => {
    expect(compare(rational(1n, 3n), rational(2n, 6n))).toBe(0);
    expect(compare(rational(-1n, 3n), rational(-1n, 2n))).toBe(1);
    expect(compare(rational(-1n), rational(0n))).toBe(-1);
    expect(compare(rational(1n, 7n), rational(1n, 6n))).toBe(-1);
  });
  it('admits the exact component boundary and rejects an oversized normalized component', () => {
    const maximum = (1n << 4096n) - 1n;
    expect(rational(maximum)).toEqual({ n: maximum, d: 1n });
    expect(rational(1n, maximum)).toEqual({ n: 1n, d: maximum });
    numericFailure(() => rational(maximum + 1n), 'RESOURCE_LIMIT');
    numericFailure(() => rational(1n, maximum + 1n), 'RESOURCE_LIMIT');
  });
  it('rejects growth past the normalized numerator or denominator quota with a domain error', () => {
    const maximum = rational((1n << 4096n) - 1n);
    numericFailure(() => add(maximum, rational(1n)), 'RESOURCE_LIMIT');
    numericFailure(() => subtract(negate(maximum), rational(1n)), 'RESOURCE_LIMIT');
    numericFailure(() => multiply(rational(1n << 3000n), rational(1n << 3000n)), 'RESOURCE_LIMIT');
    numericFailure(() => divide(rational(1n, 1n << 4095n), rational(2n)), 'RESOURCE_LIMIT');
  });
  it('cancels cross-factors before multiplication or division would create a huge temporary product', () => {
    const large = 1n << 3000n;
    const left = rational(large, 3n), inverse = rational(3n, large);
    expectPair(multiply(left, inverse), ['1', '1']); expectPair(divide(left, left), ['1', '1']);
  });
  it('uses shared denominators and exact cancellation before growing intermediate terms', () => {
    const large = (1n << 4095n) - 1n;
    const fraction = rational(large, large + 1n);
    expectPair(add(fraction, negate(fraction)), ['0', '1']);
    expectPair(add(rational(1n, large), rational(large - 1n, large)), ['1', '1']);
  });
  it('compares legal large fractions without overflowing a cross-product', () => {
    const large = (1n << 4095n) - 1n;
    const left = rational(large, large + 1n), right = rational(large + 1n, large + 2n);
    expect(compare(left, right)).toBe(-1); expect(compare(right, left)).toBe(1);
    expect(compare(negate(left), negate(right))).toBe(1);
  });
  it('does not bypass the operand quota through an arithmetic identity or DTO conversion', () => {
    const oversized: ExactRational = { n: 1n << 8192n, d: 1n };
    numericFailure(() => multiply(oversized, rational(0n)), 'RESOURCE_LIMIT');
    numericFailure(() => add(oversized, rational(0n)), 'RESOURCE_LIMIT');
    numericFailure(() => compare(oversized, oversized), 'RESOURCE_LIMIT');
    numericFailure(() => rationalToDTO(oversized), 'RESOURCE_LIMIT');
  });
});

describe('separate workbook decimal and DPM-XL numeric literal codecs', () => {
  it.each([['(-1)', '-1', '1'], ['(-0)', '0', '1'], ['0001.00', '1', '1'], ['0.125', '1', '8']] as const)('decodes admitted ANTLR lexeme %s exactly', (text, n, d) => {
    expectPair(parseLanguageNumber(text), [n, d]);
  });
  it('does not impose the workbook 128-digit quota on a supported rule literal', () => {
    const literal = '1' + '0'.repeat(200);
    expect(() => parseDecimal(literal)).toThrowError(expect.objectContaining({ code: 'INPUT_VALUE_LIMIT' }));
    expectPair(parseLanguageNumber(literal), [literal, '1']);
  });
  it('supports decimal places beyond the report input limit while remaining within 4096 bits', () => {
    const text = '0.' + '0'.repeat(199) + '1';
    expect(() => parseDecimal(text)).toThrowError(expect.objectContaining({ code: 'INPUT_VALUE_LIMIT' }));
    expectPair(parseLanguageNumber(text), ['1', '1' + '0'.repeat(200)]);
  });
  it('accepts a 4096-bit literal and rejects larger numerator or decimal denominator growth', () => {
    const maximum = (1n << 4096n) - 1n;
    expect(parseLanguageNumber(maximum.toString()).n).toBe(maximum);
    expect(parseLanguageNumber('0.' + '0'.repeat(1232) + '1').d).toBe(10n ** 1233n);
    numericFailure(() => parseLanguageNumber((maximum + 1n).toString()), 'RESOURCE_LIMIT');
    numericFailure(() => parseLanguageNumber('0.' + '0'.repeat(1233) + '1'), 'RESOURCE_LIMIT');
  });
  it.each(['1e3', 'NaN', 'Infinity', '1,5', '1.(-5)', '(-1).5', '(-1.5)', ' 1', '1 ', ''])('does not repair an unsupported or malformed literal %s', (text) => {
    numericFailure(() => parseLanguageNumber(text), 'INVALID_NUMBER');
  });
});

describe('exact closed intervals with separate nominal values', () => {
  beforeAll(loadIntervals);
  it.each(cases.intervalCases)('$id', (sample) => {
    const operation = { '+': intervals.intervalAdd, '-': intervals.intervalSubtract, '*': intervals.intervalMultiply, '/': intervals.intervalDivide }[sample.op];
    expectValue(operation(value(sample.left), value(sample.right)), sample.expected);
  });
  it.each(cases.precisionCases)('$id', (sample) => {
    expectValue(intervals.fromPrecision(pair(sample.nominal), sample.precision, sample.enabled), sample.expected);
  });
  it('defaults to a point and requires precision only when interval semantics need it', () => {
    const third = rational(1n, 3n);
    expect(intervals.fromPrecision(third, undefined)).toEqual({ nominal: third, lo: third, hi: third });
    expect(intervals.fromPrecision(third, undefined, false)).toEqual({ nominal: third, lo: third, hi: third });
    numericFailure(() => intervals.fromPrecision(third, undefined, true), 'MISSING_PRECISION');
  });
  it.each(['19', '-19', '2.5', 'inf', 'NaN', '02', '-0', ''])('rejects invalid declared precision %s', (precision) => {
    numericFailure(() => intervals.fromPrecision(rational(1n), precision, true), 'INVALID_PRECISION');
  });
  it('handles both supported precision extremes without floating point', () => {
    expectValue(intervals.fromPrecision(rational(0n), '-18', true), { nominal: ['0', '1'], lo: ['-500000000000000000', '1'], hi: ['500000000000000000', '1'] });
    expectValue(intervals.fromPrecision(rational(0n), '18', true), { nominal: ['0', '1'], lo: ['-1', '2000000000000000000'], hi: ['1', '2000000000000000000'] });
  });
  it('negates bounds in reverse order while negating the independent nominal', () => {
    expectValue(intervals.intervalNegate(range(-4n, 6n, 1n)), { nominal: ['-1', '1'], lo: ['-6', '1'], hi: ['4', '1'] });
  });
  it.each([[-1n, 1n, 1n, 2n], [0n, 2n, 1n, 1n], [-2n, 0n, -1n, 1n], [0n, 0n, 0n, 1n]] as const)('rejects a divisor containing zero, including either endpoint (%s,%s)', (lo, hi, n, d) => {
    numericFailure(() => intervals.intervalDivide(point(1n), range(lo, hi, n, d)), 'DIVISION_BY_ZERO');
  });
  it('does not collapse a very narrow positive interval to zero', () => {
    const tiny = rational(1n, 10n ** 200n), twice = rational(2n, 10n ** 200n);
    const denominator = { nominal: tiny, lo: tiny, hi: twice };
    const result = intervals.intervalDivide(point(1n), denominator);
    expect(result.lo).toEqual(rational(10n ** 200n, 2n)); expect(result.hi).toEqual(rational(10n ** 200n));
  });
  it('rejects an inverted interval instead of silently swapping its bounds', () => {
    numericFailure(() => intervals.intervalAdd(range(2n, 1n, 1n), point(1n)), 'INVALID_INTERVAL');
  });
  it('keeps the nominal result independent of the midpoint of the resulting bounds', () => {
    const result = intervals.intervalMultiply(range(-3n, -2n, -5n, 2n), range(4n, 5n, 9n, 2n));
    expectPair(result.nominal, ['-45', '4']);
    expect(compare(result.nominal, divide(add(result.lo, result.hi), rational(2n)))).not.toBe(0);
  });
  it('propagates component growth failures through interval operations', () => {
    numericFailure(() => intervals.intervalMultiply(point(1n << 3000n), point(1n << 3000n)), 'RESOURCE_LIMIT');
  });
});

describe('interval comparisons follow overlap semantics, not a total order', () => {
  beforeAll(loadIntervals);
  it.each([['=', true], ['!=', false], ['>', false], ['>=', true], ['<', true], ['<=', true]] as const)('compares touching intervals with %s', (operator, expected) => {
    expect(intervals.intervalCompare(operator, range(0n, 1n), range(1n, 2n))).toBe(expected);
  });
  it('has nontransitive equality and disjoint inequality', () => {
    const a = range(0n, 1n);
    const b = { nominal: rational(1n), lo: rational(1n, 2n), hi: rational(3n, 2n) };
    const c = { nominal: rational(7n, 4n), lo: rational(5n, 4n), hi: rational(9n, 4n) };
    expect(intervals.intervalCompare('=', a, b)).toBe(true); expect(intervals.intervalCompare('=', b, c)).toBe(true);
    expect(intervals.intervalCompare('=', a, c)).toBe(false); expect(intervals.intervalCompare('!=', a, c)).toBe(true);
  });
  it('permits both greater and less, and does not rewrite not(greater) as less-or-equal', () => {
    const a = range(0n, 2n), b = range(1n, 3n);
    expect(intervals.intervalCompare('>', a, b)).toBe(true); expect(intervals.intervalCompare('<', a, b)).toBe(true);
    expect(!intervals.intervalCompare('>', a, b)).toBe(false); expect(intervals.intervalCompare('<=', a, b)).toBe(true);
  });
  it('compares point intervals as exact rationals', () => {
    expect(intervals.intervalCompare('=', point(1n, 3n), point(2n, 6n))).toBe(true);
    expect(intervals.intervalCompare('=', point(1n, 3n), point(33n, 100n))).toBe(false);
    expect(intervals.intervalCompare('>', point(1n, 3n), point(33n, 100n))).toBe(true);
  });
});
