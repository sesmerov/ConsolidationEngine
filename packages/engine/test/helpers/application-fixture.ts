import { createHash, randomUUID } from 'node:crypto';
import type { PreviewBundle, RuleVariant, Snapshot } from '@ce/contracts';
import { parseRule } from '../../src/parser/parse-rule.js';
import { resolveDirection } from '../../src/recalculation/direction.js';
import { simulate } from '../../src/recalculation/simulate.js';
import { runValidation } from '../../src/validation/run.js';
import { context, coordinate, fact, ref, report } from './report-fixture.js';
export const APPLICATION_STARTED = '2026-10-31T00:00:00.000Z';
export function fixtureClosure(bundle: PreviewBundle, selectedIds: readonly string[], requiredIds: readonly string[] = []): string {
  const p = bundle.preview;
  return createHash('sha256').update(JSON.stringify({ baseVersionId: p.baseVersionId, policyId: p.policyId, previewId: p.id,
    profileId: p.profileId, requiredIds: [...requiredIds].sort(), selectedIds: [...selectedIds].sort() })).digest('hex');
}
export function applicationFixture(options: { a?: string | null; d?: string | null; guarded?: boolean; boolean?: boolean; extraRule?: string; implicit?: boolean } = {}) {
  const ctx = context({ filingIndicators: { READY: true } });
  const cells = ['0010', '0020', '0030', '0040', '0090'].map(row => coordinate({ context: ctx, row, dataType: options.boolean ? 'boolean' : 'number', ...(options.boolean ? {} : { unit: 'EUR', decimals: '2' }) }));
  const [a, b, c, d] = cells;
  const specifications: [string, string, string?][] = options.boolean ? [['A', `${ref(a!)}=true`], ['D', `${ref(d!)}=${ref(a!)}`]]
    : [['A', `with {interval:true}: ${ref(a!)}=${ref(b!)}+${ref(c!)}`, options.guarded ? '{v_READY}' : undefined], ['D', `with {interval:true}: ${ref(d!)}=${ref(a!)}*2`]];
  if (options.extraRule) specifications.push(['other', options.extraRule]);
  const variants: RuleVariant[] = specifications.map(([code, expression, precondition], index) => ({ variantId: createHash('sha256').update(JSON.stringify([code, expression, precondition])).digest('hex'),
    code, expression, ...(precondition ? { precondition } : {}), framework: 'COREP', modules: ['COREP_OF_4.2'], crossModule: false, tables: ['T'], active: true,
    referenceWindow: {}, severityOriginal: 'Error', severity: 'error', sourceRecords: [code], sourceLocators: [{ sheet: 'Rules', row: index + 2 }] }));
  const records = variants.map(v => ({ id: v.code, variantId: v.variantId, code: v.code, sourceLocator: v.sourceLocators[0]!, originalFields: {}, diagnostics: [] }));
  const input = report(cells, cells.filter(cell => !options.implicit || cell !== a).map((cell, index) => fact(cell, options.boolean ? false : cell === a ? options.a === undefined ? '10' : options.a : cell === d ? options.d === undefined ? '20' : options.d : cell === b ? '5' : cell === c ? '7' : '123', index + 2)), [ctx]);
  const profileId = 'ce-dpmxl-0.9-closed-v1';
  let snapshot: Snapshot = { versionId: randomUUID(), contentHash: 'a'.repeat(64), createdAt: APPLICATION_STARTED,
    content: { catalogVersion: 'fixture-catalog', reportVersion: 'fixture-report', configVersion: 'fixture-config', profileId,
      contexts: input.contexts, coordinates: input.coordinates, facts: input.facts, sources: [], directions: [],
      catalog: { records, variants, analyses: variants.map(v => ({ variantId: v.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId, ...parseRule(v.expression) })),
        coverage: { rows: records.length, variants: variants.length, applicableVariants: variants.length, supportedVariants: variants.length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } } } };
  const baseline = runValidation(snapshot, { runId: randomUUID(), startedAt: APPLICATION_STARTED });
  const directions = baseline.results.filter(r => r.code === 'A' || r.code === 'D').map(r => {
    const resolved = resolveDirection(snapshot, { instanceId: r.instanceId!, binding: r.binding!, variantIds: r.variantIds, targetSide: 'left' });
    if (!resolved.resolved) throw new Error(JSON.stringify(resolved.diagnostics)); return resolved.resolved.direction;
  });
  snapshot = { ...snapshot, content: { ...snapshot.content, directions } };
  const preview = simulate(snapshot, { previewId: randomUUID() });
  const selectedIds = preview.proposals.map(p => p.id);
  return { snapshot, preview, cells, options: { receiptId: randomUUID(), newVersionId: randomUUID(), beforeRunId: randomUUID(), runId: randomUUID(),
    startedAt: APPLICATION_STARTED, selectedIds, closureHash: fixtureClosure(preview, selectedIds) } };
}
