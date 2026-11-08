import { createHash, randomUUID } from 'node:crypto';
import type { ReportContext, Snapshot, SnapshotContent, ValidationBundle } from '@ce/contracts';
import { coordinate, fact, ref } from '../../packages/engine/test/helpers/report-fixture.js';
import { iterationContext, iterationSnapshot, validateIteration, type IterationRule } from './iteration004-fixtures.js';

/** Synthetic in-memory scenarios. They do not claim XLSX or official EBA coverage. */
export function iteration005Context(overrides: Partial<ReportContext> = {}): ReportContext {
  return iterationContext({ contextId: 'iteration005', entityId: 'SYNTHETIC_005', ...overrides });
}

function hash(content: SnapshotContent): string {
  return createHash('sha256').update(JSON.stringify(content), 'utf8').digest('hex');
}

export function iteration005Snapshot(definitions: readonly IterationRule[], rows: readonly string[], values: Readonly<Record<string, string>> = {}): Snapshot {
  const snapshot = iterationSnapshot(definitions, rows, [iteration005Context()]);
  const content: SnapshotContent = { ...snapshot.content,
    catalogVersion: 'iteration005', reportVersion: 'iteration005', configVersion: 'iteration005',
    facts: snapshot.content.coordinates.map((cell, index) => fact(cell, values[cell.rowCode] ?? '0', index + 2)),
  };
  return { ...snapshot, createdAt: '2026-11-08T00:00:00.000Z', contentHash: hash(content), content };
}

const cellRef = (row: string) => ref(coordinate({ table: 'T', row }));

/** Both operands are declared cells; no side can be chosen automatically. */
export function bothSidesSnapshot(): Snapshot {
  return iteration005Snapshot([{ code: 'BOTH_SIDES', expression: `${cellRef('0010')}=${cellRef('0020')}` }],
    ['0010', '0020'], { '0010': '90', '0020': '100' });
}

/** Exactly one eligible cell; the expression side has no declared output cell. */
export function uniqueTargetSnapshot(): Snapshot {
  return iteration005Snapshot([{ code: 'UNIQUE_TARGET', expression: `${cellRef('0010')}=5+7` }], ['0010'], { '0010': '11' });
}

/** Every rule has one target, but all compete for it: never infer a winning producer. */
export function collidingTargetsSnapshot(count = 51): Snapshot {
  if (!Number.isInteger(count) || count < 2 || count > 500) throw new RangeError('Producer count must be 2..500');
  return iteration005Snapshot(Array.from({ length: count }, (_, index) => ({
    code: `PRODUCER_${String(index + 1).padStart(3, '0')}`, expression: `${cellRef('0010')}=${index + 1}`,
  })), ['0010']);
}

/** More than one page of genuine pending choices, each with two different output cells. */
export function pendingDecisionsSnapshot(count = 51): Snapshot {
  if (!Number.isInteger(count) || count < 1 || count > 500) throw new RangeError('Decision count must be 1..500');
  const rows = Array.from({ length: count * 2 }, (_, index) => String(index + 1).padStart(4, '0'));
  const rules = Array.from({ length: count }, (_, index) => ({
    code: `DECISION_${String(index + 1).padStart(3, '0')}`,
    expression: `${cellRef(rows[index * 2]!)}=${cellRef(rows[index * 2 + 1]!)}`,
  }));
  return iteration005Snapshot(rules, rows, Object.fromEntries(rows.map((row, index) => [row, index % 2 ? '2' : '1'])));
}

/** A supported inequality is validation-only, rather than an invalid or missing rule. */
export function noCandidatesSnapshot(): Snapshot {
  return iteration005Snapshot([{ code: 'VALIDATION_ONLY', expression: `${cellRef('0010')}>0` }], ['0010'], { '0010': '1' });
}

/** Preserve the input while creating a genuinely different report for stale-result scenarios. */
export function staleDataScenario(): { before: Snapshot; after: Snapshot; historicalRun: ValidationBundle } {
  const before = uniqueTargetSnapshot();
  const content: SnapshotContent = { ...before.content, reportVersion: 'iteration005-changed',
    facts: before.content.coordinates.map((cell, index) => fact(cell, '12', index + 2)),
  };
  const after: Snapshot = { ...before, versionId: randomUUID(), parentVersionId: before.versionId,
    createdAt: '2026-11-08T00:01:00.000Z', contentHash: hash(content), content };
  return { before, after, historicalRun: validateIteration(before) };
}

/** Six distinct public labels/identities; version 1 and 6 contain intentionally different values. */
export function downloadHistoryScenario(): {
  versions: readonly Snapshot[]; selected: Snapshot; previouslyPrepared: Snapshot;
  selectedRun: ValidationBundle; previouslyPreparedRun: ValidationBundle;
} {
  const versions: Snapshot[] = [];
  for (let index = 0; index < 6; index++) {
    const original = iteration005Snapshot([{ code: 'HISTORY_VALUE', expression: `${cellRef('0010')}=120` }],
      ['0010'], { '0010': String(90 + index * 6) });
    const previous = versions.at(-1);
    versions.push({ ...original, ...(previous ? { parentVersionId: previous.versionId } : {}),
      createdAt: `2026-11-08T00:0${index}:00.000Z` });
  }
  const selected = versions[0]!, previouslyPrepared = versions[5]!;
  return { versions, selected, previouslyPrepared,
    selectedRun: validateIteration(selected), previouslyPreparedRun: validateIteration(previouslyPrepared) };
}

/** Transport fixture, not a claim that an Excel cell accepts this amount of text. */
export function largeValueFixture(byteLength = 1024 * 1024 + 65): { text: string; byteLength: number; sha256: string } {
  if (!Number.isInteger(byteLength) || byteLength < 1 || byteLength > 10 * 1024 * 1024) {
    throw new RangeError('Transport fixture size must be 1..10 MiB');
  }
  const text = 'á'.repeat(Math.floor(byteLength / 2)) + (byteLength % 2 ? 'x' : '');
  return { text, byteLength: Buffer.byteLength(text, 'utf8'), sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}

export { validateIteration as validate005 };
