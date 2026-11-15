import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { uuidSchema, validationResultsPageSchema, validationResultsQuerySchema, compactResultsQuerySchema, compactResultsPageSchema } from '@ce/contracts';
import { registerLocalPublicViews } from './public-views.js';
import type { ValidationResultsQueryDTO } from '@ce/contracts';
import { getRecalculationPolicy, resultOrderKey, WorkBudget } from '@ce/engine';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import { getValidation } from '../validation/validation-service.js';
import { directionEligibility } from '../recalculation/directions-service.js';
import { publicResult } from '../presentation/public-values.js';
import { rulePresentation } from '../presentation/rule-presentation.js';
export function registerResults(app: FastifyInstance): void {
  const views=app.ce.adapters.publicViews;registerLocalPublicViews(app,views);
  const secret = randomBytes(32), sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  app.get<{ Params: { workspaceId: string; runId: string }; Querystring: ValidationResultsQueryDTO & {compact?:string} }>('/api/v1/workspaces/:workspaceId/runs/:runId/results', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['workspaceId', 'runId'], properties: { workspaceId: uuidSchema, runId: uuidSchema } },
      querystring: {anyOf:[validationResultsQuerySchema,compactResultsQuerySchema]},
      response: { 200: {anyOf:[validationResultsPageSchema,compactResultsPageSchema]} } },
  }, async (request, reply) => {
    const { workspaceId, runId } = request.params, query = request.query, bundle = getValidation(app.ce.store, workspaceId, runId);
    if(query.compact==='true')return views.results(workspaceId,runId,query);
    // Select the closed legacy serializer before union matching to strip private fields.
    reply.serializer(reply.compileSerializationSchema(validationResultsPageSchema));
    const fingerprint = canonicalHash({ resource: 'results', workspaceId, runId, versionId: bundle.run.versionId, status: query.status ?? '', code: query.code ?? '', table: query.table ?? '' });
    let after: string | undefined;
    if (query.cursor) try {
      const [payload, signature, extra] = query.cursor.split('.'); if (!payload || !signature || extra) throw new Error();
      const supplied = Buffer.from(signature), expected = Buffer.from(sign(payload)); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
      const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { fingerprint?: string; after?: string };
      if (value.fingerprint !== fingerprint || typeof value.after !== 'string') throw new Error(); after = value.after;
    } catch { throw new ApiError('INVALID_CURSOR'); }
    const key = resultOrderKey;
    const rows = bundle.results.filter((row) => (!query.status || row.status === query.status) && (!query.code || row.code.toLowerCase().includes(query.code.toLowerCase())) && (!query.table || row.tables.includes(query.table)))
      .map((row) => ({ row, key: key(row) })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    if (after !== undefined && !rows.some((entry) => entry.key === after)) throw new ApiError('INVALID_CURSOR');
    const remaining = after === undefined ? rows : rows.filter((entry) => entry.key > after!); const entries = remaining.slice(0, Number(query.limit ?? 50));
    let nextCursor: string | null = null;
    if (remaining.length > entries.length) { const payload = Buffer.from(JSON.stringify({ fingerprint, after: entries.at(-1)!.key })).toString('base64url'); nextCursor = payload + '.' + sign(payload); }
    const snapshot = app.ce.store.snapshot(workspaceId, bundle.run.versionId), budget = new WorkBudget(), present = rulePresentation(snapshot.content);
    const items = entries.map(entry => {
      const { presentation: _storedPresentation, ...result } = publicResult(entry.row), presentation = present(result.variantIds, result.values.left?.coordinate ?? result.values.right?.coordinate ?? result.factReads[0]?.coordinate);
      const row = { ...result, ...(presentation ? { presentation } : {}) };
      const classified = getRecalculationPolicy(snapshot, { variantIds: row.variantIds,
        ...(row.binding ? { binding: row.binding } : {}), ...(row.instanceId ? { instanceId: row.instanceId } : {}),
      }, { budget });
      if (classified.policy.mode !== 'standard') {
        const unavailable = { eligible: false, diagnostics: classified.diagnostics };
        return { ...row, recalculation: { policy: classified.policy, left: unavailable, right: unavailable } };
      }
      const left = directionEligibility(snapshot, row, 'left', budget), right = directionEligibility(snapshot, row, 'right', budget);
      const unfinished = [...left.diagnostics, ...right.diagnostics].filter(issue => ['RESOURCE_LIMIT', 'CANCELLED', 'DEADLINE_EXCEEDED'].includes(issue.code));
      if (unfinished.length) {
        const unavailable = { eligible: false, diagnostics: unfinished };
        return { ...row, recalculation: { policy: { profileId: snapshot.content.profileId, mode: 'undetermined' as const, reasons: [] }, left: unavailable, right: unavailable } };
      }
      return { ...row, recalculation: { policy: classified.policy, left, right } };
    });
    return { items, total: rows.length, nextCursor, versionId: bundle.run.versionId, run: bundle.run, sourceFiles: snapshot.content.sources,
      ...(query.includeConfiguredDirections === 'false' ? {} : {
        configuredDirections: snapshot.content.directions.map(({ instanceId, targetSide }) => ({ instanceId, targetSide })) }) };
  });
}
