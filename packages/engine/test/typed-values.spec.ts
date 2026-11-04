import { describe, expect, it } from 'vitest';
import { LANGUAGE_PROFILE_V1, LANGUAGE_PROFILE_V2, type Coordinate, type ReportedFact } from '@ce/contracts';
import { evaluate, parseRule, valueToDTO } from '../src/index.js';
import { coordinate, fact, ref, report } from './helpers/report-fixture.js';

const profileId = LANGUAGE_PROFILE_V2;
const typedCell = (dataType: 'text' | 'date', row = '0010'): Coordinate => ({ ...coordinate({ row }), dataType, unit: '', decimals: '' });
const typedFact = (cell: Coordinate, value: string): ReportedFact => ({ ...fact(cell, null), presence: 'value', originalText: value, normalizedValue: { kind: cell.dataType as 'text' | 'date', value } });
function evaluation(source: string, input = report([])) {
  const parsed = parseRule(source, { profileId }); expect(parsed.ast, JSON.stringify(parsed.diagnostics)).toBeDefined();
  return evaluate(parsed.ast!, { report: input, binding: { contextId: 'demo' }, ...{ profileId } });
}
function failure(source: string, input = report([]), code = 'TYPE_MISMATCH') {
  const parsed = parseRule(source, { profileId });
  const diagnostics = parsed.ast ? evaluation(source, input).diagnostics : parsed.diagnostics;
  expect(diagnostics).toContainEqual(expect.objectContaining({ code }));
}

describe('v2 exact text and civil-date values', () => {
  it.each(['', 'Banco', 'Banco ', ' banco', 'é', 'e\u0301', 'line\nnext', '=SUM(A1:A2)', '\\n'])('preserves the exact literal %j without inventing escapes', value => {
    const result = evaluation(`"${value}"='${value}'`); expect(result.value).toEqual({ kind: 'boolean', value: true });
    expect(valueToDTO(result.operands!.left!)).toMatchObject({ kind: 'text', value }); expect(result.readKeys).toEqual([]);
  });
  it.each([['Banco', 'banco'], ['Banco', 'Banco '], ['é', 'e\u0301']])('does not normalize %s and %s', (a, b) => {
    expect(evaluation(`"${a}"="${b}"`).value).toEqual({ kind: 'boolean', value: false });
    expect(evaluation(`"${a}"!="${b}"`).value).toEqual({ kind: 'boolean', value: true });
  });
  it.each(['<', '<=', '>', '>=', '+', '-', '*', '/'])('rejects text operator %s even for two literals', op => failure(`isnull("a"${op}"b")`));
  it.each(['"5"=5', '#2025-01-01#="2025-01-01"', 'true=1', 'sum("x")=0', 'nvl("x",1)="x"'])('rejects coercion or numeric-only use: %s', source => failure(source));
  it.each(['0001-01-01', '9999-12-31', '2000-02-29', '2024-02-29'])('accepts civil date %s without timezones', date => {
    const result = evaluation(`#${date}#=#${date}#`); expect(result.value).toEqual({ kind: 'boolean', value: true });
    expect(valueToDTO(result.operands!.left!)).toEqual({ kind: 'date', value: date });
  });
  it.each(['0000-01-01', '2025-02-29', '1900-02-29', '2025-04-31', '2025-01-00'])('rejects syntactically recognized impossible date %s', date => {
    const parsed = parseRule(`#${date}#=#2025-01-01#`, { profileId }); expect(parsed.syntaxStatus).toBe('valid');
    expect(parsed.ast).toBeUndefined(); expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: 'INVALID_DATE' }));
  });
  it.each([['=', false], ['!=', true], ['<', true], ['<=', true], ['>', false], ['>=', false]] as const)('compares civil dates using %s', (op, expected) => {
    expect(evaluation(`#0001-01-01#${op}#9999-12-31#`).value).toEqual({ kind: 'boolean', value: expected });
  });
  it.each(['#2025-12-31T12:00:00#=#2025-12-31#', '#2025M01#=#2025M01#', '#2025-01-01/2025-02-01#=#2025-01-01/2025-02-01#'])('does not enable unsupported temporal constructs: %s', source => {
    const parsed = parseRule(source, { profileId }); expect(parsed.syntaxStatus).toBe('valid'); expect(parsed.supportStatus).toBe('unsupported');
    expect(parsed.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' }));
  });
  it.each(['text', 'date'] as const)('reads %s facts, preserves null provenance and supports isnull/nvl/default', kind => {
    const cell = typedCell(kind), missing = typedCell(kind, '0020'), value = kind === 'text' ? '' : '2024-02-29';
    const literal = kind === 'text' ? '""' : '#2024-02-29#', data = report([cell, missing], [typedFact(cell, value)]);
    expect(evaluation(`${ref(cell)}=${literal}`, data).value).toEqual({ kind: 'boolean', value: true });
    expect(evaluation(`isnull(${ref(cell)})`, data).value).toEqual({ kind: 'boolean', value: false });
    expect(evaluation(`isnull(${ref(missing)})`, data).value).toEqual({ kind: 'boolean', value: true });
    expect(evaluation(`nvl(${ref(missing)},${literal})=${literal}`, data).value).toEqual({ kind: 'boolean', value: true });
    expect(evaluation(`with {default:${literal}}: ${ref(missing)}=${literal}`, data).value).toEqual({ kind: 'boolean', value: true });
    const preserved = evaluation(`with {default:null}: ${ref(missing)}=${literal}`, data);
    expect(preserved.value).toMatchObject({ kind: 'null', dataType: 'boolean' }); expect(preserved.readKeys).toEqual([missing.factKey]);
    const explicit = evaluation(`isnull(${ref(missing)})`, report([missing], [fact(missing, null)])); expect(explicit.value).toEqual({ kind: 'boolean', value: true });
    failure(`with {default:0}: ${ref(cell)}=${literal}`, data); failure(`with {interval:true}: ${ref(cell)}=${literal}`, data);
    expect(evaluation(`with {interval:false}: ${ref(cell)}=${literal}`, data).value).toEqual({ kind: 'boolean', value: true });
  });
  it('rejects a numeric/date/text root discovered only after resolving its coordinate', () => {
    for (const kind of ['text', 'date'] as const) { const cell = typedCell(kind); failure(ref(cell), report([cell], [typedFact(cell, kind === 'text' ? 'x' : '2025-01-01')])); }
  });
  it.each(['"x"="x"', '""=""', '#2025-01-01#=#2025-01-01#', 'if true then true else false endif', 'with {default:"x"}: true'])('keeps new AST constructs out of v1: %s', source => {
    expect(parseRule(source, { profileId: LANGUAGE_PROFILE_V1 }).supportStatus).toBe('unsupported');
    const parsed = parseRule(source, { profileId }); expect(parsed.ast).toBeDefined();
    const result = evaluate(parsed.ast!, { report: report([]), binding: { contextId: 'demo' } });
    expect(result.value).toBeUndefined(); expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNSUPPORTED_CONSTRUCT' }));
  });
});
