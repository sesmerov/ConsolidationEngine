import type {
  DirectionOrigin, DirectionReviewClass, DirectionReviewCountsDTO, DirectionReviewDecision, DirectionReviewOperationDTO,
  DirectionReviewRowDTO, RuleResultDTO, TargetSide,
} from '@ce/contracts';
import { WorkBudget } from '../execution/budget.js';

export type ReviewSeed = Pick<RuleResultDTO, 'id' | 'code' | 'variantIds' | 'instanceId' | 'binding' | 'coverageOnly'>;
export interface ReviewOption {
  readonly side: TargetSide; readonly label: string; readonly group: number; readonly directionId: string;
}
export interface ReviewRow {
  readonly seed: ReviewSeed; readonly classification: DirectionReviewClass;
  readonly location: string; readonly contextLabel: string; readonly options: readonly ReviewOption[];
  readonly reasons: DirectionReviewRowDTO['reasons']; readonly savedOrigin?: DirectionOrigin;
}
export interface ReviewGroup { readonly id: string; readonly targetKey: string }
type Counts = { -readonly [K in keyof DirectionReviewCountsDTO]: number };
type Members = readonly (readonly (readonly number[])[])[];
export interface DirectionReviewProjection {
  readonly reviewId: string; readonly baseVersionId: string;
  readonly rows: readonly ReviewRow[]; readonly byInstance: Readonly<Record<string, number>>;
  readonly groups: readonly ReviewGroup[]; readonly byGroup: Readonly<Record<string, number>>;
  readonly decisions: readonly string[]; readonly members: Members;
  readonly blockCounts: readonly DirectionReviewCountsDTO[]; readonly clearedCounts: readonly DirectionReviewCountsDTO[];
  readonly counts: DirectionReviewCountsDTO; readonly conflictGroupCount: number;
}
export class DirectionReviewError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
// Each review decision occupies one ASCII character in its 256-row copy-on-write block.
export const decisionCode = {
  automaticLeft: 'A', automaticRight: 'B', manualLeft: 'L', manualRight: 'R', savedLeft: 'l', savedRight: 'r',
  omitted: '-', pending: '?', excluded: 'x', undetermined: 'u',
} as const;
const blockSize = 256;
const blockOf = (index: number) => Math.floor(index / blockSize);
function counts(): Counts {
  return { totalRows: 0, included: 0, omitted: 0, pending: 0, conflicted: 0, excluded: 0, undetermined: 0 };
}
function emptyChoice(row: ReviewRow): string {
  if (row.classification === 'undetermined') return decisionCode.undetermined;
  return row.classification === 'none' ? decisionCode.excluded : decisionCode.omitted;
}
export function choiceAt(projection: DirectionReviewProjection, index: number): string {
  return projection.decisions[blockOf(index)]?.[index % blockSize] ?? emptyChoice(projection.rows[index]!);
}
export function selectedSide(choice: string): TargetSide | undefined {
  if (choice === decisionCode.savedLeft || choice === decisionCode.manualLeft || choice === decisionCode.automaticLeft) return 'left';
  if (choice === decisionCode.savedRight || choice === decisionCode.manualRight || choice === decisionCode.automaticRight) return 'right';
  return undefined;
}
export function selectedOrigin(choice: string): 'automatic' | 'manual' | 'saved' | undefined {
  if (choice === decisionCode.automaticLeft || choice === decisionCode.automaticRight) return 'automatic';
  if (choice === decisionCode.manualLeft || choice === decisionCode.manualRight) return 'manual';
  if (choice === decisionCode.savedLeft || choice === decisionCode.savedRight) return 'saved';
  return undefined;
}
function optionOf(row: ReviewRow, choice: string) {
  const side = selectedSide(choice);
  return side === undefined ? undefined : row.options.find(option => option.side === side);
}
export function singleSuggestion(classification: DirectionReviewClass) {
  if (classification === 'singleLeft') return decisionCode.automaticLeft;
  if (classification === 'singleRight') return decisionCode.automaticRight;
  return decisionCode.pending;
}
const membersAt = (projection: DirectionReviewProjection, group: number): readonly number[] => projection.members[blockOf(group)]?.[group % blockSize] ?? [];
export function stateAt(projection: DirectionReviewProjection, index: number): DirectionReviewDecision {
  const choice = choiceAt(projection, index);
  switch (choice) {
    case decisionCode.undetermined: return 'undetermined';
    case decisionCode.excluded: return 'excluded';
    case decisionCode.omitted: return 'omitted';
    case decisionCode.pending: return 'pending';
  }
  const option = optionOf(projection.rows[index]!, choice);
  if (!option) throw new DirectionReviewError('INVALID_DECISION');
  return membersAt(projection, option.group).length > 1 ? 'conflicted' : 'included';
}
function publicRow(projection: DirectionReviewProjection, index: number): DirectionReviewRowDTO {
  const row = projection.rows[index]!;
  const choice = choiceAt(projection, index);
  const option = optionOf(row, choice);
  const origin = selectedOrigin(choice);
  const members = option ? membersAt(projection, option.group) : [];
  return {
    rowId: row.seed.id, code: row.seed.code, location: row.location, contextLabel: row.contextLabel,
    classification: row.classification, state: stateAt(projection, index), reasons: row.reasons,
    options: row.options.map(({ side, label }) => ({ side, label })),
    ...(row.seed.instanceId ? { instanceId: row.seed.instanceId } : {}),
    ...(option && origin ? {
      selectedSide: option.side, origin, producerCount: members.length,
      ...(members.length > 1 ? { groupId: projection.groups[option.group]!.id } : {})
    } : {}),
  };
}
function checkedIndex(lookup: Readonly<Record<string, number>>, id: string, error: string) {
  if (!Object.hasOwn(lookup, id)) throw new DirectionReviewError(error);
  return lookup[id]!;
}
export function readDirectionRows(projection: DirectionReviewProjection, query: { offset: number; limit: number; state?: DirectionReviewDecision; groupId?: string }) {
  let { offset } = query;
  const { limit, state, groupId } = query;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new DirectionReviewError('INVALID_PAGE');
  if (groupId !== undefined) {
    const indices = membersAt(projection, checkedIndex(projection.byGroup, groupId, 'UNKNOWN_GROUP'));
    const groupState = indices.length > 1 ? 'conflicted' : 'included';
    const total = state && groupState !== state ? 0 : indices.length;
    return { total, items: total ? indices.slice(offset, offset + limit).map(index => publicRow(projection, index)) : [] };
  }
  const total = state ? projection.counts[state] : projection.rows.length;
  const items: DirectionReviewRowDTO[] = [];
  if (!state) {
    for (let index = offset; index < Math.min(total, offset + limit); index++) items.push(publicRow(projection, index));
  } else if (offset < total) {
    // Skip whole blocks with the category counts; hydrate only the requested items.
    for (let block = 0; block < projection.blockCounts.length && items.length < limit; block++) {
      const matches = projection.blockCounts[block]![state];
      if (offset >= matches) {
        offset -= matches;
        continue;
      }
      const end = Math.min(projection.rows.length, (block + 1) * blockSize);
      for (let index = block * blockSize; index < end && items.length < limit; index++) {
        if (stateAt(projection, index) !== state) continue;
        if (offset) offset--; else items.push(publicRow(projection, index));
      }
    }
  }
  return { items, total };
}
function countBlock(projection: DirectionReviewProjection, block: number): Counts {
  const result = counts();
  for (let index = block * blockSize; index < Math.min((block + 1) * blockSize, projection.rows.length); index++) {
    result[stateAt(projection, index)]++;
    result.totalRows++;
  }
  return result;
}
function totalCounts(blocks: readonly DirectionReviewCountsDTO[]): Counts {
  const result = counts();
  const keys = Object.keys(result) as (keyof Counts)[];
  for (const block of blocks) {
    for (const key of keys) result[key] += block[key];
  }
  return result;
}
export function indexProjection(base: Omit<DirectionReviewProjection, 'decisions' | 'members' | 'counts' | 'blockCounts' | 'clearedCounts' | 'conflictGroupCount'>, choices: readonly string[], budget: WorkBudget) {
  const decisions: string[] = [], members: number[][][] = [], clearedCounts: Counts[] = [];
  let conflictGroupCount = 0;
  for (let index = 0; index < base.rows.length; index++) {
    if (index % blockSize === 0) {
      budget.check();
      decisions.push(choices.slice(index, index + blockSize).join(''));
      clearedCounts.push(counts());
    }
    const clear = clearedCounts[blockOf(index)]!;
    const row = base.rows[index]!;
    switch (emptyChoice(row)) {
      case decisionCode.undetermined: clear.undetermined++; break;
      case decisionCode.excluded: clear.excluded++; break;
      default: clear.omitted++;
    }
    clear.totalRows++;
    const option = optionOf(row, choices[index]!);
    if (option) {
      const block = blockOf(option.group);
      while (members.length <= block) members.push([]);
      const bucket = members[block]!;
      while (bucket.length <= option.group % blockSize) bucket.push([]);
      const producers = bucket[option.group % blockSize]!;
      producers.push(index);
      if (producers.length === 2) conflictGroupCount++;
    }
  }
  const draft: DirectionReviewProjection = { ...base, decisions, members, clearedCounts, counts: counts(), blockCounts: [], conflictGroupCount };
  const blockCounts = clearedCounts.map((_, index) => { budget.check(); return countBlock(draft, index); });
  return { ...draft, blockCounts, counts: totalCounts(blockCounts) };
}

