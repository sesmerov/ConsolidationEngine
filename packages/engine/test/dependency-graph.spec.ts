import { beforeAll, describe, expect, it } from 'vitest';
import type { Coordinate, Diagnostic, ImportedReport, MetadataReadDTO, RuleVariant, Snapshot } from '@ce/contracts';
import type { Binding } from '../src/resolver/scope.js';
import { stableId } from '../src/resolver/instances.js';
import { parseRule } from '../src/parser/parse-rule.js';
import { runValidation } from '../src/validation/run.js';
import { WorkBudget } from '../src/execution/budget.js';
import { collectReadSet } from '../src/dependencies/read-set.js';
import { buildDependencyGraph } from '../src/dependencies/producers.js';
import { context, coordinate, fact, G113, ref, report, twoSheetReport } from './helpers/report-fixture.js';

/** Test-local shapes agreed for T049–T052. No HTTP expression or AST is accepted in a direction. */
type Direction = { id: string; instanceId: string; variantIds: readonly string[]; binding: Binding; targetSide: 'left' | 'right'; targetKey: string };
type Definition = { code: string; expression: string; target: Coordinate; side?: 'left' | 'right'; precondition?: string; modules?: readonly string[]; crossModule?: boolean };
type GraphNode = { id: string; sortKey: string; targetKey: string; readKeys: readonly string[]; metadataReads: readonly MetadataReadDTO[]; diagnostics: readonly Diagnostic[] };
type GraphEdge = { from: string; to: string; factKey: string };
type Graph = { nodes: readonly GraphNode[]; edges: readonly GraphEdge[]; conflicts: readonly { targetKey: string; producerIds: readonly string[] }[]; diagnostics: readonly Diagnostic[] };
const PROFILE = 'ce-dpmxl-0.9-closed-v1';
const RUN_OPTIONS = { runId: 'graph-fixture-run', startedAt: '2026-10-31T00:00:00.000Z', now: () => 0 };
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
let orderDependencies: typeof import('../src/dependencies/kahn.js')['orderDependencies'];
let stronglyConnectedComponents: typeof import('../src/dependencies/scc.js')['stronglyConnectedComponents'];
async function loadScheduling() {
  ({ orderDependencies } = await import('../src/dependencies/kahn.js'));
  ({ stronglyConnectedComponents } = await import('../src/dependencies/scc.js'));
}

