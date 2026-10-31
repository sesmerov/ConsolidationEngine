import type { Diagnostic } from '@ce/contracts';
import type { Token } from 'antlr4';
import DpmVisitor from '../generated/dpm_xlParserVisitor.js';
import { PARSER_LIMITS } from '../ast/ast.js';
import type { Ast, AxisSelector, BinaryOperator, BooleanLiteral, DefaultLiteral, Expression, NumberLiteral, Selection, SourceSpan } from '../ast/ast.js';

// The generated JavaScript contexts have alternative-specific dynamic accessors.
// Keep that boundary here; everything emitted from it is a closed, typed JSON AST.
export type AntlrContext = { readonly start: Token; readonly stop?: Token; getText(): string; accept(visitor: DpmVisitor): unknown } & Record<string, any>;
type Context = AntlrContext;
type MutableSelection = { -readonly [K in keyof Selection]: Selection[K] };

export class AstBuildError extends Error {
  constructor(readonly diagnostic: Diagnostic) { super(diagnostic.message); }
}
export function contextSpan(ctx: Context): SourceSpan {
  return { start: ctx.start.start, end: Math.max(ctx.start.start, (ctx.stop?.stop ?? ctx.start.stop) + 1),
    line: ctx.start.line, column: ctx.start.column };
}
function fail(span: SourceSpan, code: string, message: string): never {
  throw new AstBuildError({ code, message, severity: 'error', ...span });
}

/** No inherited generic traversal is allowed: an unhandled alternative always fails. */
export class AstVisitor extends DpmVisitor {
  private nodes = 0;
  private depth = 0;
  constructor(private readonly source: string) { super(); }

