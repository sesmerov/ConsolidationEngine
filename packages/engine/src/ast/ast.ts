/** UTF-16 offsets into Ast.source, end exclusive; line starts at 1, column at 0. */
export type SourceSpan = { readonly start: number; readonly end: number; readonly line: number; readonly column: number };
export type NumberLiteral = { readonly kind: 'number'; readonly lexeme: string; readonly span: SourceSpan };
export type BooleanLiteral = { readonly kind: 'boolean'; readonly value: boolean; readonly lexeme: string; readonly span: SourceSpan };
export type TextLiteral = { readonly kind: 'text'; readonly value: string; readonly lexeme: string; readonly span: SourceSpan };
export type DateLiteral = { readonly kind: 'date'; readonly value: string; readonly lexeme: string; readonly span: SourceSpan };
export type DefaultLiteral = NumberLiteral | BooleanLiteral | TextLiteral | DateLiteral | { readonly kind: 'null'; readonly lexeme: 'null'; readonly span: SourceSpan };
export type AxisSelector = (
  | { readonly kind: 'single'; readonly code: string }
  | { readonly kind: 'range'; readonly from: string; readonly to: string }
  | { readonly kind: 'list'; readonly codes: readonly string[] }
  | { readonly kind: 'all' }
) & { readonly span: SourceSpan };
export type Selection = {
  readonly span: SourceSpan;
  readonly tableCode?: string;
  readonly row?: AxisSelector;
  readonly column?: AxisSelector;
  readonly sheet?: AxisSelector;
  readonly default?: DefaultLiteral;
  readonly interval?: boolean;
};
export type BinaryOperator = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'and' | 'or';
export type Expression = NumberLiteral | BooleanLiteral | TextLiteral | DateLiteral | (
  | { readonly kind: 'reference'; readonly selection: Selection }
  | { readonly kind: 'filing_indicator'; readonly code: string }
  | { readonly kind: 'unary'; readonly op: '+' | '-' | 'not'; readonly operand: Expression }
  | { readonly kind: 'binary'; readonly op: BinaryOperator; readonly left: Expression; readonly right: Expression }
  | { readonly kind: 'call'; readonly name: 'isnull' | 'nvl' | 'sum'; readonly arguments: readonly Expression[] }
  | { readonly kind: 'group'; readonly expression: Expression }
  | { readonly kind: 'with'; readonly scope: Selection; readonly body: Expression }
  | { readonly kind: 'if'; readonly condition: Expression; readonly then: Expression; readonly else?: Expression }
) & { readonly span: SourceSpan };

/** Executable only after parseRule succeeds; no ANTLR objects, BigInt or resolved facts. */
export type Ast = { readonly kind: 'rule'; readonly source: string; readonly body: Expression; readonly span: SourceSpan };
export const PARSER_LIMITS = Object.freeze({ characters: 32_768, tokens: 8_192, nodes: 8_192, depth: 128 });
