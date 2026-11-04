import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import writeXlsxFile from 'write-excel-file/node';
import type { SourceFile } from '@ce/contracts';
import { zipBytes } from './xlsx-fixtures.js';
import type { ZipPart } from './xlsx-fixtures.js';

export const demoOracle = JSON.parse(await readFile(path.resolve('specs/002-ui-eba-demo/contracts/demo-corpus.json'), 'utf8'));
const directory = path.resolve('.cache/typed-demo-tests'), created: string[] = [];
export async function cleanupTypedDemoFiles(): Promise<void> {
  for (const file of created.splice(0)) { if (path.dirname(file) !== directory) throw new Error('Unsafe typed fixture path'); await rm(file, { force: true }); }
}
export async function typedDemoFile(parts?: readonly ZipPart[]): Promise<{ path: string; source: SourceFile }> {
  await mkdir(directory, { recursive: true }); const id = randomUUID(), location = path.join(directory, id + '.xlsx');
  if (parts) await writeFile(location, zipBytes(parts));
  else {
    const typed = demoOracle.typed;
    const sheets = [
      { sheet: 'Instrucciones', data: [[typed.workbook.instructionsTitle], [typed.reportProfile], ['Informado conserva el texto vacío; Sin dato declara nulo. Solo validación.']] },
      { sheet: 'Datos', data: [[], [], typed.headers, ...typed.fields.map((field: { label: string; value: string; state: string }) => [field.label, field.value, field.state])] },
      { sheet: 'Contexto', data: [[], [], typed.workbook.contextHeaders, ...typed.workbook.contextFields.map((field: { label: string; value: string }) => [field.label, field.value])] },
    ];
    await writeXlsxFile(sheets.map(sheet => ({ ...sheet, data: sheet.data.map((row: string[]) => row.map(value => ({ type: String, value }))) }))).toFile(location);
  }
  created.push(location); const bytes = await readFile(location);
  return { path: location, source: { id, displayName: 'typed.xlsx', kind: 'report', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length, importedAt: '2026-11-04T00:00:00.000Z' } };
}
