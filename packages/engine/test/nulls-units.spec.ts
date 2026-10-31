import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/evaluator/evaluate.js';
import { context, coordinate, fact, fraction, INDICATOR_LOCATOR, operand, ref, report, rule } from './helpers/report-fixture.js';

describe('fact nulls and typed fallbacks', () => {
  const explicit = coordinate({ row: '0010' }); const implicit = coordinate({ row: '0020' }); const zero = coordinate({ row: '0030' });
  const input = report([explicit, implicit, zero], [fact(explicit, null), fact(zero, '0')]);
  const env = { report: input, binding: { contextId: 'demo' } };

  it('keeps explicit and implicit null origins distinct and reads their actual keys', () => {
    const a = evaluate(operand(ref(explicit)), env); const b = evaluate(operand(ref(implicit)), env);
    expect(a.value).toMatchObject({ kind: 'null', origin: 'explicit' }); expect(a.readKeys).toEqual([explicit.factKey]);
    expect(b.value).toMatchObject({ kind: 'null', origin: 'implicit' }); expect(b.readKeys).toEqual([implicit.factKey]);
  });
  it('keeps numeric zero present, including through nvl and isnull', () => {
    expect(evaluate(operand(ref(zero)), env).value).toMatchObject({ kind: 'number', nominal: fraction(0n) });
    expect(evaluate(operand(`nvl(${ref(zero)},7)`), env).value).toMatchObject({ kind: 'number', nominal: fraction(0n) });
    expect(evaluate(rule(`isnull(${ref(zero)})`), env).value).toMatchObject({ kind: 'boolean', value: false });
  });
  it.each([explicit, implicit])('applies isnull and nvl to either kind of fact null', cell => {
    expect(evaluate(rule(`isnull(${ref(cell)})`), env).value).toMatchObject({ kind: 'boolean', value: true });
    expect(evaluate(operand(`nvl(${ref(cell)},7)`), env).value).toMatchObject({ kind: 'number', nominal: fraction(7n) });
  });
  it.each(['+', '-', '*', '/'])('propagates fact null through arithmetic %s', op => {
    expect(evaluate(operand(`${ref(implicit)} ${op} 2`), env).value).toMatchObject({ kind: 'null' });
  });
  it.each(['=', '!=', '<', '<=', '>', '>='])('propagates fact null through comparison %s', op => {
    expect(evaluate(rule(`${ref(explicit)} ${op} 2`), env).value).toMatchObject({ kind: 'null' });
  });
  it('uses default only for null and keeps explicit default:null intact', () => {
    expect(evaluate(operand('{tT,r0020,c0010,default:7}'), env).value).toMatchObject({ kind: 'number', nominal: fraction(7n) });
    expect(evaluate(operand('{tT,r0030,c0010,default:7}'), env).value).toMatchObject({ kind: 'number', nominal: fraction(0n) });
    expect(evaluate(operand('{tT,r0010,c0010,default:null}'), env).value).toMatchObject({ kind: 'null', origin: 'explicit' });
  });
  it.each(['{tT,r9999,c0010}', '{tT,r9999,c0010,default:0}', 'nvl({tT,r9999,c0010},0)', 'isnull({tT,r9999,c0010})'])
    ('does not convert an invalid coordinate to a fact null: %s', source => {
      const result = evaluate(operand(source), env);
      expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COORDINATE' }));
    });
  it.each(['nvl(1/0,1)', 'isnull(1/0)'])('does not conceal arithmetic errors with %s', source => {
    const result = evaluate(operand(source), env);
    expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'DIVISION_BY_ZERO' }));
  });
  it('preserves parenthesized negative integer lexemes and explicit group nodes during evaluation', () => {
    expect(evaluate(operand('(-1)'), env).value).toMatchObject({ kind: 'number', nominal: fraction(-1n) });
    expect(evaluate(operand('((1/3)*3)'), env).value).toMatchObject({ kind: 'number', nominal: fraction(1n) });
  });
});

describe('Kleene boolean semantics for fact nulls', () => {
  const cases: [boolean | null, boolean | null, boolean | null, boolean | null][] = [
    [true, true, true, true], [true, false, false, true], [true, null, null, true],
    [false, true, false, true], [false, false, false, false], [false, null, false, null],
    [null, true, null, true], [null, false, false, null], [null, null, null, null],
  ];
  it.each(cases)('evaluates A=%s B=%s without truthiness coercion', (a, b, expectedAnd, expectedOr) => {
    const left = coordinate({ row: '0010', dataType: 'boolean' }); const right = coordinate({ row: '0020', dataType: 'boolean' });
    const env = { report: report([left, right], [fact(left, a), fact(right, b)]), binding: { contextId: 'demo' } };
    for (const [op, expected] of [['and', expectedAnd], ['or', expectedOr]] as const) {
      const result = evaluate(rule(`${ref(left)} ${op} ${ref(right)}`), env);
      if (expected === null) expect(result.value).toMatchObject({ kind: 'null' });
      else expect(result.value).toMatchObject({ kind: 'boolean', value: expected });
      expect(new Set(result.readKeys)).toEqual(new Set([left.factKey, right.factKey]));
    }
  });
  it('keeps not(null) null and a boolean default:false distinct from absence', () => {
    const cell = coordinate({ dataType: 'boolean' }); const env = { report: report([cell]), binding: { contextId: 'demo' } };
    expect(evaluate(rule(`not(${ref(cell)})`), env).value).toMatchObject({ kind: 'null' });
    expect(evaluate(rule('not({tT,r0010,c0010,default:false})'), env).value).toMatchObject({ kind: 'boolean', value: true });
  });
});

