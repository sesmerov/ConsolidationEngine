import { CharStream, CommonTokenStream, Token } from 'antlr4';
import { LANGUAGE_PROFILE_V1, type Diagnostic } from '@ce/contracts';
import DpmLexer from '../generated/dpm_xlLexer.js';
import DpmParser from '../generated/dpm_xlParser.js';
import { PARSER_LIMITS } from '../ast/ast.js';
import type { Ast, SourceSpan } from '../ast/ast.js';
import { AstBuildError, AstVisitor } from './ast-visitor.js';
import type { AntlrContext } from './ast-visitor.js';
import { languageProfile } from '../profiles/registry.js';

export type ParseRuleResult = { readonly syntaxStatus: 'valid' | 'error'; readonly supportStatus: 'supported' | 'unsupported';
  readonly diagnostics: readonly Diagnostic[]; readonly ast?: Ast };

// ANTLR 4.13.2's .d.cts entry omits inherited members under NodeNext resolution.
// Describe the small runtime surface used here without changing generated code.
type ErrorSource = {
  removeErrorListeners(): void;
  addErrorListener(listener: { syntaxError(recognizer: unknown, offending: Token | null,
    line: number, column: number, message: string): void }): void;
};

function resource(span: SourceSpan, message: string): never {
  throw new AstBuildError({ code: 'RESOURCE_LIMIT', message, severity: 'error', ...span });
}
function tokenSpan(token: Token): SourceSpan {
  return { start: token.start, end: Math.max(token.start, token.stop + 1), line: token.line, column: token.column };
}

/** Protect the recursive parser before calling start; the visitor enforces actual AST depth. */
function guardNesting(tokens: readonly Token[]): void {
  const stack: { depth: number; closing: number }[] = [];
  const opening = new Map([[DpmLexer.LPAREN, DpmLexer.RPAREN], [DpmLexer.CURLY_BRACKET_LEFT, DpmLexer.CURLY_BRACKET_RIGHT],
    [DpmLexer.SQUARE_BRACKET_LEFT, DpmLexer.SQUARE_BRACKET_RIGHT], [DpmLexer.IF, DpmLexer.ENDIF]]);
  const closing = new Set(opening.values());
  const calls = new Set([DpmLexer.NOT, DpmLexer.ISNULL, DpmLexer.NVL, DpmLexer.SUM, DpmLexer.COUNT,
    DpmLexer.AVG, DpmLexer.MEDIAN, DpmLexer.MAX_AGGR, DpmLexer.MIN_AGGR, DpmLexer.ABS, DpmLexer.EXP,
    DpmLexer.LN, DpmLexer.SQRT, DpmLexer.POWER, DpmLexer.LOG, DpmLexer.MAX, DpmLexer.MIN,
    DpmLexer.MATCH, DpmLexer.FILTER, DpmLexer.TIME_SHIFT, DpmLexer.LEN]);
  let depth = 0; let unary = 0; let expectsOperand = true; let callPending = false;
  for (const token of tokens) {
    if (token.channel !== Token.DEFAULT_CHANNEL || token.type === Token.EOF) continue;
    const type = token.type;
    if ((type === DpmLexer.PLUS || type === DpmLexer.MINUS) && expectsOperand) {
      if (++unary + depth >= PARSER_LIMITS.depth) resource(tokenSpan(token), 'La cadena de signos supera la profundidad permitida.');
      callPending = false;
      continue;
    }
    if (calls.has(type)) {
      // Count the call even if malformed input omits its required parenthesis.
      // Keep preceding signs active for the entire operand, not just until its name.
      if (++unary + depth >= PARSER_LIMITS.depth) resource(tokenSpan(token), 'La cadena de operadores supera la profundidad permitida.');
      callPending = true; expectsOperand = true; continue;
    }
    const expectedClosing = opening.get(type);
    if (expectedClosing !== undefined) {
      stack.push({ depth, closing: expectedClosing });
      depth += unary + (type === DpmLexer.LPAREN && callPending ? 0 : 1);
      unary = 0; expectsOperand = true; callPending = false;
      if (depth > PARSER_LIMITS.depth) resource(tokenSpan(token), 'La anidación supera la profundidad permitida.');
      continue;
    }
    if (closing.has(type)) {
      // A mismatched delimiter must not reset the guard while ANTLR recovers it.
      const frame = stack.at(-1);
      if (frame?.closing === type) { stack.pop(); depth = frame.depth; }
      unary = 0; expectsOperand = false; callPending = false; continue;
    }
    if ([DpmLexer.PLUS, DpmLexer.MINUS, DpmLexer.MULT, DpmLexer.DIV, DpmLexer.AND, DpmLexer.OR, DpmLexer.XOR,
      DpmLexer.EQ, DpmLexer.NE, DpmLexer.GT, DpmLexer.GE, DpmLexer.LT, DpmLexer.LE,
      DpmLexer.COMMA, DpmLexer.COLON, DpmLexer.ASSIGN, DpmLexer.PERSISTENT_ASSIGN,
      DpmLexer.THEN, DpmLexer.ELSE, DpmLexer.IF, DpmLexer.NOT, DpmLexer.WITH, DpmLexer.EOL].includes(type)) {
      unary = 0; expectsOperand = true; callPending = false;
    } else { unary = 0; expectsOperand = false; callPending = false; }
  }
}