  visitChildren(ctx: Context): never {
    return fail(contextSpan(ctx), 'UNSUPPORTED_CONSTRUCT', `Construcción fuera del perfil: ${ctx.constructor.name}.`);
  }
  private read<T>(ctx: Context): T { return ctx.accept(this) as T; }
  private node<T extends { readonly span: SourceSpan }>(value: T): T {
    if (++this.nodes > PARSER_LIMITS.nodes) fail(value.span, 'RESOURCE_LIMIT', 'Se supera la cuota de nodos AST.');
    return value;
  }
  private expression(ctx: Context, build: () => Expression): Expression {
    if (++this.depth > PARSER_LIMITS.depth) fail(contextSpan(ctx), 'RESOURCE_LIMIT', 'Se supera la profundidad máxima del AST.');
    try { return this.node(build()); } finally { this.depth--; }
  }
  override visitStart(ctx: Context): Ast {
    if (ctx.statements()) this.visitChildren(ctx);
    const body = this.read<Expression>(ctx.statement());
    const type = inferType(body);
    if (type === 'number') fail(body.span, 'TYPE_MISMATCH', 'Una regla o precondición debe producir un booleano o null.');
    return this.node({ kind: 'rule' as const, source: this.source, body, span: contextSpan(ctx) });
  }
  override visitExprWithoutAssignment(ctx: Context): Expression { return this.read(ctx.expressionWithoutAssignment()); }
  override visitExprWithoutPartialSelection(ctx: Context): Expression { return this.read(ctx.expression()); }
  override visitExprWithSelection(ctx: Context): Expression {
    if (ctx.WHERE()) this.visitChildren(ctx);
    return this.expression(ctx, () => ({ kind: 'with', scope: this.read(ctx.partialSelection()),
      body: this.read(ctx.expression(0)), span: contextSpan(ctx) }));
  }
  override visitPartialSelect(ctx: Context): Selection { return this.read(ctx.cellRef().address); }
  override visitParExpr(ctx: Context): Expression {
    return this.expression(ctx, () => ({ kind: 'group', expression: this.read(ctx.expression()), span: contextSpan(ctx) }));
  }
  override visitFuncExpr(ctx: Context): Expression { return this.read(ctx.functions()); }
  override visitUnaryExpr(ctx: Context): Expression {
    return this.expression(ctx, () => ({ kind: 'unary', op: ctx.op.text as '+' | '-', operand: this.read(ctx.expression()), span: contextSpan(ctx) }));
  }
  override visitNotExpr(ctx: Context): Expression {
    return this.expression(ctx, () => ({ kind: 'unary', op: 'not', operand: this.read(ctx.expression()), span: contextSpan(ctx) }));
  }
  private binary(ctx: Context, op: BinaryOperator): Expression {
    return this.expression(ctx, () => ({ kind: 'binary', op, left: this.read(ctx.left), right: this.read(ctx.right), span: contextSpan(ctx) }));
  }
  override visitNumericExpr(ctx: Context): Expression { return this.binary(ctx, ctx.op.text as BinaryOperator); }
  override visitCompExpr(ctx: Context): Expression { return this.binary(ctx, ctx.op.getText() as BinaryOperator); }
  override visitBoolExpr(ctx: Context): Expression {
    if (ctx.op.text !== 'and' && ctx.op.text !== 'or') this.visitChildren(ctx);
    return this.binary(ctx, ctx.op.text as 'and' | 'or');
  }
  override visitLiteralExpr(ctx: Context): Expression {
    return this.expression(ctx, () => this.literal(ctx.literal()));
  }
  private literal(ctx: Context): NumberLiteral | BooleanLiteral {
    const lexeme = ctx.getText(); const span = contextSpan(ctx);
    if (ctx.BOOLEAN_LITERAL()) return { kind: 'boolean', value: lexeme === 'true', lexeme, span };
    if ((ctx.INTEGER_LITERAL() || ctx.DECIMAL_LITERAL()) && /^(?:[0-9]+(?:\.[0-9]+)?|\(-[0-9]+\))$/.test(lexeme)) {
      return { kind: 'number', lexeme, span };
    }
    return fail(span, 'UNSUPPORTED_CONSTRUCT', 'Literal fuera del perfil numérico y booleano admitido.');
  }
  override visitComparisonFunctions(ctx: Context): Expression { return this.read(ctx.comparisonFunctionOperators()); }
  override visitConditionalFunctions(ctx: Context): Expression { return this.read(ctx.conditionalOperators()); }
  override visitAggregateFunctions(ctx: Context): Expression { return this.read(ctx.aggregateOperators()); }
  override visitIsnullExpr(ctx: Context): Expression {
    return this.expression(ctx, () => ({ kind: 'call', name: 'isnull', arguments: [this.read(ctx.expression())], span: contextSpan(ctx) }));
  }
  override visitNvlFunction(ctx: Context): Expression {
    return this.expression(ctx, () => ({ kind: 'call', name: 'nvl', arguments: [this.read(ctx.expression(0)), this.read(ctx.expression(1))], span: contextSpan(ctx) }));
  }
  override visitCommonAggrOp(ctx: Context): Expression {
    if (ctx.op.text !== 'sum' || ctx.groupingClause()) this.visitChildren(ctx);
    return this.expression(ctx, () => ({ kind: 'call', name: 'sum', arguments: [this.read(ctx.expression())], span: contextSpan(ctx) }));
  }
  override visitSelectExpr(ctx: Context): Expression {
    return this.expression(ctx, () => {
      const operand = ctx.select().selectOperand(); const span = contextSpan(ctx);
      if (operand.preconditionElem()) {
        const token = operand.preconditionElem().PRECONDITION_ELEMENT().getText();
        return { kind: 'filing_indicator', code: token.slice(2), span };
      }
      if (!operand.cellRef()) return this.visitChildren(operand);
      return { kind: 'reference', selection: this.read(operand.cellRef().address), span };
    });
  }
  override visitTableRef(ctx: Context): Selection {
    const table = ctx.tableReference();
    if (!table.TABLE_REFERENCE()) this.visitChildren(table);
    return this.selection(ctx, table.TABLE_REFERENCE().getText().slice(1));
  }
  override visitCompRef(ctx: Context): Selection { return this.selection(ctx); }
  private selection(ctx: Context, tableCode?: string): Selection {
    const selection: MutableSelection = { span: contextSpan(ctx), ...(tableCode === undefined ? {} : { tableCode }) };
    for (const argument of ctx.argument() as Context[]) {
      let key: 'row' | 'column' | 'sheet' | 'default' | 'interval';
      if (typeof argument.rowHandler === 'function') key = 'row';
      else if (typeof argument.colHandler === 'function') key = 'column';
      else if (typeof argument.sheetHandler === 'function') key = 'sheet';
      else if (typeof argument.interval === 'function') key = 'interval';
      else if (typeof argument.default_ === 'function') key = 'default';
      else return this.visitChildren(argument);
      if (Object.hasOwn(selection, key)) fail(contextSpan(argument), 'AMBIGUOUS_REFERENCE', `Argumento ${key} repetido en la misma selección.`);
      if (key === 'row') selection.row = this.axis(argument.rowHandler(), 'rowElem', 'ROW');
      else if (key === 'column') selection.column = this.axis(argument.colHandler(), 'colElem', 'COL');
      else if (key === 'sheet') selection.sheet = this.axis(argument.sheetHandler(), 'sheetElem', 'SHEET');
      else if (key === 'interval') selection.interval = argument.interval().BOOLEAN_LITERAL().getText() === 'true';
      else {
        const defaultContext = argument.default_();
        const nullToken: Token | undefined = defaultContext.NULL_LITERAL()?.symbol;
        selection.default = this.node<DefaultLiteral>(nullToken
          ? { kind: 'null', lexeme: 'null', span: { start: nullToken.start, end: nullToken.stop + 1, line: nullToken.line, column: nullToken.column } }
          : this.literal(defaultContext.literal()));
      }
    }
    return this.node(selection);
  }
  private axis(ctx: Context, elementAccessor: string, prefix: string): AxisSelector {
    const elem = ctx[elementAccessor](); const span = contextSpan(ctx);
    if (!elem) return this.node({ kind: 'list', codes: ctx[prefix]().map((token: { getText(): string }) => token.getText().slice(1)), span });
    if (elem[`${prefix}_ALL`]()) return this.node({ kind: 'all', span });
    if (elem[`${prefix}_RANGE`]()) {
      const [from, to] = elem[`${prefix}_RANGE`]().getText().slice(1).split('-') as [string, string];
      return this.node({ kind: 'range', from, to, span });
    }
    return this.node({ kind: 'single', code: elem[prefix]().getText().slice(1), span });
  }
}

