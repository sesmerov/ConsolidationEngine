import type { Rational } from '@ce/contracts';

export interface ExactRational { readonly n: bigint; readonly d: bigint }
export class DecimalInputError extends Error {
  constructor(readonly code: 'INVALID_DECIMAL' | 'INPUT_VALUE_LIMIT') { super(code); }
}
function gcd(a: bigint, b: bigint): bigint {
  while (b !== 0n) { const remainder = a % b; a = b; b = remainder; }
  return a;
}
/** Input codec only. Arithmetic and its growth checks are added in the validation increment. */
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
  if (value.d <= 0n) throw new DecimalInputError('INVALID_DECIMAL');
  const divisor = gcd(value.n < 0n ? -value.n : value.n, value.d);
  return { numerator: (value.n / divisor).toString(), denominator: (value.d / divisor).toString() };
}
