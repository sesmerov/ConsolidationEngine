import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { importWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { StagedFile } from '../../apps/api/src/import/multipart-staging.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { changeXml, readZipParts, replaceCell, textCell, zipBytes } from '../helpers/xlsx-fixtures.js';
let directory: string;
beforeAll(async () => { directory = await mkdtemp(path.resolve('.cache/import-workspace-')); });
afterAll(async () => { if (!path.relative(path.resolve('.cache'), directory).startsWith('import-workspace-')) throw new Error('Unsafe cleanup'); await rm(directory, { recursive: true, force: true }); });
const operation = { cancelled: () => false, progress: () => {} } as unknown as OperationContext;
async function staged(location: string, kind: 'catalog' | 'report'): Promise<StagedFile> {
  const bytes = await readFile(location); return { path: location, kind, id: randomUUID(), displayName: path.basename(location), size: bytes.length, importedAt: '2026-10-31T00:00:00.000Z', sha256: createHash('sha256').update(bytes).digest('hex') };
}
const catalog = () => staged(path.resolve('tests/fixtures/generated/eba-subset.xlsx'), 'catalog');
const report = (version = '42') => staged(path.resolve('tests/fixtures/generated/report-' + version + '.xlsx'), 'report');
it.each(['42', '40'])('reconciles every row and static applicability for real report %s', async (version) => {
  const snapshot = await importWorkspace([await catalog(), await report(version)], operation);
  expect(snapshot.catalog.coverage).toEqual({ rows: 3, variants: 3, applicableVariants: 1, supportedVariants: 3, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 });
  expect(snapshot.catalog.analyses.every((analysis) => analysis.ast && analysis.preconditionAst)).toBe(true);
  expect(snapshot.coordinates).toHaveLength(6); expect(snapshot.facts).toHaveLength(version === '42' ? 5 : 6);
  expect(snapshot.sources.every((source) => !('path' in source))).toBe(true);
});
it('rejects duplicate context IDs across files instead of merging by order', async () => {
  await expect(importWorkspace([await catalog(), await report(), await report()], operation)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', details: { reason: 'DUPLICATE_CONTEXT_ID' } });
});
it('rejects a second entity/date even when its context ID is different', async () => {
  const parts = await readZipParts((await report('40')).path);
  const changed = parts.map((part) => part.name.endsWith('.xml') ? { ...part, data: Buffer.from(part.data.toString('utf8').replaceAll('demo', 'other')) } : part);
  const location = path.join(directory, randomUUID() + '.xlsx'); await writeFile(location, zipBytes(changed));
  await expect(importWorkspace([await catalog(), await report(), await staged(location, 'report')], operation)).rejects.toMatchObject({ code: 'INVALID_WORKBOOK', details: { reason: 'INCOMPATIBLE_ENTITY_OR_DATE' } });
});
it('locates a syntax error at its real Excel column after headers are reordered', async () => {
  const parts = await readZipParts((await catalog()).path);
  const changed = changeXml(parts, 'xl/worksheets/sheet1.xml', (xml) => {
    const swapped = xml.replace(/r="([GI])(\d+)"/g, (_match: string, column: string, row: string) => 'r="' + (column === 'G' ? 'I' : 'G') + row + '"');
    return replaceCell(swapped, 'I3', textCell('I3', '1=1 @')).replace(/(<row\b[^>]*>)([\s\S]*?)(<\/row>)/g, (_match: string, start: string, cells: string, end: string) => {
      const ordered = cells.match(/<c\b[^>]*(?:\/>|>[\s\S]*?<\/c>)/g)!;
      ordered.sort((left, right) => /r="([A-Z]+)/.exec(left)![1]!.localeCompare(/r="([A-Z]+)/.exec(right)![1]!));
      return start + ordered.join('') + end;
    });
  });
  const location = path.join(directory, randomUUID() + '.xlsx'); await writeFile(location, zipBytes(changed));
  const snapshot = await importWorkspace([await staged(location, 'catalog'), await report()], operation);
  const row = snapshot.catalog.records.find((record) => record.sourceLocator.row === 3)!;
  expect(row.diagnostics).toContainEqual(expect.objectContaining({ code: 'SYNTAX_ERROR', locator: expect.objectContaining({ row: 3, column: 'I' }) }));
  expect(snapshot.catalog.coverage.rows).toBe(3); expect(snapshot.catalog.coverage.invalidRows).toBe(1);
});
