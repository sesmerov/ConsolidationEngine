import { RECALCULATION_POLICY_ID } from '@ce/contracts';
import { multiply, NumericError, rational, type ExactRational } from '../numeric/rational.js';

export class RecalculationError extends Error {
  constructor(readonly code: 'NON_TERMINATING_DECIMAL' | 'OUTPUT_VALUE_LIMIT') { super(code); }
}
export interface QuantizedValue {
  readonly value: ExactRational; readonly text: string; readonly decimals: string; readonly policyId: typeof RECALCULATION_POLICY_ID;
}
const absolute = (value: bigint) => value < 0n ? -value : value;
function exportable(text: string): void {
  const [integer, fraction = ''] = text.replace(/^-/, '').split('.');
  if (((integer! + fraction).replace(/^0+/, '') || '0').length > 128 || fraction.length > 128) throw new RecalculationError('OUTPUT_VALUE_LIMIT');
}
function decimalText(numerator: bigint, scale: number): string {
  const digits = absolute(numerator).toString().padStart(scale + 1, '0');
  return (numerator < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
/** Exact half-even at the destination precision; no binary floating point amounts. */
export function quantize(input: ExactRational, decimals: string): QuantizedValue {
  const normalized = rational(input.n, input.d); let text: string; let value: ExactRational;
  if (decimals === 'INF') {
    let denominator = normalized.d, twos = 0, fives = 0;
    while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
    while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
    if (denominator !== 1n) throw new RecalculationError('NON_TERMINATING_DECIMAL');
    const scale = Math.max(twos, fives);
    if (scale > 128) throw new RecalculationError('OUTPUT_VALUE_LIMIT');
    const factor = 2n ** BigInt(scale - twos) * 5n ** BigInt(scale - fives);
    // Reject the export quota before allocating a larger decimal numerator.
    if (absolute(normalized.n) > (10n ** 128n - 1n) / factor) throw new RecalculationError('OUTPUT_VALUE_LIMIT');
    text = decimalText(normalized.n * factor, scale); value = normalized;
  } else {
    if (typeof decimals !== 'string' || !/^(?:0|-?(?:[1-9]|1[0-8]))$/.test(decimals)) throw new NumericError('INVALID_PRECISION');
    const precision = Number(decimals), scale = 10n ** BigInt(Math.abs(precision));
    const scaled = multiply(normalized, precision >= 0 ? rational(scale) : rational(1n, scale));
    const unsigned = absolute(scaled.n), floor = unsigned / scaled.d, remainder = unsigned % scaled.d;
    const roundUp = remainder > scaled.d - remainder || remainder === scaled.d - remainder && floor % 2n === 1n;
    const rounded = (floor + (roundUp ? 1n : 0n)) * (scaled.n < 0n ? -1n : 1n);
    value = precision >= 0 ? rational(rounded, scale) : multiply(rational(rounded), rational(scale));
    text = precision >= 0 ? decimalText(rounded, precision) : value.n.toString();
  }
  exportable(text);
  return { value, text, decimals, policyId: RECALCULATION_POLICY_ID };
}
