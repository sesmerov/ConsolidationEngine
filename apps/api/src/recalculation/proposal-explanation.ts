import { setImmediate as yieldTurn } from 'node:timers/promises';
import type { ProposalDTO, ProposalExplanationDTO, ProposalExplanationItemDTO, ProposalExplanationPageDTO, ProposalExplanationSection, ScalarExplanationValueDTO, SourceLocator, ValidationValueDTO } from '@ce/contracts';
import { WorkBudget, WorkLimitError } from '@ce/engine';
import { ApiError } from '../errors.js';
import { publicValue } from '../presentation/public-values.js';
import type { ProposalSelectionService, SelectionContext } from './proposal-selection-service.js';

const MAX_JSON = 1024 * 1024;
const exactText = (value: string) => { if (value.length > 32767) throw new ApiError('EXPANSION_LIMIT'); return value; };
const scalar = (value: ValidationValueDTO): ScalarExplanationValueDTO => { const { coordinate: _coordinate, sourceLocator: _source, ...result } = publicValue(value); return result; };
const cell = (source: SourceLocator) => source.column && source.row ? `${source.column}${source.row}` : '';
const file = (c: SelectionContext, source: SourceLocator) => c.snapshot.content.sources.find(f => f.id === source.fileId)?.displayName ?? '';
function source(c: SelectionContext, p: ProposalDTO, index: number) {
  const reads = p.calculation?.reads ?? [], read = reads[index];
  const locator = read ? read.fact.sourceLocator : p.sources[index - reads.length]!;
  const kind = read?.fromProposalId ? 'proposal' as const : read?.fact.derivation ? 'application' as const : read ? 'report' as const : 'catalog' as const;
  return { locator, kind, name: file(c, locator) };
}
interface ExplanationIndex { readonly origins: readonly number[]; readonly descriptions: readonly { readonly variant: number; readonly record: number }[] }
/** Indices contain only ordinals into immutable simulation/catalog evidence, never cloned reads or values. */
async function index(service: ProposalSelectionService, c: SelectionContext, p: ProposalDTO, cancelled?: () => boolean): Promise<ExplanationIndex> {
  const origins: number[] = [], seen = new Set<string>(), budget = new WorkBudget({ ...(cancelled ? { cancelled } : {}) });
  const total = (p.calculation?.reads.length ?? 0) + p.sources.length;
  let bytes = 0;
  try { for (let n = 0; n < total; n++) { budget.consume('reads'); const item = source(c, p, n), key = JSON.stringify([item.kind, item.locator.fileId, item.locator.sheet, item.locator.row, item.locator.column]);
    if (!seen.has(key)) { seen.add(key); origins.push(n); bytes += key.length * 2 + 32; if (bytes > service.store.availableBytes) throw new ApiError('SESSION_LIMIT'); }
    if ((n & 1023) === 1023) await yieldTurn();
  } } catch (error) { if (error instanceof WorkLimitError) throw new ApiError('EXPANSION_LIMIT', { reason: error.code }); throw error; }
  const descriptions: { variant: number; record: number }[] = [];
  c.snapshot.content.catalog.variants.forEach((v, variant) => { if (!p.variantIds.includes(v.variantId)) return; c.snapshot.content.catalog.records.forEach((r, record) => { if (v.sourceRecords.includes(r.id)) descriptions.push({ variant, record }); }); });
  service.current(c); service.store.assertTransientCapacity([{ origins, descriptions }]); return { origins, descriptions };
}
async function prepare(service: ProposalSelectionService, workspaceId: string, previewId: string, proposalId: string, cancelled?: () => boolean) {
  const c = service.context(workspaceId, previewId); if (!c.record.projection) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE');
  const byId = await service.ordinals(c, cancelled), ordinal = byId.get(proposalId); if (ordinal === undefined) throw new ApiError('RESOURCE_NOT_FOUND');
  const p = c.bundle.proposals[ordinal]!, indices = await index(service, c, p, cancelled);
  return { c, p, indices, byId, row: await service.row(c, ordinal, byId, cancelled) };
}
function identity(c: SelectionContext, proposalId: string) { return { selectionId: c.record.summary.id, previewId: c.previewId, baseVersionId: c.record.summary.baseVersionId, revision: c.record.summary.revision, state: c.record.summary.state, proposalId }; }
function counts(p: ProposalDTO, idx: ExplanationIndex) { return { operandCount: p.calculation?.reads.length ?? 0, originCount: idx.origins.length, diagnosticCount: p.diagnostics.length, descriptionCount: idx.descriptions.length }; }
export async function proposalExplanation(service: ProposalSelectionService, workspaceId: string, previewId: string, proposalId: string, cancelled?: () => boolean): Promise<ProposalExplanationDTO> {
  const { c, p, row, indices } = await prepare(service, workspaceId, previewId, proposalId, cancelled), calculation = p.calculation;
  const fallback = c.snapshot.content.catalog.variants.filter(v => p.variantIds.includes(v.variantId));
  const expression = calculation?.expression ?? (fallback.length === 1 ? fallback[0]!.expression : undefined), precondition = calculation?.precondition ?? (fallback.length === 1 ? fallback[0]!.precondition : undefined);
  const result: ProposalExplanationDTO = { ...identity(c, proposalId), code: p.code, target: row.target, ...(row.before ? { before: row.before } : {}), ...(row.after ? { after: row.after } : {}), ...(row.origin ? { origin: row.origin } : {}), evidenceState: calculation ? 'recorded' : 'unavailable',
    ...(expression === undefined ? {} : { expression: exactText(expression) }), ...(precondition === undefined ? {} : { precondition: exactText(precondition) }),
    ...(calculation?.sourceValue ? { sourceValue: scalar(calculation.sourceValue) } : {}), ...(calculation?.preconditionValue ? { preconditionValue: scalar(calculation.preconditionValue) } : {}),
    ...(p.exactNominal ? { exactNominal: p.exactNominal } : {}), ...(p.derivedInterval ? { interval: p.derivedInterval } : {}), rounded: row.rounded,
    ...(row.rounded ? { roundingLabel: 'Redondeo al par según la precisión del destino' } : {}), ...(p.after && 'decimals' in p.after ? { decimals: p.after.decimals, unit: p.after.unit } : {}), ...counts(p, indices) };
  service.current(c); if (Buffer.byteLength(JSON.stringify(result)) > MAX_JSON) throw new ApiError('EXPANSION_LIMIT'); return result;
}
export async function proposalExplanationItems(service: ProposalSelectionService, workspaceId: string, previewId: string, proposalId: string,
  query: { section: ProposalExplanationSection; limit?: string; cursor?: string }, cancelled?: () => boolean): Promise<ProposalExplanationPageDTO> {
  const { c, p, indices, byId } = await prepare(service, workspaceId, previewId, proposalId, cancelled), section = query.section;
  const lengths = { operands: p.calculation?.reads.length ?? 0, origins: indices.origins.length, diagnostics: p.diagnostics.length, descriptions: indices.descriptions.length };
  const total = lengths[section], fingerprint = service.fingerprint(c, { resource: 'explanation', proposalId, section }), offset = service.offset(fingerprint, query.cursor, total), items: ProposalExplanationItemDTO[] = [];
  const base = { ...identity(c, proposalId), section, total };
  const item = (n: number): ProposalExplanationItemDTO => {
    const itemId = `${section}:${n}`;
    if (section === 'operands') {
      const read = p.calculation!.reads[n]!, f = read.fact, coordinate = f.coordinate, producerOrdinal = read.fromProposalId ? byId.get(read.fromProposalId) : undefined;
      if (read.fromProposalId && producerOrdinal === undefined) throw new ApiError('INTERNAL_ERROR');
      const producer = producerOrdinal === undefined ? undefined : c.bundle.proposals[producerOrdinal];
      const ctx = c.snapshot.content.contexts.find(ctx => ctx.contextId === coordinate.contextId);
      return { itemId, contextId: coordinate.contextId, tableCode: coordinate.tableCode, sheetCode: coordinate.sheetCode, rowCode: coordinate.rowCode, columnCode: coordinate.columnCode,
        ...(ctx ? { contextLabel: `${ctx.entityId} · ${ctx.referenceDate} · ${ctx.moduleVersion}`.slice(0, 500) } : {}), presence: f.presence, ...(f.normalizedValue === undefined ? {} : { value: f.normalizedValue }),
        unit: coordinate.unit, decimals: coordinate.decimals, fileName: file(c, f.sourceLocator), sheet: f.sourceLocator.sheet ?? '', cell: cell(f.sourceLocator), originKind: read.fromProposalId ? 'proposal' : f.derivation ? 'application' : 'report',
        ...(producer ? { fromProposalId: producer.id, fromProposalCode: producer.code } : {}) };
    }
    if (section === 'origins') { const s = source(c, p, indices.origins[n]!); return { itemId, kind: s.kind, fileName: s.name, ...(s.locator.sheet ? { sheet: s.locator.sheet } : {}), ...(s.locator.row ? { row: s.locator.row } : {}), ...(s.locator.column ? { column: s.locator.column } : {}), ...(cell(s.locator) ? { cell: cell(s.locator) } : {}), label: [s.name, s.locator.sheet, cell(s.locator)].filter(Boolean).join(' · ') }; }
    if (section === 'diagnostics') { const d = p.diagnostics[n]!; return { itemId, code: d.code, severity: d.severity ?? 'error', message: d.message.slice(0, 4096), messageTruncated: d.message.length > 4096, location: d.locator ? [file(c, d.locator), d.locator.sheet, cell(d.locator)].filter(Boolean).join(' · ') : '' }; }
    const pointer = indices.descriptions[n]!, record = c.snapshot.content.catalog.records[pointer.record]!, variant = c.snapshot.content.catalog.variants[pointer.variant]!;
    const value = record.originalFields.Description;
    return { itemId, description: exactText(value === undefined || value === null ? '' : String(value)), expression: exactText(variant.expression), ...(variant.precondition ? { precondition: exactText(variant.precondition) } : {}), fileName: file(c, record.sourceLocator), ...(record.sourceLocator.sheet ? { sheet: record.sourceLocator.sheet } : {}), ...(record.sourceLocator.row ? { row: record.sourceLocator.row } : {}) };
  };
  const limit = Number(query.limit ?? 50);
  for (let n = offset; n < total && items.length < limit; n++) {
    const next = item(n), candidate = { ...base, items: [...items, next], nextCursor: service.cursor(fingerprint, n + 1, total) };
    if (Buffer.byteLength(JSON.stringify(candidate)) > MAX_JSON) { if (!items.length) throw new ApiError('EXPANSION_LIMIT'); break; } items.push(next);
  }
  service.current(c); return { ...base, items, nextCursor: service.cursor(fingerprint, offset + items.length, total) };
}
