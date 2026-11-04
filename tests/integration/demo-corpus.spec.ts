import { expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { Snapshot, RuleResultDTO, ValidationBundle } from '@ce/contracts';
import { applyCandidate, buildDependencyGraph, getRecalculationPolicy, parseDecimal, parseRule, rationalToDTO, resolveDirection, runValidation, selectionClosureHash, simulate, WorkBudget } from '@ce/engine';
import { inspectWorkspace } from '../../apps/api/src/import/import-workspace.js';
import type { StagedFile } from '../../apps/api/src/import/multipart-staging.js';
import type { OperationContext } from '../../apps/api/src/workers/protocol.js';
import { canonicalHash } from '../../apps/api/src/session/canonical-state.js';
import { directionEligibility } from '../../apps/api/src/recalculation/directions-service.js';
import { preflightXlsx } from '../../apps/api/src/import/xlsx-preflight.js';
import { readZipParts } from '../helpers/xlsx-fixtures.js';
import { demoOracle } from '../helpers/typed-demo-fixtures.js';

const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const operation = { cancelled: () => false, progress: () => {} } as unknown as OperationContext;
const startedAt = '2026-11-04T00:00:00.000Z';
async function staged(demo: 'corep' | 'types', kind: 'catalog' | 'report'): Promise<StagedFile> {
  const file = `demo-${demo}-${kind}.xlsx`, location = path.resolve('assets/demos', file), bytes = await readFile(location);
  return { path: location, kind, id: randomUUID(), displayName: file, size: bytes.length, importedAt: startedAt, sha256: hash(bytes) };
}
async function snapshot(demo: 'corep' | 'types'): Promise<Snapshot> {
  const candidate = await inspectWorkspace([await staged(demo, 'catalog'), await staged(demo, 'report')], operation, { source: 'workbook' });
  return { versionId: randomUUID(), contentHash: canonicalHash(candidate.content), createdAt: startedAt, content: candidate.content };
}
function compareResults(snapshot: Snapshot, results: readonly RuleResultDTO[], rules: typeof demoOracle.corep.rules, phase: 'Initial' | 'After') {
  expect(results).toHaveLength(rules.length);
  for (const expected of rules) {
    const result = results.find(result => result.code === expected.code)!;
    expect(result, expected.code).toBeDefined(); expect(result.status, expected.code).toBe(expected['expected' + phase]);
    expect(result.coverageOnly, expected.code).toBe(false); expect(result.diagnostics, expected.code).toEqual([]);
    expect([...new Set(result.factReads.map(read => read.coordinate.rowCode))].sort(), expected.code).toEqual([...expected.expectedReads].sort());
    expect(result.factReads.map(read => read.factKey).sort()).toEqual([...result.readKeys].sort());
    expect(result.factReads.every(read => read.sourceLocator.fileId === snapshot.content.sources.find(source => source.kind === 'report')!.id)).toBe(true);
    const classified = getRecalculationPolicy(snapshot, result);
    expect(classified.policy, expected.code).toEqual(expected.expectedRecalculation.policy);
    for (const side of ['left', 'right'] as const) {
      const eligibility = directionEligibility(snapshot, result, side, new WorkBudget());
      expect(eligibility.eligible, `${expected.code}/${side}`).toBe(expected.expectedRecalculation.eligibleSides.includes(side));
      if (expected.expectedRecalculation.ineligibleReason) expect.soft(eligibility.diagnostics.map(item => item.code), expected.code).toContain(expected.expectedRecalculation.ineligibleReason);
      if (expected.expectedRecalculation.policy.mode === 'validation_only') expect(eligibility.target).toBeUndefined();
    }
    if (expected.origin === 'official_catalog') {
      expect(result.metadataReads).toEqual([expect.objectContaining({ contextId: 'corep', code: 'C_01.00', presence: 'declared', value: true, sourceLocator: { fileId: snapshot.content.sources.find(source => source.kind === 'report')!.id, sheet: 'Contexto', row: 11, column: 'B' } })]);
      expect(result.expression).toBe(expected.source.fields.Expression); expect(result.precondition).toBe(expected.source.fields.Precondtion);
    }
  }
}
function counts(bundle: ValidationBundle, expected: Record<string, number>) { expect(bundle.run.status).toBe('completed'); expect(bundle.run.summary.byStatus).toEqual({ pass: 0, fail: 0, not_applicable: 0, not_evaluable: 0, error: 0, ...expected }); }

test('all 24 frozen demo expressions and six formal preconditions are supported in v2', () => {
  const rules = [...demoOracle.corep.rules, ...demoOracle.typed.rules];
  expect(rules).toHaveLength(24); expect(rules.filter(rule => rule.precondition)).toHaveLength(6);
  for (const rule of rules) for (const expression of [rule.expression, rule.precondition].filter(Boolean)) {
    const result = parseRule(expression, { profileId: demoOracle.profileId });
    expect(result, rule.code).toMatchObject({ syntaxStatus: 'valid', supportStatus: 'supported' });
    expect(result.ast, rule.code).toBeDefined();
  }
});

test('independent integer-cent sums reproduce 60, 185, 50, 100 and 285 without evaluating engine expressions', () => {
  const cents = (value: string): bigint => { const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value); if (!match) throw new Error('Unexpected independent input'); return BigInt(match[1]!) * 100n + BigInt((match[2] ?? '').padEnd(2, '0')); };
  const values = new Map<string, bigint>(demoOracle.corep.inputs.map((input: { rowCode: string; value: string | null }) => [input.rowCode, input.value === null ? 0n : cents(input.value)]));
  const order = ['v0174_m', 'v0173_m', 'v0176_m', 'v0175_m', 'v0172_m'], expectedCents = [6000n, 18500n, 5000n, 10000n, 28500n];
  for (const [index, code] of order.entries()) {
    const rule = demoOracle.corep.rules.find((item: { code: string }) => item.code === code);
    const sum = rule.expectedReads.filter((row: string) => row !== rule.targetRow).reduce((value: bigint, row: string) => value + values.get(row)!, 0n);
    expect(sum, code).toBe(expectedCents[index]); expect(sum, code).toBe(cents(rule.expectedTargetAfter)); values.set(rule.targetRow, sum);
  }
});

