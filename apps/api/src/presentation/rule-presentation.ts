import type { PresentationDTO, RawRuleRecord, SnapshotContent } from '@ce/contracts';

const ordinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function description(record: RawRuleRecord): string | undefined {
  const field = record.originalFields.Description;
  const value = typeof field === 'string' ? field : field && typeof field === 'object' && !Array.isArray(field) && 'value' in field ? field.value : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}
/** Index once per query. Descriptions remain plain source text and never affect identity or permission. */
export function rulePresentation(content: SnapshotContent): (variantIds: readonly string[]) => PresentationDTO | undefined {
  const fileOrder = new Map(content.sources.map((file, index) => [file.id, index]));
  const sourceOrder = (left: RawRuleRecord, right: RawRuleRecord): number => {
    const a = left.sourceLocator, b = right.sourceLocator;
    return (fileOrder.get(a.fileId ?? '') ?? Number.MAX_SAFE_INTEGER) - (fileOrder.get(b.fileId ?? '') ?? Number.MAX_SAFE_INTEGER)
      || ordinal(a.fileId ?? '', b.fileId ?? '') || ordinal(a.sheet ?? '', b.sheet ?? '') || (a.row ?? 0) - (b.row ?? 0)
      || ordinal(a.column ?? '', b.column ?? '') || ordinal(left.id, right.id);
  };
  const byId = new Map(content.catalog.records.map(record => [record.id, record]));
  const descriptions = new Map(content.catalog.variants.map(variant => [variant.variantId,
    variant.sourceRecords.flatMap(id => { const record = byId.get(id); return record && description(record) !== undefined ? [record] : []; }).sort(sourceOrder)]));
  return variantIds => {
    const first = variantIds.flatMap(id => descriptions.get(id) ?? []).sort(sourceOrder)[0];
    const text = first ? description(first) : undefined;
    return text === undefined ? undefined : { description: text };
  };
}
