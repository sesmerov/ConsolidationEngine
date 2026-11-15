import { UUID_PATTERN } from '@ce/contracts';
import type { JsonObject, JsonValue, ResultExplanationItemDTO, ResultExplanationSection, RuleResultDTO, Snapshot, ValidationBundle } from '@ce/contracts';
import { resultOrderKey, runValidation, WorkBudget } from '@ce/engine';
import { ApiError } from '../errors.js';
import { createPublicResultProjector, type BoundPublicValue } from '../presentation/public-results.js';
import type { HostedWorkerRequest } from '../workers/protocol.js';
import type { CanonicalWriteContext } from './canonical-codec.js';
import type { ProjectionInputRow } from './projection-store.js';
import type { PublicationEnvelope, PublishedValidation } from './publication.js';
import { executeTransferCommand } from './transfer-commands.js';
import { createHostedWorkerRuntime, type HostedCommandDependencies } from './worker-runtime.js';
import { prepareHostedReview } from './review-commands.js';
import { calculateHostedPreview } from './preview-commands.js';
import { editHostedSelection } from './selection-commands.js';
import { applyHostedSelection } from './application-commands.js';

const json = (value: unknown): JsonObject => value as JsonObject;
export function commandId(command: JsonObject, field: string): string {
  const value = command[field]; if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ApiError('INTERNAL_ERROR'); return value;
}
export function commandBody(request: HostedWorkerRequest): JsonObject {
  const command = request.claim.inputRefs['command']; if (!command || typeof command !== 'object' || Array.isArray(command)) throw new ApiError('INTERNAL_ERROR'); return command as JsonObject;
}
export function commandWriteContext(request: HostedWorkerRequest, cancelled: () => boolean): CanonicalWriteContext {
  const claim = request.claim; return { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt, cancelled };
}
export async function persistValidation(request: HostedWorkerRequest, cancelled: () => boolean, deps: HostedCommandDependencies,
  snapshot: Snapshot, bundle: ValidationBundle, budget: WorkBudget): Promise<Pick<PublicationEnvelope, 'canonicalRoots' | 'indexes'> & { validation: PublishedValidation }> {
  if (bundle.run.status !== 'completed' || !bundle.run.summary.complete || bundle.run.validationBasisId !== snapshot.validationBasisId) throw new ApiError('INCOMPATIBLE_VALIDATION_BASIS');
  const claim = request.claim, runId = bundle.run.id, context = commandWriteContext(request, cancelled);
  const basisExists = (await deps.db.query('SELECT id FROM validation_bases WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, snapshot.validationBasisId])).rowCount === 1;
  const stagedBasis = basisExists ? { basisId: snapshot.validationBasisId! } : {};
  const bundleRef = await deps.codec.put(claim, bundle, context);
  let currentBound: BoundPublicValue = async value => value;
  const projector = createPublicResultProjector(snapshot, { budget, bound: value => currentBound(value) });
  const indexed = await deps.indexes.stage(claim, { resource: { type: 'run', id: runId, view: 'rows' }, kind: 'results', ...stagedBasis, revision: 1,
    rows: bundle.results.map(result => ({ key: result.id, sortKey: resultOrderKey(result), code: result.code, status: result.status,
      selectors: { tables: result.tables, ...(result.contextId ? { contextId: result.contextId } : {}) }, value: result as unknown as JsonValue })),
    project: async (row, bound) => { currentBound = bound; return await projector.row(row.value as unknown as RuleResultDTO) as unknown as JsonValue; } });
  const evidence = createPublicResultProjector(snapshot, { budget });
  async function* itemRows(): AsyncGenerator<ProjectionInputRow> {
    const sections: ResultExplanationSection[] = ['operands', 'reads', 'metadata', 'origins', 'diagnostics', 'descriptions'];
    for (const result of bundle.results) for (const section of sections) {
      let ordinal = 0;
      for await (const item of evidence.items(result, section)) yield { key: item.itemId, sortKey: JSON.stringify([result.id, section, String(ordinal++).padStart(12, '0')]),
        code: result.code, selectors: { resultId: result.id, section }, value: item as unknown as JsonValue };
    }
  }
  const details = await deps.indexes.stage(claim, { resource: { type: 'run', id: runId, view: 'items' }, kind: 'details', ...stagedBasis, revision: 1, rows: itemRows(),
    project: async (row, bound) => { const item = row.value as unknown as ResultExplanationItemDTO; return { ...item, value: await bound(item.value) } as unknown as JsonValue; } });
  const diagnostics=await deps.indexes.stage(claim,{resource:{type:'run',id:runId,view:'diagnostics'},kind:'details',...stagedBasis,revision:1,
    rows:bundle.run.diagnostics.map((diagnostic,index)=>({key:String(index),sortKey:String(index).padStart(12,'0'),value:diagnostic as unknown as JsonValue}))});
  const validation: PublishedValidation = { id: runId, versionId: snapshot.versionId, basisId: snapshot.validationBasisId!, profileId: snapshot.content.profileId, summary: bundle.run.summary,
    resultIndexRef: { bundle: json(bundleRef), views: { rows: json(indexed.ref), items: json(details.ref),diagnostics:json(diagnostics.ref) } }, diagnosticsRef: { count: bundle.run.diagnostics.length } };
  return { validation, canonicalRoots: [bundleRef, indexed.manifestRef, details.manifestRef,diagnostics.manifestRef], indexes: [indexed, details,diagnostics].map(staged => ({ kind: staged.ref.kind, id: staged.ref.indexId, revision: staged.ref.revision, basisId: snapshot.validationBasisId! })) };
}
export async function executeRegulatoryCommand(request: HostedWorkerRequest, cancelled: () => boolean, deps: HostedCommandDependencies): Promise<PublicationEnvelope> {
  const claim = request.claim, command = commandBody(request), remaining = Date.parse(claim.deadlineAt) - deps.now();
  if (remaining <= 0) throw new ApiError('JOB_TIMED_OUT');
  const budget = new WorkBudget({ cancelled, now: deps.now, limits: { milliseconds: Math.min(60000, remaining) } });
  if (claim.kind === 'validate') {
    const snapshot = await deps.repository.loadSnapshot(claim, commandId(command, 'versionId')); budget.check();
    const bundle = runValidation(snapshot, { runId: commandId(command, 'runId'), startedAt: claim.startedAt, budget, cancelled });
    const { validation, ...stored } = await persistValidation(request, cancelled, deps, snapshot, bundle, budget);
    return { kind: 'validate', resultRef: { type: 'validation', id: bundle.run.id }, ...stored, validations: [validation] };
  }
  if (claim.kind === 'prepare-directions' || claim.kind === 'recalculation-operation') {
    const snapshot = await deps.repository.loadSnapshot(claim, commandId(command, 'versionId')); budget.check();
    if (snapshot.validationBasisId !== command['validationBasisId']) throw new ApiError('INCOMPATIBLE_VALIDATION_BASIS');
    return claim.kind === 'prepare-directions' ? prepareHostedReview(request, cancelled, deps, snapshot, budget) : calculateHostedPreview(request, cancelled, deps, snapshot, budget);
  }
  if (claim.kind === 'select-proposals' || claim.kind === 'apply') {
    const snapshot = await deps.repository.loadSnapshot(claim, commandId(command, 'versionId')); budget.check();
    return claim.kind === 'apply' ? applyHostedSelection(request, cancelled, deps, snapshot, budget) : editHostedSelection(request, cancelled, deps, snapshot, budget);
  }
  throw new ApiError('INVALID_REQUEST');
}
/** Fixed server entry point. Heavy objects never leave this worker; IPC carries only compact publication metadata. */
export async function executeHostedCommand(request: HostedWorkerRequest, cancelled: () => boolean): Promise<PublicationEnvelope> {
  const runtime = await createHostedWorkerRuntime(request);
  try {
    return await (['seal-upload', 'inspect-import', 'import', 'export'].includes(request.claim.kind)
      ? executeTransferCommand(request, cancelled, runtime) : executeRegulatoryCommand(request, cancelled, runtime));
  } finally { await runtime.close(); }
}
