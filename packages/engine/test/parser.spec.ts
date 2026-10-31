import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@ce/contracts';
import { parseRule } from '../src/parser/parse-rule.js';

const G113 = 'with{tC_18.00, c0060, s*, default: 0, interval: true}: {r0011} = {r0020} + {r0210}';
const G169 = 'with {default: 0, interval: true}: {tC_01.00, r0230, c0010} = {tC_05.01, r0090, c0060}';
const ref = '{tC_01.00,r0230,c0010}';
function body(text: string) {
  const result = parseRule(text);
  expect(result.diagnostics).toEqual([]);
  expect(result.syntaxStatus).toBe('valid');
  expect(result.supportStatus).toBe('supported');
  expect(result.ast).toBeDefined();
  return result.ast!.body;
}

describe('closed DPM-XL parser', () => {
  it('retains real G113 scope, partial cells and a sheet binding without resolving them', () => {
    expect(body(G113)).toMatchObject({ kind: 'with', scope: {
      tableCode: 'C_18.00', column: { kind: 'single', code: '0060' }, sheet: { kind: 'all' },
      default: { kind: 'number', lexeme: '0' }, interval: true,
    }, body: { kind: 'binary', op: '=', left: { kind: 'reference', selection: { row: { code: '0011' } } },
      right: { kind: 'binary', op: '+' } } });
  });

  it('retains independent table references in G169', () => {
    expect(body(G169)).toMatchObject({ kind: 'with', body: { kind: 'binary',
      left: { selection: { tableCode: 'C_01.00', row: { code: '0230' }, column: { code: '0010' } } },
      right: { selection: { tableCode: 'C_05.01', row: { code: '0090' }, column: { code: '0060' } } },
    } });
  });

  it.each(['{v_C_18.00} ', '{v_C_01.00} and {v_C_05.01}'])('accepts the original filing precondition %s', text => {
    expect(parseRule(text).supportStatus).toBe('supported');
    expect(parseRule(text).ast?.source).toBe(text);
  });
  it('keeps filing indicator code exact and separate from coordinate selections', () => {
    expect(body('{v_C_07.00.a}')).toMatchObject({ kind: 'filing_indicator', code: 'C_07.00.a' });
  });

  it('preserves ANTLR precedence and distinct comparison operator contexts', () => {
    expect(body('1 + 2 * 3 >= 7 and not(false) or true')).toMatchObject({ kind: 'binary', op: 'or',
      left: { kind: 'binary', op: 'and', left: { kind: 'binary', op: '>=', left: { op: '+', right: { op: '*' } } },
        right: { kind: 'unary', op: 'not' } }, right: { kind: 'boolean', value: true } });
  });
  it.each(['=', '!=', '<', '<=', '>', '>='])('accepts comparison %s', op => {
    expect(body(`1 ${op} 2`)).toMatchObject({ kind: 'binary', op });
  });
  it('preserves left associativity and explicit grouping', () => {
    expect(body('(8 / 2 / 2) = 2')).toMatchObject({ left: { kind: 'group', expression: {
      kind: 'binary', op: '/', left: { kind: 'binary', op: '/' },
    } } });
  });
  it('accepts nvl, isnull, and finite sum selections', () => {
    expect(body(`isnull(nvl(${ref},0)) or sum({tC_01.00,r0010-0230,(c0010,c0020),sA-C}) > 0`))
      .toMatchObject({ left: { kind: 'call', name: 'isnull', arguments: [{ name: 'nvl' }] },
        right: { left: { kind: 'call', name: 'sum', arguments: [{ kind: 'reference', selection: {
          row: { kind: 'range', from: '0010', to: '0230' }, column: { kind: 'list', codes: ['0010', '0020'] },
          sheet: { kind: 'range', from: 'A', to: 'C' },
        } }] } } });
  });
  it('accepts row/sheet lists and finite wildcards without manufacturing coordinates', () => {
    expect(body('sum({tC-TEST,(r01,rA),c*,(sA,sB)}) = 0')).toMatchObject({ left: { arguments: [{ selection: {
      tableCode: 'C-TEST', row: { kind: 'list', codes: ['01', 'A'] }, column: { kind: 'all' },
      sheet: { kind: 'list', codes: ['A', 'B'] },
    } }] } });
  });
  it('distinguishes omitted options from explicit null/false and keeps scope separate', () => {
    const parsed = body('with {tC_01.00,default:0,interval:true}: {r1,c1,default:null,interval:false} = {r2,c1}');
    expect(parsed).toMatchObject({ scope: { default: { lexeme: '0' }, interval: true }, body: {
      left: { selection: { default: { kind: 'null', lexeme: 'null' }, interval: false } },
    } });
    if (parsed.kind !== 'with' || parsed.body.kind !== 'binary' || parsed.body.right.kind !== 'reference') throw Error('shape');
    expect(parsed.body.right.selection).not.toHaveProperty('default');
    expect(parsed.body.right.selection).not.toHaveProperty('interval');
    expect(parsed.body.right.selection).not.toHaveProperty('tableCode');
  });
  it('preserves parenthesized negative integer tokens instead of converting through Number', () => {
    expect(body('(-1) = -1')).toMatchObject({ left: { kind: 'number', lexeme: '(-1)' }, right: { kind: 'unary', op: '-' } });
    expect(body(`with {default:(-1)}: ${ref} = 0`)).toMatchObject({ scope: { default: { lexeme: '(-1)' } } });
    expect(body('-0.125 = +0.125')).toMatchObject({ left: { op: '-', operand: { lexeme: '0.125' } } });
  });
  it.each(['null', 'isnull(null)', 'nvl(null,0)', `with {default:-1}: ${ref} = 0`, 'not true', 'TRUE', '1=1\n2=2'])
    ('does not repair syntax %s', text => {
      const result = parseRule(text);
      expect(result.syntaxStatus).toBe('error'); expect(result.ast).toBeUndefined();
      expect(result.diagnostics.some(d => d.code === 'SYNTAX_ERROR')).toBe(true);
    });

  it.each(['1=1 @', '1=1; @', '1=1 }', '1=1 2', ''])('rejects recovered or incomplete input %s', text => {
    const result = parseRule(text);
    expect(result.syntaxStatus).toBe('error'); expect(result.ast).toBeUndefined();
  });
  it('reports original positions for a trailing lexical failure', () => {
    const text = '1 = 1\n @'; const result = parseRule(text);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ code: 'SYNTAX_ERROR', line: 2, column: 1, start: 7, end: 8 }));
  });
  it('accepts a single optional semicolon and whitespace', () => {
    expect(parseRule(' \n true ;\r\n').supportStatus).toBe('supported');
  });

  it.each(['1=1;2=2;', 'x := true', `${ref} <- 1`, 'true xor false', 'if true then true else false endif',
    'abs(1)=1', 'max_aggr({tC,r1,c1})=1', 'sum({tC,r1,c1} group by r)=1',
    'match("abc","abc")', '"a" & "b" = "ab"', '1 in {1,2}', '{vVariable}', '{oOperation}', '{gGroup,r1,c1} = 0',
    'with {tC}[where true]: {r1,c1} = 0', `${ref}[where true] = 0`,
    '1%=1', '#2025-01-01#=#2025-01-01#', '""=""', '1.(-5)=1', '(-1).5=1'])
    ('distinguishes recognized unsupported constructs: %s', text => {
      const result = parseRule(text);
      expect(result.syntaxStatus).toBe('valid'); expect(result.supportStatus).toBe('unsupported');
      expect(result.ast).toBeUndefined(); expect(result.diagnostics.some(d => d.code === 'UNSUPPORTED_CONSTRUCT')).toBe(true);
    });
  it.each(['1', '(1+2)', 'sum({tC,r1,c1})', `nvl(${ref},1)`, 'true+false=0', 'not(1)', '1 and true', '1=2=3'])
    ('rejects statically incompatible result types: %s', text => {
      const result = parseRule(text);
      expect(result.syntaxStatus).toBe('valid'); expect(result.supportStatus).toBe('unsupported');
      expect(result.ast).toBeUndefined(); expect(result.diagnostics.some(d => d.code === 'TYPE_MISMATCH')).toBe(true);
    });
  it.each([ref, `nvl(${ref},true)`, `${ref} and true`])('defers coordinate-dependent typing for %s', text => {
    expect(body(text)).toBeDefined();
  });
  it.each(['{tC,r1,r2,c1}=0', '{tC,r1,c1,interval:true,interval:false}=0', '{tC,r1,c1,default:0,default:null}=0'])
    ('rejects ambiguous repeated selection arguments %s', text => {
      const result = parseRule(text); expect(result.syntaxStatus).toBe('valid');
      expect(result.supportStatus).toBe('unsupported'); expect(result.ast).toBeUndefined();
    });

  it('keeps source spans, original lexemes and JSON-only snapshot data', () => {
    const source = '\n  (0001.00) = 1'; const result = parseRule(source);
    expect(result.ast?.source).toBe(source);
    expect(result.ast?.body).toMatchObject({ span: { start: 3, end: source.length, line: 2, column: 2 },
      left: { kind: 'group', expression: { kind: 'number', lexeme: '0001.00', span: { start: 4, end: 11 } } } });
    const json: JsonObject = result.ast!;
    expect(JSON.parse(JSON.stringify(json))).toEqual(result.ast);
  });
  it.each([
    ' '.repeat(32769),
    ' '.repeat(32765) + 'true',
    'true' + ' '.repeat(2) + Array(4200).fill('or true').join(' '),
    '('.repeat(129) + 'true' + ')'.repeat(129),
    '-'.repeat(129) + '1=1',
    Array(90).fill('-(').join('') + '1' + ')'.repeat(90) + '=0',
    Array(130).fill('true').join(' and '),
    'if true then '.repeat(140) + 'true' + ' endif'.repeat(140),
    '(]'.repeat(140) + 'true' + ')'.repeat(140),
    'not '.repeat(140) + 'true',
    ('-'.repeat(50) + 'not(').repeat(70) + 'true' + ')'.repeat(70),
  ])('enforces resource limits before executable AST creation', text => {
    const result = parseRule(text);
    expect(result.ast).toBeUndefined(); expect(result.supportStatus).toBe('unsupported');
    expect(result.diagnostics.some(d => d.code === 'RESOURCE_LIMIT')).toBe(true);
  });
  it('accepts the exact character boundary', () => {
    expect(parseRule(' '.repeat(32764) + 'true').supportStatus).toBe('supported');
  });
  it.each([
    '('.repeat(127) + 'true' + ')'.repeat(127),
    'not('.repeat(127) + 'true' + ')'.repeat(127),
    'nvl('.repeat(127) + 'true' + ',true)'.repeat(127),
    'isnull(' + '-'.repeat(126) + '1)',
  ])('accepts the supported AST depth boundary without stack errors', text => {
    expect(parseRule(text).supportStatus).toBe('supported');
  });
  it('locates an explicit default null at the literal, not the entire option', () => {
    const text = 'with {default:null}: true';
    const parsed = body(text);
    if (parsed.kind !== 'with') throw Error('shape');
    expect(parsed.scope.default).toMatchObject({ kind: 'null', span: { start: 14, end: 18 } });
  });
  it('counts hidden tokens too and stops lexing at the token quota', () => {
    const result = parseRule(Array(3000).fill('true').join(' or '));
    expect(result.diagnostics.some(d => d.code === 'RESOURCE_LIMIT')).toBe(true);
  });
});
