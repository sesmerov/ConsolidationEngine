import { ENGINE_PROFILE_ID, parseRule } from '@ce/engine';
import type { CatalogData, Coordinate, Diagnostic, ReportContext, ReportedFact, RuleAnalysis, SnapshotContent, SourceFile, SourceLocator } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash, canonicalStringify } from '../session/canonical-state.js';
import type { OperationContext } from '../workers/protocol.js';
import type { StagedFile } from './multipart-staging.js';
import { preflightXlsx } from './xlsx-preflight.js';
import { readWorkbook } from './xlsx-reader.js';
import { importReportStream } from './ce-report.js';
import { conflictingVariants, importCatalog, variantApplicability } from './eba-catalog.js';

export const GRAMMAR_VERSION = 'dpm-xl-0.9-antlr-4.13.2';
/** Fully builds a candidate. Only JobManager on the main thread can publish it. */
export async function importWorkspace(files: readonly StagedFile[], operation: OperationContext): Promise<SnapshotContent> {
  if (files.filter((file) => file.kind === 'catalog').length !== 1 || files.filter((file) => file.kind === 'report').length < 1 || files.filter((file) => file.kind === 'report').length > 20) throw new ApiError('INVALID_REQUEST');
  const check = () => { if (operation.cancelled() || operation.job?.deadline && Date.now() >= Date.parse(operation.job.deadline)) throw new ApiError('INTERNAL_ERROR'); };
  const budget = { expandedBytes: 0 }; const contexts: ReportContext[] = []; const coordinates: Coordinate[] = []; const facts: ReportedFact[] = [];
  const contextIds = new Set<string>(), coordinateKeys = new Set<string>(), factKeys = new Set<string>();
  const definitions = new Map<string, string>(), axesBySheet = new Map<string, string>(), tableModes = new Map<string, boolean>();
  const expansionBySource = new Map<string, number>();
  let importedCatalog: ReturnType<typeof importCatalog> | undefined;
  for (const [index, file] of files.entries()) {
    try {
    check(); const preflight = await preflightXlsx(file.path, { budget, retainCells: file.kind === 'catalog', check }); expansionBySource.set(file.id, preflight.expandedBytes); check();
    if (file.kind === 'catalog') { const workbook = await readWorkbook(file.path, preflight); check(); importedCatalog = importCatalog(workbook, file); }
    else {
      const report = await importReportStream(file.path, preflight, file, { check });
      const invalid = (reason: string, locator: SourceLocator) => { throw new ApiError('INVALID_WORKBOOK', { reason }, locator); };
      const local = new Map(report.contexts.map((context) => [context.contextId, context]));
      for (const context of report.contexts) {
        const locator = context.filingIndicatorsLocator ?? { fileId: file.id, sheet: 'Contexts' };
        if (contextIds.has(context.contextId)) invalid('DUPLICATE_CONTEXT_ID', { ...locator, column: 'B' });
        const first = contexts[0];
        if (first && (context.entityId !== first.entityId || context.referenceDate !== first.referenceDate)) invalid('INCOMPATIBLE_ENTITY_OR_DATE', { ...locator, column: 'C' });
        const definition = canonicalStringify({ filingIndicators: context.filingIndicators, submissionDate: context.submissionDate ?? '' });
        const previous = definitions.get(context.canonicalContextKey);
        if (previous !== undefined && previous !== definition) invalid('CONFLICTING_CONTEXT_ATTRIBUTES', locator);
        definitions.set(context.canonicalContextKey, definition); contextIds.add(context.contextId); contexts.push(context);
      }
      for (const coordinate of report.coordinates) {
        if (coordinateKeys.has(coordinate.factKey)) invalid('DUPLICATE_COORDINATE', coordinate.sourceLocator);
        coordinateKeys.add(coordinate.factKey);
        const context = local.get(coordinate.contextId)!; const table = canonicalStringify([context.canonicalContextKey, coordinate.tableCode]);
        const sheet = canonicalStringify([table, coordinate.sheetCode]); const mode = coordinate.sheetCode !== '';
        if (tableModes.has(table) && tableModes.get(table) !== mode) invalid('MIXED_SHEET_AXIS', coordinate.sourceLocator);
        const axes = canonicalStringify(coordinate.axes);
        if (axesBySheet.has(sheet) && axesBySheet.get(sheet) !== axes) invalid('INCONSISTENT_SHEET_AXES', coordinate.sourceLocator);
        tableModes.set(table, mode); axesBySheet.set(sheet, axes); coordinates.push(coordinate);
      }
      for (const fact of report.facts) { if (factKeys.has(fact.factKey)) invalid('DUPLICATE_FACT', fact.sourceLocator); factKeys.add(fact.factKey); facts.push(fact); }
      if (coordinates.length > 100_000 || facts.length > 100_000) throw new ApiError('EXPANSION_LIMIT');
    }
    operation.progress(index + 1, files.length + 1);
    } catch (error) {
      if (error instanceof ApiError) throw new ApiError(error.code, { ...error.details, displayName: file.displayName }, error.locator ?? { fileId: file.id });
      throw error;
    }
  }
  if (!importedCatalog) throw new ApiError('INVALID_WORKBOOK');
  const conflicts = conflictingVariants(importedCatalog.variants, contexts);
  const records = importedCatalog.records.map((record) => ({ ...record, diagnostics: [...record.diagnostics] }));
  const analyses: RuleAnalysis[] = [];
  for (const variant of importedCatalog.variants) {
    check(); const expression = parseRule(variant.expression); const precondition = variant.precondition ? parseRule(variant.precondition) : undefined;
    const diagnostics: Diagnostic[] = [];
    for (const record of records.filter((row) => row.variantId === variant.variantId)) {
      const append = (items: readonly Diagnostic[], field: string) => {
        const raw = record.originalFields[field]; const column = raw && typeof raw === 'object' && !Array.isArray(raw) && 'column' in raw && typeof raw.column === 'string' ? raw.column : undefined;
        const located = items.map((item) => ({ ...item, locator: { ...record.sourceLocator, ruleCode: record.code, ...(column ? { column } : {}) } }));
        record.diagnostics.push(...located); diagnostics.push(...located);
      };
      append(expression.diagnostics, 'Expression'); if (precondition) append(precondition.diagnostics, 'Precondtion');
      if (conflicts.has(variant.variantId)) append([{ code: 'CONFLICTING_VARIANTS', message: 'Hay variantes incompatibles aplicables al mismo contexto; no se selecciona ninguna por orden.', severity: 'error' }], 'Expression');
    }
    const syntaxStatus = expression.syntaxStatus === 'error' || precondition?.syntaxStatus === 'error' ? 'error' : 'valid';
    const supportStatus = expression.supportStatus === 'unsupported' || precondition?.supportStatus === 'unsupported' || conflicts.has(variant.variantId) ? 'unsupported' : 'supported';
    analyses.push({ variantId: variant.variantId, grammarVersion: GRAMMAR_VERSION, profileId: ENGINE_PROFILE_ID, syntaxStatus, supportStatus, diagnostics,
      ...(syntaxStatus === 'valid' && supportStatus === 'supported' && expression.ast ? { ast: expression.ast, ...(precondition?.ast ? { preconditionAst: precondition.ast } : {}) } : {}) });
  }
  const catalog: CatalogData = { records, variants: importedCatalog.variants, analyses, coverage: {
    rows: records.length, variants: importedCatalog.variants.length,
    applicableVariants: importedCatalog.variants.filter((variant) => variantApplicability(variant, contexts) === 'applicable').length,
    supportedVariants: analyses.filter((analysis) => analysis.syntaxStatus === 'valid' && analysis.supportStatus === 'supported').length,
    invalidRows: records.filter((record) => record.diagnostics.some((item) => item.severity === 'error' || item.code === 'SYNTAX_ERROR' || item.code === 'UNSUPPORTED_CONSTRUCT')).length,
    duplicateRows: records.filter((record) => record.diagnostics.some((item) => item.code === 'DUPLICATE_RULE')).length, conflictingVariants: conflicts.size,
  } };
  const sources: SourceFile[] = files.map(({ id, sha256, displayName, kind, size, importedAt }) => ({ id, sha256, displayName, kind, size, importedAt, expandedBytes: expansionBySource.get(id)! }));
  check(); operation.progress(files.length + 1, files.length + 1);
  return { catalogVersion: canonicalHash(catalog), reportVersion: canonicalHash({ contexts, coordinates, facts }), configVersion: canonicalHash([]), profileId: ENGINE_PROFILE_ID,
    contexts, coordinates, facts, catalog, directions: [], sources };
}
