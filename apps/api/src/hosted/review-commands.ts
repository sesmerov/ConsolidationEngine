import type { DirectionConflictCandidateDTO, JsonObject, JsonValue, Snapshot, ValidationBundle } from '@ce/contracts';
import { prepareDirectionProjection, projectDirectionConfiguration, readDirectionRows, readDirectionGroups, readDirectionCandidates, WorkBudget } from '@ce/engine';
import type { DirectionReviewProjection } from '@ce/engine';
import { ApiError } from '../errors.js';
import { ruleSourceDetails } from '../presentation/rule-presentation.js';
import { directionConfigurationVersion } from '../session/canonical-state.js';
import type { HostedWorkerRequest } from '../workers/protocol.js';
import type { CanonicalRef } from './canonical-codec.js';
import type { HostedCommandDependencies } from './worker-runtime.js';
import type { PublicationEnvelope } from './publication.js';
import type { ProjectionInputRow } from './projection-store.js';
import { commandBody, commandId, commandWriteContext } from './domain-commands.js';
import { restoreReviewChoices, stageReviewChoices } from './review-choices.js';

const json = (value: unknown) => value as JsonObject;
export async function loadReviewProjection(request: HostedWorkerRequest, deps: HostedCommandDependencies): Promise<DirectionReviewProjection> {
  const command = commandBody(request), reviewId = commandId(command, 'reviewId');
  const row = (await deps.db.query('SELECT * FROM direction_reviews WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [request.claim.sessionId, request.claim.workspaceId, reviewId])).rows[0];
  if (!row || !row.choices_ref?.projection || row.basis_id !== command['validationBasisId'] || row.base_version_id !== request.claim.baseVersionId
    || row.pending_job_id !== request.claim.jobId || row.revision !== String(command['reviewRevision'])) throw new ApiError('STALE_DIRECTION_REVIEW');
  const projection = await deps.codec.get(request.claim, row.choices_ref.projection as CanonicalRef) as unknown as DirectionReviewProjection;
  return restoreReviewChoices(deps, request.claim, projection);
}

export async function prepareHostedReview(request: HostedWorkerRequest, cancelled: () => boolean, deps: HostedCommandDependencies, snapshot: Snapshot, budget: WorkBudget): Promise<PublicationEnvelope> {
  const command = commandBody(request), claim = request.claim, runId = commandId(command, 'runId'), reviewId = commandId(command, 'reviewId');
  const run = (await deps.db.query('SELECT * FROM validation_runs WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, runId])).rows[0];
  if (!run || run.basis_id !== snapshot.validationBasisId || run.status !== 'completed' || !run.summary.complete || !run.result_index_ref?.bundle) throw new ApiError('INCOMPATIBLE_VALIDATION_BASIS');
  const bundle = await deps.codec.get(claim, run.result_index_ref.bundle) as unknown as ValidationBundle;
  if (bundle.run.id !== runId || bundle.run.validationBasisId !== snapshot.validationBasisId || !bundle.run.summary.complete) throw new ApiError('INCOMPATIBLE_VALIDATION_BASIS');
  const projection = prepareDirectionProjection(snapshot, bundle.results, { budget, reviewId }), context = commandWriteContext(request, cancelled);
  const choiceMetadata = await stageReviewChoices(deps, claim, snapshot, projection);
  const projectionRef = await deps.codec.put(claim, projection, context), roots = [projectionRef], indexes: PublicationEnvelope['indexes'][number][] = [], views: Record<string, JsonValue> = {};
  const stage = async (view: string, rows: AsyncIterable<ProjectionInputRow>) => {
    const output = await deps.indexes.stage(claim, { resource: { type: 'review', id: reviewId, view }, kind: view === 'rows' ? 'decisions' : view === 'groups' ? 'conflicts' : 'details', basisId: snapshot.validationBasisId!, revision: 1, rows,
      ...(view === 'candidateDetails' ? { project: async (row:ProjectionInputRow,bound:import('./projection-store.js').BoundProjectionValue) => {
        const detail=row.value as JsonObject;
        return {...detail,expression:await bound(detail['expression']),...(detail['precondition']===undefined?{}:{precondition:await bound(detail['precondition'])}),descriptions:await bound(detail['descriptions'])} as JsonValue;
      } } : {}) });
    views[view] = json(output.ref); roots.push(output.manifestRef); indexes.push({ kind: output.ref.kind, id: output.ref.indexId, revision: 1, basisId: snapshot.validationBasisId! });
  };
  async function* rows(): AsyncGenerator<ProjectionInputRow> {
    for (let offset = 0; offset < projection.counts.totalRows; offset += 200) for (const row of readDirectionRows(projection, { offset, limit: 200 }).items) {
      budget.check(); yield { key: row.rowId, sortKey: JSON.stringify([row.code, row.rowId]), code: row.code, status: row.state,
        selectors: { ...(row.groupId ? { groupId: row.groupId } : {}), ...(row.instanceId ? { instanceId: row.instanceId } : {}) }, value: row as unknown as JsonValue };
    }
  }
  const allGroups: DirectionReviewProjection = { ...projection, observedGroups: projection.groups.map((_group, ordinal) => ordinal),
    observedFlags: Array.from({ length: Math.ceil(projection.groups.length / 256) }, (_value, block) => '1'.repeat(Math.min(256, projection.groups.length - block * 256))) };
  const observed = new Set(projection.observedGroups.map(ordinal => projection.groups[ordinal]!.id));
  async function* groups(): AsyncGenerator<ProjectionInputRow> {
    for (let offset = 0; offset < allGroups.observedGroups.length; offset += 200) for (const group of readDirectionGroups(allGroups, { offset, limit: 200 }).items) {
      budget.check(); yield { key: group.groupId, sortKey: group.groupId, status: observed.has(group.groupId) ? group.state : 'not-observed', value: group as unknown as JsonValue };
    }
  }
  const source = ruleSourceDetails(snapshot.content);
  async function* candidates(detail: boolean): AsyncGenerator<ProjectionInputRow> {
    for (const groupOrdinal of allGroups.observedGroups) {
      const groupId = projection.groups[groupOrdinal]!.id;
      for (let offset = 0, total = 1; offset < total; offset += 200) {
        const page = readDirectionCandidates(allGroups, groupId, { offset, limit: 200 }); total = page.total;
        for (const identity of page.items) {
          budget.check(); const row = projection.rows[projection.byInstance[identity.instanceId]!]!, details = source(row.seed.variantIds), description = details.descriptions[0]?.description;
          const candidate: DirectionConflictCandidateDTO = { ...identity, expressionPreview: details.expression.slice(0, 512), expressionTruncated: details.expression.length > 512,
            descriptionTruncated: (description?.length ?? 0) > 512, ...(description === undefined ? {} : { descriptionPreview: description.slice(0, 512) }) };
          yield { key: groupId + ':' + identity.instanceId, sortKey: JSON.stringify([groupId, identity.code, identity.instanceId]), code: identity.code,
            selectors: { groupId, instanceId: identity.instanceId }, value: (detail ? { reviewId, revision: 1, candidate, ...details } : candidate) as unknown as JsonValue };
        }
      }
    }
  }
  await stage('rows', rows()); await stage('groups', groups()); await stage('candidates', candidates(false)); await stage('candidateDetails', candidates(true));
  let configChanged = choiceMetadata.configChanged;
  if (!projection.counts.conflicted && !projection.conflictGroupCount) {
    const compiled = projectDirectionConfiguration(projection, { budget });
    const exactChanged = directionConfigurationVersion(compiled.directions, compiled.decisionState) !== snapshot.content.configVersion;
    if (exactChanged !== configChanged) throw new ApiError('INTERNAL_ERROR');
  }
  return { kind: 'prepare-directions', resultRef: { type: 'direction-review', id: reviewId }, canonicalRoots: roots, indexes,
    review: { id: reviewId, expectedRevision: 0, state: 'ready', choicesRef: { projection: json(projectionRef), views },
      counts: { ...projection.counts, conflictGroupCount: projection.conflictGroupCount }, configChanged, dirtyCount: choiceMetadata.dirtyCount } };
}
