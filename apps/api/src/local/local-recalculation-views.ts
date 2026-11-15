import { PUBLIC_JSON_MAX_BYTES, largeValueDescriptorSchema } from '@ce/contracts';
import type { ProposalExplanationSection, ProposalSelectionRowsQueryDTO, PublicValue } from '@ce/contracts';
import { WorkBudget } from '@ce/engine';
import { ApiError } from '../errors.js';
import { createPublicProposalProjector } from '../presentation/public-proposals.js';
import type { ProposalSelectionService } from '../recalculation/proposal-selection-service.js';
import type { LocalPublicViews } from './local-public-views.js';

type Schema = Record<string, unknown>;
export const compactOnlyQuery = { type: 'object', additionalProperties: false, properties: { compact: { const: 'true' } } };
export function withCompactQuery(schema: Schema) { return { ...schema, properties: { ...schema['properties'] as Schema, compact: { const: 'true' } } }; }
/** Compact values are bounded by UTF-8 bytes and use descriptors, rather than text-length truncation. */
function exactSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(exactSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => !['maxLength', 'maxItems'].includes(key)).map(([key, value]) => [key, exactSchema(value)]));
}
export function compactDetailResponse(schema: Schema, fields: readonly string[] = []) {
  const compact = exactSchema(schema) as Schema, properties = { ...compact['properties'] as Schema };
  for (const field of fields) properties[field] = { anyOf: [properties[field], largeValueDescriptorSchema] };
  return { anyOf: [largeValueDescriptorSchema, { ...compact, properties }, schema] };
}
export function compactPageResponse(schema: Schema): Schema {
  const compact = (part: Schema): Schema => {
    if (part['oneOf']) return { oneOf: (part['oneOf'] as Schema[]).map(compact) };
    const exact = exactSchema(part) as Schema, properties = exact['properties'] as Schema, items = properties['items'] as Schema;
    return { ...exact, properties: { ...properties, items: { ...items, maxItems: 50, items: { anyOf: [items['items'], largeValueDescriptorSchema] } } } };
  };
  return { anyOf: [compact(schema), schema] };
}
export function compactLimit(limit?: string): number {
  const value = Number(limit ?? 50); if (!Number.isSafeInteger(value) || value < 1 || value > 50) throw new ApiError('INVALID_REQUEST'); return value;
}
export async function compactRecalculationPage<T, P extends { items: readonly T[]; total: number; nextCursor?: string | null }>(values: LocalPublicViews,
  workspaceId: string, scopeId: string, authorize: () => void, page: P, nextCursor: (consumed: number) => string | null) {
  authorize(); const items: PublicValue<T>[] = [];
  let cursor: string | null = nextCursor(0);
  for (const item of page.items) {
    const value = await values.retainValue(workspaceId, scopeId, authorize, item), next = nextCursor(items.length + 1);
    if (Buffer.byteLength(JSON.stringify({ ...page, items: [...items, value], nextCursor: next })) > PUBLIC_JSON_MAX_BYTES) {
      if (!items.length) throw new ApiError('RESPONSE_LIMIT'); break;
    }
    items.push(value); cursor = next;
  }
  authorize(); return { ...page, items, nextCursor: cursor };
}

