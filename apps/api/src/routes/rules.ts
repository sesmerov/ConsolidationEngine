import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isRationalValue, uuidSchema, workspaceParamsSchema } from '@ce/contracts';
import type { RuleRowDTO } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import { variantApplicability } from '../import/eba-catalog.js';
interface Query { versionId: string; limit?: string; cursor?: string; status?: string; code?: string; table?: string }
export function registerRules(app: FastifyInstance): void {
  const secret = randomBytes(32);
  const sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  app.get<{ Params: { workspaceId: string }; Querystring: Query }>('/api/v1/workspaces/:workspaceId/rules', {
    schema: { params: workspaceParamsSchema, querystring: { type: 'object', additionalProperties: false, required: ['versionId'], properties: {
      versionId: uuidSchema, compact:{const:'true'}, limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' }, cursor: { type: 'string', maxLength: 8192 },
      status: { enum: ['error', 'unsupported', 'supported', 'applicable', 'not_applicable', 'not_evaluable', 'invalid'] }, code: { type: 'string', maxLength: 128 }, table: { type: 'string', maxLength: 128 },
    } } },
  }, async (request) => {
    if((request.query as Query&{compact?:string}).compact==='true')return app.ce.adapters.publicViews.rules(request.params.workspaceId,request.query);
    const { workspaceId } = request.params, query = request.query; const snapshot = app.ce.store.snapshot(workspaceId, query.versionId), catalog = snapshot.content.catalog;
    const fingerprint = canonicalHash({ resource: 'rules', workspaceId, versionId: query.versionId, status: query.status ?? '', code: query.code ?? '', table: query.table ?? '' });
    let after: string | undefined;
    if (query.cursor) {
      try {
        const [payload, signature, extra] = query.cursor.split('.'); if (!payload || !signature || extra) throw new Error();
        const supplied = Buffer.from(signature), expected = Buffer.from(sign(payload)); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
        const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { fingerprint?: string; after?: string };
        if (value.fingerprint !== fingerprint || typeof value.after !== 'string') throw new Error(); after = value.after;
      } catch { throw new ApiError('INVALID_CURSOR'); }
    }
    const variants = new Map(catalog.variants.map((variant) => [variant.variantId, variant])); const analyses = new Map(catalog.analyses.map((analysis) => [analysis.variantId, analysis]));
    const rows = catalog.records.map((record): RuleRowDTO => {
      const variant = record.variantId ? variants.get(record.variantId) : undefined, analysis = record.variantId ? analyses.get(record.variantId) : undefined;
      return { ...record, ...(variant ? { expression: variant.expression, ...(variant.precondition ? { precondition: variant.precondition } : {}), severity: variant.severity, active: variant.active, modules: variant.modules, tables: variant.tables,
        applicability: variantApplicability(variant, snapshot.content.contexts) } : {}), ...(analysis ? { syntaxStatus: analysis.syntaxStatus, supportStatus: analysis.supportStatus } : {}) };
    }).filter((row) => (!query.code || row.code.toLowerCase().includes(query.code.toLowerCase())) && (!query.table || row.tables?.includes(query.table))
      && (!query.status || row.syntaxStatus === query.status || row.supportStatus === query.status || row.applicability === query.status || (query.status === 'invalid' && row.diagnostics.some((diagnostic) => diagnostic.severity === 'error'))));
    const key = (row: RuleRowDTO) => JSON.stringify([row.code, row.variantId ?? '', row.sourceLocator.fileId ?? '', row.sourceLocator.row ?? 0, row.id]);
    rows.sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
    if (after !== undefined && !rows.some((row) => key(row) === after)) throw new ApiError('INVALID_CURSOR');
    const remaining = after === undefined ? rows : rows.filter((row) => key(row) > after!); const items = remaining.slice(0, Number(query.limit ?? 50));
    let nextCursor: string | null = null;
    if (remaining.length > items.length) { const payload = Buffer.from(JSON.stringify({ fingerprint, after: key(items.at(-1)!) })).toString('base64url'); nextCursor = payload + '.' + sign(payload); }
    return { items, total: rows.length, nextCursor, versionId: query.versionId, coverage: catalog.coverage, sources: snapshot.content.sources,
      dataSummary: { explicitNulls: snapshot.content.facts.filter((fact) => fact.presence === 'null').length,
        implicitNulls: snapshot.content.coordinates.length - snapshot.content.facts.length,
        zeroValues: snapshot.content.facts.filter((fact) => isRationalValue(fact.normalizedValue) && fact.normalizedValue.numerator === '0').length } };
  });
}