function fixture(definitions: readonly Definition[], input: ImportedReport, permute = false) {
  const variants: RuleVariant[] = definitions.map(definition => ({
    variantId: stableId([definition.code, definition.expression, definition.precondition ?? null]), code: definition.code,
    expression: definition.expression, ...(definition.precondition ? { precondition: definition.precondition } : {}),
    framework: input.contexts.find(ctx => ctx.contextId === definition.target.contextId)!.framework,
    modules: definition.modules ?? [input.contexts.find(ctx => ctx.contextId === definition.target.contextId)!.moduleVersion],
    crossModule: definition.crossModule ?? false, tables: [...new Set(input.coordinates.map(cell => cell.tableCode))].sort(lexical),
    active: true, referenceWindow: {}, severity: 'error', severityOriginal: 'Error', sourceRecords: [definition.code + '-row'],
    sourceLocators: [{ sheet: 'Synthetic rules', row: permute ? 100 - definitions.indexOf(definition) : definitions.indexOf(definition) + 2 }],
  }));
  const records = variants.map(variant => ({ id: variant.sourceRecords[0]!, code: variant.code, variantId: variant.variantId,
    sourceLocator: variant.sourceLocators[0]!, originalFields: {}, diagnostics: [] }));
  const analyses = variants.map(variant => ({ variantId: variant.variantId, grammarVersion: 'dpm-xl-0.9-antlr-4.13.2', profileId: PROFILE, ...parseRule(variant.expression) }));
  const reorder = <T>(items: readonly T[]): T[] => permute ? [...items].reverse() : [...items];
  const snapshot: Snapshot = { versionId: 'graph-snapshot', contentHash: 'synthetic-graph-content', createdAt: RUN_OPTIONS.startedAt, content: {
    catalogVersion: 'synthetic-catalog', reportVersion: 'synthetic-report', configVersion: 'synthetic-config', profileId: PROFILE,
    contexts: reorder(input.contexts),
    coordinates: reorder(input.coordinates).map((cell, index) => permute ? { ...cell, sourceLocator: { ...cell.sourceLocator, row: index + 40 } } : cell),
    facts: reorder(input.facts).map((value, index) => permute ? { ...value, sourceLocator: { ...value.sourceLocator, row: index + 70 } } : value), sources: [], directions: [],
    catalog: { records: reorder(records), variants: reorder(variants), analyses: reorder(analyses), coverage: { rows: records.length, variants: variants.length,
      applicableVariants: variants.length, supportedVariants: variants.length, invalidRows: 0, duplicateRows: 0, conflictingVariants: 0 } },
  } };
  const validation = runValidation(snapshot, RUN_OPTIONS);
  const directions: Direction[] = definitions.map(definition => {
    const candidates = validation.results.filter(result => result.code === definition.code && result.contextId === definition.target.contextId
      && (!result.binding?.sheetCode || result.binding.sheetCode === definition.target.sheetCode));
    const result = candidates[0];
    if (candidates.length !== 1 || !result?.instanceId || !result.binding) throw new Error(`Fixture needs one real structural instance for ${definition.code}`);
    const targetSide = definition.side ?? 'left';
    return { id: stableId([result.instanceId, targetSide, definition.target.factKey]), instanceId: result.instanceId,
      variantIds: result.variantIds, binding: result.binding, targetSide, targetKey: definition.target.factKey };
  });
  const configured: Snapshot = { ...snapshot, content: { ...snapshot.content, directions: directions.map(direction => ({ ...direction, binding: { ...direction.binding } })) } };
  return { snapshot: configured, directions: reorder(directions), validation,
    direction: (code: string) => directions[definitions.findIndex(definition => definition.code === code)]! };
}
function chainFixture(permute = false) {
  const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' }), c = coordinate({ row: '0030' }), x = coordinate({ row: '0090' });
  return fixture([
    { code: 'A', expression: `${ref(a)}=${ref(b)}+1`, target: a },
    { code: 'B', expression: `${ref(b)}=${ref(x)}+1`, target: b },
    { code: 'C', expression: `${ref(c)}=7`, target: c },
  ], report([x, c, a, b], [fact(x, '1'), fact(a, '0'), fact(b, '0'), fact(c, '0')]), permute);
}
function graphOf(input: ReturnType<typeof fixture>) { return buildDependencyGraph(input.snapshot, input.directions); }
function conflictFixture() {
  const a = coordinate({ row: '0010' }), d = coordinate({ row: '0020' }), e = coordinate({ row: '0030' }), free = coordinate({ row: '0040' });
  return fixture([
    { code: 'A1', expression: `${ref(a)}=1`, target: a }, { code: 'A2', expression: `${ref(a)}=1`, target: a },
    { code: 'D', expression: `${ref(d)}=${ref(a)}*2`, target: d }, { code: 'E', expression: `${ref(e)}=${ref(d)}*2`, target: e },
    { code: 'free', expression: `${ref(free)}=7`, target: free },
  ], report([a, d, e, free]));
}

