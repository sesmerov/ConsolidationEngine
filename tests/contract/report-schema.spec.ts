import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { coordinateSchema, reportContextSchema } from '@ce/contracts';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readWorkbook } from '../../apps/api/src/import/xlsx-reader.js';
import { importReport } from '../../apps/api/src/import/ce-report.js';
import { changeXml, readZipParts, replaceCell, textCell, zipBytes } from '../helpers/xlsx-fixtures.js';

it('validates imported lowercase/hyphen codes against the same closed DTO schemas and preserves alphanumeric row prefixes', async () => {
  const directory = await mkdtemp(path.resolve('.cache/schema-report-')); const app = Fastify({ ajv: { customOptions: { removeAdditional: false } } });
  try {
    let parts = await readZipParts('tests/fixtures/generated/report-42.xlsx');
    for (const name of ['xl/worksheets/sheet3.xml', 'xl/worksheets/sheet4.xml']) parts = changeXml(parts, name, (xml) => replaceCell(replaceCell(xml, 'B2', textCell('B2', 'a-B')), 'D2', textCell('D2', 'rA')));
    parts = changeXml(parts, 'xl/worksheets/sheet2.xml', (xml) => replaceCell(xml, 'H2', textCell('H2', '{"a-B":true}')));
    const bytes = zipBytes(parts); const file = path.join(directory, 'report.xlsx'); await writeFile(file, bytes);
    const report = importReport(await readWorkbook(file, await preflightXlsx(file)), { id: randomUUID(), sha256: createHash('sha256').update(bytes).digest('hex'), kind: 'report', displayName: 'report.xlsx', size: bytes.length, importedAt: new Date().toISOString() });
    const coordinate = report.coordinates.find((item) => item.tableCode === 'a-B')!; expect(coordinate.rowCode).toBe('rA');
    app.post('/check', { schema: { body: { type: 'object', additionalProperties: false, required: ['context', 'coordinate'], properties: { context: reportContextSchema, coordinate: coordinateSchema } } } }, () => ({ accepted: true }));
    expect((await app.inject({ method: 'POST', url: '/check', payload: { context: report.contexts[0], coordinate } })).statusCode).toBe(200);
    const wrong = { ...report.contexts[0], filingIndicators: { 'v_a-B': true } };
    expect((await app.inject({ method: 'POST', url: '/check', payload: { context: wrong, coordinate } })).statusCode).toBe(400);
  } finally {
    await app.close(); const relative = path.relative(path.resolve('.cache'), directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Unsafe cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});
