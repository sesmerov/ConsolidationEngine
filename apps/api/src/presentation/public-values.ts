import type { Coordinate, FactReadDTO, NormalizedValue, ProposalCalculationDTO, ProposalDTO, Rational, RuleResultDTO, SourceLocator, ValidationValueDTO } from '@ce/contracts';

function locator(value: SourceLocator): SourceLocator {
  return Object.fromEntries(['fileId', 'sheet', 'row', 'column', 'ruleCode'].flatMap(key => {
    const field = value[key as keyof SourceLocator]; return field === undefined ? [] : [[key, field]];
  }));
}
function coordinate(value: Coordinate): Coordinate {
  return { factKey: value.factKey, contextId: value.contextId, tableCode: value.tableCode, sheetCode: value.sheetCode,
    rowCode: value.rowCode, columnCode: value.columnCode, dataType: value.dataType, unit: value.unit, decimals: value.decimals,
    axes: value.axes, sourceLocator: locator(value.sourceLocator) };
}
const rational = (value: Rational): Rational => ({ numerator: value.numerator, denominator: value.denominator });
function normalized(value: NormalizedValue): NormalizedValue {
  if (typeof value === 'boolean') return value;
  return 'kind' in value ? { kind: value.kind, value: value.value } : rational(value);
}
/** Project union members before serializer branch selection; internal fields are never wire fields. */
export function publicValue(value: ValidationValueDTO): ValidationValueDTO {
  const trace = { ...(value.coordinate ? { coordinate: coordinate(value.coordinate) } : {}), ...(value.sourceLocator ? { sourceLocator: locator(value.sourceLocator) } : {}) };
  switch (value.kind) {
    case 'number': return { kind: 'number', nominal: rational(value.nominal), interval: { lo: rational(value.interval.lo), hi: rational(value.interval.hi) }, unit: value.unit, ...trace };
    case 'boolean': return { kind: 'boolean', value: value.value, ...trace };
    case 'text': return { kind: 'text', value: value.value, ...trace };
    case 'date': return { kind: 'date', value: value.value, ...trace };
    case 'null': return { kind: 'null', presence: value.presence, dataType: value.dataType, ...(value.unit === undefined ? {} : { unit: value.unit }), ...trace };
    case 'unknown': return { kind: 'unknown', presence: 'unknown', ...trace };
  }
}
export function publicFact(read: FactReadDTO): FactReadDTO {
  return { factKey: read.factKey, coordinate: coordinate(read.coordinate), presence: read.presence, sourceLocator: locator(read.sourceLocator),
    ...(read.normalizedValue === undefined ? {} : { normalizedValue: normalized(read.normalizedValue) }),
    ...(read.originalText === undefined ? {} : { originalText: read.originalText }), ...(read.derivation ? { derivation: read.derivation } : {}) };
}
export function publicResult(row: RuleResultDTO): RuleResultDTO {
  return { ...row,
    ...(row.preconditionResult ? { preconditionResult: publicValue(row.preconditionResult) } : {}),
    values: { ...(row.values.left ? { left: publicValue(row.values.left) } : {}), ...(row.values.right ? { right: publicValue(row.values.right) } : {}),
      ...(row.values.result ? { result: publicValue(row.values.result) } : {}) }, factReads: row.factReads.map(publicFact),
  };
}
function calculation(value: ProposalCalculationDTO): ProposalCalculationDTO {
  return { expression: value.expression, ...(value.precondition === undefined ? {} : { precondition: value.precondition }),
    ...(value.sourceValue ? { sourceValue: publicValue(value.sourceValue) } : {}), ...(value.preconditionValue ? { preconditionValue: publicValue(value.preconditionValue) } : {}),
    reads: value.reads.map(read => ({ fact: publicFact(read.fact), ...(read.fromProposalId ? { fromProposalId: read.fromProposalId } : {}) })) };
}
/** The closed response schemas strip remaining ordinary fields. Never reconstruct simulation reads. */
export function publicProposal(value: ProposalDTO, detail = false): ProposalDTO {
  const { calculation: storedCalculation, ...row } = value;
  const after = row.after;
  return { ...row, ...(row.before ? { before: publicFact(row.before) } : {}),
    ...(after ? { after: 'decimals' in after
      ? { normalizedValue: rational(after.normalizedValue), originalText: after.originalText, decimals: after.decimals, unit: after.unit }
      : { normalizedValue: after.normalizedValue, originalText: after.originalText } } : {}),
    ...(detail && storedCalculation ? { calculation: calculation(storedCalculation) } : {}) };
}