describe('static dependency reads from configured equality directions', () => {
  it('resolves RHS ranges and preconditions through with, without reading unused scope coordinates or target', () => {
    const [a, b, c, d, p, unused] = ['0010', '0020', '0030', '0040', '0080', '0090'].map(row => coordinate({ row, column: '0060' })) as [Coordinate, Coordinate, Coordinate, Coordinate, Coordinate, Coordinate];
    const input = fixture([{ code: 'scope', expression: 'with {tT,r0010,c0060,default:0}: {r0010}={r0020}+sum({r0030-0040})',
      precondition: '{r0080}>0', target: a }], report([unused, p, a, d, c, b]));
    const reads = collectReadSet(input.snapshot, input.direction('scope'));
    expect(reads.diagnostics).toEqual([]); expect(reads.readKeys).toEqual([b, c, d, p].map(cell => cell.factKey).sort(lexical));
    expect(reads.readKeys).not.toContain(a.factKey); expect(reads.readKeys).not.toContain(unused.factKey);
    expect(reads.metadataReads).toEqual([]);
  });
  it('collects the left expression when the explicitly selected target is on the right', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' }), c = coordinate({ row: '0030' });
    const input = fixture([{ code: 'right', expression: `${ref(b)}+${ref(c)}=${ref(a)}`, target: a, side: 'right' }], report([c, a, b]));
    expect(collectReadSet(input.snapshot, input.direction('right')).readKeys).toEqual([b.factKey, c.factKey].sort(lexical));
  });
  it('collects static RHS reads even when the current precondition prevents body evaluation', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' });
    const input = fixture([{ code: 'false-now', expression: `${ref(a)}=${ref(b)}+1`, target: a, precondition: 'false' }], report([a, b]));
    expect(input.validation.results[0]!.readKeys).toEqual([]);
    expect(collectReadSet(input.snapshot, input.direction('false-now')).readKeys).toEqual([b.factKey]);
  });
  it('keeps every static boolean branch and a target read in the precondition as a conservative self dependency', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' });
    const input = fixture([{ code: 'guard', expression: `${ref(a)}=${ref(b)}`, target: a, precondition: `false and (${ref(a)}>0)` }], report([a, b]));
    expect(collectReadSet(input.snapshot, input.direction('guard')).readKeys).toEqual([a.factKey, b.factKey].sort(lexical));
  });
  it('drops inherited axes when RHS references another table', () => {
    const a = coordinate({ table: 'A', sheet: '01', row: '0010', column: '0060' }), b = coordinate({ table: 'B', row: '0020', column: '0070' });
    const input = fixture([{ code: 'other-table', expression: 'with {tA,r0010,c0060,s01,default:0}: {r0010}={tB,r0020,c0070}', target: a }], report([a, b]));
    const reads = collectReadSet(input.snapshot, input.direction('other-table')); expect(reads.diagnostics).toEqual([]); expect(reads.readKeys).toEqual([b.factKey]);
  });
  it('uses only the selected finite sheet binding for G113 and does not couple the other sheet', () => {
    const data = twoSheetReport(); const target = data.coordinates.find(cell => cell.rowCode === '0011' && cell.sheetCode === '0001')!;
    const input = fixture([{ code: 'G113', expression: G113, target, precondition: '{v_C_18.00}' }], data);
    const reads = collectReadSet(input.snapshot, input.direction('G113'));
    const expected = data.coordinates.filter(cell => cell.sheetCode === '0001' && cell.rowCode !== '0011').map(cell => cell.factKey).sort(lexical);
    expect(reads.readKeys).toEqual(expected); expect(reads.metadataReads).toEqual([expect.objectContaining({ contextId: 'demo', code: 'C_18.00', presence: 'declared', value: true })]);
  });
  it('keeps missing filing indicators as metadata rather than fact keys or producers', () => {
    const a = coordinate({ row: '0010' }); const input = fixture([{ code: 'metadata', expression: `${ref(a)}=1`, target: a, precondition: 'true or {v_MISSING}' }], report([a]));
    const reads = collectReadSet(input.snapshot, input.direction('metadata'));
    expect(reads.readKeys).toEqual([]); expect(reads.metadataReads).toEqual([expect.objectContaining({ contextId: 'demo', code: 'MISSING', presence: 'missing' })]);
    expect(graphOf(input).edges).toEqual([]);
  });
  it('reports an unknown RHS coordinate without inventing a null read or a fact key', () => {
    const a = coordinate(); const input = fixture([{ code: 'unknown', expression: `${ref(a)}={tT,r9999,c0010}`, target: a }], report([a]));
    const reads = collectReadSet(input.snapshot, input.direction('unknown'));
    expect(reads.readKeys).toEqual([]); expect(reads.diagnostics).toContainEqual(expect.objectContaining({ code: 'UNKNOWN_COORDINATE' }));
  });
});

