import { WorkBudget } from '../execution/budget.js';
import { ordinal } from '../resolver/coordinates.js';
import type { DependencyGraph } from './producers.js';
import { DependencyGraphError, indexGraph, stronglyConnectedComponents } from './scc.js';

export type DependencyBlockReason = 'producer_conflict' | 'cycle' | 'blocked_dependency' | 'invalid_direction';
export interface DependencyBlock { readonly id: string; readonly reason: DependencyBlockReason; readonly causes: readonly string[] }
export interface DependencySchedule { readonly order: readonly string[]; readonly cycles: readonly (readonly string[])[]; readonly blocked: readonly DependencyBlock[] }
class ReadyQueue {
  private readonly values: string[] = [];
  constructor(private readonly compare: (left: string, right: string) => number) {}
  get size(): number { return this.values.length; }
  push(value: string): void {
    let position = this.values.length; this.values.push(value);
    while (position > 0) { const parent = Math.floor((position - 1) / 2); if (this.compare(this.values[parent]!, value) <= 0) break; this.values[position] = this.values[parent]!; position = parent; }
    this.values[position] = value;
  }
  pop(): string {
    const first = this.values[0]!, last = this.values.pop()!;
    if (!this.values.length) return first;
    let position = 0;
    while (position * 2 + 1 < this.values.length) {
      let child = position * 2 + 1;
      if (child + 1 < this.values.length && this.compare(this.values[child + 1]!, this.values[child]!) < 0) child++;
      if (this.compare(last, this.values[child]!) <= 0) break;
      this.values[position] = this.values[child]!; position = child;
    }
    this.values[position] = last; return first;
  }
}

/** Conflicts and their descendants are removed before Kahn; only the remaining residue needs SCC. */
export function orderDependencies(input: DependencyGraph, options: { budget?: WorkBudget } = {}): DependencySchedule {
  const budget = options.budget ?? new WorkBudget(), graph = indexGraph(input.nodes, input.edges, budget);
  const blocked = new Map<string, { reason: DependencyBlockReason; causes: Set<string> }>();
  for (const conflict of [...input.conflicts].sort((a, b) => ordinal(a.targetKey, b.targetKey))) {
    budget.check(); const producers = [...new Set(conflict.producerIds)];
    if (producers.length < 2 || producers.some(id => !graph.nodes.has(id))) throw new DependencyGraphError('Producer conflict must identify distinct declared nodes');
    producers.sort(graph.compare);
    // A deterministic pair is sufficient evidence for each conflicting producer. The full set
    // remains in graph.conflicts, avoiding a quadratic cause list for a large conflict group.
    for (const id of producers) { budget.check(); blocked.set(id, { reason: 'producer_conflict', causes: new Set([id === producers[0] ? producers[1]! : producers[0]!]) }); }
  }
  for (const node of graph.nodes.values()) {
    budget.check();
    if (!blocked.has(node.id) && node.diagnostics.some(item => item.severity !== 'warning' && item.severity !== 'info')) blocked.set(node.id, { reason: 'invalid_direction', causes: new Set([node.id]) });
  }
  function propagate(initial: readonly string[], allowed?: ReadonlySet<string>): void {
    const queue = [...initial].sort(graph.compare);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      budget.check(); const from = queue[cursor]!;
      for (const to of graph.successors.get(from)!) {
        budget.check(); if (allowed && !allowed.has(to)) continue;
        const existing = blocked.get(to);
        if (!existing) { blocked.set(to, { reason: 'blocked_dependency', causes: new Set([from]) }); queue.push(to); }
        else if (existing.reason === 'blocked_dependency') existing.causes.add(from);
      }
    }
  }
  propagate([...blocked.keys()]);
  const indegrees = new Map<string, number>(), ready = new ReadyQueue(graph.compare), order: string[] = [], emitted = new Set<string>();
  for (const id of graph.ids) {
    budget.check(); if (blocked.has(id)) continue;
    const degree = graph.predecessors.get(id)!.filter(predecessor => !blocked.has(predecessor)).length;
    indegrees.set(id, degree); if (degree === 0) ready.push(id);
  }
  while (ready.size) {
    budget.check(); const id = ready.pop(); order.push(id); emitted.add(id);
    for (const successor of graph.successors.get(id)!) {
      budget.check(); if (blocked.has(successor)) continue;
      const remaining = indegrees.get(successor)! - 1; indegrees.set(successor, remaining); if (remaining === 0) ready.push(successor);
    }
  }
  const residual = new Set(graph.ids.filter(id => !blocked.has(id) && !emitted.has(id)));
  const residualNodes = [...residual].map(id => graph.nodes.get(id)!);
  const residualEdges = input.edges.filter(edge => { budget.check(); return residual.has(edge.from) && residual.has(edge.to); });
  const cycles = stronglyConnectedComponents(residualNodes, residualEdges, { budget }).filter(component => component.length > 1 || graph.successors.get(component[0]!)!.includes(component[0]!));
  for (const component of cycles) {
    budget.check(); const members = new Set(component);
    for (const id of component) {
      budget.check(); blocked.set(id, { reason: 'cycle', causes: new Set(graph.predecessors.get(id)!.filter(predecessor => members.has(predecessor))) });
    }
  }
  propagate(cycles.flat(), residual);
  if ([...residual].some(id => !blocked.has(id))) throw new DependencyGraphError('The Kahn residue contains an unclassified node');
  budget.check(); return { order, cycles, blocked: [...blocked].sort(([a], [b]) => graph.compare(a, b)).map(([id, value]) => ({ id, reason: value.reason, causes: [...value.causes].sort(graph.compare) })) };
}
