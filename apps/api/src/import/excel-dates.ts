import { isCivilDate } from '@ce/contracts';
import { ApiError } from '../errors.js';
import type { RawCell } from './xlsx-preflight.js';
/** Convert the original XML value, never a Date produced by the high-level reader. */
export function excelDate(cell: RawCell | undefined, date1904: boolean): string | undefined {
  if (!cell) return undefined;
  if (['s', 'inlineStr', 'str'].includes(cell.xmlType)) {
    if (cell.text === '' || cell.text === 'NULL') return undefined;
    if (!isCivilDate(cell.text)) throw new ApiError('INVALID_WORKBOOK'); return cell.text;
  }
  if (cell.xmlType === 'd') { if (!isCivilDate(cell.text)) throw new ApiError('INVALID_WORKBOOK'); return cell.text; }
  if (cell.xmlType === 'n' && cell.lexeme === '') return undefined;
  if (cell.xmlType !== 'n' || cell.lexeme.length > 32) throw new ApiError('INVALID_WORKBOOK');
  const match = /^\+?(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(cell.lexeme);
  if (!match) throw new ApiError('INVALID_WORKBOOK');
  const fraction = match[2] ?? ''; const exponent = Number(match[3] ?? 0) - fraction.length;
  if (Math.abs(exponent) > 32) throw new ApiError('INVALID_WORKBOOK');
  let days = BigInt(match[1]! + fraction);
  if (exponent < 0) { const divisor = 10n ** BigInt(-exponent); if (days % divisor !== 0n) throw new ApiError('INVALID_WORKBOOK'); days /= divisor; }
  else days *= 10n ** BigInt(exponent);
  if (days > 2_958_465n || (!date1904 && days === 60n)) throw new ApiError('INVALID_WORKBOOK');
  const adjusted = Number(days) - (!date1904 && days > 60n ? 1 : 0);
  const date = new Date((date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31)) + adjusted * 86_400_000);
  const result = date.toISOString().slice(0, 10); if (!isCivilDate(result) || date.getUTCFullYear() > 9999) throw new ApiError('INVALID_WORKBOOK'); return result;
}