describe('producers and graph edges', () => {
  it('links unique producers to consumers, not external reported inputs', () => {
    const input = chainFixture(); const graph = graphOf(input);
    expect(graph.nodes).toHaveLength(3); expect(graph.conflicts).toEqual([]);
    expect(graph.edges).toEqual([{ from: input.direction('B').id, to: input.direction('A').id, factKey: input.direction('B').targetKey }]);
  });
  it('deduplicates repeated reads so one producer-consumer pair has one edge per fact', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' });
    const input = fixture([{ code: 'A', expression: `${ref(a)}=${ref(b)}+${ref(b)}`, target: a }, { code: 'B', expression: `${ref(b)}=1`, target: b }], report([a, b]));
    const graph = graphOf(input); expect(graph.nodes.find(node => node.id === input.direction('A').id)!.readKeys).toEqual([b.factKey]);
    expect(graph.edges).toEqual([{ from: input.direction('B').id, to: input.direction('A').id, factKey: b.factKey }]);
  });
  it('does not create dependencies between directions that merely share an external read', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' }), x = coordinate({ row: '0090' });
    const input = fixture([{ code: 'A', expression: `${ref(a)}=${ref(x)}`, target: a }, { code: 'B', expression: `${ref(b)}=${ref(x)}+1`, target: b }], report([a, b, x]));
    expect(graphOf(input).edges).toEqual([]); expect(graphOf(input).nodes).toHaveLength(2);
  });
  it('links a boolean producer to a consumer whose current false precondition reads it', () => {
    const amount = coordinate({ row: '0010' }), flag = coordinate({ row: '0090', dataType: 'boolean' });
    const input = fixture([{ code: 'conditional', expression: `${ref(amount)}=7`, precondition: ref(flag), target: amount },
      { code: 'flag-producer', expression: `${ref(flag)}=true`, target: flag }], report([amount, flag], [fact(amount, '0'), fact(flag, false)]));
    expect(input.validation.results.find(result => result.code === 'conditional')!.status).toBe('not_applicable');
    const graph = graphOf(input);
    expect(graph.edges).toEqual([{ from: input.direction('flag-producer').id, to: input.direction('conditional').id, factKey: flag.factKey }]);
  });
  it('detects equal-value duplicate producers before scheduling and retains every conflicting edge', () => {
    const input = conflictFixture();
    const graph = graphOf(input); const producers = [input.direction('A1').id, input.direction('A2').id].sort(lexical);
    expect(graph.conflicts).toEqual([{ targetKey: input.direction('A1').targetKey, producerIds: producers }]);
    for (const from of producers) expect(graph.edges).toContainEqual({ from, to: input.direction('D').id, factKey: input.direction('A1').targetKey });
    expect(graph.edges).toContainEqual({ from: input.direction('D').id, to: input.direction('E').id, factKey: input.direction('D').targetKey });
  });
  it('keeps identical row/table coordinates in different logical contexts distinct', () => {
    const first = context({ contextId: 'first', moduleVersion: 'MODULE_A' }), second = context({ contextId: 'second', moduleVersion: 'MODULE_B' });
    const firstA = coordinate({ context: first, row: '0010' }), secondA = coordinate({ context: second, row: '0010' }), secondD = coordinate({ context: second, row: '0020' });
    const input = fixture([{ code: 'first-producer', expression: `${ref(firstA)}=1`, target: firstA },
      { code: 'second-consumer', expression: `${ref(secondD)}=${ref(secondA)}+1`, target: secondD }], report([firstA, secondA, secondD], [], [second, first]));
    expect(graphOf(input).edges).toEqual([]); expect(graphOf(input).conflicts).toEqual([]);
  });
});