/** Parse the original input completely; a recovered tree is never executable. */
export function parseRule(text: string, options: { readonly profileId?: string } = {}): ParseRuleResult {
  const diagnostics: Diagnostic[] = [];
  let syntaxValidated = false;
  const position = (offset: number): SourceSpan => {
    const start = Math.max(0, Math.min(text.length, offset));
    const before = text.slice(0, start); const lastNewline = before.lastIndexOf('\n');
    return { start, end: Math.min(text.length, start + 1), line: before.split('\n').length, column: start - lastNewline - 1 };
  };
  try {
    if (!languageProfile(options.profileId ?? LANGUAGE_PROFILE_V1)) return { syntaxStatus: 'error', supportStatus: 'unsupported', diagnostics: [{ code: 'PROFILE_MISMATCH', message: 'El perfil del lenguaje no está admitido.', severity: 'error' }] };
    if (text.length > PARSER_LIMITS.characters) resource(position(PARSER_LIMITS.characters), 'La expresión supera 32768 caracteres.');
    // false keeps token offsets in the same UTF-16 units as JavaScript slice and source spans.
    const lexer = new DpmLexer(new CharStream(text, false)) as DpmLexer & ErrorSource;
    lexer.removeErrorListeners();
    lexer.addErrorListener({ syntaxError: (_recognizer, _symbol, line, column, message) => {
      if (diagnostics.length < 32) diagnostics.push({ code: 'SYNTAX_ERROR', message, severity: 'error',
        ...position(lexer._tokenStartCharIndex), line, column });
    } });
    const tokens: Token[] = [];
    for (;;) {
      const token = lexer.nextToken();
      if (token.type === Token.EOF) break;
      tokens.push(token);
      if (tokens.length > PARSER_LIMITS.tokens) resource(tokenSpan(token), 'La expresión supera 8192 tokens, incluido whitespace.');
    }
    if (diagnostics.length) return { syntaxStatus: 'error', supportStatus: 'unsupported', diagnostics };
    guardNesting(tokens);
    // Reuse the validated lexer input, resetting modes; no unbounded fill is required.
    lexer.reset(); lexer.removeErrorListeners();
    const parser = new DpmParser(new CommonTokenStream(lexer)) as DpmParser & ErrorSource;
    parser.removeErrorListeners();
    parser.addErrorListener({ syntaxError: (_recognizer, offending, line, column, message) => {
      if (diagnostics.length < 32) diagnostics.push({ code: 'SYNTAX_ERROR', message, severity: 'error',
        ...(offending ? tokenSpan(offending) : position(text.length)), line, column });
    } });
    const tree = parser.start();
    if (diagnostics.length) return { syntaxStatus: 'error', supportStatus: 'unsupported', diagnostics };
    syntaxValidated = true;
    const ast = new AstVisitor(text, options.profileId ?? LANGUAGE_PROFILE_V1).visitStart(tree as unknown as AntlrContext);
    return { syntaxStatus: 'valid', supportStatus: 'supported', diagnostics: [], ast };
  } catch (error) {
    if (!(error instanceof AstBuildError)) throw error;
    diagnostics.push(error.diagnostic);
    return { syntaxStatus: syntaxValidated ? 'valid' : 'error', supportStatus: 'unsupported', diagnostics };
  }
}
