/// <reference types="node" />
import { createHash } from 'node:crypto';
import { RECALCULATION_POLICY_ID, UUID_PATTERN, isRationalValue, type Diagnostic, type PreviewBundle, type PreviewDTO, type ProposalAfterDTO, type ProposalDTO,
  type NormalizedValue, type Rational, type ReportedFact, type Snapshot, type ValidationBundle } from '@ce/contracts';
import { buildDependencyGraph } from '../dependencies/producers.js';
import { orderDependencies } from '../dependencies/kahn.js';
import { WorkBudget, WorkLimitError, type WorkLimits } from '../execution/budget.js';
import { compare, rational, NumericError } from '../numeric/rational.js';
import { ordinal, reportIndex } from '../resolver/coordinates.js';
import { runValidation } from '../validation/run.js';
import { evaluateCandidate } from './candidate.js';
import { uuidV5 } from './simulate.js';
import { assertRecalculationConfiguration } from './configuration.js';

export interface ApplyCandidateOptions {
  readonly receiptId: string; readonly newVersionId: string; readonly beforeRunId: string; readonly runId: string; readonly startedAt: string;
  readonly selectedIds: readonly string[]; readonly closureHash: string; readonly beforeValidation?: ValidationBundle;
  readonly budget?: WorkBudget; readonly limits?: Partial<WorkLimits>; readonly cancelled?: () => boolean; readonly now?: () => number;
  readonly progress?: (completed: number, total: number) => void;
}
/** Transportable computation only. Receipts, snapshots and their publication belong to the main thread. */
export interface ApplicationCandidate {
  readonly factPatches: readonly ReportedFact[]; readonly beforeValidation: ValidationBundle; readonly validation: ValidationBundle;
}
export type ApplicationErrorCode = 'INVALID_REQUEST' | 'STALE_VERSION' | 'PROFILE_MISMATCH' | 'PREVIEW_NOT_APPLICABLE' | 'SELECTION_NOT_CLOSED' | 'INTERNAL_ERROR';
export class ApplicationError extends Error {
  constructor(readonly code: ApplicationErrorCode, message: string, readonly diagnostics: readonly Diagnostic[] = []) { super(message); }
}
/** Fixed keys in canonical alphabetical order match the API's canonical JSON hash. */
export function selectionClosureHash(preview: Pick<PreviewDTO, 'id' | 'baseVersionId' | 'policyId' | 'profileId'>, selectedIds: readonly string[], requiredIds: readonly string[] = []): string {
  return createHash('sha256').update(JSON.stringify({ baseVersionId: preview.baseVersionId, policyId: preview.policyId, previewId: preview.id,
    profileId: preview.profileId, requiredIds: [...new Set(requiredIds)].sort(ordinal), selectedIds: [...new Set(selectedIds)].sort(ordinal) })).digest('hex');
}
function exact(value: Rational) {
  // Bound input text before constructing a BigInt, including when the pure API is called with malformed internal data.
  if (value.numerator.length > 1235 || value.denominator.length > 1234) throw new NumericError('RESOURCE_LIMIT');
  if (!/^-?(0|[1-9][0-9]*)$/.test(value.numerator) || !/^[1-9][0-9]*$/.test(value.denominator)) throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'El valor propuesto no es un racional válido.');
  return rational(BigInt(value.numerator), BigInt(value.denominator));
}
export function sameReportedValue(left: NormalizedValue | undefined, right: NormalizedValue | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  if (typeof left === 'boolean' || typeof right === 'boolean') return left === right;
  if (!isRationalValue(left) || !isRationalValue(right)) return !isRationalValue(left) && !isRationalValue(right) && left.kind === right.kind && left.value === right.value;
  return compare(exact(left), exact(right)) === 0;
}
function sameAfter(left: ProposalAfterDTO, right: ProposalAfterDTO): boolean {
  return sameReportedValue(left.normalizedValue, right.normalizedValue) && left.originalText === right.originalText
    && ('decimals' in left ? 'decimals' in right && left.decimals === right.decimals && left.unit === right.unit : !('decimals' in right));
}
function completed(bundle: ValidationBundle): ValidationBundle {
  if (bundle.run.status === 'completed' && bundle.run.summary.complete) return bundle;
  const issue = bundle.run.diagnostics.find(d => ['RESOURCE_LIMIT', 'CANCELLED', 'DEADLINE_EXCEEDED'].includes(d.code));
  if (issue) throw new WorkLimitError(issue.code as 'RESOURCE_LIMIT' | 'CANCELLED' | 'DEADLINE_EXCEEDED', issue.message);
  throw new ApplicationError(bundle.run.diagnostics.some(d => d.code === 'PROFILE_MISMATCH') ? 'PROFILE_MISMATCH' : 'INTERNAL_ERROR', 'La revalidación técnica no se ha completado.', bundle.run.diagnostics);
}
function reusable(bundle: ValidationBundle | undefined, snapshot: Snapshot, id: string): bundle is ValidationBundle {
  return !!bundle && bundle.run.id === id && bundle.run.versionId === snapshot.versionId && bundle.run.profileId === snapshot.content.profileId
    && bundle.run.status === 'completed' && bundle.run.summary.complete && bundle.run.summary.rows === snapshot.content.catalog.records.length
    && bundle.run.summary.variants === snapshot.content.catalog.variants.length && bundle.run.resultIds.length === bundle.results.length
    && bundle.results.every((result, index) => result.id === bundle.run.resultIds[index] && result.runId === id && result.versionId === snapshot.versionId && result.profileId === snapshot.content.profileId);
}

