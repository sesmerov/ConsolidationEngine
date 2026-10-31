/** Identifies the explicitly bounded profile; evaluation is not implemented yet. */
export const ENGINE_PROFILE_ID = 'ce-dpmxl-0.9-closed-v1' as const;
export { DecimalInputError, parseDecimal, rationalToDTO } from './numeric/rational.js';
export type { ExactRational } from './numeric/rational.js';
export { parseRule } from './parser/parse-rule.js';
export type { ParseRuleResult } from './parser/parse-rule.js';
export { PARSER_LIMITS } from './ast/ast.js';
export type { Ast, Expression, Selection, AxisSelector, DefaultLiteral, NumberLiteral, BooleanLiteral, BinaryOperator, SourceSpan } from './ast/ast.js';