test('versioned product inputs and reproducible assets match the independent frozen oracle and original sources', async () => {
  const product = JSON.parse(await readFile('assets/demos/source-data.json', 'utf8'));
  expect(product.sourceSha256).toBe(demoOracle.sourceSha256); expect(hash(await readFile(product.sourceName))).toBe(demoOracle.sourceSha256);
  for (const name of ['corep', 'typed'] as const) {
    expect(product[name].context).toEqual(demoOracle[name].context);
    expect(product[name].rules).toHaveLength(demoOracle[name].rules.length);
    for (const rule of product[name].rules) { const expected = demoOracle[name].rules.find((item: { code: string }) => item.code === rule.code); for (const field of ['code', 'origin', 'family', 'expression', 'precondition', 'source']) expect(rule[field] ?? undefined, rule.code + '/' + field).toEqual(expected[field]); }
  }
  expect(product.corep.inputs).toEqual(demoOracle.corep.inputs.map(({ rowCode, valueCell, value }: { rowCode: string; valueCell: string; value: string | null }) => ({ rowCode, valueCell, value })));
  expect(product.typed.fields).toEqual(demoOracle.typed.fields.map(({ rowCode, value, state }: { rowCode: string; value: string; state: string }) => ({ rowCode, value, state })));
  const mapping = JSON.parse(await readFile('apps/api/src/import/profiles/demo-types-mapping.json', 'utf8'));
  expect(mapping.fields).toEqual(demoOracle.typed.fields.map(({ unit: _unit, decimals: _decimals, value: _value, state: _state, ...field }: Record<string, unknown>) => field));
  const templates = JSON.parse(await readFile('assets/templates/manifest.json', 'utf8'));
  for (const [file, profileId] of [['corep-ca1-mapping.json', 'eba-corep-of-4.0-ca1-v1'], ['demo-types-mapping.json', 'ce-demo-types-1']]) {
    const bytes = await readFile(path.join('apps/api/src/import/profiles', file!)); expect(bytes.includes(13), file).toBe(false);
    expect(templates.profiles.find((item: { profileId: string }) => item.profileId === profileId).mappingSha256).toBe(hash(bytes));
  }
  const before = await readFile('assets/demos/manifest.json', 'utf8'); execFileSync(process.execPath, ['scripts/create-visual-demos.mjs'], { stdio: 'pipe' });
  expect(await readFile('assets/demos/manifest.json', 'utf8')).toBe(before);
  const manifest = JSON.parse(before); expect(manifest.files).toHaveLength(4);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join('assets/demos', file.file)); expect(hash(bytes)).toBe(file.sha256); expect(bytes.length).toBe(file.size);
    expect(hash(await readFile(path.join('tests/fixtures/generated', file.file)))).toBe(file.sha256);
    const preflight = await preflightXlsx(path.join('assets/demos', file.file)); expect(preflight.scan?.formulas).toBe(0); expect(preflight.scan?.externalLinkXmlParts).toBe(0);
    expect((await readZipParts(path.join('assets/demos', file.file))).some(part => /externalLinks|vbaProject|customXml/.test(part.name))).toBe(false);
  }
  for (const script of ['scripts/create-visual-demos.mjs', 'scripts/prepare-visual-templates.mjs', 'scripts/lib/visual-xlsx.mjs']) expect(await readFile(script, 'utf8')).not.toMatch(/specs\/|\.cache\//);
});

