import { describe, expect, it } from 'vitest';
import { logicalAnd, logicalOr, logicalNot, isNull, nvl, applyDefault, sumValues } from '../src/evaluator/nulls.js';
import type { BooleanScalar, NullScalar, NumericScalar, ScalarValue } from '../src/evaluator/value.js';
import { contextualUnits, divideUnits, formatUnit, multiplyUnits, parseUnit, unitsEqual } from '../src/numeric/units.js';
import { NumericError, rational } from '../src/numeric/rational.js';
import type { DefaultLiteral } from '../src/ast/ast.js';

const span = { start: 0, end: 1, line: 1, column: 0 };
const number = (n: bigint, unit = 'pure', literal = false): NumericScalar => ({ kind: 'number', nominal: rational(n), lo: rational(n), hi: rational(n), unit: parseUnit(unit), literal });
const bool = (value: boolean): BooleanScalar => ({ kind: 'boolean', value });
const nil = (origin: 'explicit' | 'implicit' | 'derived' = 'explicit', unit = 'pure'): NullScalar => ({ kind: 'null', origin, dataType: 'number', unit: parseUnit(unit) });
const nilBool: NullScalar = { kind: 'null', origin: 'implicit', dataType: 'boolean' };
const unknown = { kind: 'unknown' } as const;
const defaultNumber = (lexeme: string): DefaultLiteral => ({ kind: 'number', lexeme, span });
function failure(run: () => unknown, code: string) {
  expect(run).toThrowError(expect.objectContaining({ code }));
}

describe('typed truth primitives', () => {
  const cases: [boolean | null, boolean | null, boolean | null, boolean | null][] = [
    [true, true, true, true], [true, false, false, true], [true, null, null, true],
    [false, true, false, true], [false, false, false, false], [false, null, false, null],
    [null, true, null, true], [null, false, false, null], [null, null, null, null],
  ];
  it.each(cases)('uses Kleene logic for %s and %s', (a, b, and, or) => {
    const left = a === null ? nilBool : bool(a), right = b === null ? nilBool : bool(b);
    for (const [actual, expected] of [[logicalAnd(left, right), and], [logicalOr(left, right), or]] as const) {
      expect(actual).toMatchObject(expected === null ? { kind: 'null', dataType: 'boolean', origin: 'derived' } : { kind: 'boolean', value: expected });
    }
  });
  it.each([true, false])('negates boolean %s', value => { expect(logicalNot(bool(value))).toEqual(bool(!value)); });
  it('preserves null and unknown distinctions under not', () => {
    expect(logicalNot(nilBool)).toMatchObject({ kind: 'null', dataType: 'boolean' });
    expect(logicalNot(unknown)).toEqual(unknown);
  });
  it('determines false-and/true-or for missing metadata in either position', () => {
    expect(logicalAnd(bool(false), unknown)).toEqual(bool(false)); expect(logicalAnd(unknown, bool(false))).toEqual(bool(false));
    expect(logicalOr(bool(true), unknown)).toEqual(bool(true)); expect(logicalOr(unknown, bool(true))).toEqual(bool(true));
  });
  it('keeps undecidable unknown instead of converting it to fact null', () => {
    expect(logicalAnd(bool(true), unknown)).toEqual(unknown); expect(logicalOr(bool(false), unknown)).toEqual(unknown);
    expect(logicalAnd(nilBool, unknown)).toEqual(unknown); expect(logicalOr(unknown, nilBool)).toEqual(unknown);
  });
  it.each([number(0n), number(1n), nil()])('rejects nonboolean operands even when the other value could decide', value => {
    failure(() => logicalAnd(bool(false), value), 'TYPE_MISMATCH'); failure(() => logicalOr(bool(true), value), 'TYPE_MISMATCH');
    failure(() => logicalNot(value), 'TYPE_MISMATCH');
  });
});

