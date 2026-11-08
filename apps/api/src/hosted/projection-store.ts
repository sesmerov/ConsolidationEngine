import { createHash, randomUUID } from 'node:crypto';
import type { JsonObject, JsonValue, LargeValueDescriptorDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalStringify } from '../session/canonical-state.js';
import { CanonicalCodec, type CanonicalRef, type CanonicalWriteContext } from './canonical-codec.js';
import type { HostedDatabase } from './database.js';
import { assertClaimAuthority, type HostedJobClaim } from './job-coordinator.js';
import type { ObjectLedger } from './object-ledger.js';
import { QuotaLedger } from './quota-ledger.js';

export type ProjectionKind = 'catalog' | 'results' | 'decisions' | 'proposals' | 'conflicts' | 'changes' | 'details';
export interface ProjectionResource { readonly type: 'version' | 'run' | 'review' | 'preview' | 'selection' | 'application' | 'inspection'; readonly id: string; readonly view: string }
export interface ProjectionIndexRef { readonly kind: ProjectionKind; readonly indexId: string; readonly revision: number }
export interface ProjectionInputRow {
  readonly key: string; readonly sortKey: string; readonly code?: string; readonly status?: string;
  /** Small indexed selectors/counters, never the result payload or all the rule's reads. */
  readonly selectors?: JsonObject; readonly value: JsonValue;
}
export type BoundProjectionValue = <T>(value: T) => Promise<T | LargeValueDescriptorDTO>;
export interface ProjectionStage { readonly resource: ProjectionResource; readonly kind: ProjectionKind; readonly basisId?: string; readonly revision: number;
  readonly rows: Iterable<ProjectionInputRow> | AsyncIterable<ProjectionInputRow>;
  readonly project?: (row: ProjectionInputRow, bound: BoundProjectionValue) => Promise<JsonValue>;
}
export const HOSTED_VALUE_PART_BYTES = 128 * 1024;
const CHUNK_BYTES = 192 * 1024;
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
interface StoredRow { row_key: string; sort_key: string; rule_code: string | null; status: string | null; summary: JsonObject; payload_ref: JsonObject }

