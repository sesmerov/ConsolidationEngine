import type { DefaultLiteral } from '../ast/ast.js';
import { isCivilDateV2, type DataType } from '@ce/contracts';
import { add, compare, NumericError, parseLanguageNumber, rational } from '../numeric/rational.js';
import { contextualUnits, formatUnit, unitsEqual } from '../numeric/units.js';
import type { UnitMap } from '../numeric/units.js';
import { ValueError } from './value.js';
import type { BooleanScalar, NullScalar, PrimitiveResult, ScalarValue } from './value.js';

/** Check value tags and known types before any null/default logic can hide an error. */
function checked(value: ScalarValue): void {
  if (!value || typeof value !== 'object') throw new ValueError('TYPE_MISMATCH');
  switch (value.kind) {
    case 'number': {
      const nominal = rational(value.nominal?.n, value.nominal?.d), lo = rational(value.lo?.n, value.lo?.d), hi = rational(value.hi?.n, value.hi?.d);
      if (compare(lo, hi) > 0 || compare(nominal, lo) < 0 || compare(nominal, hi) > 0) throw new NumericError('INVALID_INTERVAL');
      formatUnit(value.unit);
      if (value.literal && Object.keys(value.unit).length > 0) throw new ValueError('INVALID_UNIT');
      return;
    }
    case 'boolean': if (typeof value.value !== 'boolean') throw new ValueError('TYPE_MISMATCH'); return;
    case 'text': if (typeof value.value !== 'string' || value.value.length > 32_767) throw new ValueError('TYPE_MISMATCH'); return;
    case 'date': if (typeof value.value !== 'string' || !isCivilDateV2(value.value)) throw new ValueError('INVALID_DATE'); return;
    case 'unknown':
      if (value.dataType !== undefined && !['number', 'boolean', 'text', 'date'].includes(value.dataType)) throw new ValueError('TYPE_MISMATCH');
      return;
    case 'null':
      if (!['explicit', 'implicit', 'derived'].includes(value.origin)) throw new ValueError('TYPE_MISMATCH');
      if (value.dataType === 'number') formatUnit(value.unit);
      else if (!['boolean', 'text', 'date'].includes(value.dataType)) throw new ValueError('TYPE_MISMATCH');
      return;
    default: throw new ValueError('TYPE_MISMATCH');
  }
}
function typeOf(value: ScalarValue): DataType | 'unknown' {
  return value.kind === 'null' ? value.dataType : value.kind === 'unknown' ? value.dataType ?? 'unknown' : value.kind;
}
function clone(value: ScalarValue): ScalarValue {
  if (value.kind === 'number') return { ...value, nominal: rational(value.nominal.n, value.nominal.d), lo: rational(value.lo.n, value.lo.d), hi: rational(value.hi.n, value.hi.d), unit: { ...value.unit } };
  if (value.kind === 'null' && value.dataType === 'number') return { ...value, unit: { ...value.unit } };
  return { ...value };
}
const boolean = (value: boolean): BooleanScalar => ({ kind: 'boolean', value });
const booleanNull = (): NullScalar => ({ kind: 'null', origin: 'derived', dataType: 'boolean' });
function booleanOperand(value: ScalarValue): void {
  checked(value);
  if (typeOf(value) !== 'boolean' && typeOf(value) !== 'unknown') throw new ValueError('TYPE_MISMATCH');
}

/** The evaluator collects both read traces before using these deterministic reductions. */
export function logicalAnd(left: ScalarValue, right: ScalarValue): ScalarValue {
  booleanOperand(left); booleanOperand(right);
  if ((left.kind === 'boolean' && !left.value) || (right.kind === 'boolean' && !right.value)) return boolean(false);
  if (left.kind === 'unknown') return clone(left); if (right.kind === 'unknown') return clone(right);
  if (left.kind === 'null' || right.kind === 'null') return booleanNull();
  return boolean(true);
}
export function logicalOr(left: ScalarValue, right: ScalarValue): ScalarValue {
  booleanOperand(left); booleanOperand(right);
  if ((left.kind === 'boolean' && left.value) || (right.kind === 'boolean' && right.value)) return boolean(true);
  if (left.kind === 'unknown') return clone(left); if (right.kind === 'unknown') return clone(right);
  if (left.kind === 'null' || right.kind === 'null') return booleanNull();
  return boolean(false);
}
export function logicalNot(value: ScalarValue): ScalarValue {
  booleanOperand(value);
  if (value.kind === 'unknown') return clone(value);
  if (value.kind === 'null') return booleanNull();
  if (value.kind !== 'boolean') throw new ValueError('TYPE_MISMATCH');
  return boolean(!value.value);
}
export function isNull(value: ScalarValue): ScalarValue {
  checked(value); return value.kind === 'unknown' ? clone(value) : boolean(value.kind === 'null');
}
function numericUnit(value: ScalarValue): UnitMap {
  if (value.kind === 'number' || (value.kind === 'null' && value.dataType === 'number')) return value.unit;
  throw new ValueError('TYPE_MISMATCH');
}
function withUnit(value: ScalarValue, unit: UnitMap, literal: boolean): ScalarValue {
  const copy = clone(value);
  if (copy.kind === 'number') return { ...copy, unit: { ...unit }, literal };
  if (copy.kind === 'null' && copy.dataType === 'number') return { ...copy, unit: { ...unit }, literal };
  throw new ValueError('TYPE_MISMATCH');
}