describe('typed null substitution', () => {
  it('identifies explicit and implicit fact nulls without treating zero, false, or unknown as null', () => {
    expect(isNull(nil('explicit'))).toEqual(bool(true)); expect(isNull(nil('implicit'))).toEqual(bool(true));
    expect(isNull(number(0n))).toEqual(bool(false)); expect(isNull(bool(false))).toEqual(bool(false));
    expect(isNull(unknown)).toEqual(unknown);
  });
  it('nvl substitutes only actual nulls and preserves zero and false', () => {
    expect(nvl(nil(), number(7n))).toMatchObject({ kind: 'number', nominal: rational(7n) });
    expect(nvl(number(0n), number(7n))).toMatchObject({ kind: 'number', nominal: rational(0n) });
    expect(nvl(bool(false), bool(true))).toEqual(bool(false)); expect(nvl(nilBool, bool(true))).toEqual(bool(true));
  });
  it('nvl validates both branches before returning a known first branch', () => {
    failure(() => nvl(number(1n), bool(true)), 'TYPE_MISMATCH'); failure(() => nvl(nil(), bool(true)), 'TYPE_MISMATCH');
    failure(() => nvl(bool(true), nil()), 'TYPE_MISMATCH');
  });
  it('nvl keeps unknown metadata unknown instead of using its fallback', () => {
    expect(nvl(unknown, bool(true))).toEqual(unknown); expect(isNull(nvl(unknown, bool(false)))).toEqual(unknown);
  });
  it('adopts EUR for a fallback literal with typed null and with a known number', () => {
    const zero = number(0n, 'pure', true);
    expect(nvl(nil('implicit', 'EUR'), zero)).toMatchObject({ kind: 'number', nominal: rational(0n), unit: { EUR: 1 }, literal: false });
    expect(nvl(number(7n, 'EUR'), zero)).toMatchObject({ kind: 'number', nominal: rational(7n), unit: { EUR: 1 }, literal: false });
    expect(zero.unit).toEqual({}); expect(zero.literal).toBe(true);
  });
  it('also contextualizes a first-branch literal, and keeps two literals pure', () => {
    expect(nvl(number(0n, 'pure', true), nil('explicit', 'EUR'))).toMatchObject({ unit: { EUR: 1 }, literal: false });
    expect(nvl(number(1n, 'pure', true), number(2n, 'pure', true))).toMatchObject({ unit: {} });
  });
  it('does not promote a pure fact or convert a USD fallback to EUR', () => {
    failure(() => nvl(nil('explicit', 'EUR'), number(0n, 'USD')), 'UNIT_MISMATCH');
    failure(() => nvl(number(1n, 'EUR'), number(2n, 'USD')), 'UNIT_MISMATCH');
    failure(() => nvl(nil('implicit', 'EUR'), number(0n)), 'UNIT_MISMATCH');
  });
  it('consumes contextual-literal status, including when adopting a known pure unit', () => {
    const adopted = nvl(nil('implicit', 'pure'), number(0n, 'pure', true));
    expect(adopted).toMatchObject({ kind: 'number', unit: {}, literal: false });
    failure(() => nvl(nil('explicit', 'EUR'), adopted), 'UNIT_MISMATCH');
  });
  it('preserves default absence and explicit default:null, replacing only missing values', () => {
    const source = nil('implicit', 'EUR');
    expect(applyDefault(source)).toEqual(source);
    expect(applyDefault(source, { kind: 'null', lexeme: 'null', span })).toEqual(source);
    expect(applyDefault(number(0n, 'EUR'), defaultNumber('7'))).toMatchObject({ nominal: rational(0n), unit: { EUR: 1 } });
  });
  it('uses exact point defaults with coordinate units and the negative token spelling', () => {
    expect(applyDefault(nil('implicit', 'EUR'), defaultNumber('(-1)'))).toMatchObject({ kind: 'number', nominal: rational(-1n),
      lo: rational(-1n), hi: rational(-1n), unit: { EUR: 1 }, literal: false });
    expect(applyDefault(nilBool, { kind: 'boolean', value: false, lexeme: 'false', span })).toEqual(bool(false));
  });
  it('does not apply default to unknown metadata or rescue an invalid coordinate type', () => {
    expect(applyDefault(unknown, { kind: 'boolean', value: true, lexeme: 'true', span })).toEqual(unknown);
    failure(() => applyDefault(nil(), { kind: 'boolean', value: false, lexeme: 'false', span }), 'TYPE_MISMATCH');
    failure(() => applyDefault(nilBool, defaultNumber('0')), 'TYPE_MISMATCH');
  });
  it('does not treat non-value errors as a known value or fact null', () => {
    const error = new NumericError('DIVISION_BY_ZERO') as unknown as ScalarValue;
    failure(() => isNull(error), 'TYPE_MISMATCH'); failure(() => nvl(error, number(1n)), 'TYPE_MISMATCH');
    failure(() => applyDefault(error, defaultNumber('0')), 'TYPE_MISMATCH');
  });
});

