import { WorkBudget, WorkLimitError } from '../execution/budget.js';
import { ordinal } from '../resolver/coordinates.js';
import type { DependencyEdge, DependencyNode } from './producers.js';

export class DependencyGraphError extends Error { readonly code = 'INVALID_GRAPH'; }
export interface GraphIndex {
  readonly nodes: ReadonlyMap<string, DependencyNode>; readonly ids: readonly string[];
  readonly successors: ReadonlyMap<string, readonly string[]>; readonly predecessors: ReadonlyMap<string, readonly string[]>;
  readonly compare: (left: string, right: string) => number;
}
/** One adjacency per node pair; several source facts never inflate indegree inconsistently. */
export function indexGraph(nodes: readonly DependencyNode[], edges: readonly DependencyEdge[], budget: WorkBudget): GraphIndex {
  budget.check();
  if (nodes.length > budget.limits.instances || edges.length > budget.limits.edges) throw new WorkLimitError('RESOURCE_LIMIT', 'Graph size exceeds the work quota');
  const byId = new Map<string, DependencyNode>(), successors = new Map<string, Set<string>>(), predecessors = new Map<string, Set<string>>();
  for (const node of nodes) {
    budget.check(); if (byId.has(node.id)) throw new DependencyGraphError('Graph node identities must be unique');
    byId.set(node.id, node); successors.set(node.id, new Set()); predecessors.set(node.id, new Set());
  }
  for (const edge of edges) {
    budget.check(); if (!byId.has(edge.from) || !byId.has(edge.to)) throw new DependencyGraphError('An edge refers to an undeclared graph node');
    successors.get(edge.from)!.add(edge.to); predecessors.get(edge.to)!.add(edge.from);
  }
  const compare = (left: string, right: string) => ordinal(byId.get(left)!.sortKey, byId.get(right)!.sortKey) || ordinal(left, right);
  const ordered = (source: Map<string, Set<string>>) => new Map([...source].map(([id, neighbors]) => { budget.check(); return [id, [...neighbors].sort(compare)] as const; }));
  budget.check(); return { nodes: byId, ids: [...byId.keys()].sort(compare), successors: ordered(successors), predecessors: ordered(predecessors), compare };
}

/** Iterative Tarjan traversal: depth is bounded by heap storage, not the JavaScript call stack. */
export function stronglyConnectedComponents(nodes: readonly DependencyNode[], edges: readonly DependencyEdge[], options: { budget?: WorkBudget } = {}): string[][] {
  const budget = options.budget ?? new WorkBudget(), graph = indexGraph(nodes, edges, budget);
  const discovered = new Map<string, number>(), low = new Map<string, number>(), active = new Set<string>(), stack: string[] = [], components: string[][] = [];
  const frames: { id: string; next: number }[] = []; let ordinalIndex = 0;
  function enter(id: string): void {
    discovered.set(id, ordinalIndex); low.set(id, ordinalIndex++); active.add(id); stack.push(id); frames.push({ id, next: 0 });
  }
  for (const id of graph.ids) {
    budget.check(); if (discovered.has(id)) continue; enter(id);
    while (frames.length) {
      budget.check(); const frame = frames[frames.length - 1]!, neighbors = graph.successors.get(frame.id)!;
      if (frame.next < neighbors.length) {
        const next = neighbors[frame.next++]!;
        if (!discovered.has(next)) enter(next);
        else if (active.has(next)) low.set(frame.id, Math.min(low.get(frame.id)!, discovered.get(next)!));
        continue;
      }
      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent) low.set(parent.id, Math.min(low.get(parent.id)!, low.get(frame.id)!));
      if (low.get(frame.id) === discovered.get(frame.id)) {
        const component: string[] = []; let member: string;
        do { budget.check(); member = stack.pop()!; active.delete(member); component.push(member); } while (member !== frame.id);
        component.sort(graph.compare); components.push(component);
      }
    }
  }
  budget.check(); components.sort((a, b) => graph.compare(a[0]!, b[0]!)); return components;
}