/** nvl checks compatibility even when its first branch is already known. */
export function nvl(first: ScalarValue, second: ScalarValue): ScalarValue {
  checked(first); checked(second);
  const a = typeOf(first), b = typeOf(second);
  if (a !== 'unknown' && b !== 'unknown' && a !== b) throw new ValueError('TYPE_MISMATCH');
  if (first.kind === 'unknown') return clone(first);
  if (second.kind === 'unknown') return first.kind === 'null' ? clone(second) : clone(first);
  if (a === 'number' && b === 'number') {
    const units = contextualUnits('nvl', numericUnit(first), numericUnit(second), 'literal' in first && first.literal === true, 'literal' in second && second.literal === true);
    return first.kind === 'null' ? withUnit(second, units.right, units.rightLiteral) : withUnit(first, units.left, units.leftLiteral);
  }
  return clone(first.kind === 'null' ? second : first);
}

/** Defaults are grammar literals, not arbitrary evaluated expressions or error fallbacks. */
export function applyDefault(value: ScalarValue, replacement?: DefaultLiteral): ScalarValue {
  checked(value);
  if (value.kind === 'unknown' || replacement === undefined || replacement.kind === 'null') return clone(value);
  if (typeOf(value) !== replacement.kind) throw new ValueError('TYPE_MISMATCH');
  if (replacement.kind === 'number') {
    const nominal = parseLanguageNumber(replacement.lexeme);
    if (value.kind !== 'null') return clone(value);
    const { coordinate, sourceLocator } = value;
    return { kind: 'number', nominal, lo: { ...nominal }, hi: { ...nominal }, unit: { ...numericUnit(value) }, literal: false,
      ...(coordinate ? { coordinate } : {}), ...(sourceLocator ? { sourceLocator } : {}) };
  }
  if (value.kind !== 'null') return clone(value);
  if (replacement.kind === 'text' || replacement.kind === 'date') {
    const result: ScalarValue = { kind: replacement.kind, value: replacement.value,
      ...(value.coordinate ? { coordinate: value.coordinate } : {}), ...(value.sourceLocator ? { sourceLocator: value.sourceLocator } : {}) };
    checked(result); return result;
  }
  return { kind: 'boolean', value: replacement.value,
    ...(value.coordinate ? { coordinate: value.coordinate } : {}), ...(value.sourceLocator ? { sourceLocator: value.sourceLocator } : {}) };
}

/** Aggregate nulls are typed, carry a diagnostic, and are still usable by isnull. */
export function sumValues(values: readonly ScalarValue[]): PrimitiveResult {
  let unit: UnitMap | undefined;
  let unknown: ScalarValue | undefined;
  for (const value of values) {
    checked(value);
    if (typeOf(value) !== 'number' && typeOf(value) !== 'unknown') throw new ValueError('TYPE_MISMATCH');
    if (value.kind === 'unknown') { unknown ??= value; continue; }
    const current = numericUnit(value);
    if (unit !== undefined && !unitsEqual(unit, current)) throw new ValueError('UNIT_MISMATCH');
    unit ??= current;
  }
  if (unknown) return { value: clone(unknown), diagnostics: [] };
  let nominal = rational(0n), lo = rational(0n), hi = rational(0n), present = false;
  for (const value of values) {
    if (value.kind !== 'number') continue;
    present = true; nominal = add(nominal, value.nominal); lo = add(lo, value.lo); hi = add(hi, value.hi);
  }
  if (!present) return { value: { kind: 'null', origin: 'derived', dataType: 'number', unit: { ...unit } },
    diagnostics: [{ code: 'EMPTY_AGGREGATION', message: 'La selección está vacía o todos sus hechos son null.', severity: 'info' }] };
  return { value: { kind: 'number', nominal, lo, hi, unit: { ...unit }, literal: false }, diagnostics: [] };
}
