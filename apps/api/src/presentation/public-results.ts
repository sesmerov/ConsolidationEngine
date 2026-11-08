import type { CompactRuleResultDTO, LargeValueDescriptorDTO, PublicValue, RawRuleRecord, ResultDescriptionDTO, ResultEvidenceCountsDTO,
  ResultExplanationDTO, ResultExplanationItemDTO, ResultExplanationSection, RuleResultDTO, Snapshot, SourceLocator, ValidationValueDTO } from '@ce/contracts';
import { getRecalculationPolicy, WorkBudget } from '@ce/engine';
import { publicFact, publicValue } from './public-values.js';
import { rulePresentation } from './rule-presentation.js';

export type BoundPublicValue = <T>(value: T) => Promise<PublicValue<T>>;
function recordDescription(record: RawRuleRecord): string | undefined {
  const original = record.originalFields['Description'];
  const value = typeof original === 'string' ? original : original && typeof original === 'object' && !Array.isArray(original) && 'value' in original ? original.value : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}
/** Shared local/hosted projection of immutable execution evidence. Fragment storage is an injected, owner-authorized boundary. */
export function createPublicResultProjector(snapshot: Snapshot, options: { bound?: BoundPublicValue; budget?: WorkBudget } = {}) {
  const bound: BoundPublicValue = options.bound ?? (async value => value), budget = options.budget ?? new WorkBudget();
  const present = rulePresentation(snapshot.content), names = new Map(snapshot.content.sources.map(source => [source.id, source.displayName]));
  const byVariant = new Map<string, RawRuleRecord[]>();
  for (const record of snapshot.content.catalog.records) if (record.variantId && recordDescription(record) !== undefined) {
    const records = byVariant.get(record.variantId) ?? []; records.push(record); byVariant.set(record.variantId, records);
  }
  const origin = (locator: SourceLocator) => ({ locator, fileName: names.get(locator.fileId ?? '') ?? 'Catálogo' });
  function descriptions(result: RuleResultDTO): ResultDescriptionDTO[] {
    const seen = new Set<string>(), records = result.variantIds.flatMap(id => byVariant.get(id) ?? []).filter(record => {
      if (seen.has(record.id)) return false; seen.add(record.id); return true;
    });
    return records.map(record => ({ description: recordDescription(record)!, source: origin(record.sourceLocator), expression: result.expression,
      ...(result.precondition === undefined ? {} : { precondition: result.precondition }) }));
  }
  function operands(result: RuleResultDTO): { label: string; value: ValidationValueDTO }[] {
    return ([['left', 'Izquierda'], ['right', 'Derecha'], ['result', 'Resultado']] as const)
      .flatMap(([key, label]) => result.values[key] ? [{ label, value: publicValue(result.values[key]!) }] : []);
  }
  function counts(result: RuleResultDTO): ResultEvidenceCountsDTO {
    return { operands: operands(result).length, reads: result.factReads.length, metadataReads: result.metadataReads.length,
      origins: result.sources.length, diagnostics: result.diagnostics.length, descriptions: descriptions(result).length };
  }
  async function row(result: RuleResultDTO): Promise<CompactRuleResultDTO> {
    budget.check();
    const coordinate = result.values.left?.coordinate ?? result.values.right?.coordinate ?? result.factReads[0]?.coordinate;
    const presentation = present(result.variantIds, coordinate), values: CompactRuleResultDTO['values'] = {
      ...(result.values.left ? { left: await bound(publicValue(result.values.left)) } : {}),
      ...(result.values.right ? { right: await bound(publicValue(result.values.right)) } : {}),
      ...(result.values.result ? { result: await bound(publicValue(result.values.result)) } : {}),
    };
    const policy = getRecalculationPolicy(snapshot, { variantIds: result.variantIds, ...(result.binding ? { binding: result.binding } : {}),
      ...(result.instanceId ? { instanceId: result.instanceId } : {}) }, { budget }).policy;
    return { id: result.id, runId: result.runId, versionId: result.versionId, profileId: result.profileId,
      ...(result.instanceId ? { instanceId: result.instanceId } : {}), coverageOnly: result.coverageOnly,
      ...(result.contextId ? { contextId: result.contextId } : {}), code: result.code, status: result.status, severity: result.severity, severityOriginal: result.severityOriginal,
      location: coordinate ? [coordinate.tableCode, coordinate.rowCode ? 'r' + coordinate.rowCode : '', coordinate.columnCode ? 'c' + coordinate.columnCode : ''].filter(Boolean).join(' · ')
        : [result.binding?.tableCode, result.binding?.rowCode ? 'r' + result.binding.rowCode : '', result.binding?.columnCode ? 'c' + result.binding.columnCode : ''].filter(Boolean).join(' · '),
      ...(presentation ? { presentation: { ...(presentation.description === undefined ? {} : { description: await bound(presentation.description) }),
        ...(presentation.conceptLabel === undefined ? {} : { conceptLabel: await bound(presentation.conceptLabel) }) } } : {}),
      expression: await bound(result.expression), ...(result.precondition === undefined ? {} : { precondition: await bound(result.precondition) }),
      ...(result.preconditionResult ? { preconditionResult: await bound(publicValue(result.preconditionResult)) } : {}),
      values, recalculationPolicy: policy, counts: counts(result) };
  }
  async function* items(result: RuleResultDTO, section: ResultExplanationSection): AsyncGenerator<ResultExplanationItemDTO> {
    let ordinal = 0;
    if (section === 'operands') for (const item of operands(result)) { budget.check(); yield { itemId: `${result.id}:${section}:${ordinal++}`, section, label: item.label, value: await bound(item.value) }; }
    else if (section === 'reads') for (const value of result.factReads) { budget.check(); yield { itemId: `${result.id}:${section}:${ordinal++}`, section, value: await bound(publicFact(value)) }; }
    else if (section === 'metadata') for (const value of result.metadataReads) { budget.check(); yield { itemId: `${result.id}:${section}:${ordinal++}`, section, value: await bound(value) }; }
    else if (section === 'origins') for (const value of result.sources) { budget.check(); yield { itemId: `${result.id}:${section}:${ordinal++}`, section, value: await bound(origin(value)) }; }
    else if (section === 'diagnostics') for (const value of result.diagnostics) { budget.check(); yield { itemId: `${result.id}:${section}:${ordinal++}`, section, value: await bound(value) }; }
    else if (section === 'descriptions') for (const value of descriptions(result)) { budget.check(); yield { itemId: `${result.id}:${section}:${ordinal++}`, section, value: await bound(value) }; }
  }
  async function explanation(workspaceId: string, result: RuleResultDTO): Promise<ResultExplanationDTO> { return { ...await row(result), workspaceId }; }
  return { row, explanation, items, counts };
}
