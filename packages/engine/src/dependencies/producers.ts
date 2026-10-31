import type { Diagnostic, DirectionDTO, MetadataReadDTO, ProducerConflictDTO, Snapshot } from '@ce/contracts';
import { WorkBudget, WorkLimitError } from '../execution/budget.js';
import { ordinal } from '../resolver/coordinates.js';
import { collectReadSet } from './read-set.js';

export interface DependencyNode {
  readonly id: string; readonly sortKey: string; readonly targetKey: string; readonly readKeys: readonly string[];
  readonly metadataReads: readonly MetadataReadDTO[]; readonly diagnostics: readonly Diagnostic[];
}
export interface DependencyEdge { readonly from: string; readonly to: string; readonly factKey: string }
export interface DependencyGraph {
  readonly nodes: readonly DependencyNode[]; readonly edges: readonly DependencyEdge[];
  readonly conflicts: readonly ProducerConflictDTO[]; readonly diagnostics: readonly Diagnostic[];
}

/** A graph node is a configured producer. Reported inputs and filing metadata never become nodes. */
export function buildDependencyGraph(snapshot: Snapshot, directions: readonly DirectionDTO[], options: { budget?: WorkBudget } = {}): DependencyGraph {
  const budget = options.budget ?? new WorkBudget(); budget.check();
  if (directions.length > budget.limits.instances) throw new WorkLimitError('RESOURCE_LIMIT', 'Configured direction count exceeds the instance quota');
  const groups = new Map<string, DirectionDTO[]>(), diagnostics: Diagnostic[] = [], nodes: DependencyNode[] = [];
  for (const direction of directions) { budget.check(); const group = groups.get(direction.id); if (group) group.push(direction); else groups.set(direction.id, [direction]); }
  for (const [id, group] of [...groups].sort(([a], [b]) => ordinal(a, b))) {
    budget.check(); const reads = group.map(direction => collectReadSet(snapshot, direction, { budget }));
    const targetKeys = [...new Set(group.map(direction => direction.targetKey))].sort(ordinal);
    const issues = reads.flatMap(read => read.diagnostics);
    if (group.length > 1) issues.push({ code: 'DUPLICATE_DIRECTION', message: 'A configured direction identity appears more than once', severity: 'error' });
    // Inconsistent duplicate identities have no canonical destination; no input row wins.
    const targetKey = targetKeys.length === 1 ? targetKeys[0]! : '';
    if (!targetKey) issues.push({ code: 'INVALID_DIRECTION', message: 'The direction has no unambiguous canonical destination', severity: 'error' });
    const metadata = new Map(reads.flatMap(read => read.metadataReads).map(read => [JSON.stringify([read.contextId, read.code]), read]));
    nodes.push({ id, sortKey: targetKey + '\u0000' + id, targetKey,
      readKeys: [...new Set(reads.flatMap(read => read.readKeys))].sort(ordinal),
      metadataReads: [...metadata.values()].sort((a, b) => ordinal(a.contextId, b.contextId) || ordinal(a.code, b.code)), diagnostics: issues });
  }
  nodes.sort((a, b) => ordinal(a.sortKey, b.sortKey));
  const producers = new Map<string, string[]>();
  for (const node of nodes) {
    budget.check(); if (!node.targetKey) continue;
    const existing = producers.get(node.targetKey); if (existing) existing.push(node.id); else producers.set(node.targetKey, [node.id]);
  }
  const conflicts: ProducerConflictDTO[] = [];
  for (const [targetKey, producerIds] of [...producers].sort(([a], [b]) => ordinal(a, b))) {
    budget.check(); producerIds.sort(ordinal);
    if (producerIds.length > 1) {
      conflicts.push({ targetKey, producerIds });
      diagnostics.push({ code: 'MULTIPLE_PRODUCERS', message: 'Several configured directions produce the same canonical fact, regardless of their current values', severity: 'error' });
    }
  }
  const edges: DependencyEdge[] = [];
  for (const node of nodes) for (const factKey of node.readKeys) {
    budget.check();
    // Conflicting producers remain represented so their downstream consumers cannot use old data.
    for (const from of producers.get(factKey) ?? []) { budget.consume('edges'); edges.push({ from, to: node.id, factKey }); }
  }
  edges.sort((a, b) => ordinal(a.from, b.from) || ordinal(a.to, b.to) || ordinal(a.factKey, b.factKey));
  budget.check(); return { nodes, edges, conflicts, diagnostics };
}
