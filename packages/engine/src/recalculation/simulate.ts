/// <reference types="node" />
import { createHash } from 'node:crypto';
import { RECALCULATION_POLICY_ID, type Diagnostic, type DirectionDTO, type FactReadDTO, type PreviewBundle, type ProposalDTO, type Snapshot, type SourceLocator } from '@ce/contracts';
import { buildDependencyGraph, type DependencyNode } from '../dependencies/producers.js';
import { orderDependencies, type DependencyBlockReason } from '../dependencies/kahn.js';
import { WorkBudget, type WorkLimits } from '../execution/budget.js';
import { ordinal, reportIndex } from '../resolver/coordinates.js';
import { evaluateCandidate } from './candidate.js';
import { assertRecalculationConfiguration } from './configuration.js';

export interface SimulateOptions {
  readonly previewId: string; readonly now?: () => number; readonly limits?: Partial<WorkLimits>;
  readonly cancelled?: () => boolean; readonly progress?: (completed: number, total: number) => void;
}
export class SimulationError extends Error {
  constructor(readonly code: 'PROFILE_MISMATCH' | 'INVALID_PREVIEW_ID' | 'INVALID_DIRECTION', message: string) { super(message); }
}
/** RFC 9562 §5.5: namespace octets in network order followed by the UTF-8 name. */
export function uuidV5(namespace: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(namespace)) throw new SimulationError('INVALID_PREVIEW_ID', 'The preview namespace must be a UUID');
  const digest = createHash('sha1').update(Buffer.from(namespace.replaceAll('-', ''), 'hex')).update(name, 'utf8').digest().subarray(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x50; digest[8] = (digest[8]! & 0x3f) | 0x80;
  const text = digest.toString('hex'); return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`;
}
const uniqueSources = (sources: readonly SourceLocator[]) => [...new Map(sources.map(source => [JSON.stringify(source), source])).entries()].sort(([a], [b]) => ordinal(a, b)).map(([, source]) => source);
const blockCode: Record<DependencyBlockReason, string> = { producer_conflict: 'MULTIPLE_PRODUCERS', cycle: 'DEPENDENCY_CYCLE', blocked_dependency: 'BLOCKED_DEPENDENCY', invalid_direction: 'INVALID_DIRECTION' };
const blockMessage: Record<DependencyBlockReason, string> = {
  producer_conflict: 'Varias direcciones producen el mismo destino; no se selecciona una por orden.',
  cycle: 'La dirección pertenece a un ciclo de dependencias y no se simula.',
  blocked_dependency: 'La dirección necesita un productor bloqueado; no se utiliza su valor anterior.',
  invalid_direction: 'La dirección no tiene una estructura o referencias válidas para esta versión.',
};

/** The base is immutable. Only fully completed simulations return a publishable preview bundle. */
export function simulate(snapshot: Snapshot, options: SimulateOptions): PreviewBundle {
  const createdAt = new Date((options.now ?? Date.now)()).toISOString();
  const budget = new WorkBudget({ ...(options.now ? { now: options.now } : {}), ...(options.limits ? { limits: options.limits } : {}), ...(options.cancelled ? { cancelled: options.cancelled } : {}) });
  budget.check(); uuidV5(options.previewId, '');
  assertRecalculationConfiguration(snapshot, { budget });
  // All graph and candidate resolution shares one private snapshot identity. Only its facts
  // change; the operation's cached structural expansions must not be charged repeatedly.
  const current = { ...snapshot, content: { ...snapshot.content, facts: [...snapshot.content.facts] } };
  const graph = buildDependencyGraph(current, current.content.directions, { budget }), schedule = orderDependencies(graph, { budget });
  const directions = new Map<string, DirectionDTO>();
  for (const direction of snapshot.content.directions) {
    budget.check(); const existing = directions.get(direction.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(direction)) throw new SimulationError('INVALID_DIRECTION', 'Duplicate direction identities have inconsistent definitions');
    directions.set(direction.id, direction);
  }
  const nodeById = new Map<string, DependencyNode>(), proposalIds = new Map<string, string>();
  for (const node of graph.nodes) { budget.check(); nodeById.set(node.id, node); proposalIds.set(node.id, uuidV5(options.previewId, node.id)); }
  const predecessors = new Map(graph.nodes.map(node => [node.id, new Set<string>()]));
  for (const edge of graph.edges) { budget.check(); predecessors.get(edge.to)!.add(edge.from); }
  const proposals = new Map<string, ProposalDTO>();
  // This provenance describes the private simulation, never an applied receipt.
  const simulatedProducers = new Map<string, string>();
  const index = reportIndex(snapshot.content, budget), coordinateByKey = new Map(snapshot.content.coordinates.map(cell => [cell.factKey, cell]));
  let completed = 0;
  function progress(): void { options.progress?.(++completed, graph.nodes.length); budget.check(); }
  function identity(node: DependencyNode): Pick<ProposalDTO, 'id' | 'previewId' | 'directionId' | 'instanceId' | 'variantIds' | 'binding' | 'code' | 'targetKey' | 'predecessorIds'> {
    const direction = directions.get(node.id)!;
    const codes = new Set(snapshot.content.catalog.variants.filter(variant => direction.variantIds.includes(variant.variantId)).map(variant => variant.code));
    return { id: proposalIds.get(node.id)!, previewId: options.previewId, directionId: node.id, instanceId: direction.instanceId,
      variantIds: [...direction.variantIds].sort(ordinal), binding: direction.binding, code: codes.size === 1 ? [...codes][0]! : '', targetKey: direction.targetKey,
      predecessorIds: [...predecessors.get(node.id)!].sort(ordinal).map(id => proposalIds.get(id)!) };
  }
  function blocked(node: DependencyNode, reason: DependencyBlockReason, causes: readonly string[]): ProposalDTO {
    budget.check(); const direction = directions.get(node.id)!, coordinate = coordinateByKey.get(direction.targetKey), previous = index.facts.get(direction.targetKey) ?? [];
    let before: FactReadDTO | undefined;
    if (coordinate && previous.length <= 1) {
      const fact = previous[0];
      before = { factKey: coordinate.factKey, coordinate, presence: fact ? fact.presence === 'null' ? 'explicit_null' : 'value' : 'implicit_null',
        ...(fact?.normalizedValue !== undefined ? { normalizedValue: fact.normalizedValue } : {}), ...(fact?.originalText !== undefined ? { originalText: fact.originalText } : {}),
        ...(fact?.derivation ? { derivation: fact.derivation } : {}), sourceLocator: fact?.sourceLocator ?? coordinate.sourceLocator };
    }
    const readSet = new Set([...node.readKeys, direction.targetKey]);
    const sources = uniqueSources([...snapshot.content.catalog.variants.filter(variant => direction.variantIds.includes(variant.variantId)).flatMap(variant => variant.sourceLocators),
      ...[...readSet].flatMap(key => { budget.check(); return [...(coordinateByKey.has(key) ? [coordinateByKey.get(key)!.sourceLocator] : []), ...(index.facts.get(key) ?? []).map(fact => fact.sourceLocator)]; }),
      ...node.metadataReads.flatMap(read => read.sourceLocator ? [read.sourceLocator] : [])]);
    const ids = [...causes].sort(ordinal).map(id => proposalIds.get(id)).filter((id): id is string => id !== undefined);
    const issue: Diagnostic = { code: blockCode[reason], message: blockMessage[reason] + (ids.length ? ' Propuestas relacionadas: ' + ids.join(', ') + '.' : ''), severity: 'error' };
    return { ...identity(node), state: 'blocked', ...(before ? { before } : {}), readKeys: node.readKeys, metadataReads: node.metadataReads, sources, diagnostics: [...node.diagnostics, issue] };
  }
  for (const item of schedule.blocked) { budget.check(); proposals.set(item.id, blocked(nodeById.get(item.id)!, item.reason, item.causes)); progress(); }
  // Each fact update gets fresh content, preventing reportIndex from seeing stale facts.
  for (const id of schedule.order) {
    budget.check(); const node = nodeById.get(id)!, direction = directions.get(id)!;
    const unavailable = [...predecessors.get(id)!].filter(predecessor => proposals.get(predecessor)?.state !== 'available');
    if (unavailable.length) proposals.set(id, blocked(node, 'blocked_dependency', unavailable));
    else {
      const candidate = evaluateCandidate(current, direction, { budget });
      const { fact, ...details } = candidate;
      if (candidate.state === 'available' && (!fact || !candidate.after)) throw new SimulationError('INVALID_DIRECTION', 'An available candidate must contain its quantized fact');
      const calculation = candidate.calculation ? { ...candidate.calculation, reads: candidate.calculation.reads.map(read => {
        budget.check(); const fromProposalId = simulatedProducers.get(read.fact.factKey);
        return { ...read, ...(fromProposalId ? { fromProposalId } : {}) };
      }) } : undefined;
      proposals.set(id, { ...identity(node), ...details, ...(calculation ? { calculation } : {}) });
      if (candidate.state === 'available') {
        current.content = { ...current.content, facts: [...current.content.facts.filter(value => value.factKey !== direction.targetKey), fact!] };
        simulatedProducers.set(direction.targetKey, proposalIds.get(id)!);
      }
    }
    progress();
  }
  budget.check();
  const ordered = [...schedule.order, ...schedule.blocked.map(item => item.id)].map(id => proposals.get(id)!);
  if (ordered.some(proposal => !proposal)) throw new SimulationError('INVALID_DIRECTION', 'Every configured graph node must have a proposal result');
  return { preview: { id: options.previewId, baseVersionId: snapshot.versionId, profileId: snapshot.content.profileId, policyId: RECALCULATION_POLICY_ID,
    createdAt, state: 'ready', proposalIds: ordered.map(proposal => proposal.id), graphSummary: { nodes: graph.nodes.length, edges: graph.edges.length,
      order: schedule.order, conflicts: graph.conflicts, cycles: schedule.cycles, blocked: ordered.filter(proposal => proposal.state === 'blocked').length }, diagnostics: graph.diagnostics }, proposals: ordered };
}
