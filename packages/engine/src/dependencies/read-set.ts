import type { DirectionDTO, MetadataReadDTO, Snapshot } from '@ce/contracts';
import { WorkBudget } from '../execution/budget.js';
import { resolveDirection } from '../recalculation/direction.js';
import { ordinal } from '../resolver/coordinates.js';
import { collectExpressionReads, type StaticReads } from '../resolver/static-reads.js';

/** Dependencies describe the configured expression, irrespective of today's precondition value. */
export function collectReadSet(snapshot: Snapshot, direction: DirectionDTO, options: { budget?: WorkBudget } = {}): StaticReads {
  const budget = options.budget ?? new WorkBudget(); budget.check();
  const resolution = resolveDirection(snapshot, direction, { budget });
  if (!resolution.resolved) return { readKeys: [], metadataReads: [], diagnostics: resolution.diagnostics };
  const { source, precondition, binding, scope } = resolution.resolved;
  const environment = { report: snapshot.content, binding, budget, ...(scope ? { scope } : {}) };
  const sourceReads = collectExpressionReads(source, environment);
  const preconditionReads = precondition ? collectExpressionReads(precondition.body, environment) : undefined;
  const readKeys = new Set(sourceReads.readKeys);
  for (const key of preconditionReads?.readKeys ?? []) { budget.check(); readKeys.add(key); }
  const metadata = new Map<string, MetadataReadDTO>();
  for (const read of [...sourceReads.metadataReads, ...(preconditionReads?.metadataReads ?? [])]) {
    budget.check(); metadata.set(JSON.stringify([read.contextId, read.code]), read);
  }
  budget.check();
  return { readKeys: [...readKeys].sort(ordinal),
    metadataReads: [...metadata.values()].sort((a, b) => ordinal(a.contextId, b.contextId) || ordinal(a.code, b.code)),
    diagnostics: [...resolution.diagnostics, ...sourceReads.diagnostics, ...(preconditionReads?.diagnostics ?? [])] };
}
