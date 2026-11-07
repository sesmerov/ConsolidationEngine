import type { Coordinate, DirectionConflictCandidateDetailDTO, PresentationDTO, RawRuleRecord, SnapshotContent } from '@ce/contracts';
import { COREP_MAPPING, COREP_MAPPING_SHA256, COREP_PROFILE_ID } from '../import/profiles/corep-ca1.js';
import { DEMO_TYPES_MAPPING, DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_PROFILE_ID } from '../import/profiles/demo-types.js';
import { FINREP_MAPPING,FINREP_MAPPING_SHA256,FINREP_PROFILE_ID } from '../import/profiles/finrep-f0101.js';

const ordinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
function description(record: RawRuleRecord): string | undefined {
  const field = record.originalFields.Description;
  const value = typeof field === 'string' ? field : field && typeof field === 'object' && !Array.isArray(field) && 'value' in field ? field.value : undefined;
  return typeof value === 'string' && value.trim() ? value : undefined;
}
function recordOrder(content: SnapshotContent) {
  const fileOrder = new Map(content.sources.map((file, index) => [file.id, index]));
  return (left: RawRuleRecord, right: RawRuleRecord): number => {
    const a = left.sourceLocator, b = right.sourceLocator;
    return (fileOrder.get(a.fileId ?? '') ?? Number.MAX_SAFE_INTEGER) - (fileOrder.get(b.fileId ?? '') ?? Number.MAX_SAFE_INTEGER)
      || ordinal(a.fileId ?? '', b.fileId ?? '') || ordinal(a.sheet ?? '', b.sheet ?? '') || (a.row ?? 0) - (b.row ?? 0)
      || ordinal(a.column ?? '', b.column ?? '') || ordinal(left.id, right.id);
  };
}

/** Resolve exact catalog text for one instance's variant IDs; never recover by a code substring. */
export function ruleSourceDetails(content: SnapshotContent) {
  const order = recordOrder(content);
  const variants = new Map(content.catalog.variants.map(variant => [variant.variantId, variant]));
  const records = new Map(content.catalog.records.map(record => [record.id, record]));
  const names = new Map(content.sources.map(source => [source.id, source.displayName]));
  return (variantIds: readonly string[]): Pick<DirectionConflictCandidateDetailDTO, 'expression' | 'precondition' | 'descriptions'> => {
    const matches = variantIds.flatMap(id => {
      const variant = variants.get(id);
      return variant ? [{ variant, records: variant.sourceRecords.flatMap(key => records.get(key) ? [records.get(key)!] : []).sort(order) }] : [];
    }).sort((a, b) => a.records[0] && b.records[0] ? order(a.records[0], b.records[0]) || ordinal(a.variant.variantId, b.variant.variantId)
      : a.records[0] ? -1 : b.records[0] ? 1 : ordinal(a.variant.variantId, b.variant.variantId));
    const descriptions: { description: string; sourceLabel: string }[] = [], seen = new Set<string>();
    for (const record of matches.flatMap(match => match.records).sort(order)) {
      const text = description(record);
      if (text === undefined || seen.has(text)) continue;
      seen.add(text);
      const at = record.sourceLocator;
      descriptions.push({ description: text, sourceLabel: [names.get(at.fileId ?? '') ?? 'Catálogo', at.sheet,
        at.row ? 'fila ' + at.row : undefined, at.column ? 'columna ' + at.column : undefined].filter(Boolean).join(' · ').slice(0, 2048) });
    }
    const variant = matches[0]?.variant;
    return { expression: variant?.expression ?? '', ...(variant?.precondition ? { precondition: variant.precondition } : {}), descriptions };
  };
}
/** Index once per query. Descriptions remain plain source text and never affect identity or permission. */
export function rulePresentation(content: SnapshotContent): (variantIds: readonly string[], coordinate?: Coordinate) => PresentationDTO | undefined {
  const sourceOrder = recordOrder(content);
  const byId = new Map(content.catalog.records.map(record => [record.id, record]));
  const descriptions = new Map(content.catalog.variants.map(variant => [variant.variantId,
    variant.sourceRecords.flatMap(id => { const record = byId.get(id); return record && description(record) !== undefined ? [record] : []; }).sort(sourceOrder)]));
  return (variantIds, coordinate) => {
    const first = variantIds.flatMap(id => descriptions.get(id) ?? []).sort(sourceOrder)[0];
    const text = first ? description(first) : undefined;
    const bound = (profileId: string, mappingSha256: string) => coordinate && content.reportSourceBindings?.some(binding => binding.profileId === profileId && binding.mappingSha256 === mappingSha256
      && binding.sourceFileId === coordinate.sourceLocator.fileId && binding.contextIds.includes(coordinate.contextId));
    const conceptLabel = coordinate && bound(COREP_PROFILE_ID, COREP_MAPPING_SHA256)
      ? COREP_MAPPING.mapping.find(cell => cell.tableCode === coordinate.tableCode && cell.sheetCode === coordinate.sheetCode && cell.rowCode === coordinate.rowCode && cell.columnCode === coordinate.columnCode)?.label
      : coordinate && bound(DEMO_TYPES_PROFILE_ID, DEMO_TYPES_MAPPING_SHA256) && coordinate.tableCode === DEMO_TYPES_MAPPING.tableCode && coordinate.columnCode === DEMO_TYPES_MAPPING.columnCode && coordinate.sheetCode === ''
        ? DEMO_TYPES_MAPPING.fields.find(cell => cell.rowCode === coordinate.rowCode)?.label
        : coordinate && bound(FINREP_PROFILE_ID,FINREP_MAPPING_SHA256)?FINREP_MAPPING.mapping.find(cell=>cell.tableCode===coordinate.tableCode&&cell.sheetCode===coordinate.sheetCode&&cell.rowCode===coordinate.rowCode&&cell.columnCode===coordinate.columnCode)?.label:undefined;
    return text === undefined && conceptLabel === undefined ? undefined : { ...(text === undefined ? {} : { description: text }), ...(conceptLabel === undefined ? {} : { conceptLabel }) };
  };
}