test.each(['corep', 'types'] as const)('%s demo imports exact business inputs and all source metadata', async demo => {
  const current = await snapshot(demo), expected = demo === 'corep' ? demoOracle.corep : demoOracle.typed, context = current.content.contexts[0]!;
  expect(current.content.profileId).toBe(demoOracle.profileId);
  const { contextId: _logicalAlias, unit: _unit, decimals: _decimals, scale: _scale, ...business } = expected.context;
  expect(context).toMatchObject({ ...business, contextId: demo === 'corep' ? 'corep' : 'demo_types' });
  expect(current.content.catalog.coverage).toMatchObject({ rows: expected.rules.length, variants: expected.rules.length, applicableVariants: expected.rules.length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 });
  expect(current.content.coordinates).toHaveLength(demo === 'corep' ? 110 : 6); expect(current.content.facts).toHaveLength(demo === 'corep' ? 15 : 6);
  for (const input of demo === 'corep' ? expected.inputs : expected.fields) {
    const coordinate = current.content.coordinates.find(item => item.rowCode === input.rowCode)!, fact = current.content.facts.find(item => item.factKey === coordinate.factKey);
    expect(coordinate, input.rowCode).toBeDefined();
    if (input.value === null) expect(fact, input.rowCode).toBeUndefined();
    else expect(fact).toMatchObject({ presence: 'value', normalizedValue: demo === 'corep' ? rationalToDTO(parseDecimal(input.value)) : { kind: input.type, value: input.value } });
  }
  for (const rule of expected.rules) {
    const variant = current.content.catalog.variants.find(item => item.code === rule.code)!, record = current.content.catalog.records.find(item => item.code === rule.code)!;
    expect(variant.expression).toBe(rule.expression); expect(variant.precondition).toBe(rule.precondition); expect(variant.framework).toBe(expected.context.framework); expect(variant.modules).toEqual([expected.context.moduleVersion]);
    if (rule.origin === 'official_catalog') {
      for (const [header, value] of Object.entries(rule.source.fields)) expect(record.originalFields[header], rule.code + '/' + header).toMatchObject({ value });
      expect(variant.referenceWindow).toEqual({ from: '2025-03-31', to: '2026-03-30' }); expect(variant.submissionFrom).toBe('2025-03-31'); expect(variant.severity).toBe(rule.source.fields.Severity.toLowerCase()); expect(variant.severityOriginal).toBe(rule.source.fields.Severity);
    } else expect(record.originalFields.Source).toMatchObject({ value: 'SYNTHETIC · demostración propia' });
  }
  const workbook = await preflightXlsx((await staged(demo, 'catalog')).path), provenance = workbook.sheets.find(sheet => sheet.name === 'Procedencia')!;
  for (const [index, rule] of expected.rules.entries()) {
    const row = index + 2; expect(provenance.cells['A' + row]?.text).toBe(rule.code);
    if (rule.source) {
      expect(['C', 'D', 'E', 'F'].map(column => provenance.cells[column + row]?.text)).toEqual([rule.source.sourceName, rule.source.sourceSha256, rule.source.sourceSheet, String(rule.source.row)]);
    } else expect(provenance.cells['B' + row]?.text).toBe('Regla sintética propia');
  }
});