describe('finite sum and empty aggregation', () => {
  const cells = ['0010', '0020', '0030', '0040'].map(row => coordinate({ row }));
  it('excludes explicit and implicit nulls, while summing known values exactly', () => {
    const env = { report: report(cells, [fact(cells[0]!, '1'), fact(cells[1]!, null), fact(cells[3]!, '2')]), binding: { contextId: 'demo' } };
    const result = evaluate(operand('sum({tT,r0010-0040,c0010})'), env);
    expect(result.value).toMatchObject({ kind: 'number', nominal: fraction(3n), unit: {} });
    expect(new Set(result.readKeys)).toEqual(new Set(cells.map(cell => cell.factKey)));
  });
  it.each(['sum({tT,r0010-0040,c0010})', 'sum({tT,r0070-0080,c0010})'])('returns null, not zero, for %s without known values', source => {
    const env = { report: report(cells, [fact(cells[0]!, null)]), binding: { contextId: 'demo' } };
    const result = evaluate(operand(source), env);
    expect(result.value).toMatchObject({ kind: 'null', origin: 'derived' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'EMPTY_AGGREGATION' }));
    const outer = evaluate(rule(`isnull(${source})`), env);
    expect(outer.value).toMatchObject({ kind: 'boolean', value: true });
    expect(outer.diagnostics).toContainEqual(expect.objectContaining({ code: 'EMPTY_AGGREGATION' }));
  });
  it('does not treat a missing table as an empty aggregation', () => {
    const result = evaluate(operand('sum({tABSENT,r0010-0040,c0010})'), { report: report(cells), binding: { contextId: 'demo' } });
    expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COORDINATE' }));
  });
});

describe('units and coordinate-dependent types', () => {
  const eur = coordinate({ row: '0010', unit: 'EUR' }); const usd = coordinate({ row: '0020', unit: 'USD' });
  const pure = coordinate({ row: '0030' }); const flag = coordinate({ row: '0040', dataType: 'boolean' });
  const input = report([eur, usd, pure, flag], [fact(eur, '3'), fact(usd, '2'), fact(pure, '1'), fact(flag, true)]);
  const env = { report: input, binding: { contextId: 'demo' } };

  it.each([`${ref(eur)}+2`, `2+${ref(eur)}`])('promotes an actual numeric literal for contextual addition: %s', source => {
    expect(evaluate(operand(source), env).value).toMatchObject({ kind: 'number', nominal: fraction(5n), unit: { EUR: 1 } });
  });
  it.each([`${ref(eur)}>0`, `0<${ref(eur)}`, `${ref(eur)}=3`])('promotes literals in comparisons: %s', source => {
    expect(evaluate(rule(source), env).value).toMatchObject({ kind: 'boolean', value: true });
  });
  it('treats literal factors/divisors as pure and composes unit exponents for facts', () => {
    expect(evaluate(operand(`${ref(eur)}*2`), env).value).toMatchObject({ kind: 'number', nominal: fraction(6n), unit: { EUR: 1 } });
    expect(evaluate(operand(`${ref(eur)}/2`), env).value).toMatchObject({ kind: 'number', nominal: fraction(3n, 2n), unit: { EUR: 1 } });
    expect(evaluate(operand(`${ref(eur)}*${ref(eur)}`), env).value).toMatchObject({ kind: 'number', nominal: fraction(9n), unit: { EUR: 2 } });
    expect(evaluate(operand(`${ref(eur)}/${ref(usd)}`), env).value).toMatchObject({ kind: 'number', nominal: fraction(3n, 2n), unit: { EUR: 1, USD: -1 } });
    expect(evaluate(operand(`${ref(eur)}/${ref(eur)}`), env).value).toMatchObject({ kind: 'number', nominal: fraction(1n), unit: {} });
  });
  it.each([`${ref(eur)}+${ref(usd)}`, `${ref(eur)}-${ref(usd)}`, `${ref(eur)}=${ref(usd)}`, `${ref(eur)}+${ref(pure)}`])
    ('rejects incompatible fact units and does not relabel a pure fact as a literal: %s', source => {
      const result = evaluate(operand(source), env);
      expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNIT_MISMATCH' }));
    });
  it('lets numeric default adopt the coordinate unit and keeps the literal exact', () => {
    const result = evaluate(operand('{tT,r0010,c0010,default:0,interval:true}'), { report: report([eur]), binding: { contextId: 'demo' } });
    expect(result.value).toMatchObject({ kind: 'number', nominal: fraction(0n), lo: fraction(0n), hi: fraction(0n), unit: { EUR: 1 } });
  });
  it.each([`${ref(eur)} and true`, `${ref(flag)}+1`, `${ref(eur)}=${ref(flag)}`, `nvl(${ref(eur)},${ref(flag)})`])
    ('rejects incompatible coordinate types after metadata resolution: %s', source => {
      const result = evaluate(operand(source), env);
      expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
    });
  it('rejects a default of the wrong coordinate type', () => {
    const result = evaluate(operand('{tT,r0010,c0010,default:false}'), { report: report([eur]), binding: { contextId: 'demo' } });
    expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'TYPE_MISMATCH' }));
  });
});