/** Worker-only append/stage path. Public routes see a set only after a domain pointer is published atomically. */
export class HostedProjectionWriter {
  constructor(readonly database: HostedDatabase, readonly quotas: QuotaLedger, readonly objects: ObjectLedger, readonly options: { now?: () => number } = {}) {}
  private now() { return new Date((this.options.now ?? Date.now)()); }
  async stage(claim: HostedJobClaim, input: ProjectionStage): Promise<{ ref: ProjectionIndexRef; manifestRef: CanonicalRef; rowCount: number }> {
    const indexId = randomUUID(), ref = { kind: input.kind, indexId, revision: input.revision }, codec = new CanonicalCodec(this.objects);
    const context: CanonicalWriteContext = { operationId: claim.jobId, jobId: claim.jobId, attemptId: claim.attemptId, fence: claim.fence, deadline: claim.deadlineAt };
    const roots: CanonicalRef[] = [];
    await this.database.transaction(async tx => {
      await assertClaimAuthority(tx, claim, this.now());
      const allocation = await this.quotas.reserve(tx, { owner: claim, operationId: claim.jobId, resource: 'sql-bytes', units: 32768, purpose: 'public', now: this.now() });
      await tx.query(`INSERT INTO projection_sets(session_id,workspace_id,resource_kind,resource_id,basis_id,revision,row_count,job_id,attempt_id,fence,owner_ref)
        VALUES($1,$2,$3,$4,$5,$6,0,$7,$8,$9,$10)`, [claim.sessionId, claim.workspaceId, input.kind, indexId, input.basisId ?? null, input.revision, claim.jobId, claim.attemptId, claim.fence, input.resource]);
      await tx.query(`INSERT INTO cleanup_tasks(id,session_id,workspace_id,object_ref,reason,not_before,deadline,state,updated_at)
        VALUES($1,$2,$3,$4,'provisional-projection',$5,$6,'pending',$7)`, [randomUUID(), claim.sessionId, claim.workspaceId,
        { kind: 'projection-index', resourceKind: input.kind, resourceId: indexId, jobId: claim.jobId, attemptId: claim.attemptId },
        new Date(Date.parse(claim.deadlineAt) + 120000), new Date(this.now().getTime() + 86400000), this.now()]);
      await this.quotas.consume(tx, { reservationId: allocation.id, now: this.now() });
    });
    let values: JsonValue[] = [], rows: Omit<StoredRow, 'payload_ref'>[] = [], bytes = 2, rowCount = 0;
    const flush = async () => {
      if (!rows.length) return;
      const chunk = await codec.put(claim, values, context); roots.push(chunk);
      const payload = rows.map((row, offset) => ({ ...row, payload_ref: { chunk, offset } }));
      await this.database.transaction(async tx => {
        await assertClaimAuthority(tx, claim, this.now());
        const allocation = await this.quotas.reserve(tx, { owner: claim, operationId: claim.jobId, resource: 'sql-bytes',
          units: Buffer.byteLength(JSON.stringify(payload)) * 2 + payload.length * 1024 + 4096, purpose: 'public', now: this.now() });
        await tx.query(`INSERT INTO projection_rows(session_id,workspace_id,resource_kind,resource_id,row_key,sort_key,rule_code,status,summary,payload_ref)
          SELECT $1,$2,$3,$4,r.row_key,r.sort_key,r.rule_code,r.status,r.summary,r.payload_ref
          FROM jsonb_to_recordset($5::jsonb) r(row_key text,sort_key text,rule_code text,status text,summary jsonb,payload_ref jsonb)`,
        [claim.sessionId, claim.workspaceId, input.kind, indexId, JSON.stringify(payload)]);
        await this.quotas.consume(tx, { reservationId: allocation.id, now: this.now() });
      });
      rowCount += rows.length; values = []; rows = []; bytes = 2;
    };
    for await (const row of input.rows) {
      if (!row.key || row.key.length > 500 || row.sortKey.length > 500 || Buffer.byteLength(JSON.stringify(row.selectors ?? {})) > 4096) throw new ApiError('INTERNAL_ERROR');
      const bound: BoundProjectionValue = async value => {
        const serialized = canonicalStringify(value);
        if (Buffer.byteLength(serialized) <= 32768) return value;
        const stored = await this.value(claim, ref, row.key, Buffer.from(serialized), context, codec);
        roots.push(...stored.roots); return stored.descriptor;
      };
      let value = input.project ? await input.project(row, bound) : row.value, serialized = canonicalStringify(value);
      if (Buffer.byteLength(serialized) > CHUNK_BYTES - 4096) {
        const stored = await this.value(claim, ref, row.key, Buffer.from(serialized), context, codec);
        roots.push(...stored.roots); value = stored.descriptor as unknown as JsonValue; serialized = canonicalStringify(value);
      }
      const size = Buffer.byteLength(serialized) + 1;
      if (rows.length >= 50 || bytes + size > CHUNK_BYTES) await flush();
      values.push(value); rows.push({ row_key: row.key, sort_key: row.sortKey, rule_code: row.code ?? null, status: row.status ?? null, summary: row.selectors ?? {} }); bytes += size;
    }
    await flush();
    // Explicit dependency edges retain all staged chunks/large parts with a bounded root, without hydrating them during publication.
    let children = roots;
    do {
      const parents: CanonicalRef[] = [];
      for (let offset = 0; offset < Math.max(1, children.length); offset += 64) {
        const group = children.slice(offset, offset + 64), data = Buffer.from(canonicalStringify({ codecVersion: 1, type: 'json', value: { chunks: group } }));
        parents.push(await this.objects.putCanonical(claim, data, group, context));
      }
      children = parents;
    } while (children.length > 1);
    const manifestRef = children[0]!;
    await this.database.transaction(async tx => {
      await assertClaimAuthority(tx, claim, this.now());
      const result = await tx.query(`UPDATE projection_sets SET complete=true,finished_at=$7,row_count=$8,manifest_ref=$9
        WHERE session_id=$1 AND workspace_id=$2 AND resource_kind=$3 AND resource_id=$4 AND job_id=$5 AND attempt_id=$6 AND fence=$10 AND NOT complete RETURNING resource_id`,
      [claim.sessionId, claim.workspaceId, input.kind, indexId, claim.jobId, claim.attemptId, this.now(), rowCount, manifestRef, claim.fence]);
      if (result.rowCount !== 1) throw new ApiError('STALE_VERSION');
    });
    return { ref, manifestRef, rowCount };
  }
  private async value(claim: HostedJobClaim, index: ProjectionIndexRef, rowKey: string, bytes: Buffer, context: CanonicalWriteContext, codec: CanonicalCodec) {
    const valueId = randomUUID(), parts: { index: number; size: number; sha256: string; ref: CanonicalRef }[] = [];
    for (let offset = 0; offset < bytes.length; offset += HOSTED_VALUE_PART_BYTES) {
      const part = bytes.subarray(offset, offset + HOSTED_VALUE_PART_BYTES);
      parts.push({ index: parts.length, size: part.length, sha256: sha256(part), ref: await codec.put(claim, part.toString('base64'), context) });
    }
    const descriptor: LargeValueDescriptorDTO = { valueRef: valueId, byteLength: bytes.length, sha256: sha256(bytes), mediaType: 'application/json' };
    await this.database.transaction(async tx => {
      await assertClaimAuthority(tx, claim, this.now());
      const quota = await this.quotas.reserve(tx, { owner: claim, operationId: claim.jobId, resource: 'sql-bytes', units: parts.length * 2048 + 16384, purpose: 'public', now: this.now() });
      await tx.query(`INSERT INTO projection_values(session_id,workspace_id,id,resource_kind,resource_id,row_key,byte_length,sha256,media_type,part_count)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [claim.sessionId, claim.workspaceId, valueId, index.kind, index.indexId, rowKey, bytes.length, descriptor.sha256, descriptor.mediaType, parts.length]);
      await tx.query(`INSERT INTO projection_value_parts(session_id,workspace_id,value_id,part_index,byte_length,sha256,canonical_ref)
        SELECT $1,$2,$3,p.index,p.size,p.sha256,p.ref FROM jsonb_to_recordset($4::jsonb) p(index integer,size integer,sha256 text,ref jsonb)`,
      [claim.sessionId, claim.workspaceId, valueId, JSON.stringify(parts)]);
      await this.quotas.consume(tx, { reservationId: quota.id, now: this.now() });
    });
    return { descriptor, roots: parts.map(part => part.ref) };
  }
}