describe('stable Kahn scheduling and residual SCC classification', () => {
  beforeAll(loadScheduling);
  it('blocks an unresolved direction rather than scheduling a synthetic null read', () => {
    const a = coordinate(); const input = fixture([{ code: 'unknown', expression: `${ref(a)}={tT,r9999,c0010}`, target: a }], report([a]));
    const scheduled = orderDependencies(graphOf(input)); expect(scheduled.order).toEqual([]);
    expect(scheduled.blocked).toContainEqual(expect.objectContaining({ id: input.direction('unknown').id, reason: 'invalid_direction' }));
  });
  it('blocks conflicting producers and their descendants while the independent branch continues', () => {
    const input = conflictFixture(); const scheduled = orderDependencies(graphOf(input));
    expect(scheduled.order).toEqual([input.direction('free').id]); expect(scheduled.cycles).toEqual([]); expect(scheduled.blocked).toHaveLength(4);
    for (const code of ['A1', 'A2']) expect(scheduled.blocked).toContainEqual(expect.objectContaining({ id: input.direction(code).id, reason: 'producer_conflict' }));
    for (const code of ['D', 'E']) expect(scheduled.blocked).toContainEqual(expect.objectContaining({ id: input.direction(code).id, reason: 'blocked_dependency' }));
  });
  it('chooses canonical target order again whenever a dependency releases a new ready node', () => {
    const input = chainFixture(); const scheduled = orderDependencies(graphOf(input));
    // Initially B and C are ready. B releases A, whose canonical key precedes C.
    expect(scheduled.order).toEqual(['B', 'A', 'C'].map(code => input.direction(code).id)); expect(scheduled.blocked).toEqual([]); expect(scheduled.cycles).toEqual([]);
  });
  it('classifies a two-node cycle separately from its descendant and runs an independent branch', () => {
    const a = coordinate({ row: '0010' }), b = coordinate({ row: '0020' }), d = coordinate({ row: '0030' }), free = coordinate({ row: '0040' });
    const input = fixture([{ code: 'A', expression: `${ref(a)}=${ref(b)}+1`, target: a }, { code: 'B', expression: `${ref(b)}=${ref(a)}+1`, target: b },
      { code: 'D', expression: `${ref(d)}=${ref(b)}*2`, target: d }, { code: 'free', expression: `${ref(free)}=7`, target: free }], report([a, b, d, free]));
    const graph = graphOf(input), scheduled = orderDependencies(graph);
    expect(scheduled.order).toEqual([input.direction('free').id]); expect(scheduled.cycles).toHaveLength(1);
    expect(new Set(scheduled.cycles[0])).toEqual(new Set([input.direction('A').id, input.direction('B').id]));
    for (const code of ['A', 'B']) expect(scheduled.blocked).toContainEqual(expect.objectContaining({ id: input.direction(code).id, reason: 'cycle' }));
    expect(scheduled.blocked).toContainEqual(expect.objectContaining({ id: input.direction('D').id, reason: 'blocked_dependency' }));
    expect(scheduled.cycles.flat()).not.toContain(input.direction('D').id);
  });
  it('detects a self-cycle from a target read in the precondition without labeling its descendant as cyclic', () => {
    const a = coordinate({ row: '0010' }), d = coordinate({ row: '0020' }), free = coordinate({ row: '0030' });
    const input = fixture([{ code: 'self', expression: `${ref(a)}=1`, target: a, precondition: `${ref(a)}>0` },
      { code: 'D', expression: `${ref(d)}=${ref(a)}*2`, target: d }, { code: 'free', expression: `${ref(free)}=7`, target: free }], report([a, d, free]));
    const graph = graphOf(input), scheduled = orderDependencies(graph); const self = input.direction('self').id;
    expect(graph.edges).toContainEqual({ from: self, to: self, factKey: a.factKey }); expect(scheduled.cycles).toEqual([[self]]);
    expect(scheduled.order).toEqual([input.direction('free').id]); expect(scheduled.blocked).toContainEqual(expect.objectContaining({ id: input.direction('D').id, reason: 'blocked_dependency' }));
  });
  it('keeps graph identities and scheduling unchanged under direction, catalog, fact and source-row permutations', () => {
    const first = chainFixture(), second = chainFixture(true); const graph = graphOf(first), permuted = graphOf(second);
    expect(new Set(graph.nodes.map(node => node.id))).toEqual(new Set(permuted.nodes.map(node => node.id)));
    expect(graph.edges).toEqual(permuted.edges);
    expect(orderDependencies(permuted)).toEqual(orderDependencies(graph));
    expect(orderDependencies({ ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() })).toEqual(orderDependencies(graph));
  });
  it('preserves SCC sets and descendant classifications across residual node and edge permutations', () => {
    const nodes = ['a', 'b', 'c', 'd', 'free'].map(syntheticNode); const edges = [edge('a', 'b'), edge('b', 'a'), edge('b', 'c'), edge('c', 'd')];
    const graph: Graph = { nodes, edges, conflicts: [], diagnostics: [] };
    const scheduled = orderDependencies(graph);
    expect(orderDependencies({ ...graph, nodes: [...nodes].reverse(), edges: [...edges].reverse() })).toEqual(scheduled);
    const components = stronglyConnectedComponents(nodes, edges).map(component => [...component].sort(lexical)).sort((a, b) => lexical(a.join(','), b.join(',')));
    expect(components).toEqual([['a', 'b'], ['c'], ['d'], ['free']]);
    expect(scheduled.order).toEqual(['free']); expect(scheduled.cycles).toEqual([['a', 'b']]);
  });
});

