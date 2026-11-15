import type { Snapshot } from '@ce/contracts';
import { restoreDirectionProjection, WorkBudget } from '@ce/engine';
import type { DirectionReviewProjection } from '@ce/engine';
import type { HostedCommandDependencies } from './worker-runtime.js';
import { assertClaimAuthority, type HostedJobClaim } from './job-coordinator.js';

export function sideOf(choice: string): 'left' | 'right' | undefined { return 'ALl'.includes(choice) ? 'left' : 'BRr'.includes(choice) ? 'right' : undefined; }
export function tokenOf(choice: string, savedOrigin?: string): string {
  const side = sideOf(choice); return side ? `${side}:${'AB'.includes(choice) ? 'automatic' : 'LR'.includes(choice) ? 'explicit' : savedOrigin ?? 'previous'}` : choice;
}
export async function stageReviewChoices(deps: HostedCommandDependencies, claim: HostedJobClaim, snapshot: Snapshot, projection: DirectionReviewProjection) {
  const saved = new Map(snapshot.content.directions.map(row => [row.instanceId, row])), state = snapshot.content.directionDecisionState;
  const origins = new Map(state?.mode === 'reviewed' ? state.originExceptions.map(row => [row.instanceId, row.origin]) : []);
  const exceptions = new Set(state?.mode === 'reviewed' ? state.unselectedExceptions : []);
  let dirtyCount = 0, matchedDirections = 0;
  const data = projection.rows.map((row, ordinal) => {
    const choice = projection.decisions[Math.floor(ordinal / 256)]?.[ordinal % 256] ?? (row.classification === 'none' ? 'x' : row.classification === 'undetermined' ? 'u' : '-');
    const options = row.options.map(option => ({ side: option.side, groupId: projection.groups[option.group]!.id, label: option.label }));
    const prior = row.seed.instanceId ? saved.get(row.seed.instanceId) : undefined;
    let baseline = row.classification === 'none' ? 'x' : row.classification === 'undetermined' ? 'u' : '?';
    if (prior) { matchedDirections++; baseline = `${prior.targetSide}:${origins.get(prior.instanceId) ?? (state?.mode === 'reviewed' ? state.originDefault : 'previous')}`; }
    else if (state?.mode === 'reviewed' && row.options.length) baseline = (state.unselectedDefault === 'omitted') !== exceptions.has(row.seed.instanceId!) ? '-' : '?';
    const token = tokenOf(choice, row.savedOrigin); if (baseline !== token) dirtyCount++;
    const selected = options.find(option => option.side === sideOf(choice));
    return { row_id: row.seed.id, instance_id: row.seed.instanceId ?? null, ordinal, classification: row.classification, options, choice, baseline_token: baseline,
      current_token: token, saved_origin: row.savedOrigin ?? null, selected_group: selected?.groupId ?? null, state: sideOf(choice) ? 'included' : choice === '-' ? 'omitted' : choice === 'x' ? 'excluded' : choice === 'u' ? 'undetermined' : 'pending' };
  });
  const headerDirty = state?.mode !== 'reviewed' || state.source !== 'review' || matchedDirections !== snapshot.content.directions.length;
  for (let offset = 0; offset < data.length; offset += 50) {
    const part = data.slice(offset, offset + 50);
    await deps.db.transaction(async tx => {
      await assertClaimAuthority(tx, claim, new Date(deps.now()));
      const quota = await deps.quotas.reserve(tx, { owner: claim, operationId: claim.jobId, resource: 'sql-bytes', units: Buffer.byteLength(JSON.stringify(part)) * 3 + part.length * 2048, purpose: 'public', now: new Date(deps.now()) });
      await tx.query(`INSERT INTO review_choice_rows(session_id,workspace_id,review_id,row_id,instance_id,ordinal,classification,options,choice,baseline_token,current_token,saved_origin,selected_group,state)
        SELECT $1,$2,$3,r.row_id,r.instance_id,r.ordinal,r.classification,r.options,r.choice,r.baseline_token,r.current_token,r.saved_origin,r.selected_group,r.state
        FROM jsonb_to_recordset($4::jsonb) r(row_id text,instance_id text,ordinal integer,classification text,options jsonb,choice text,baseline_token text,current_token text,saved_origin text,selected_group text,state text)`,
        [claim.sessionId, claim.workspaceId, projection.reviewId, JSON.stringify(part)]);
      await deps.quotas.consume(tx, { reservationId: quota.id, now: new Date(deps.now()) });
    });
  }
  for (let offset = 0; offset < projection.groups.length; offset += 50) {
    const groups = projection.groups.slice(offset, offset + 50).map((group, n) => ({ group_id: group.id, ordinal: offset + n, observed: projection.observedFlags[Math.floor((offset + n) / 256)]?.[(offset + n) % 256] === '1' }));
    await deps.db.transaction(async tx => {
      await assertClaimAuthority(tx, claim, new Date(deps.now()));
      const quota = await deps.quotas.reserve(tx, { owner: claim, operationId: claim.jobId, resource: 'sql-bytes', units: groups.length * 2048 + 4096, purpose: 'public', now: new Date(deps.now()) });
      await tx.query(`INSERT INTO review_choice_groups(session_id,workspace_id,review_id,group_id,ordinal,observed)
        SELECT $1,$2,$3,g.group_id,g.ordinal,g.observed FROM jsonb_to_recordset($4::jsonb) g(group_id text,ordinal integer,observed boolean)`, [claim.sessionId, claim.workspaceId, projection.reviewId, JSON.stringify(groups)]);
      await deps.quotas.consume(tx, { reservationId: quota.id, now: new Date(deps.now()) });
    });
  }
  await deps.db.transaction(async tx => {
    await assertClaimAuthority(tx, claim, new Date(deps.now()));
    await tx.query(`UPDATE review_choice_groups g SET active_count=(SELECT count(*) FROM review_choice_rows r WHERE r.session_id=g.session_id AND r.workspace_id=g.workspace_id AND r.review_id=g.review_id AND r.selected_group=g.group_id)
      WHERE g.session_id=$1 AND g.workspace_id=$2 AND g.review_id=$3`, [claim.sessionId, claim.workspaceId, projection.reviewId]);
    await tx.query(`UPDATE review_choice_rows r SET state='conflicted' FROM review_choice_groups g WHERE r.session_id=$1 AND r.workspace_id=$2 AND r.review_id=$3
      AND g.session_id=r.session_id AND g.workspace_id=r.workspace_id AND g.review_id=r.review_id AND g.group_id=r.selected_group AND g.active_count>1`, [claim.sessionId, claim.workspaceId, projection.reviewId]);
    await tx.query('UPDATE direction_reviews SET baseline_header_dirty=$4 WHERE session_id=$1 AND workspace_id=$2 AND id=$3', [claim.sessionId, claim.workspaceId, projection.reviewId, headerDirty]);
  });
  return { dirtyCount, configChanged: headerDirty || dirtyCount > 0 };
}

/** Worker-only hydration: API mutations and reads never reconstruct a complete projection. */
export async function restoreReviewChoices(deps: HostedCommandDependencies, claim: HostedJobClaim, original: DirectionReviewProjection, budget = new WorkBudget()) {
  const identity = [claim.sessionId, claim.workspaceId, original.reviewId];
  const rows = (await deps.db.query('SELECT choice FROM review_choice_rows WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 ORDER BY ordinal', identity)).rows;
  const groups = (await deps.db.query('SELECT ordinal,observed,omitted FROM review_choice_groups WHERE session_id=$1 AND workspace_id=$2 AND review_id=$3 ORDER BY ordinal', identity)).rows;
  return restoreDirectionProjection(original, rows.map(row => row.choice), groups.filter(row => row.observed).map(row => row.ordinal), groups.filter(row => row.omitted).map(row => row.ordinal), budget);
}
