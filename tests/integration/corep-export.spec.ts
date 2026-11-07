import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { ImportContextFormDTO, Snapshot } from '@ce/contracts';
import { applyCandidate, resolveDirection, runValidation, selectionClosureHash, simulate } from '@ce/engine';
import sax from 'sax';
import readXlsxFile from 'read-excel-file/node';
import { afterAll, expect, test } from 'vitest';
import { inspectReportWorkbook } from '../../apps/api/src/import/profiles/registry.js';
import { canonicalHash, canonicalStringify } from '../../apps/api/src/session/canonical-state.js';
import { prepareReportExportData, reportExportLimits, writeReportExport } from '../../apps/api/src/export/recalculated-report.js';
import { changeXml, readZipParts, textCell } from '../helpers/xlsx-fixtures.js';
import { corepAmount, corepReplaceCell } from '../helpers/corep-fixtures.js';
import { cleanupVisualExports, emptyVisualHistory, exportVisual, importVisual, reimportVisual, visualBusiness, visualDemo, visualFile, visualHash, visualOutput, visualSnapshot, visualStaged, visualStartedAt } from '../helpers/visual-export-harness.js';

afterAll(cleanupVisualExports);
const oracle = JSON.parse(await readFile('specs/002-ui-eba-demo/contracts/corep-ca1-mapping.json', 'utf8'));
const form: ImportContextFormDTO = { entityId: 'SYNTHETIC', referenceDate: '2025-12-31', submissionDate: '2026-01-15', currency: 'EUR', scaleExponent: 0, displayDecimals: 2, filingIndicators: { 'C_01.00': true } };
async function importedAmounts(values: readonly string[], declaration = form) {
  const parts = changeXml(await readZipParts(path.resolve('assets/templates/corep-ca1.xlsx')), 'xl/worksheets/sheet1.xml', xml => values.reduce((result, value, index) => corepReplaceCell(result, 'E' + (index + 5), corepAmount('E' + (index + 5), value)), xml));
  return importVisual(await visualFile(parts), 'corep', { source: 'form', declaration });
}
test('COREP workbook export retains its visual profile and every imported business value', async () => {
  const fixture = await visualDemo('corep'), output = await exportVisual(fixture.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!);
  expect(inspected.profileId).toBe('eba-corep-of-4.0-ca1-v1');
  expect(inspected.preflight.sheets.map(sheet => sheet.name).sort()).toEqual(['CA1', 'Contexto', 'Instrucciones']);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports))).toEqual(visualBusiness(fixture.snapshot.content));
});
test('manual context partitions by source binding without inventing a workbook metadata locator', async () => {
  const fixture = await importVisual(await visualStaged(path.resolve('assets/templates/corep-ca1.xlsx'), 'report'), 'corep', { source: 'form', declaration: { entityId: 'SYNTHETIC', referenceDate: '2025-12-31', currency: 'EUR', scaleExponent: 3, displayDecimals: 2, filingIndicators: { 'C_01.00': false } } });
  expect(fixture.snapshot.content.contexts[0]?.filingIndicatorsLocator).toBeUndefined();
  const output = await exportVisual(fixture.snapshot);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports))).toEqual(visualBusiness(fixture.snapshot.content));
});
test('fills all 110 positions in trusted CA1 layout without copying untrusted instruction content', async () => {
  const fixture = await importedAmounts(oracle.mapping.map((_item: unknown, index: number) => `${index + 1}.25`));
  const marked = changeXml(await readZipParts(fixture.files[1]!.path), 'xl/worksheets/sheet3.xml', xml => xml.replace('</sheetData>', '<row r="20">' + textCell('A20', 'UPLOAD_ONLY_SECRET_MARKER') + '</row></sheetData>'));
  const current = await importVisual(await visualFile(marked), 'corep', { source: 'form', declaration: form }), before = canonicalStringify(current.snapshot);
  const output = await exportVisual(current.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!), ca1 = inspected.preflight.sheets.find(sheet => sheet.name === 'CA1')!;
  expect(ca1.mergeRanges).toEqual(['B2:E2']);
  for (const [address, text] of oracle.structureAnchors) expect(ca1.cells[address]?.text, address).toBe(text);
  expect(current.snapshot.content.coordinates).toHaveLength(110); expect(current.snapshot.content.facts).toHaveLength(110);
  for (const [index, cell] of oracle.mapping.entries()) expect(ca1.cells[cell.amountCell]?.text).toBe(`${index + 1}.25`);
  const exportedParts = await readZipParts(output.paths.reports[0]!), trustedParts = await readZipParts(path.resolve('assets/templates/corep-ca1.xlsx'));
  const sheetXml = exportedParts.find(part => part.name === ca1.part!.name)!.data.toString(), templateXml = trustedParts.find(part => part.name === 'xl/worksheets/sheet1.xml')!.data.toString();
  expect(sheetXml.match(/<cols\b[\s\S]*?<\/cols>/)?.[0]).toBe(templateXml.match(/<cols\b[\s\S]*?<\/cols>/)?.[0]);
  for (const part of exportedParts) expect(part.data.toString()).not.toMatch(/UPLOAD_ONLY_SECRET_MARKER|<(?:\w+:)?f\b|<hyperlink\b|TargetMode="External"/);
  expect(exportedParts.some(part => /externalLink|vbaProject|calcChain/i.test(part.name))).toBe(false);
  expect(visualBusiness(await reimportVisual(current.files[0]!, output.paths.reports))).toEqual(visualBusiness(current.snapshot.content));
  expect(canonicalStringify(current.snapshot)).toBe(before);
  for (const file of current.files) expect(visualHash(await readFile(file.path))).toBe(file.sha256);
  expect(output.artifact.sha256).toBe(visualHash(await readFile(output.paths.zip)));
});
test.each([0, 3, 6] as const)('roundtrips scale %i without rounding again or losing blank, zero, long digits and declared precision', async scaleExponent => {
  const values = ['0', '12.345678901', '-0.01', '123456789012345678901234567890.123456789'];
  const fixture = await importedAmounts(values, { ...form, scaleExponent }), output = await exportVisual(fixture.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!);
  expect(inspected.workbookContext).toMatchObject({ ...form, scaleExponent });
  const ca1 = inspected.preflight.sheets.find(sheet => sheet.name === 'CA1')!;
  for (const [index, value] of values.entries()) expect(ca1.cells['E' + (index + 5)]?.text).toBe(value);
  expect(ca1.cells.E9?.text ?? '').toBe('');
  expect(fixture.snapshot.content.coordinates.every(coordinate => coordinate.decimals === String(2 - scaleExponent))).toBe(true);
  const restored = await reimportVisual(fixture.files[0]!, output.paths.reports);
  expect(restored.facts).toHaveLength(values.length); expect(visualBusiness(restored)).toEqual(visualBusiness(fixture.snapshot.content));
});
test.each([-18, 18, 'INF'] as const)('keeps declared precision %s independently of display styles', async displayDecimals => {
  const fixture = await importedAmounts(['12.345'], { ...form, displayDecimals }), output = await exportVisual(fixture.snapshot);
  expect((await inspectReportWorkbook(output.paths.reports[0]!)).workbookContext?.displayDecimals).toBe(displayDecimals);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports))).toEqual(visualBusiness(fixture.snapshot.content));
});
test('chooses exact numeric XML versus right-aligned decimal text at importable digit and magnitude boundaries', async () => {
  const values = ['0', '999999999999999', '1000000000000001', '1000000000000000', '1E127', '1E-128'];
  const fixture = await importedAmounts(values, { ...form, displayDecimals: 'INF' }), output = await exportVisual(fixture.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!);
  const ca1 = inspected.preflight.sheets.find(sheet => sheet.name === 'CA1')!;
  for (const address of ['E5', 'E6', 'E8', 'E9', 'E10']) expect(ca1.cells[address]?.xmlType, address).toBe('n');
  expect(['inlineStr', 's', 'str']).toContain(ca1.cells.E7?.xmlType); expect(ca1.cells.E7?.text).toBe('1000000000000001');
  const parts = await readZipParts(output.paths.reports[0]!), sheet = parts.find(part => part.name === ca1.part!.name)!.data.toString(), styles = parts.find(part => part.name === 'xl/styles.xml')!.data.toString();
  const style = /<c\b[^>]*\br="E7"[^>]*\bs="([0-9]+)"/.exec(sheet)?.[1] ?? /<c\b[^>]*\bs="([0-9]+)"[^>]*\br="E7"/.exec(sheet)?.[1];
  expect(style).toBeDefined();
  const alignments = new Map<number, string>(), parser = sax.parser(true); let inCellXfs = false, xf = -1;
  parser.onopentag = node => { if (node.name === 'cellXfs') inCellXfs = true; else if (inCellXfs && node.name === 'xf') xf++; else if (inCellXfs && node.name === 'alignment') alignments.set(xf, String(node.attributes.horizontal ?? '')); };
  parser.onclosetag = name => { if (name === 'cellXfs') inCellXfs = false; }; parser.write(styles).close();
  expect(alignments.get(Number(style))).toBe('right');
  const instructions = inspected.preflight.sheets.find(sheet => sheet.name === 'Instrucciones')!;
  expect(Object.values(instructions.cells).map(cell => cell.text).join(' ')).toMatch(/texto/i);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports))).toEqual(visualBusiness(fixture.snapshot.content));
});
test('exports only CA1 from the real complete EBA workbook and preserves excluded-sheet provenance separately', async () => {
  const report=await visualStaged(path.resolve('tests/fixtures/eba/official-annexes-4.0.xlsx'),'report');
  const fixture = await importVisual(report, 'corep', { source: 'form', declaration: form,reportProfiles:[{reportIndex:0,sha256:report.sha256,profileId:'eba-corep-of-4.0-ca1-v1'}] });
  expect(fixture.snapshot.content.reportSourceBindings![0]!.excludedSheets).toHaveLength(190);
  const output = await exportVisual(fixture.snapshot), inspected = await inspectReportWorkbook(output.paths.reports[0]!);
  expect(inspected.preflight.sheets.map(sheet => sheet.name).sort()).toEqual(['CA1', 'Contexto', 'Instrucciones']);
  expect(output.log.reportSourceBindings).toEqual(fixture.snapshot.content.reportSourceBindings);
  expect(output.log).toMatchObject({ versionId: fixture.snapshot.versionId, contentHash: fixture.snapshot.contentHash, profileId: fixture.snapshot.content.profileId, receipts: [], changes: [] });
  expect(output.log.reports[0]).toMatchObject({ sourceFileId: fixture.files[1]!.id, contextIds: ['corep'], sha256: visualHash(await readFile(output.paths.reports[0]!)) });
  const sheets = await readXlsxFile(output.paths.xlsx, { trim: false }), binding = fixture.snapshot.content.reportSourceBindings![0]!;
  expect(sheets.find(sheet => sheet.sheet === 'ReportBindings')!.data[1]).toEqual([binding.sourceFileId, binding.profileId, binding.mappingSha256, 'form', '0', '2']);
  expect(sheets.find(sheet => sheet.sheet === 'BindingContexts')!.data.slice(1)).toEqual([[binding.sourceFileId, 'corep']]);
  const exclusions = sheets.find(sheet => sheet.sheet === 'BindingSheets')!.data.slice(1).filter(row => row[1] === 'excluded');
  expect(exclusions.map(row => row[2]).sort()).toEqual([...binding.excludedSheets].sort()); expect(exclusions.every(row => row[0] === binding.sourceFileId)).toBe(true);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, output.paths.reports))).toEqual(visualBusiness(fixture.snapshot.content));
  expect(visualHash(await readFile(fixture.files[1]!.path))).toBe(fixture.files[1]!.sha256);
});
test.each(['non-finite', 'too-many-digits', 'too-many-decimals', 'explicit-null'] as const)('rejects controlled internal %s state instead of producing a non-reimportable COREP workbook', async kind => {
  const fixture = await importedAmounts(['1']);
  const facts = fixture.snapshot.content.facts.map(({ originalText, normalizedValue: _value, ...fact }) => kind === 'explicit-null' ? { ...fact, presence: 'null' as const } : { ...fact, originalText: originalText!, normalizedValue: kind === 'non-finite' ? { numerator: '1', denominator: '3' } : kind === 'too-many-digits' ? { numerator: '1' + '0'.repeat(128), denominator: '1' } : { numerator: '1', denominator: '1' + '0'.repeat(129) } });
  await expect(exportVisual(visualSnapshot({ ...fixture.snapshot.content, facts })).then(() => undefined)).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE' });
});
test.each(['missing', 'unknown-profile', 'mapping', 'source', 'contexts', 'scale'] as const)('rejects inconsistent %s binding before publishing an artifact', async kind => {
  const fixture = await visualDemo('corep'), binding = fixture.snapshot.content.reportSourceBindings![0]!;
  const bindings = kind === 'missing' ? [] : [{ ...binding, ...(kind === 'unknown-profile' ? { profileId: 'unknown' } : kind === 'mapping' ? { mappingSha256: '0'.repeat(64) } : kind === 'source' ? { sourceFileId: randomUUID() } : kind === 'contexts' ? { contextIds: ['missing'] } : { scaleExponent: 4 }) }];
  await expect(exportVisual(visualSnapshot({ ...fixture.snapshot.content, reportSourceBindings: bindings as typeof fixture.snapshot.content.reportSourceBindings })).then(() => undefined)).rejects.toMatchObject({ code: 'EXPORT_NOT_AVAILABLE' });
});
test('keeps historical values separate from a real engine application candidate and records the selected lineage', async () => {
  const fixture = await visualDemo('corep'), original = fixture.snapshot, validation = runValidation(original, { runId: randomUUID(), startedAt: visualStartedAt });
  const codes = new Set<string>();
  // Select the five explicit numeric directions from the frozen demo rather than inventing patches.
  const demo = JSON.parse(await readFile('specs/002-ui-eba-demo/contracts/demo-corpus.json', 'utf8'));
  for (const rule of demo.corep.rules) if (rule.configure) codes.add(rule.code);
  const directions = validation.results.filter(result => codes.has(result.code)).map(result => resolveDirection(original, { instanceId: result.instanceId!, binding: result.binding!, variantIds: result.variantIds, targetSide: 'left' }).resolved!.direction);
  const configured = visualSnapshot({ ...original.content, directions, configVersion: canonicalHash(directions) }), preview = simulate(configured, { previewId: randomUUID() }), selectedIds = preview.proposals.map(proposal => proposal.id);
  const options = { receiptId: randomUUID(), newVersionId: randomUUID(), beforeRunId: randomUUID(), runId: randomUUID(), startedAt: visualStartedAt, selectedIds, closureHash: selectionClosureHash(preview.preview, selectedIds) };
  const applied = applyCandidate(configured, preview, options), patches = new Map(applied.factPatches.map(fact => [fact.factKey, fact]));
  const content = { ...configured.content, facts: configured.content.facts.map(fact => patches.get(fact.factKey) ?? fact) };
  const selected: Snapshot = { ...visualSnapshot(content), versionId: options.newVersionId, parentVersionId: configured.versionId };
  // Receipt packaging is controlled test metadata; the changes and patches above come from real evaluation.
  const receipt = { id: options.receiptId, previewId: preview.preview.id, acceptedIds: selectedIds, closureHash: options.closureHash, baseVersionId: configured.versionId, newVersionId: selected.versionId, beforeValidationRunId: options.beforeRunId, validationRunId: options.runId, appliedAt: visualStartedAt };
  const changes = preview.proposals.map(proposal => ({ changed: patches.has(proposal.targetKey), receiptId: receipt.id, proposalId: proposal.id, directionId: proposal.directionId, instanceId: proposal.instanceId, variantIds: proposal.variantIds, code: proposal.code, targetKey: proposal.targetKey, before: proposal.before!, after: proposal.after!, readKeys: proposal.readKeys, predecessorIds: proposal.predecessorIds, metadataReads: proposal.metadataReads, sources: proposal.sources, exactNominal: proposal.exactNominal!, derivedInterval: proposal.derivedInterval!, policyId: preview.preview.policyId }));
  const history = { applications: [{ receipt, changes }] as import('@ce/contracts').ApplicationBundle[], snapshot: (id: string) => { expect(id).toBe(configured.versionId); return configured; } };
  const before = await exportVisual(configured, history), after = await exportVisual(selected, history);
  expect(before.log.receipts).toEqual([]); expect(before.log.changes).toEqual([]); expect(after.log.receipts).toEqual([receipt]); expect(after.log.changes).toHaveLength(5);
  expect(visualBusiness(await reimportVisual(fixture.files[0]!, before.paths.reports))).toEqual(visualBusiness(configured.content));
  const restored = await reimportVisual(fixture.files[0]!, after.paths.reports);
  expect(visualBusiness(restored)).toEqual(visualBusiness(selected.content)); expect(restored.facts.every(fact => !fact.derivation)).toBe(true);
  expect(restored.sources.every(source => !selected.content.sources.some(original => original.id === source.id))).toBe(true);
  expect((await exportVisual(visualSnapshot(restored))).log.receipts).toEqual([]);
  expect(visualBusiness(configured.content)).not.toEqual(visualBusiness(selected.content));
});
test.each(['cancelled', 'compressed', 'expanded'] as const)('keeps visual package unpublished on %s failure', async failure => {
  const fixture = await visualDemo('corep'), limits = reportExportLimits(failure === 'compressed' ? { maxReportBytes: 100 } : failure === 'expanded' ? { maxExpandedBytes: fixture.snapshot.content.sources.find(source => source.kind === 'catalog')!.expandedBytes! + 100 } : {});
  const data = prepareReportExportData(fixture.snapshot, emptyVisualHistory), paths = await visualOutput(); let cancelled = false;
  const marker = new Error('controlled export cancellation');
  const writing = writeReportExport(data, paths, limits, () => { if (cancelled) throw marker; }, () => { if (failure === 'cancelled') cancelled = true; });
  if (failure === 'cancelled') await expect(writing).rejects.toBe(marker); else await expect(writing).rejects.toMatchObject({ code: 'EXPORT_LIMIT' });
  expect((await stat(paths.zip)).size).toBe(0);
});