describe('filing indicators remain metadata, separate from null facts', () => {
  it.each([true, false])('returns explicitly declared %s even without any Facts or Coordinates', value => {
    const ctx = context({ filingIndicators: { 'C_01.00': value } });
    const result = evaluate(rule('{v_C_01.00}'), { report: report([], [], [ctx]), binding: { contextId: 'demo' } });
    expect(result.value).toMatchObject({ kind: 'boolean', value }); expect(result.readKeys).toEqual([]);
    expect(result.metadataReads).toContainEqual(expect.objectContaining({ contextId: 'demo', code: 'C_01.00', presence: 'declared', value, sourceLocator: INDICATOR_LOCATOR }));
  });
  it('does not infer an undeclared indicator from a nonzero fact or a declared coordinate', () => {
    const cell = coordinate({ table: 'C_01.00' });
    const result = evaluate(rule('{v_C_01.00}'), { report: report([cell], [fact(cell, '100')]), binding: { contextId: 'demo' } });
    expect(result.value).toMatchObject({ kind: 'unknown' }); expect(result.readKeys).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_FILING_INDICATOR' }));
    expect(result.metadataReads).toContainEqual(expect.objectContaining({ code: 'C_01.00', presence: 'missing', sourceLocator: INDICATOR_LOCATOR }));
  });
  it('looks only in the selected context, without a first match from another module', () => {
    const selected = context({ contextId: 'selected' }); const other = context({ contextId: 'other', moduleVersion: 'OTHER', filingIndicators: { 'C_01.00': true } });
    const result = evaluate(rule('{v_C_01.00}'), { report: report([], [], [other, selected]), binding: { contextId: 'selected' } });
    expect(result.value).toMatchObject({ kind: 'unknown' });
    expect(result.metadataReads).toContainEqual(expect.objectContaining({ contextId: 'selected', code: 'C_01.00', presence: 'missing' }));
  });
  it.each(['{v_C_01.00}', 'nvl({v_C_01.00},true)', 'isnull({v_C_01.00})'])('cannot substitute missing metadata through scope or functions: %s', expression => {
    const result = evaluate(rule(`with {tT,r0010,c0010,default:true,interval:true}: ${expression}`), {
      report: report([coordinate()]), binding: { contextId: 'demo' },
    });
    expect(result.value).toMatchObject({ kind: 'unknown' }); expect(result.readKeys).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_FILING_INDICATOR' }));
  });
  it('does not inherit coordinate axes/options for a declared indicator', () => {
    const ctx = context({ filingIndicators: { 'C_01.00': true } });
    const result = evaluate(rule('with {tT,r0010,c0010,sA,default:false,interval:true}: {v_C_01.00}'), {
      report: report([], [], [ctx]), binding: { contextId: 'demo' },
    });
    expect(result.value).toMatchObject({ kind: 'boolean', value: true }); expect(result.readKeys).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });
  it.each([
    ['false and {v_MISSING}', false], ['{v_MISSING} and false', false],
    ['true or {v_MISSING}', true], ['{v_MISSING} or true', true],
  ] as const)('determines %s while preserving the absent metadata in its trace', (expression, expected) => {
    const result = evaluate(rule(expression), { report: report([]), binding: { contextId: 'demo' } });
    expect(result.value).toMatchObject({ kind: 'boolean', value: expected }); expect(result.readKeys).toEqual([]);
    expect(result.metadataReads).toContainEqual(expect.objectContaining({ contextId: 'demo', code: 'MISSING', presence: 'missing', sourceLocator: INDICATOR_LOCATOR }));
  });
  it.each(['true and {v_MISSING}', 'false or {v_MISSING}', 'not({v_MISSING})'])('retains undecidable metadata as unknown for %s', expression => {
    const result = evaluate(rule(expression), { report: report([]), binding: { contextId: 'demo' } });
    expect(result.value).toMatchObject({ kind: 'unknown' });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'MISSING_FILING_INDICATOR' }));
  });
});
