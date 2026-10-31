import { NumericError, add, compare, divide, multiply, negate, rational, subtract } from './rational.js';
import type { ExactRational } from './rational.js';

export interface NumericValue {
  readonly nominal: ExactRational;
  readonly lo: ExactRational;
  readonly hi: ExactRational;
}
export type IntervalComparison = '=' | '!=' | '<' | '<=' | '>' | '>=';
const ZERO: ExactRational = { n: 0n, d: 1n };

/** All components retain their exact values; the nominal is not replaced by a midpoint. */
function checked(value: NumericValue): NumericValue {
  const nominal = rational(value.nominal.n, value.nominal.d);
  const lo = rational(value.lo.n, value.lo.d), hi = rational(value.hi.n, value.hi.d);
  if (compare(lo, hi) > 0 || compare(nominal, lo) < 0 || compare(nominal, hi) > 0) throw new NumericError('INVALID_INTERVAL');
  return { nominal, lo, hi };
}
function point(nominal: ExactRational): NumericValue { return { nominal, lo: nominal, hi: nominal }; }

/** Precision describes uncertainty. It never quantizes or rounds the imported nominal. */
export function fromPrecision(value: ExactRational, decimals: string | undefined, enabled = false): NumericValue {
  const nominal = rational(value.n, value.d);
  if (!enabled || decimals === 'INF') return point(nominal);
  if (decimals === undefined) throw new NumericError('MISSING_PRECISION');
  if (!/^(?:0|[1-9]|-[1-9]|1[0-8]|-1[0-8])$/.test(decimals)) throw new NumericError('INVALID_PRECISION');
  const precision = BigInt(decimals);
  // The exponent is already bounded to 18, so these small constants cannot exceed the component quota.
  const radius = precision >= 0n ? rational(1n, 2n * 10n ** precision) : rational(10n ** -precision, 2n);
  return { nominal, lo: subtract(nominal, radius), hi: add(nominal, radius) };
}

export function intervalAdd(left: NumericValue, right: NumericValue): NumericValue {
  const a = checked(left), b = checked(right);
  return { nominal: add(a.nominal, b.nominal), lo: add(a.lo, b.lo), hi: add(a.hi, b.hi) };
}
export function intervalSubtract(left: NumericValue, right: NumericValue): NumericValue {
  const a = checked(left), b = checked(right);
  return { nominal: subtract(a.nominal, b.nominal), lo: subtract(a.lo, b.hi), hi: subtract(a.hi, b.lo) };
}
export function intervalNegate(value: NumericValue): NumericValue {
  const a = checked(value);
  return { nominal: negate(a.nominal), lo: negate(a.hi), hi: negate(a.lo) };
}
function corners(a: NumericValue, b: NumericValue, operation: (left: ExactRational, right: ExactRational) => ExactRational): { lo: ExactRational; hi: ExactRational } {
  const first = operation(a.lo, b.lo); let lo = first, hi = first;
  for (const value of [operation(a.lo, b.hi), operation(a.hi, b.lo), operation(a.hi, b.hi)]) {
    if (compare(value, lo) < 0) lo = value;
    if (compare(value, hi) > 0) hi = value;
  }
  return { lo, hi };
}
export function intervalMultiply(left: NumericValue, right: NumericValue): NumericValue {
  const a = checked(left), b = checked(right);
  return { nominal: multiply(a.nominal, b.nominal), ...corners(a, b, multiply) };
}
export function intervalDivide(left: NumericValue, right: NumericValue): NumericValue {
  const a = checked(left), b = checked(right);
  if (compare(b.lo, ZERO) <= 0 && compare(b.hi, ZERO) >= 0) throw new NumericError('DIVISION_BY_ZERO');
  return { nominal: divide(a.nominal, b.nominal), ...corners(a, b, divide) };
}

/** The local profile's overlap comparison is deliberately not a total order or a sorting relation. */
export function intervalCompare(operator: IntervalComparison, left: NumericValue, right: NumericValue): boolean {
  const a = checked(left), b = checked(right);
  switch (operator) {
    case '=': return compare(a.lo, b.hi) <= 0 && compare(b.lo, a.hi) <= 0;
    case '!=': return compare(a.lo, b.hi) > 0 || compare(b.lo, a.hi) > 0;
    case '>': return compare(a.hi, b.lo) > 0;
    case '>=': return compare(a.hi, b.lo) >= 0;
    case '<': return compare(a.lo, b.hi) < 0;
    case '<=': return compare(a.lo, b.hi) <= 0;
    default: throw new NumericError('INVALID_NUMBER');
  }
}
