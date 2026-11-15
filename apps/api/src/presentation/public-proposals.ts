import type { PreviewBundle, ProposalDTO, ProposalExplanationDTO, ProposalExplanationItemDTO, ProposalExplanationSection, ProposalSelectionRowDTO, Snapshot, SourceLocator, ValidationValueDTO } from '@ce/contracts';
import { selectionMaskReader, WorkBudget } from '@ce/engine';
import type { ProposalSelectionProjection } from '@ce/engine';
import { ApiError } from '../errors.js';
import { rulePresentation } from './rule-presentation.js';
import { publicValue } from './public-values.js';

/** Pure projection shared by hosted staging and compact reads; no store or server-side visitor cache. */
export function createPublicProposalProjector(snapshot: Snapshot, bundle: PreviewBundle, selection: ProposalSelectionProjection, budget = new WorkBudget()) {
  const selected = selectionMaskReader(selection.selected), required = selectionMaskReader(selection.required), present = rulePresentation(snapshot.content);
  const contexts = new Map(snapshot.content.contexts.map(item => [item.contextId, item])), byId = new Map(bundle.proposals.map((row, ordinal) => [row.id, ordinal]));
  const files = new Map(snapshot.content.sources.map(item => [item.id, item.displayName]));
  const variants = new Map(snapshot.content.catalog.variants.map(item => [item.variantId, item]));
  const records = new Map(snapshot.content.catalog.records.map(item => [item.id, item]));
  const file = (locator: SourceLocator) => files.get(locator.fileId ?? '') ?? '';
  const cell = (locator: SourceLocator) => locator.column && locator.row ? `${locator.column}${locator.row}` : '';
  const scalar = (value: ValidationValueDTO) => { const { coordinate: _coordinate, sourceLocator: _source, ...rest } = publicValue(value); return rest; };
  function* descriptions(proposal: ProposalDTO) {
    for (const id of proposal.variantIds) {
      const variant = variants.get(id); if (!variant) throw new ApiError('INTERNAL_ERROR');
      for (const recordId of variant.sourceRecords) { budget.check(); const record = records.get(recordId); if (!record) throw new ApiError('INTERNAL_ERROR'); yield { variant, record }; }
    }
  }
  function* origins(proposal: ProposalDTO) {
    const seen = new Set<string>();
    const reads = proposal.calculation?.reads ?? [];
    for (let n = 0; n < reads.length + proposal.sources.length; n++) {
      budget.check(); const read = reads[n], locator = read ? read.fact.sourceLocator : proposal.sources[n - reads.length]!;
      const kind = read?.fromProposalId ? 'proposal' as const : read?.fact.derivation ? 'application' as const : read ? 'report' as const : 'catalog' as const;
      const key = JSON.stringify([kind, locator.fileId, locator.sheet, locator.row, locator.column]);
      if (!seen.has(key)) { seen.add(key); yield { kind, locator }; }
    }
  }
  function row(ordinal: number): ProposalSelectionRowDTO {
    budget.check(); const proposal = bundle.proposals[ordinal]; if (!proposal) throw new ApiError('RESOURCE_NOT_FOUND');
    const cell = proposal.before?.coordinate, presentation = present(proposal.variantIds, cell), description = presentation?.description ?? '';
    const context = contexts.get(cell?.contextId ?? proposal.binding.contextId ?? ''), before = proposal.before, origin = before?.sourceLocator ?? cell?.sourceLocator;
    const predecessors = new Set(proposal.predecessorIds); let pending = 0;
    for (const id of predecessors) { budget.check(); const n = byId.get(id); if (n === undefined) throw new ApiError('INTERNAL_ERROR'); if (required(n)) pending++; }
    const exact = proposal.exactNominal, after = proposal.after, rounded = !!exact && !!after && typeof after.normalizedValue === 'object' && 'numerator' in after.normalizedValue &&
      (exact.numerator !== after.normalizedValue.numerator || exact.denominator !== after.normalizedValue.denominator);
    return { id: proposal.id, code: proposal.code, state: proposal.state,
      target: { contextId: cell?.contextId ?? proposal.binding.contextId ?? '', tableCode: cell?.tableCode ?? proposal.binding.tableCode ?? '', sheetCode: cell?.sheetCode ?? proposal.binding.sheetCode ?? '',
        rowCode: cell?.rowCode ?? proposal.binding.rowCode ?? '', columnCode: cell?.columnCode ?? proposal.binding.columnCode ?? '',
        ...(context ? { contextLabel: `${context.entityId} · ${context.referenceDate} · ${context.framework} · ${context.moduleVersion}`.slice(0, 500) } : {}),
        ...(presentation?.conceptLabel ? { conceptLabel: presentation.conceptLabel.slice(0, 500) } : {}) },
      description: description.slice(0, 500), descriptionTruncated: description.length > 500,
      ...(before ? { before: { presence: before.presence, ...(before.normalizedValue === undefined ? {} : { normalizedValue: before.normalizedValue }), unit: before.coordinate.unit, decimals: before.coordinate.decimals } } : {}),
      ...(after ? { after } : {}), ...(origin ? { origin: { ...(origin.fileId ? { fileId: origin.fileId } : {}), ...(origin.sheet ? { sheet: origin.sheet } : {}), ...(origin.column && origin.row ? { cell: `${origin.column}${origin.row}` } : {}) } } : {}),
      selected: selected(ordinal), required: required(ordinal), predecessorCount: predecessors.size, requiredPredecessorCount: pending,
      rounded, hasInterval: !!proposal.derivedInterval && (proposal.derivedInterval.lo.numerator !== proposal.derivedInterval.hi.numerator || proposal.derivedInterval.lo.denominator !== proposal.derivedInterval.hi.denominator), diagnosticCount: proposal.diagnostics.length };
  }
  function* dependencies(proposal: ProposalDTO) {
    for (const id of new Set(proposal.predecessorIds)) { const ordinal = byId.get(id); if (ordinal === undefined) throw new ApiError('INTERNAL_ERROR'); yield row(ordinal); }
  }
  function explanation(ordinal: number, selectionId: string, revision: number): ProposalExplanationDTO {
    const p = bundle.proposals[ordinal]!, display = row(ordinal), calculation = p.calculation;
    const fallback = p.variantIds.length === 1 ? variants.get(p.variantIds[0]!) : undefined;
    const expression = calculation?.expression ?? fallback?.expression, precondition = calculation?.precondition ?? fallback?.precondition;
    let originCount = 0, descriptionCount = 0; for (const _item of origins(p)) originCount++; for (const _item of descriptions(p)) descriptionCount++;
    return { selectionId, previewId: bundle.preview.id, baseVersionId: snapshot.versionId, revision, state: 'ready', proposalId: p.id,
      code: p.code, target: display.target, ...(display.before ? { before: display.before } : {}), ...(display.after ? { after: display.after } : {}), ...(display.origin ? { origin: display.origin } : {}),
      evidenceState: calculation ? 'recorded' : 'unavailable', ...(expression === undefined ? {} : { expression }), ...(precondition === undefined ? {} : { precondition }),
      ...(calculation?.sourceValue ? { sourceValue: scalar(calculation.sourceValue) } : {}), ...(calculation?.preconditionValue ? { preconditionValue: scalar(calculation.preconditionValue) } : {}),
      ...(p.exactNominal ? { exactNominal: p.exactNominal } : {}), ...(p.derivedInterval ? { interval: p.derivedInterval } : {}), rounded: display.rounded,
      ...(display.rounded ? { roundingLabel: 'Redondeo al par según la precisión del destino' } : {}), ...(p.after && 'decimals' in p.after ? { decimals: p.after.decimals, unit: p.after.unit } : {}),
      operandCount: calculation?.reads.length ?? 0, originCount, diagnosticCount: p.diagnostics.length, descriptionCount };
  }
  function* items(p: ProposalDTO, section: ProposalExplanationSection): Generator<ProposalExplanationItemDTO> {
    let n = 0;
    if (section === 'operands') for (const read of p.calculation?.reads ?? []) {
      budget.check(); const fact = read.fact, coordinate = fact.coordinate, ctx = contexts.get(coordinate.contextId), producerOrdinal = read.fromProposalId ? byId.get(read.fromProposalId) : undefined;
      if (read.fromProposalId && producerOrdinal === undefined) throw new ApiError('INTERNAL_ERROR');
      const producer = producerOrdinal === undefined ? undefined : bundle.proposals[producerOrdinal];
      yield { itemId: `${section}:${n++}`, contextId: coordinate.contextId, tableCode: coordinate.tableCode, sheetCode: coordinate.sheetCode, rowCode: coordinate.rowCode, columnCode: coordinate.columnCode,
        ...(ctx ? { contextLabel: `${ctx.entityId} · ${ctx.referenceDate} · ${ctx.moduleVersion}`.slice(0, 500) } : {}), presence: fact.presence, ...(fact.normalizedValue === undefined ? {} : { value: fact.normalizedValue }),
        unit: coordinate.unit, decimals: coordinate.decimals, fileName: file(fact.sourceLocator), sheet: fact.sourceLocator.sheet ?? '', cell: cell(fact.sourceLocator), originKind: read.fromProposalId ? 'proposal' : fact.derivation ? 'application' : 'report',
        ...(producer ? { fromProposalId: producer.id, fromProposalCode: producer.code } : {}) };
    }
    else if (section === 'origins') for (const source of origins(p)) yield { itemId: `${section}:${n++}`, kind: source.kind, fileName: file(source.locator),
      ...(source.locator.sheet ? { sheet: source.locator.sheet } : {}), ...(source.locator.row ? { row: source.locator.row } : {}), ...(source.locator.column ? { column: source.locator.column } : {}),
      ...(cell(source.locator) ? { cell: cell(source.locator) } : {}), label: [file(source.locator), source.locator.sheet, cell(source.locator)].filter(Boolean).join(' · ') };
    else if (section === 'diagnostics') for (const diagnostic of p.diagnostics) { budget.check(); yield { itemId: `${section}:${n++}`, code: diagnostic.code, severity: diagnostic.severity ?? 'error', message: diagnostic.message,
      messageTruncated: false, location: diagnostic.locator ? [file(diagnostic.locator), diagnostic.locator.sheet, cell(diagnostic.locator)].filter(Boolean).join(' · ') : '' }; }
    else for (const { variant, record } of descriptions(p)) {
      const original = record.originalFields['Description'], value = original && typeof original === 'object' && !Array.isArray(original) && 'value' in original ? original['value'] : original;
      yield { itemId: `${section}:${n++}`, description: value == null ? '' : String(value), expression: variant.expression, ...(variant.precondition ? { precondition: variant.precondition } : {}), fileName: file(record.sourceLocator),
        ...(record.sourceLocator.sheet ? { sheet: record.sourceLocator.sheet } : {}), ...(record.sourceLocator.row ? { row: record.sourceLocator.row } : {}) };
    }
  }
  return { row, dependencies, explanation, items };
}
