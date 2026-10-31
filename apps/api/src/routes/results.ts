import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { uuidSchema } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash, canonicalStringify } from '../session/canonical-state.js';
import { getValidation } from '../validation/validation-service.js';
interface Query { limit?: string; cursor?: string; status?: string; code?: string; table?: string }
export function registerResults(app: FastifyInstance): void {
  const secret = randomBytes(32), sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  app.get<{ Params: { workspaceId: string; runId: string }; Querystring: Query }>('/api/v1/workspaces/:workspaceId/runs/:runId/results', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['workspaceId', 'runId'], properties: { workspaceId: uuidSchema, runId: uuidSchema } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' }, cursor: { type: 'string', maxLength: 8192 },
        status: { enum: ['pass', 'fail', 'not_applicable', 'not_evaluable', 'error'] }, code: { type: 'string', maxLength: 128 }, table: { type: 'string', maxLength: 128 } } } },
  }, async (request) => {
    const { workspaceId, runId } = request.params, query = request.query, bundle = getValidation(app.ce.store, workspaceId, runId);
    const fingerprint = canonicalHash({ resource: 'results', workspaceId, runId, versionId: bundle.run.versionId, status: query.status ?? '', code: query.code ?? '', table: query.table ?? '' });
    let after: string | undefined;
    if (query.cursor) try {
      const [payload, signature, extra] = query.cursor.split('.'); if (!payload || !signature || extra) throw new Error();
      const supplied = Buffer.from(signature), expected = Buffer.from(sign(payload)); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { fingerprint?: string; after?: string };
      if (value.fingerprint !== fingerprint || typeof value.after !== 'string') throw new Error(); after = value.after;
    } catch { throw new ApiError('INVALID_CURSOR'); }
    const key = (row: (typeof bundle.results)[number]) => canonicalStringify([row.code, row.variantIds, row.binding ?? null, row.id]);
    const rows = bundle.results.filter((row) => (!query.status || row.status === query.status) && (!query.code || row.code.toLowerCase().includes(query.code.toLowerCase())) && (!query.table || row.tables.includes(query.table)))
      .map((row) => ({ row, key: key(row) })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    if (after !== undefined && !rows.some((entry) => entry.key === after)) throw new ApiError('INVALID_CURSOR');
    const remaining = after === undefined ? rows : rows.filter((entry) => entry.key > after!); const entries = remaining.slice(0, Number(query.limit ?? 50));
    let nextCursor: string | null = null;
    if (remaining.length > entries.length) { const payload = Buffer.from(JSON.stringify({ fingerprint, after: entries.at(-1)!.key })).toString('base64url'); nextCursor = payload + '.' + sign(payload); }
    return { items: entries.map((entry) => entry.row), total: rows.length, nextCursor, versionId: bundle.run.versionId, run: bundle.run, sourceFiles: app.ce.store.snapshot(workspaceId, bundle.run.versionId).content.sources };
  });
}
