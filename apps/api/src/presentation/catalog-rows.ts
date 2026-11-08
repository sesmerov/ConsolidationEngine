import type { RuleRowDTO, Snapshot } from '@ce/contracts';
import { variantApplicability } from '../import/eba-catalog.js';

/** Shared display projection. It does not decide calculation authority or mutate the retained catalog. */
export function catalogRows(snapshot: Snapshot): RuleRowDTO[] {
  const catalog = snapshot.content.catalog, variants = new Map(catalog.variants.map(variant => [variant.variantId, variant]));
  const analyses = new Map(catalog.analyses.map(analysis => [analysis.variantId, analysis]));
  return catalog.records.map(record => {
    const variant = record.variantId ? variants.get(record.variantId) : undefined, analysis = record.variantId ? analyses.get(record.variantId) : undefined;
    return { ...record, ...(variant ? { expression: variant.expression, ...(variant.precondition ? { precondition: variant.precondition } : {}), severity: variant.severity,
      active: variant.active, modules: variant.modules, tables: variant.tables, applicability: variantApplicability(variant, snapshot.content.contexts) } : {}),
      ...(analysis ? { syntaxStatus: analysis.syntaxStatus, supportStatus: analysis.supportStatus } : {}) };
  });
}
