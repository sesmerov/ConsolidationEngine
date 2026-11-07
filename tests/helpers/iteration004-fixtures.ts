import { randomUUID } from 'node:crypto';
import type { ReportContext, RuleVariant, Snapshot } from '@ce/contracts';
import { runValidation } from '@ce/engine';
import { stableId } from '../../packages/engine/src/resolver/instances.js';
import { context, coordinate, fact, ref } from '../../packages/engine/test/helpers/report-fixture.js';
import { corepAmount, corepChange, corepParts, corepReplaceCell } from './corep-fixtures.js';
import { zipBytes } from './xlsx-fixtures.js';

/** Synthetic snapshots, not evidence of a complete visual import. Each invocation has its own version. */
export function iterationContext(overrides: Partial<ReportContext> = {}): ReportContext {
  return context({ contextId: 'iteration004', entityId: 'SYNTHETIC_004', referenceDate: '2025-12-31',
    submissionDate: '2025-12-31', moduleVersion: 'COREP_OF_4.0', ...overrides });
}

/** Same entity/date, distinct declared modules: compatible contexts without duplicate business keys. */
export function iterationContexts(): ReportContext[] {
  return [iterationContext(), iterationContext({ contextId: 'iteration004-second', moduleVersion: 'COREP_OF_4.2' })];
}

export interface IterationRule { code: string; expression: string; precondition?: string }
export function iterationSnapshot(definitions: readonly IterationRule[], rows: readonly string[], contexts = [iterationContext()]): Snapshot {
  const cells = contexts.flatMap(ctx => rows.map((row, index) => coordinate({ context: ctx, table: 'T', row, sourceRow: index + 2 })));
  const variants: RuleVariant[] = definitions.map((rule, index) => ({ ...rule,
    variantId: stableId([rule.code, rule.expression, rule.precondition]), framework: 'COREP',
    modules: [...new Set(contexts.map(ctx => ctx.moduleVersion))], crossModule: false, tables: ['T'], active: true,
    referenceWindow: {}, severity: 'error', severityOriginal: 'error', sourceRecords: [rule.code], sourceLocators: [{ row: index + 2 }],
  }));
  return { versionId: randomUUID(), contentHash: '4'.repeat(64), createdAt: '2026-11-07T00:00:00.000Z', content: {
    catalogVersion: 'iteration004', reportVersion: 'iteration004', configVersion: 'iteration004',
    profileId: 'ce-dpmxl-0.9-closed-v2', contexts, coordinates: cells, facts: cells.map(cell => fact(cell, '0')),
    sources: [], directions: [], directionDecisionState: { schemaVersion: 1, mode: 'new' },
    catalog: { variants, records: variants.map(variant => ({ id: variant.code, code: variant.code, variantId: variant.variantId,
      sourceLocator: variant.sourceLocators[0]!, originalFields: { Description: `Regla sintética ${variant.code}` }, diagnostics: [] })),
      analyses: [], coverage: { rows: variants.length, variants: variants.length, applicableVariants: variants.length,
        supportedVariants: variants.length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } },
  } };
}

export function conflictSnapshot(count: 2 | 3 | 51 = 3, contexts = [iterationContext()]): Snapshot {
  const target = ref(coordinate({ table: 'T', row: '0010' }));
  return iterationSnapshot(Array.from({ length: count }, (_, index) => ({
    code: `CANDIDATE_${String(index + 1).padStart(3, '0')}`, expression: `${target}=${index + 1}`,
  })), ['0010'], contexts);
}

/** The last proposal depends on the first: its predecessor can sit outside the visible page. */
export function selectionSnapshot(count = 51, contexts = [iterationContext()]): Snapshot {
  if (!Number.isInteger(count) || count < 2 || count > 500) throw new Error('Fixture count must be 2..500');
  const rows = Array.from({ length: count }, (_, i) => String((i + 1) * 10).padStart(4, '0'));
  const cell = (row: string) => ref(coordinate({ table: 'T', row }));
  return iterationSnapshot(rows.map((row, index) => ({ code: `PROPOSAL_${String(index + 1).padStart(3, '0')}`,
    expression: `${cell(row)}=${index === count - 1 ? cell(rows[0]!) + '+1' : index + 1}` })), rows, contexts);
}

export function validateIteration(snapshot: Snapshot) {
  return runValidation(snapshot, { runId: randomUUID(), startedAt: snapshot.createdAt });
}

/** Visual COREP input for public upload journeys; workflow-helpers owns workspace/session isolation. */
export async function iterationCorepWorkbook(address = 'F8', amount = '12'): Promise<Buffer> {
  return zipBytes(corepChange(await corepParts(), xml => corepReplaceCell(xml, address, corepAmount(address, amount))));
}