/** Recheck the explicitly accepted preview, compute patches, and revalidate without publishing or mutating input. */
export function applyCandidate(snapshot: Snapshot, bundle: PreviewBundle, options: ApplyCandidateOptions): ApplicationCandidate {
  const budget = options.budget ?? new WorkBudget({ ...(options.limits ? { limits: options.limits } : {}), ...(options.cancelled ? { cancelled: options.cancelled } : {}), ...(options.now ? { now: options.now } : {}) });
  budget.check();
  if (!Array.isArray(options.selectedIds)) throw new ApplicationError('INVALID_REQUEST', 'La selección debe ser una lista de propuestas.');
  const { preview } = bundle, selected = new Set(options.selectedIds);
  if (selected.size === 0 || selected.size !== options.selectedIds.length
    || [options.receiptId, options.newVersionId, options.beforeRunId, options.runId].some(id => !UUID_PATTERN.test(id))
    || options.newVersionId === snapshot.versionId || options.beforeRunId === options.runId || !Number.isFinite(Date.parse(options.startedAt))) throw new ApplicationError('INVALID_REQUEST', 'La solicitud de aplicación no es válida.');
  if (preview.baseVersionId !== snapshot.versionId) throw new ApplicationError('STALE_VERSION', 'La previsualización pertenece a otra versión.');
  if (preview.profileId !== snapshot.content.profileId || preview.policyId !== RECALCULATION_POLICY_ID) throw new ApplicationError('PROFILE_MISMATCH', 'El perfil o la política no coincide.');
  assertRecalculationConfiguration(snapshot, { budget });
  if (preview.state !== 'ready') throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'La previsualización ya no está disponible.');
  const byId = new Map<string, ProposalDTO>();
  for (const proposal of bundle.proposals) { budget.check(); if (byId.has(proposal.id)) throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'La previsualización contiene identidades duplicadas.'); byId.set(proposal.id, proposal); }
  for (const id of selected) {
    budget.consume('instances'); const proposal = byId.get(id);
    if (!proposal) throw new ApplicationError('INVALID_REQUEST', 'La selección contiene una propuesta desconocida.');
    if (proposal.previewId !== preview.id || proposal.state !== 'available' || !proposal.after) throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'La propuesta seleccionada no es aplicable.');
    for (const predecessor of proposal.predecessorIds) { budget.consume('edges'); if (!selected.has(predecessor)) throw new ApplicationError('SELECTION_NOT_CLOSED', 'Falta un antecesor explícitamente seleccionado.'); }
  }
  if (selectionClosureHash(preview, options.selectedIds) !== options.closureHash) throw new ApplicationError('SELECTION_NOT_CLOSED', 'El hash no corresponde a la selección cerrada.');
  // Keep one private snapshot identity for bounded structural caches, replacing content after each actual patch.
  const current = { ...snapshot, content: snapshot.content };
  const graph = buildDependencyGraph(current, snapshot.content.directions, { budget }), schedule = orderDependencies(graph, { budget });
  const directions = new Map(snapshot.content.directions.map(direction => [direction.id, direction]));
  const byDirection = new Map<string, ProposalDTO>(), targets = new Set<string>();
  for (const id of selected) {
    budget.check(); const proposal = byId.get(id)!, direction = directions.get(proposal.directionId);
    if (!direction || proposal.id !== uuidV5(preview.id, direction.id) || proposal.instanceId !== direction.instanceId || proposal.targetKey !== direction.targetKey
      || byDirection.has(direction.id) || targets.has(direction.targetKey)) throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'La selección contiene destinos o direcciones incompatibles.');
    byDirection.set(direction.id, proposal); targets.add(direction.targetKey);
  }
  if (schedule.blocked.some(item => byDirection.has(item.id))) throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'Una dirección seleccionada está bloqueada por el grafo.');
  for (const edge of graph.edges) if (byDirection.has(edge.to) && !byDirection.has(edge.from)) throw new ApplicationError('SELECTION_NOT_CLOSED', 'La selección no incluye todas las dependencias actuales.');
  const selectedOrder = schedule.order.filter(id => byDirection.has(id));
  if (selectedOrder.length !== selected.size) throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'No se pueden ordenar todas las propuestas.');
  const advance = (stage: number) => { options.progress?.(stage, 3); budget.check(); };
  advance(0);
  const runOptions = { startedAt: options.startedAt, budget, ...(options.now ? { now: options.now } : {}) };
  const beforeValidation = reusable(options.beforeValidation, snapshot, options.beforeRunId) ? options.beforeValidation : completed(runValidation(snapshot, { ...runOptions, runId: options.beforeRunId }));
  advance(1);
  const factPatches: ReportedFact[] = [];
  for (const id of selectedOrder) {
    budget.check(); const proposal = byDirection.get(id)!, candidate = evaluateCandidate(current, directions.get(id)!, { budget });
    if (candidate.state !== 'available' || !candidate.fact || !candidate.after || !sameAfter(candidate.after, proposal.after!)) throw new ApplicationError('PREVIEW_NOT_APPLICABLE', 'La propuesta ya no coincide con un candidato válido.', candidate.diagnostics);
    const previous = reportIndex(current.content, budget).facts.get(candidate.fact.factKey)?.[0];
    // Padding differences do not replace the original text or its existing derivation.
    if (previous?.presence === 'value' && sameReportedValue(previous.normalizedValue, candidate.fact.normalizedValue)) continue;
    const patch: ReportedFact = { ...candidate.fact, derivation: { receiptId: options.receiptId, previewId: preview.id, proposalId: proposal.id, baseVersionId: snapshot.versionId } };
    factPatches.push(patch);
    current.content = { ...current.content, facts: [...current.content.facts.filter(fact => fact.factKey !== patch.factKey), patch] };
  }
  advance(2);
  // This private evaluation view is never returned as a persisted snapshot; main computes the final content hash.
  const validation = completed(runValidation({ ...current, versionId: options.newVersionId, parentVersionId: snapshot.versionId }, { ...runOptions, runId: options.runId }));
  advance(3);
  return { factPatches, beforeValidation, validation };
}
