import type { Rational } from '@ce/contracts';

export interface ExactRational { readonly n: bigint; readonly d: bigint }
export type NumericErrorCode = 'RESOURCE_LIMIT' | 'DIVISION_BY_ZERO' | 'INVALID_NUMBER' | 'MISSING_PRECISION' | 'INVALID_PRECISION' | 'INVALID_INTERVAL';
export class NumericError extends Error { constructor(readonly code: NumericErrorCode) { super(code); } }
export const RATIONAL_BITS = 4096;
const MAXIMUM = (1n << BigInt(RATIONAL_BITS)) - 1n;
const absolute = (value: bigint) => value < 0n ? -value : value;
export class DecimalInputError extends Error {
  constructor(readonly code: 'INVALID_DECIMAL' | 'INPUT_VALUE_LIMIT') { super(code); }
}
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return a;
}
/** Workbook codec: decimal text is deliberately narrower than the DPM-XL literal codec. */
export function parseDecimal(text: string): ExactRational {
  if (!/^-?[0-9]+(?:\.[0-9]+)?$/.test(text)) throw new DecimalInputError('INVALID_DECIMAL');
  const negative = text.startsWith('-'); const unsigned = negative ? text.slice(1) : text;
  const [integer, fraction = ''] = unsigned.split('.');
  const digits = (integer! + fraction).replace(/^0+/, '') || '0';
  if (digits.length > 128 || fraction.length > 128) throw new DecimalInputError('INPUT_VALUE_LIMIT');
  // Strip leading zeroes before constructing BigInt; never pass a report amount through Number.
  const numerator = BigInt(digits) * (negative ? -1n : 1n);
  if (numerator === 0n) return { n: 0n, d: 1n };
  const denominator = 10n ** BigInt(fraction.length);
  const divisor = gcd(numerator < 0n ? -numerator : numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
}
export function rationalToDTO(value: ExactRational): Rational {
  const normalized = rational(value.n, value.d);
  return { numerator: normalized.n.toString(), denominator: normalized.d.toString() };
}
function bounded(value: bigint): bigint { if (absolute(value) > MAXIMUM) throw new NumericError('RESOURCE_LIMIT'); return value; }
/** Normalizes supplied components; every arithmetic entry point validates even identity operands. */
export function rational(n: bigint, d = 1n): ExactRational {
  if (typeof n !== 'bigint' || typeof d !== 'bigint') throw new NumericError('INVALID_NUMBER');
  if (d === 0n) throw new NumericError('DIVISION_BY_ZERO');
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(absolute(n), d); return { n: bounded(n / divisor), d: bounded(d / divisor) };
}
function product(left: bigint, right: bigint): bigint {
  // The quotient test is exact: reject growth before creating a too-large product.
  if (left !== 0n && absolute(right) > MAXIMUM / absolute(left)) throw new NumericError('RESOURCE_LIMIT');
  return left * right;
}
export function negate(value: ExactRational): ExactRational { const normalized = rational(value.n, value.d); return { n: -normalized.n, d: normalized.d }; }
export function add(left: ExactRational, right: ExactRational): ExactRational {
  const a = rational(left.n, left.d), b = rational(right.n, right.d);
  const common = gcd(a.d, b.d); const aScale = b.d / common, bScale = a.d / common;
  const aNumerator = product(a.n, aScale), bNumerator = product(b.n, bScale);
  // Each term is bounded. Their sum has at most one additional bit, removed by normalization or rejected.
  const numerator = aNumerator + bNumerator;
  if (numerator === 0n) return { n: 0n, d: 1n };
  const cancellation = gcd(absolute(numerator), common);
  return rational(bounded(numerator / cancellation), product(bScale, b.d / cancellation));
}
export function subtract(left: ExactRational, right: ExactRational): ExactRational { return add(left, negate(right)); }
export function multiply(left: ExactRational, right: ExactRational): ExactRational {
  const a = rational(left.n, left.d), b = rational(right.n, right.d);
  const first = gcd(absolute(a.n), b.d), second = gcd(absolute(b.n), a.d);
  return rational(product(a.n / first, b.n / second), product(a.d / second, b.d / first));
}
export function divide(left: ExactRational, right: ExactRational): ExactRational {
  const a = rational(left.n, left.d), b = rational(right.n, right.d);
  if (b.n === 0n) throw new NumericError('DIVISION_BY_ZERO');
  const first = gcd(absolute(a.n), absolute(b.n)), second = gcd(a.d, b.d);
  return rational(product(a.n / first, b.d / second), product(a.d / second, b.n / first));
}
/** Continued-fraction comparison uses divisions/remainders, never an oversized cross-product. */
export function compare(left: ExactRational, right: ExactRational): -1 | 0 | 1 {
  const a = rational(left.n, left.d), b = rational(right.n, right.d);
  if (a.n < 0n && b.n >= 0n) return -1; if (a.n >= 0n && b.n < 0n) return 1;
  let sign: -1 | 1 = a.n < 0n ? -1 : 1;
  let an = absolute(a.n), ad = a.d, bn = absolute(b.n), bd = b.d;
  while (true) {
    const aq = an / ad, bq = bn / bd;
    if (aq !== bq) return aq < bq ? -sign as -1 | 1 : sign;
    const ar = an % ad, br = bn % bd;
    if (ar === 0n || br === 0n) return ar === br ? 0 : ar === 0n ? -sign as -1 | 1 : sign;
    an = ad; ad = ar; bn = bd; bd = br; sign = -sign as -1 | 1;
  }
}
function power(base: bigint, exponent: number): bigint {
  let result = 1n, factor = base, remaining = exponent;
  while (remaining > 0) { if (remaining % 2 === 1) result = product(result, factor); remaining = Math.floor(remaining / 2); if (remaining) factor = product(factor, factor); }
  return result;
}
/** Exact ANTLR number token codec. Parenthesized negative integers are a lexer-specific form. */
export function parseLanguageNumber(text: string): ExactRational {
  if (!/^(?:[0-9]+(?:\.[0-9]+)?|\(-[0-9]+\))$/.test(text)) throw new NumericError('INVALID_NUMBER');
  if (text.length > 32_768) throw new NumericError('RESOURCE_LIMIT');
  const negative = text.startsWith('(-'), unsigned = negative ? text.slice(2, -1) : text;
  const [integer, originalFraction = ''] = unsigned.split('.'); const fraction = originalFraction.replace(/0+$/, '');
  const digits = (integer! + fraction).replace(/^0+/, '') || '0';
  let numerator = BigInt(digits); if (numerator === 0n) return { n: 0n, d: 1n };
  // Cancel decimal powers before allocating the denominator. The input is bounded by the parser's text limit.
  let twos = fraction.length, fives = fraction.length;
  while (twos && numerator % 2n === 0n) { numerator /= 2n; twos--; }
  while (fives && numerator % 5n === 0n) { numerator /= 5n; fives--; }
  bounded(numerator); const denominator = product(power(2n, twos), power(5n, fives));
  return rational(negative ? -numerator : numerator, denominator);
}
