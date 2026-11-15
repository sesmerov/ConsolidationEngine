import { createHash } from 'node:crypto';
import type { JsonObject, JsonValue } from '@ce/contracts';
import type { QueryResultRow } from 'pg';
import { ApiError } from '../errors.js';
import type { WorkspaceOwner } from '../ports/workspace-repository.js';
import { createHostedCursorCodec } from '../routes/pagination.js';
import { canonicalHash } from '../session/canonical-state.js';
import type { CanonicalCodec, CanonicalRef } from './canonical-codec.js';
import type { DatabaseTransaction, HostedDatabase } from './database.js';
import type { ProjectionIndexRef, ProjectionResource } from './projection-store.js';
import { revisionNumber, requireVersion, requireWorkspace } from './postgres-repository.js';
import { assertLiveSession } from './session-service.js';

export interface ProjectionFilter {
  readonly code?: string; readonly status?: string; readonly scope?: 'all' | 'pending' | 'resolved' | 'selected' | 'missing';
  readonly table?: string; readonly contextId?: string; readonly groupId?: string; readonly resultId?: string; readonly section?: string; readonly rowKey?: string;
}
interface Resolved { ref: ProjectionIndexRef; versionId?: string; basisId?: string; revision: number }
interface Row extends QueryResultRow { row_key: string; sort_key: string; summary:JsonObject; payload_ref: { chunk: CanonicalRef; offset: number }; overlay?: {set:JsonObject;unset:string[];nested?:string|null;revision?:number}|null }
const columns = {
  version: ['workspace_versions', 'summary'], run: ['validation_runs', 'result_index_ref'], review: ['direction_reviews', 'choices_ref'],
  preview: ['previews', 'manifest_refs'], selection: ['proposal_selections', 'mask_ref'], application: ['application_receipts', 'detail_ref'],
  inspection: ['import_inspections', 'detail_ref'],
} as const;

/** Maintenance must hold the session/workspace locks before this read and any subsequent delete. */
export async function isProjectionReferenced(tx: DatabaseTransaction, owner: WorkspaceOwner, ref: Pick<ProjectionIndexRef, 'kind' | 'indexId'>): Promise<boolean> {
  const branches = Object.entries(columns).map(([type, [table, column]]) => `SELECT 1 FROM ${table} r
    CROSS JOIN LATERAL jsonb_each(coalesce(r.${column}->'views','{}'::jsonb)) v
    WHERE r.session_id=$1 AND r.workspace_id=$2${type === 'version' ? ' AND r.retained' : ''}
      AND v.value->>'indexId'=$3 AND v.value->>'kind'=$4`);
  return Boolean((await tx.query<{ referenced: boolean }>(`SELECT EXISTS(${branches.join(' UNION ALL ')}) AS referenced`, [owner.sessionId, owner.workspaceId, ref.indexId, ref.kind])).rows[0]!.referenced);
}

