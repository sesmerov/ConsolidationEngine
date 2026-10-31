import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';
import { reportTemplate } from '../../apps/api/src/export/report-template.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import { importReport } from '../../apps/api/src/import/ce-report.js';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
it('roundtrips the downloadable template with exact text, precision and both kinds of null', async () => {
  const file = path.resolve('.cache/template-' + randomUUID() + '.xlsx'); const bytes = await reportTemplate();
  try {
    await writeFile(file, bytes); const raw = await preflightXlsx(file);
    const report = importReport(await readWorkbook(file, raw), { id: randomUUID(), displayName: 'ce-report-1.xlsx', kind: 'report', sha256: '0'.repeat(64), size: bytes.length, importedAt: '2026-10-31T00:00:00.000Z' });
    expect(raw.sheets.map((sheet) => sheet.name)).toEqual(['Instructions', 'Contexts', 'Coordinates', 'Facts']);
    expect(report.coordinates).toHaveLength(6); expect(report.facts).toHaveLength(5);
    expect(report.facts[2]?.originalText).toBe('123456789012345678901234567890.123456789');
    expect(report.facts[3]?.originalText).toBe('0'); expect(report.facts[4]?.presence).toBe('null');
    expect(report.coordinates[0]).toMatchObject({ rowCode: '0230', columnCode: '0010', decimals: '2' });
    expect(report.contexts[0]?.filingIndicators).toEqual({ 'C_01.00': true, 'C_05.01': true });
    const styles = (await readZipParts(file)).find((part) => part.name === 'xl/styles.xml')!.data.toString('utf8');
    const formats = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1]!.match(/<xf\b[^>]*(?:\/>|>[\s\S]*?<\/xf>)/g)!;
    const dataStyle = Number(raw.sheets.find((sheet) => sheet.name === 'Facts')!.cells['G2']!.style);
    const formatId = /numFmtId="(\d+)"/.exec(formats[dataStyle]!)![1];
    expect(formatId === '49' || styles.includes('numFmtId="' + formatId + '" formatCode="@"')).toBe(true);
  } finally { await unlink(file).catch(() => undefined); }
});