test('COREP validates all 16 rules, applies only five explicit numeric changes in Kahn order, and revalidates the frozen oracle', async () => {
  const original = await snapshot('corep'), before = runValidation(original, { runId: randomUUID(), startedAt });
  counts(before, demoOracle.corep.expectedInitialCounts); compareResults(original, before.results, demoOracle.corep.rules, 'Initial');
  const directions = demoOracle.corep.rules.filter((rule: { configure: string | null }) => rule.configure).map((rule: { code: string }) => {
    const result = before.results.find(result => result.code === rule.code)!;
    const resolution = resolveDirection(original, { instanceId: result.instanceId!, variantIds: result.variantIds, binding: result.binding!, targetSide: 'left' });
    expect(resolution.diagnostics).toEqual([]); return resolution.resolved!.direction;
  });
  const configured: Snapshot = { ...original, content: { ...original.content, directions, configVersion: canonicalHash(directions) } };
  const preview = simulate(configured, { previewId: randomUUID() }), graph = buildDependencyGraph(configured, directions), codeByDirection = new Map(preview.proposals.map(item => [item.directionId, item.code]));
  expect(preview.proposals).toHaveLength(5); expect(preview.preview.graphSummary).toMatchObject({ nodes: 5, edges: 4, conflicts: [], cycles: [], blocked: 0 });
  expect(graph.edges.map(edge => [codeByDirection.get(edge.from), codeByDirection.get(edge.to)]).sort()).toEqual([...demoOracle.corep.expectedEdges].sort());
  for (const edge of graph.edges) expect(preview.preview.graphSummary.order.indexOf(edge.from)).toBeLessThan(preview.preview.graphSummary.order.indexOf(edge.to));
  for (const expected of demoOracle.corep.expectedChangedValues) {
    const proposal = preview.proposals.find(item => original.content.coordinates.find(coordinate => coordinate.factKey === item.targetKey)?.rowCode === expected.rowCode)!;
    expect(proposal.before?.originalText).toBe(expected.before); expect(proposal.after).toMatchObject({ originalText: expected.after, normalizedValue: rationalToDTO(parseDecimal(expected.after)), unit: 'EUR', decimals: '2' }); expect(proposal.state).toBe('available');
  }
  const final = preview.proposals.find(item => item.code === 'v0172_m')!, required = new Set<string>();
  const visit = (id: string): void => { for (const predecessor of preview.proposals.find(item => item.id === id)!.predecessorIds) if (!required.has(predecessor)) { required.add(predecessor); visit(predecessor); } }; visit(final.id);
  expect(required.size).toBe(4);
  const options = { receiptId: randomUUID(), newVersionId: randomUUID(), beforeRunId: randomUUID(), runId: randomUUID(), startedAt };
  expect(() => applyCandidate(configured, preview, { ...options, selectedIds: [final.id], closureHash: selectionClosureHash(preview.preview, [final.id]) })).toThrowError(expect.objectContaining({ code: 'SELECTION_NOT_CLOSED' }));
  const selectedIds = preview.proposals.map(item => item.id), applied = applyCandidate(configured, preview, { ...options, selectedIds, closureHash: selectionClosureHash(preview.preview, selectedIds) });
  expect(applied.factPatches).toHaveLength(5); const patches = new Map(applied.factPatches.map(fact => [fact.factKey, fact]));
  const after: Snapshot = { ...configured, versionId: options.newVersionId, content: { ...configured.content, facts: configured.content.facts.map(fact => patches.get(fact.factKey) ?? fact) } };
  counts(applied.validation, demoOracle.corep.expectedAfterCounts); compareResults(after, applied.validation.results, demoOracle.corep.rules, 'After');
  for (const input of demoOracle.corep.inputs) { const fact = after.content.facts.find(item => item.rowCode === input.rowCode); if (input.expectedAfter === null) expect(fact).toBeUndefined(); else expect(fact?.normalizedValue).toEqual(rationalToDTO(parseDecimal(input.expectedAfter))); }
  expect(original.content.facts.find(fact => fact.rowCode === '0020')?.originalText).toBe('1000');
});

test('all eight typed rules validate exact text/date reads and have no recalculation nodes or proposals', async () => {
  const current = await snapshot('types'), validation = runValidation(current, { runId: randomUUID(), startedAt });
  counts(validation, demoOracle.typed.expectedInitialCounts); compareResults(current, validation.results, demoOracle.typed.rules, 'Initial');
  const preview = simulate(current, { previewId: randomUUID() }); expect(preview.proposals).toEqual([]); expect(preview.preview.graphSummary).toMatchObject({ nodes: 0, edges: 0 });
});
