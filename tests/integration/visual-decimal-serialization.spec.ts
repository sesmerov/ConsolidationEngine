import { expect, test } from 'vitest';
import { decimalForWorkbook, isSafeXmlNumber, serializeWorkbookAmount } from '../../apps/api/src/export/visual-report-shared.js';

const value = (numerator: string, denominator = '1') => ({ numerator, denominator });
const decimalPower = (exponent: number) => exponent < 0 ? '0.' + '0'.repeat(-exponent - 1) + '1' : '1' + '0'.repeat(exponent);

test.each([
  ['0', true], ['-0', true], ['12.345', true], ['-12.345', true], ['123456789012345', true], ['1234567890123456', false],
  ['1000000000000000', true], ['1000000000000001', false], ['0.123456789012345', true], ['0.1234567890123456', false],
  [decimalPower(-128), true], [decimalPower(-129), false], [decimalPower(128), true], [decimalPower(129), false],
  ['1' + '0'.repeat(127) + '1', false], ['-1' + '0'.repeat(127), true], ['-1' + '0'.repeat(128), true],
  ['1e10', false], ['NaN', false], ['Infinity', false], ['12,34', false], [' 12', false],
])('pure XML numeric policy classifies %s as %s', (text, expected) => { expect(isSafeXmlNumber(text)).toBe(expected); });

test('amount serialization divides source scale exactly without rounding to declared precision', () => {
  expect(decimalForWorkbook(value('1234567', '100'), 0)).toBe('12345.67');
  expect(decimalForWorkbook(value('1234567', '100'), 3)).toBe('12.34567');
  expect(decimalForWorkbook(value('1234567', '100'), 6)).toBe('0.01234567');
  expect(decimalForWorkbook(value('-1', '8'), 3)).toBe('-0.000125');
  expect(decimalForWorkbook(value('0', '125'), 6)).toBe('0');
  expect(serializeWorkbookAmount(value('1234567890123456'), 0)).toEqual({ text: '1234567890123456', type: 'text' });
  expect(serializeWorkbookAmount(value('123456789012345'), 0)).toEqual({ text: '123456789012345', type: 'number' });
});

test('the complete report codec rejects non-importable values independently of the pure numeric-storage threshold', () => {
  expect(isSafeXmlNumber(decimalPower(128))).toBe(true);
  expect(() => serializeWorkbookAmount(value(decimalPower(128)), 0)).toThrowError(expect.objectContaining({ code: 'EXPORT_NOT_AVAILABLE', details: { reason: 'INVALID_REPORT_SOURCE' } }));
  expect(() => serializeWorkbookAmount(value('1', decimalPower(129)), 0)).toThrowError(expect.objectContaining({ code: 'EXPORT_NOT_AVAILABLE' }));
  expect(() => serializeWorkbookAmount(value('1', '3'), 0)).toThrowError(expect.objectContaining({ code: 'EXPORT_NOT_AVAILABLE' }));
  expect(serializeWorkbookAmount(value(decimalPower(127)), 0)).toEqual({ text: decimalPower(127), type: 'number' });
  expect(serializeWorkbookAmount(value('1', decimalPower(128)), 0)).toEqual({ text: decimalPower(-128), type: 'number' });
  expect(serializeWorkbookAmount(value(decimalPower(133)), 6)).toEqual({ text: decimalPower(127), type: 'number' });
});

test('exact serialization observes cancellation and rejects malformed rational metadata before constructing unbounded integers', () => {
  const cancelled = new Error('cancelled'); expect(() => decimalForWorkbook(value('1', decimalPower(128)), 0, () => { throw cancelled; })).toThrow(cancelled);
  for (const invalid of [value('NaN'), value('1', '0'), value('1.5'), value('1'.repeat(5000))]) expect(() => decimalForWorkbook(invalid, 0)).toThrowError(expect.objectContaining({ code: 'EXPORT_NOT_AVAILABLE' }));
});
