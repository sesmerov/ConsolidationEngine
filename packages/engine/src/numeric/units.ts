import { NumericError } from './rational.js';
import { ValueError } from '../evaluator/value.js';

export type UnitMap = Readonly<Record<string, number>>;
const ATOM = /^[A-Z][A-Z0-9_]{0,15}$/;

function entries(unit: UnitMap): [string, number][] {
  if (unit === null || typeof unit !== 'object' || Array.isArray(unit)) throw new ValueError('INVALID_UNIT');
  const values = Object.entries(unit);
  if (values.some(([atom, exponent]) => !ATOM.test(atom) || !Number.isSafeInteger(exponent) || exponent === 0)) throw new ValueError('INVALID_UNIT');
  return values.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

/** Workbook units must already be canonical; do not silently repair spelling or ordering. */
export function parseUnit(text: string): UnitMap {
  if (text === 'pure') return {};
  if (typeof text !== 'string' || text.length === 0) throw new ValueError('INVALID_UNIT');
  const result: Record<string, number> = {};
  for (const part of text.split('*')) {
    const match = /^([A-Z][A-Z0-9_]{0,15})(?:\^(-?[1-8]))?$/.exec(part);
    if (!match || Object.hasOwn(result, match[1]!) || match[2] === '1') throw new ValueError('INVALID_UNIT');
    result[match[1]!] = match[2] === undefined ? 1 : Number(match[2]);
  }
  if (formatUnit(result) !== text) throw new ValueError('INVALID_UNIT');
  return result;
}

/** Derived units may have exponents outside the workbook input range until they cancel. */
export function formatUnit(unit: UnitMap): string {
  return entries(unit).map(([atom, exponent]) => `${atom}${exponent === 1 ? '' : `^${exponent}`}`).join('*') || 'pure';
}
export function unitsEqual(left: UnitMap, right: UnitMap): boolean { return formatUnit(left) === formatUnit(right); }

function combine(left: UnitMap, right: UnitMap, sign: 1 | -1): UnitMap {
  const result: Record<string, number> = Object.fromEntries(entries(left));
  for (const [atom, exponent] of entries(right)) {
    const combined = (result[atom] ?? 0) + sign * exponent;
    if (!Number.isSafeInteger(combined)) throw new NumericError('RESOURCE_LIMIT');
    if (combined === 0) delete result[atom]; else result[atom] = combined;
  }
  return Object.fromEntries(entries(result));
}
export function multiplyUnits(left: UnitMap, right: UnitMap): UnitMap { return combine(left, right, 1); }
export function divideUnits(left: UnitMap, right: UnitMap): UnitMap { return combine(left, right, -1); }
export type UnitOperation = '+' | '-' | '*' | '/' | '=' | '!=' | '<' | '<=' | '>' | '>=' | 'nvl';
export type ContextualUnits = {
  readonly left: UnitMap; readonly right: UnitMap; readonly result: UnitMap;
  readonly leftLiteral: boolean; readonly rightLiteral: boolean; readonly resultLiteral: boolean;
};

/** Assign a free literal a unit once; never reinterpret a pure fact or convert currencies. */
export function contextualUnits(operation: UnitOperation, left: UnitMap, right: UnitMap, leftLiteral = false, rightLiteral = false): ContextualUnits {
  let a = Object.fromEntries(entries(left)), b = Object.fromEntries(entries(right));
  if ((leftLiteral && Object.keys(a).length) || (rightLiteral && Object.keys(b).length)) throw new ValueError('INVALID_UNIT', 'Un literal libre debe tener unidad pure.');
  if (operation === '*' || operation === '/') {
    return { left: a, right: b, result: operation === '*' ? multiplyUnits(a, b) : divideUnits(a, b),
      leftLiteral, rightLiteral, resultLiteral: leftLiteral && rightLiteral };
  }
  if (!['+', '-', '=', '!=', '<', '<=', '>', '>=', 'nvl'].includes(operation)) throw new ValueError('INVALID_UNIT');
  if (leftLiteral && !rightLiteral) { a = { ...b }; leftLiteral = false; }
  if (rightLiteral && !leftLiteral) { b = { ...a }; rightLiteral = false; }
  if (!unitsEqual(a, b)) throw new ValueError('UNIT_MISMATCH');
  return { left: a, right: b, result: { ...a }, leftLiteral, rightLiteral, resultLiteral: leftLiteral && rightLiteral };
}