describe('sum primitives', () => {
  it('excludes fact nulls and sums nominal and endpoints independently', () => {
    const a: NumericScalar = { ...number(2n, 'EUR'), lo: rational(1n), hi: rational(3n) };
    const b: NumericScalar = { ...number(4n, 'EUR'), lo: rational(3n), hi: rational(5n) };
    expect(sumValues([nil('explicit', 'EUR'), a, nil('implicit', 'EUR'), b])).toMatchObject({ diagnostics: [],
      value: { kind: 'number', nominal: rational(6n), lo: rational(4n), hi: rational(8n), unit: { EUR: 1 }, literal: false } });
  });
  it.each([{ values: [] }, { values: [nil()] }, { values: [nil('explicit', 'EUR'), nil('implicit', 'EUR')] }])('returns derived null and an explicit empty diagnostic', ({ values }) => {
    const result = sumValues(values);
    expect(result.value).toMatchObject({ kind: 'null', origin: 'derived', dataType: 'number' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'EMPTY_AGGREGATION' }));
    expect(isNull(result.value)).toEqual(bool(true));
  });
  it('keeps zero a real aggregation and unknown distinct from an empty set', () => {
    expect(sumValues([number(0n)])).toMatchObject({ value: { kind: 'number', nominal: rational(0n) }, diagnostics: [] });
    expect(sumValues([unknown, number(1n)]).value).toEqual(unknown);
  });
  it('rejects incompatible values instead of skipping them like null', () => {
    failure(() => sumValues([bool(false)]), 'TYPE_MISMATCH'); failure(() => sumValues([nilBool]), 'TYPE_MISMATCH');
    failure(() => sumValues([number(1n, 'EUR'), number(1n, 'USD')]), 'UNIT_MISMATCH');
  });
  it('propagates numeric quota errors without returning an empty/null result', () => {
    const maximum = (1n << 4096n) - 1n;
    failure(() => sumValues([number(maximum), number(1n)]), 'RESOURCE_LIMIT');
  });
  it('does not mutate inputs or their units', () => {
    const value = number(2n, 'EUR'); Object.freeze(value.unit); Object.freeze(value);
    const before = { ...value }; const result = sumValues([value, nil('implicit', 'EUR')]);
    expect(value).toEqual(before); expect(result.value).not.toBe(value);
  });
});

describe('canonical units', () => {
  it.each(['pure', 'EUR', 'EUR*SHARE^-1', 'A1_2^-8*USD^8'])('roundtrips %s', text => {
    expect(formatUnit(parseUnit(text))).toBe(text);
  });
  it.each(['', 'eur', ' EUR', 'EUR ', 'EUR/USD', 'USD*EUR', 'EUR*EUR', 'EUR^0', 'EUR^1', 'EUR^01', 'EUR^9',
    'EUR^-9', 'EUR^+2', 'pure*EUR', 'EUR**USD', '1EUR', '_EUR', 'ABCDEFGHIJKLMNOPQ'])('rejects noncanonical input %s', text => {
    failure(() => parseUnit(text), 'INVALID_UNIT');
  });
  it('compares maps independent of property insertion order, preserving currencies', () => {
    expect(unitsEqual({ USD: -1, EUR: 1 }, { EUR: 1, USD: -1 })).toBe(true);
    expect(unitsEqual({ EUR: 1 }, { USD: 1 })).toBe(false);
    expect(formatUnit({ USD: -1, EUR: 2 })).toBe('EUR^2*USD^-1');
  });
  it('adds/subtracts exponents and removes cancelled atoms without mutating operands', () => {
    const left = Object.freeze({ EUR: 1, SHARE: -1 }), right = Object.freeze({ SHARE: 1 });
    expect(multiplyUnits(left, right)).toEqual({ EUR: 1 });
    expect(divideUnits({ EUR: 1 }, { EUR: 1 })).toEqual({});
    expect(divideUnits({ EUR: 1 }, { USD: 1 })).toEqual({ EUR: 1, USD: -1 });
    expect(left).toEqual({ EUR: 1, SHARE: -1 });
  });
  it('allows bounded derived exponents beyond the workbook input range, then cancellation', () => {
    const squared = multiplyUnits(parseUnit('EUR^8'), parseUnit('EUR^8'));
    expect(squared).toEqual({ EUR: 16 }); expect(divideUnits(squared, parseUnit('EUR^8'))).toEqual({ EUR: 8 });
  });
  it.each(['+', '-', '=', '!=', '<', '<=', '>', '>=', 'nvl'] as const)('promotes and consumes an actual literal for %s', operator => {
    expect(contextualUnits(operator, {}, { EUR: 1 }, true, false)).toMatchObject({ left: { EUR: 1 }, right: { EUR: 1 }, result: { EUR: 1 }, leftLiteral: false, resultLiteral: false });
    expect(contextualUnits(operator, { EUR: 1 }, {}, false, true)).toMatchObject({ left: { EUR: 1 }, right: { EUR: 1 }, rightLiteral: false });
  });
  it('does not promote a fact with a pure unit and rejects cross-currency comparisons', () => {
    failure(() => contextualUnits('+', {}, { EUR: 1 }), 'UNIT_MISMATCH');
    failure(() => contextualUnits('=', { EUR: 1 }, { USD: 1 }), 'UNIT_MISMATCH');
  });
  it('keeps literal factors pure instead of adopting the other operand unit', () => {
    expect(contextualUnits('*', { EUR: 1 }, {}, false, true)).toMatchObject({ left: { EUR: 1 }, right: {}, result: { EUR: 1 } });
    expect(contextualUnits('/', {}, { EUR: 1 }, true, false)).toMatchObject({ result: { EUR: -1 } });
  });
});