function syntheticNode(id: string): GraphNode { return { id, sortKey: 'fact:' + id, targetKey: 'fact:' + id, readKeys: [], metadataReads: [], diagnostics: [] }; }
function edge(from: string, to: string): GraphEdge { return { from, to, factKey: 'fact:' + from }; }

describe('graph construction budget', () => {
  it('stops graph expansion when its shared edge quota is exhausted', () => {
    const input = chainFixture(); const budget = new WorkBudget({ limits: { edges: 0 } });
    expect(() => buildDependencyGraph(input.snapshot, input.directions, { budget })).toThrow(expect.objectContaining({ code: 'RESOURCE_LIMIT' }));
  });
});
describe('bounded graph work and deep nonrecursive SCC traversal', () => {
  beforeAll(loadScheduling);
  it('honors job cancellation before scheduling work', () => {
    const graph: Graph = { nodes: [syntheticNode('a')], edges: [], conflicts: [], diagnostics: [] };
    expect(() => orderDependencies(graph, { budget: new WorkBudget({ cancelled: () => true }) })).toThrow(expect.objectContaining({ code: 'CANCELLED' }));
  });
  it('handles a 20000-node chain without depending on the JavaScript call-stack depth', () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => 'node-' + String(index).padStart(5, '0'));
    const nodes = ids.map(syntheticNode), edges = ids.slice(1).map((id, index) => edge(ids[index]!, id));
    const components = stronglyConnectedComponents(nodes, edges);
    expect(components).toHaveLength(ids.length); expect(components.every(component => component.length === 1)).toBe(true);
    const scheduled = orderDependencies({ nodes: [...nodes].reverse(), edges: [...edges].reverse(), conflicts: [], diagnostics: [] });
    expect(scheduled.order).toEqual(ids); expect(scheduled.blocked).toEqual([]); expect(scheduled.cycles).toEqual([]);
  });
  it('handles a deep residual cycle plus descendant without mistaking either for an independent branch', () => {
    const ids = Array.from({ length: 20_000 }, (_, index) => 'cycle-' + String(index).padStart(5, '0'));
    const nodes = [...ids.map(syntheticNode), syntheticNode('descendant'), syntheticNode('free')];
    const edges = [...ids.slice(1).map((id, index) => edge(ids[index]!, id)), edge(ids.at(-1)!, ids[0]!), edge(ids.at(-1)!, 'descendant')];
    const scheduled = orderDependencies({ nodes, edges, conflicts: [], diagnostics: [] });
    expect(scheduled.order).toEqual(['free']); expect(scheduled.cycles).toHaveLength(1); expect(new Set(scheduled.cycles[0])).toEqual(new Set(ids));
    expect(scheduled.blocked).toHaveLength(ids.length + 1);
    expect(scheduled.blocked).toContainEqual(expect.objectContaining({ id: 'descendant', reason: 'blocked_dependency' }));
    expect(scheduled.cycles[0]).not.toContain('descendant');
  });
});