type ValueType = 'number' | 'boolean' | 'unknown';
function expectType(type: ValueType, expected: 'number' | 'boolean', span: SourceSpan): void {
  if (type !== 'unknown' && type !== expected) fail(span, 'TYPE_MISMATCH', `El operando debe tener tipo ${expected}.`);
}
/** Only reject contradictions known without coordinate metadata; resolution completes typing. */
function inferType(expression: Expression): ValueType {
  switch (expression.kind) {
    case 'number': return 'number';
    case 'boolean': case 'filing_indicator': return 'boolean';
    case 'reference': return 'unknown';
    case 'group': return inferType(expression.expression);
    case 'with': return inferType(expression.body);
    case 'unary': {
      const expected = expression.op === 'not' ? 'boolean' : 'number';
      expectType(inferType(expression.operand), expected, expression.operand.span); return expected;
    }
    case 'binary': {
      const left = inferType(expression.left); const right = inferType(expression.right);
      if (expression.op === 'and' || expression.op === 'or') {
        expectType(left, 'boolean', expression.left.span); expectType(right, 'boolean', expression.right.span); return 'boolean';
      }
      if (expression.op === '=' || expression.op === '!=') {
        if (left !== 'unknown' && right !== 'unknown' && left !== right) fail(expression.span, 'TYPE_MISMATCH', 'No se pueden comparar tipos incompatibles.');
        return 'boolean';
      }
      expectType(left, 'number', expression.left.span); expectType(right, 'number', expression.right.span);
      return ['+', '-', '*', '/'].includes(expression.op) ? 'number' : 'boolean';
    }
    case 'call': {
      const first = inferType(expression.arguments[0]!);
      if (expression.name === 'isnull') return 'boolean';
      if (expression.name === 'sum') { expectType(first, 'number', expression.span); return 'number'; }
      const second = inferType(expression.arguments[1]!);
      if (first !== 'unknown' && second !== 'unknown' && first !== second) fail(expression.span, 'TYPE_MISMATCH', 'Los argumentos de nvl deben tener tipos compatibles.');
      return first === 'unknown' ? second : first;
    }
  }
}