interface DecisionEdits {
  rows: Map<number, string>;
  // A group resolution retains just its winner, including when the group spans thousands of pages.
  groups: Map<number, number | null>;
}

function planEdits(projection: DirectionReviewProjection, operations: readonly DirectionReviewOperationDTO[], budget: WorkBudget): DecisionEdits {
  const rows = new Map<number, string>();
  const groups = new Map<number, number | null>();
  const touchedGroups = new Set<number>();
  const reserveGroup = (group: number) => {
    if (touchedGroups.has(group)) throw new DirectionReviewError('OVERLAPPING_OPERATIONS');
    touchedGroups.add(group);
  };

  for (const operation of operations) {
    budget.check();
    if (operation.op === 'resolveGroup') {
      const group = checkedIndex(projection.byGroup, operation.groupId, 'UNKNOWN_GROUP');
      reserveGroup(group);
      if (membersAt(projection, group).length < 2) throw new DirectionReviewError('GROUP_NOT_CONFLICTED');
      let winner: number | null = null;
      if (operation.winnerInstanceId !== null) {
        winner = checkedIndex(projection.byInstance, operation.winnerInstanceId, 'UNKNOWN_INSTANCE');
        const option = optionOf(projection.rows[winner]!, choiceAt(projection, winner));
        if (option?.group !== group) throw new DirectionReviewError('INVALID_GROUP_WINNER');
      }
      groups.set(group, winner);
      continue;
    }
    if (operation.op !== 'set') throw new DirectionReviewError('INVALID_OPERATION');
    const rowIndex = checkedIndex(projection.byInstance, operation.instanceId, 'UNKNOWN_INSTANCE');
    if (rows.has(rowIndex)) throw new DirectionReviewError('OVERLAPPING_OPERATIONS');
    const row = projection.rows[rowIndex]!;
    if (!row.options.length) throw new DirectionReviewError('UNAVAILABLE_INSTANCE');
    let choice: string;
    switch (operation.choice) {
      case 'left':
      case 'right':
        if (!row.options.some(option => option.side === operation.choice)) throw new DirectionReviewError('INELIGIBLE_SIDE');
        choice = operation.choice === 'left' ? decisionCode.manualLeft : decisionCode.manualRight;
        break;
      case 'omit': choice = decisionCode.omitted; break;
      case 'suggest': choice = singleSuggestion(row.classification); break;
      default: throw new DirectionReviewError('INVALID_OPERATION');
    }
    const oldGroup = optionOf(row, choiceAt(projection, rowIndex))?.group;
    const newGroup = optionOf(row, choice)?.group;
    if (oldGroup !== undefined) reserveGroup(oldGroup);
    if (newGroup !== undefined && newGroup !== oldGroup) reserveGroup(newGroup);
    rows.set(rowIndex, choice);
  }
  return { rows, groups };
}