/** Only requested selection evidence is projected; authority stays in the local immutable workspace records. */
export class LocalRecalculationViews {
  constructor(readonly service: ProposalSelectionService, readonly values: LocalPublicViews) {}
  private context(workspaceId: string, previewId: string) {
    const context = this.service.context(workspaceId, previewId);
    if (!context.record.projection) throw new ApiError('PROPOSAL_SELECTION_NOT_APPLICABLE');
    const scope = `${context.record.summary.id}:${context.record.summary.revision}`;
    return { context, scope, authorize: () => this.service.current(context) };
  }
  async rows(workspaceId: string, previewId: string, query: ProposalSelectionRowsQueryDTO, cancelled?: () => boolean) {
    compactLimit(query.limit); const { context, scope: storageScope, authorize } = this.context(workspaceId, previewId);
    const scope = query.scope ?? 'all', filter = { ...(query.status ? { status: query.status } : {}), ...(query.code ? { code: query.code.toLowerCase() } : {}), ...(query.table ? { table: query.table } : {}), ...(query.contextId ? { contextId: query.contextId } : {}) };
    const fingerprint = this.service.fingerprint(context, { resource: 'rows', scope, filter });
    const raw = await this.service.rows(workspaceId, previewId, query, cancelled), offset = this.service.offset(fingerprint, query.cursor, raw.total);
    const page = await compactRecalculationPage(this.values, workspaceId, storageScope, authorize, raw, count => this.service.cursor(fingerprint, offset + count, raw.total));
    return { ...page, filterCounts: { ...page.filterCounts, selectedOutsidePage: (context.record.summary.selectedCount ?? 0) - raw.items.slice(0, page.items.length).filter(row => row.selected).length } };
  }
  async dependencies(workspaceId: string, previewId: string, proposalId: string, query: { scope?: 'all' | 'missing'; limit?: string; cursor?: string }, cancelled?: () => boolean) {
    compactLimit(query.limit); const { context, scope, authorize } = this.context(workspaceId, previewId);
    const fingerprint = this.service.fingerprint(context, { resource: 'dependencies', proposalId, scope: query.scope ?? 'all' });
    const raw = await this.service.dependencies(workspaceId, previewId, proposalId, query, cancelled), offset = this.service.offset(fingerprint, query.cursor, raw.total);
    return compactRecalculationPage(this.values, workspaceId, scope, authorize, raw, count => this.service.cursor(fingerprint, offset + count, raw.total));
  }
  private async proposal(workspaceId: string, previewId: string, proposalId: string, cancelled?: () => boolean) {
    const state = this.context(workspaceId, previewId), { context } = state, byId = await this.service.ordinals(context, cancelled), ordinal = byId.get(proposalId);
    if (ordinal === undefined) throw new ApiError('RESOURCE_NOT_FOUND');
    const projector = createPublicProposalProjector(context.snapshot, context.bundle, context.record.projection!, new WorkBudget({ ...(cancelled ? { cancelled } : {}) }));
    return { ...state, ordinal, projector, proposal: context.bundle.proposals[ordinal]! };
  }
  async explanation(workspaceId: string, previewId: string, proposalId: string, cancelled?: () => boolean) {
    const { context, ordinal, projector, scope, authorize } = await this.proposal(workspaceId, previewId, proposalId, cancelled);
    const detail = { ...projector.explanation(ordinal, context.record.summary.id, context.record.summary.revision), state: context.record.summary.state };
    authorize(); return this.values.retainValue(workspaceId, scope, authorize, detail);
  }
  async explanationItems(workspaceId: string, previewId: string, proposalId: string, query: { section: ProposalExplanationSection; limit?: string; cursor?: string }, cancelled?: () => boolean) {
    const limit = compactLimit(query.limit), { context, ordinal, projector, proposal, scope, authorize } = await this.proposal(workspaceId, previewId, proposalId, cancelled);
    const detail = projector.explanation(ordinal, context.record.summary.id, context.record.summary.revision), counts = { operands: detail.operandCount, origins: detail.originCount, diagnostics: detail.diagnosticCount, descriptions: detail.descriptionCount };
    const total = counts[query.section], fingerprint = this.service.fingerprint(context, { resource: 'compact-explanation', proposalId, section: query.section });
    const offset = this.service.offset(fingerprint, query.cursor, total), items = []; let index = 0;
    for (const item of projector.items(proposal, query.section)) { if (index++ < offset) continue; items.push(item); if (items.length >= limit) break; }
    const raw = { selectionId: context.record.summary.id, previewId, baseVersionId: context.record.summary.baseVersionId, revision: context.record.summary.revision,
      state: context.record.summary.state, proposalId, section: query.section, items, total };
    return compactRecalculationPage(this.values, workspaceId, scope, authorize, raw, count => this.service.cursor(fingerprint, offset + count, total));
  }
}
