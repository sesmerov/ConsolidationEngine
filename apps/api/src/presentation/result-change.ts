import { isRationalValue } from '@ce/contracts';
import type { Coordinate, NormalizedValue, Rational, RuleResultDTO, ValidationValueDTO } from '@ce/contracts';
import { rational, rationalToDTO } from '@ce/engine';
import type { WorkBudget } from '@ce/engine';
import { canonicalStringify } from '../session/canonical-state.js';

const exact = (value: Rational) => rationalToDTO(rational(BigInt(value.numerator), BigInt(value.denominator)));
const normalized = (value: NormalizedValue | undefined) => value === undefined ? null : isRationalValue(value) ? exact(value) : value;
const coordinate = (value: Coordinate) => ({ factKey: value.factKey, contextId: value.contextId, tableCode: value.tableCode,
  sheetCode: value.sheetCode, rowCode: value.rowCode, columnCode: value.columnCode, dataType: value.dataType, unit: value.unit, decimals: value.decimals, axes: value.axes });
function effective(value: ValidationValueDTO | undefined): unknown {
  if (!value) return null;
  switch (value.kind) {
    case 'number': return { kind: value.kind, nominal: exact(value.nominal), interval: { lo: exact(value.interval.lo), hi: exact(value.interval.hi) }, unit: value.unit };
    case 'text': case 'date': case 'boolean': return { kind: value.kind, value: value.value };
    case 'null': return { kind: value.kind, presence: value.presence, dataType: value.dataType, unit: value.unit ?? '' };
    case 'unknown': return { kind: value.kind };
  }
}
const sorted = (values: readonly unknown[]) => values.map(canonicalStringify).sort();
/** Business outcome only: generated IDs, timestamps, provenance and display text are excluded. */
function meaning(row: RuleResultDTO, budget?: WorkBudget): string {
  budget?.check();
  return canonicalStringify({ status: row.status, severity: row.severity,
    precondition: effective(row.preconditionResult), values: { left: effective(row.values.left), right: effective(row.values.right), result: effective(row.values.result) },
    diagnostics: sorted(row.diagnostics.map(issue => ({ code: issue.code, message: issue.message, severity: issue.severity ?? null,
      line: issue.line ?? null, column: issue.column ?? null, start: issue.start ?? null, end: issue.end ?? null }))),
    readKeys: [...row.readKeys].sort(),
    facts: sorted(row.factReads.map(read => { budget?.consume('reads'); return { factKey: read.factKey, coordinate: coordinate(read.coordinate), presence: read.presence, value: normalized(read.normalizedValue) }; })),
    metadata: sorted(row.metadataReads.map(read => { budget?.consume('reads'); return { contextId: read.contextId, code: read.code, presence: read.presence, value: read.value ?? null }; })),
  });
}
export function resultChanged(before: RuleResultDTO | undefined, after: RuleResultDTO | undefined, budget?: WorkBudget): boolean {
  return !before || !after || meaning(before, budget) !== meaning(after, budget);
}