/** Public reads resolve retained authority first, then only the requested indexed page and its bounded immutable chunks. */
export class HostedQueryRepository {
  private readonly cursors: ReturnType<typeof createHostedCursorCodec>;
  constructor(readonly database: HostedDatabase, readonly codec: CanonicalCodec,
    readonly options: { signingKey: Uint8Array; now?: () => number }) { this.cursors = createHostedCursorCodec(options.signingKey); }
  private now() { return new Date((this.options.now ?? Date.now)()); }
  private async resolve(tx: DatabaseTransaction, owner: WorkspaceOwner, resource: ProjectionResource): Promise<Resolved> {
    await assertLiveSession(tx, owner.sessionId, this.now()); await requireWorkspace(tx, owner);
    if (!columns[resource.type] || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(resource.view)) throw new ApiError('RESOURCE_NOT_FOUND');
    const [table, column] = columns[resource.type];
    const row = (await tx.query(`SELECT * FROM ${table} WHERE session_id=$1 AND workspace_id=$2 AND id=$3`, [owner.sessionId, owner.workspaceId, resource.id])).rows[0];
    // Historical/incomplete domain states remain inspectable while their authoritative pointer is retained.
    // Only mutation/admission decides whether those results may authorize a calculation.
    if (!row || resource.type === 'version' && !row.retained || row.expires_at && this.now() >= row.expires_at) throw new ApiError('RESOURCE_NOT_FOUND');
    const ref = row[column]?.views?.[resource.view] as ProjectionIndexRef | undefined;
    if (!ref || !Number.isSafeInteger(ref.revision) || ref.revision < 1) throw new ApiError('RESOURCE_NOT_FOUND');
    const index = (await tx.query('SELECT * FROM projection_sets WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4', [owner.sessionId, owner.workspaceId, ref.kind, ref.indexId])).rows[0];
    if (!index?.complete || index.revision !== String(ref.revision) || index.owner_ref.type !== resource.type || index.owner_ref.id !== resource.id || index.owner_ref.view !== resource.view
      || (['review', 'selection'].includes(resource.type) && row.revision !== index.revision)) throw new ApiError('RESOURCE_NOT_FOUND');
    const versionId = resource.type === 'version' ? row.id : row.version_id ?? row.base_version_id ?? row.new_version_id;
    if (versionId) await requireVersion(tx, owner, versionId);
    const basisId = row.basis_id ?? index.basis_id;
    return { ref, ...(versionId ? { versionId } : {}), ...(basisId ? { basisId } : {}), revision: revisionNumber(index.revision) };
  }
  async page(owner: WorkspaceOwner, resource: ProjectionResource,
    query: { limit?: number; cursor?: string; filter?: ProjectionFilter;byteBudget?:number }, prefix: JsonObject = {}, onRow?:(metadata:{rowKey:string;summary:JsonObject})=>void) {
    const limit = query.limit ?? 50, filter = query.filter ?? {};
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new ApiError('INVALID_REQUEST');
    const byteBudget=query.byteBudget??1024*1024;if(!Number.isSafeInteger(byteBudget)||byteBudget<32768||byteBudget>1024*1024)throw new ApiError('INTERNAL_ERROR');
    const selected = await this.database.transaction(async tx => {
      const resolved = await this.resolve(tx, owner, resource);
      const fingerprint = canonicalHash({ owner, resource, basisId: resolved.basisId ?? null, ref: resolved.ref, filter });
      const after = query.cursor ? this.cursors.decode(query.cursor, fingerprint) : undefined;
      const values: unknown[] = [owner.sessionId, owner.workspaceId, resolved.ref.kind, resolved.ref.indexId];
      const clauses = ['session_id=$1', 'workspace_id=$2', 'resource_kind=$3', 'resource_id=$4'];
      if(resource.type==='review'&&resource.view==='groups')clauses.push("status<>'not-observed'");
      const where = (sql: string, value: unknown) => { values.push(value); clauses.push(sql.replace('?', '$' + values.length)); };
      if (filter.code) where("strpos(lower(rule_code),lower(?))>0", filter.code);
      if (filter.status) { values.push(filter.status); clauses.push(`(status=$${values.length} OR coalesce(summary->'statuses','[]'::jsonb) ? $${values.length})`); }
      if (filter.rowKey) where('row_key=?', filter.rowKey);
      if (filter.table) { values.push(filter.table); clauses.push(`(summary->>'table'=$${values.length} OR coalesce(summary->'tables','[]'::jsonb) ? $${values.length})`); }
      for (const field of ['contextId', 'groupId', 'resultId', 'section'] as const) if (filter[field] !== undefined) where(`summary->>'${field}'=?`, filter[field]);
      if (filter.scope === 'pending') clauses.push("status IN ('pending','conflicted','undetermined')");
      if (filter.scope === 'resolved') clauses.push("status IN ('included','resolved','omitted')");
      if (filter.scope === 'selected') clauses.push("summary->>'selected'='true'");
      if (filter.scope === 'missing') clauses.push("summary->>'required'='true'");
      const total = Number((await tx.query<{ total: string }>(`SELECT count(*)::text AS total FROM projection_rows WHERE ${clauses.join(' AND ')}`, values)).rows[0]!.total);
      if (after) { values.push(after.sortKey, after.rowKey); clauses.push(`(sort_key COLLATE "C",row_key COLLATE "C")>($${values.length - 1} COLLATE "C",$${values.length} COLLATE "C")`); }
      values.push(limit + 1);
      const rows = (await tx.query<Row>(`SELECT row_key,sort_key,payload_ref,summary,overlay FROM projection_rows WHERE ${clauses.join(' AND ')} ORDER BY sort_key COLLATE "C",row_key COLLATE "C" LIMIT $${values.length}`, values)).rows;
      return { resolved, fingerprint, rows, total };
    });
    const { resolved, fingerprint, rows, total } = selected, items: JsonValue[] = [], chunks = new Map<string, JsonValue[]>();
    const base = { ...prefix, workspaceId: owner.workspaceId, ...(resolved.versionId ? { versionId: resolved.versionId } : {}), ...(resolved.basisId ? { validationBasisId: resolved.basisId } : {}), revision: resolved.revision };
    let nextCursor: string | null = null;
    for (const row of rows.slice(0, limit)) {
      const { chunk, offset } = row.payload_ref;
      let values = chunks.get(chunk.resourceId);
      if (!values) { const decoded = await this.codec.get(owner, chunk); if (!Array.isArray(decoded)) throw new ApiError('INTERNAL_ERROR'); values = decoded as JsonValue[]; chunks.set(chunk.resourceId, values); }
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= values.length) throw new ApiError('INTERNAL_ERROR');
      let item=values[offset]!;
      if(row.overlay){
        if(!item||typeof item!=='object'||Array.isArray(item))throw new ApiError('INTERNAL_ERROR');
        const copy={...item} as Record<string,JsonValue>,patch=row.overlay;
        const target=(patch.nested?{...(copy[patch.nested] as JsonObject)}:copy);
        for(const key of patch.unset)delete target[key];Object.assign(target,patch.set);
        if(patch.nested){copy[patch.nested]=target;if(patch.revision!==undefined)copy['revision']=patch.revision;}
        item=copy;
      }
      const candidateCursor = rows.length > items.length + 1 ? this.cursors.encode(fingerprint, { sortKey: row.sort_key, rowKey: row.row_key }) : null;
      const candidate = { ...base, items: [...items, item], total, nextCursor: candidateCursor };
      if (Buffer.byteLength(JSON.stringify(candidate)) > byteBudget) {
        if (!items.length) throw new ApiError('RESPONSE_LIMIT'); break;
      }
      items.push(item); nextCursor = candidateCursor;onRow?.({rowKey:row.row_key,summary:row.summary});
    }
    await this.database.transaction(async tx => {
      const current = await this.resolve(tx, owner, resource);
      if (current.ref.indexId !== resolved.ref.indexId || current.revision !== resolved.revision) throw new ApiError('INVALID_CURSOR');
    });
    return { ...base, items, total, nextCursor };
  }
  async item(owner: WorkspaceOwner, resource: ProjectionResource, rowKey: string): Promise<JsonValue> {
    const page = await this.page(owner, resource, { limit: 1, filter: { rowKey } });
    if (!page.items.length) throw new ApiError('RESOURCE_NOT_FOUND'); return page.items[0]!;
  }
  async metadata(owner:WorkspaceOwner,resource:ProjectionResource,rowKey:string):Promise<JsonObject>{
    return this.database.transaction(async tx=>{
      const {ref}=await this.resolve(tx,owner,resource);
      const row=(await tx.query<{summary:JsonObject}>('SELECT summary FROM projection_rows WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4 AND row_key=$5',[owner.sessionId,owner.workspaceId,ref.kind,ref.indexId,rowKey])).rows[0];
      if(!row)throw new ApiError('RESOURCE_NOT_FOUND');return row.summary;
    });
  }
  async valuePart(owner: WorkspaceOwner, valueId: string, partIndex: number): Promise<{ bytes: Uint8Array; sha256: string }> {
    if (!Number.isSafeInteger(partIndex) || partIndex < 0) throw new ApiError('RESOURCE_NOT_FOUND');
    const planned = await this.database.transaction(async tx => {
      await assertLiveSession(tx, owner.sessionId, this.now()); await requireWorkspace(tx, owner);
      const value = (await tx.query(`SELECT v.*,s.owner_ref FROM projection_values v JOIN projection_sets s
        ON s.session_id=v.session_id AND s.workspace_id=v.workspace_id AND s.resource_kind=v.resource_kind AND s.resource_id=v.resource_id
        WHERE v.session_id=$1 AND v.workspace_id=$2 AND v.id=$3`, [owner.sessionId, owner.workspaceId, valueId])).rows[0];
      if (!value || partIndex >= value.part_count) throw new ApiError('RESOURCE_NOT_FOUND');
      const resolved = await this.resolve(tx, owner, value.owner_ref);
      if (resolved.ref.indexId !== value.resource_id || resolved.ref.kind !== value.resource_kind) throw new ApiError('RESOURCE_NOT_FOUND');
      const part = (await tx.query('SELECT * FROM projection_value_parts WHERE session_id=$1 AND workspace_id=$2 AND value_id=$3 AND part_index=$4', [owner.sessionId, owner.workspaceId, valueId, partIndex])).rows[0];
      if (!part) throw new ApiError('RESOURCE_NOT_FOUND'); return { value, part, resolved };
    });
    const encoded = await this.codec.get(owner, planned.part.canonical_ref); if (typeof encoded !== 'string') throw new ApiError('INTERNAL_ERROR');
    const bytes = Buffer.from(encoded, 'base64'), digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.length !== planned.part.byte_length || digest !== planned.part.sha256) throw new ApiError('INTERNAL_ERROR');
    await this.database.transaction(async tx => {
      const current = await this.resolve(tx, owner, planned.value.owner_ref);
      if (current.ref.indexId !== planned.resolved.ref.indexId) throw new ApiError('RESOURCE_NOT_FOUND');
    });
    return { bytes, sha256: digest };
  }
}