/** Edits share the immutable classification and copy only affected decision blocks and memberships. */
export function editDirectionProjection(
  projection: DirectionReviewProjection,
  operations: readonly DirectionReviewOperationDTO[],
  options: { budget?: WorkBudget } = {},
): DirectionReviewProjection {
  const budget = options.budget ?? new WorkBudget();
  budget.check();
  if (!operations.length || operations.length > 200) throw new DirectionReviewError('INVALID_BATCH_SIZE');
  if (operations.some(operation => operation.op === 'omitAll')) {
    if (operations.length !== 1) throw new DirectionReviewError('OVERLAPPING_OPERATIONS');
    return {
      ...projection, decisions: [], members: [], blockCounts: projection.clearedCounts,
      counts: totalCounts(projection.clearedCounts), conflictGroupCount: 0
    };
  }
  const plan = planEdits(projection, operations, budget);
  const changes = new Map<number, string[]>();
  const affectedBlocks = new Set<number>();
  const writeDecision = (rowIndex: number, choice: string) => {
    budget.check();
    const block = blockOf(rowIndex);
    let characters = changes.get(block);
    if (!characters) {
      const start = block * blockSize;
      const length = Math.min(blockSize, projection.rows.length - start);
      characters = Array.from({ length }, (_, offset) => choiceAt(projection, start + offset));
      changes.set(block, characters);
    }
    characters[rowIndex % blockSize] = choice;
    affectedBlocks.add(block);
  };

  const members = Array.from({ length: Math.ceil(projection.groups.length / blockSize) }, (_, block) => projection.members[block] ?? []);
  const changedBuckets = new Map<number, (readonly number[])[]>();
  let conflictGroupCount = projection.conflictGroupCount;
  const writeGroup = (group: number, producers: readonly number[]) => {
    const previous = membersAt(projection, group);
    // A singleton's existing row can cross the included/conflicted boundary without an explicit edit to its own choice.
    if (previous.length === 1) affectedBlocks.add(blockOf(previous[0]!));
    if (producers.length === 1) affectedBlocks.add(blockOf(producers[0]!));
    conflictGroupCount += Number(producers.length > 1) - Number(previous.length > 1);
    const block = blockOf(group);
    let bucket = changedBuckets.get(block);
    if (!bucket) {
      bucket = [...members[block]!];
      changedBuckets.set(block, bucket);
      members[block] = bucket;
    }
    while (bucket.length <= group % blockSize) bucket.push([]);
    bucket[group % blockSize] = producers;
  };

  for (const [group, winner] of plan.groups) {
    for (const rowIndex of membersAt(projection, group)) {
      const side = selectedSide(choiceAt(projection, rowIndex));
      writeDecision(rowIndex, rowIndex === winner ? (side === 'left' ? decisionCode.manualLeft : decisionCode.manualRight) : decisionCode.omitted);
    }
    writeGroup(group, winner === null ? [] : [winner]);
  }
  for (const [rowIndex, choice] of plan.rows) {
    const row = projection.rows[rowIndex]!;
    const oldGroup = optionOf(row, choiceAt(projection, rowIndex))?.group;
    const newGroup = optionOf(row, choice)?.group;
    writeDecision(rowIndex, choice);
    if (oldGroup === newGroup) continue;
    if (oldGroup !== undefined) {
      const remaining = membersAt(projection, oldGroup).filter(producer => { budget.check(); return producer !== rowIndex; });
      writeGroup(oldGroup, remaining);
    }
    if (newGroup !== undefined) {
      const previous = membersAt(projection, newGroup);
      // Position in the globally sorted review is also the sort key for the paginated group.
      const insertion = previous.findIndex(producer => { budget.check(); return producer > rowIndex; });
      const next = [...previous];
      next.splice(insertion < 0 ? next.length : insertion, 0, rowIndex);
      writeGroup(newGroup, next);
    }
  }
  const decisions = Array.from({ length: projection.blockCounts.length }, (_, block) => changes.get(block)?.join('') ?? projection.decisions[block] ?? '');
  const result = { ...projection, decisions, members, conflictGroupCount };
  const blockCounts = [...projection.blockCounts];
  const combined = { ...projection.counts };
  for (const block of affectedBlocks) {
    budget.check();
    const replacement = countBlock(result, block), old = blockCounts[block]!;
    for (const key of Object.keys(combined) as (keyof Counts)[]) combined[key] += replacement[key] - old[key];
    blockCounts[block] = replacement;
  }
  return { ...result, blockCounts, counts: combined };
}
