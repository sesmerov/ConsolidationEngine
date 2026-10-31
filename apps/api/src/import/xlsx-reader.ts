import readXlsxFile from 'read-excel-file/node';
import { ApiError } from '../errors.js';
import type { PreflightWorkbook, RawSheet } from './xlsx-preflight.js';
export { readSheetRows } from './xlsx-row-reader.js';
export type { RawSheetRow } from './xlsx-row-reader.js';
export interface WorkbookSheet extends RawSheet { readonly rows: readonly (readonly (string | boolean | Date | null)[])[] }
export interface RawWorkbook { readonly date1904: boolean; readonly sheets: readonly WorkbookSheet[] }
/** Only a completed, bounded preflight can authorize materialization. Raw cell metadata remains authoritative for types/dates. */
export async function readWorkbook(filePath: string, preflight: PreflightWorkbook): Promise<RawWorkbook> {
  try {
    const read = await readXlsxFile<string>(filePath, { parseNumber: (text) => text, trim: false });
    if (read.length !== preflight.sheets.length) throw new ApiError('INVALID_WORKBOOK');
    const sheets = preflight.sheets.map((sheet) => {
      const loaded = read.find((item) => item.sheet === sheet.name); if (!loaded) throw new ApiError('INVALID_WORKBOOK');
      if (loaded.data.length > 200_001 || loaded.data.some((row) => row.length > 64)) throw new ApiError('EXPANSION_LIMIT');
      const rows = loaded.data.map((row) => row.map((value: unknown) => {
        if (value === null || typeof value === 'string' || typeof value === 'boolean' || value instanceof Date) return value;
        throw new ApiError('INVALID_WORKBOOK');
      }));
      return { ...sheet, rows };
    });
    return { date1904: preflight.date1904, sheets };
  } catch (error) { if (error instanceof ApiError) throw error; throw new ApiError('INVALID_WORKBOOK'); }
}
