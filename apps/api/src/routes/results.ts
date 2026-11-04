import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { uuidSchema, validationResultsPageSchema } from '@ce/contracts';
import type { Coordinate, NormalizedValue, Rational, RuleResultDTO, SourceLocator, ValidationValueDTO } from '@ce/contracts';
import { getRecalculationPolicy, resultOrderKey, WorkBudget } from '@ce/engine';
import { ApiError } from '../errors.js';
import { canonicalHash } from '../session/canonical-state.js';
import { getValidation } from '../validation/validation-service.js';
import { directionEligibility } from '../recalculation/directions-service.js';
interface Query { limit?: string; cursor?: string; status?: string; code?: string; table?: string }
function locator(value: SourceLocator): SourceLocator {
  return Object.fromEntries(['fileId', 'sheet', 'row', 'column', 'ruleCode'].flatMap(key => {
    const field = value[key as keyof SourceLocator]; return field === undefined ? [] : [[key, field]];
  }));
}
function coordinate(value: Coordinate): Coordinate {
  return { factKey: value.factKey, contextId: value.contextId, tableCode: value.tableCode, sheetCode: value.sheetCode,
    rowCode: value.rowCode, columnCode: value.columnCode, dataType: value.dataType, unit: value.unit, decimals: value.decimals,
    axes: value.axes, sourceLocator: locator(value.sourceLocator) };
}
const rational = (value: Rational): Rational => ({ numerator: value.numerator, denominator: value.denominator });
function normalized(value: NormalizedValue): NormalizedValue {
  if (typeof value === 'boolean') return value;
  return 'kind' in value ? { kind: value.kind, value: value.value } : rational(value);
}
/** Project union members before serializer branch selection; unknown internal fields are never wire fields. */
function effectiveValue(value: ValidationValueDTO): ValidationValueDTO {
  const trace = { ...(value.coordinate ? { coordinate: coordinate(value.coordinate) } : {}), ...(value.sourceLocator ? { sourceLocator: locator(value.sourceLocator) } : {}) };
  switch (value.kind) {
    case 'number': return { kind: 'number', nominal: rational(value.nominal), interval: { lo: rational(value.interval.lo), hi: rational(value.interval.hi) }, unit: value.unit, ...trace };
    case 'boolean': return { kind: 'boolean', value: value.value, ...trace };
    case 'text': return { kind: 'text', value: value.value, ...trace };
    case 'date': return { kind: 'date', value: value.value, ...trace };
    case 'null': return { kind: 'null', presence: value.presence, dataType: value.dataType, ...(value.unit === undefined ? {} : { unit: value.unit }), ...trace };
    case 'unknown': return { kind: 'unknown', presence: 'unknown', ...trace };
  }
}
function resultValues(row: RuleResultDTO): RuleResultDTO {
  return { ...row,
    ...(row.preconditionResult ? { preconditionResult: effectiveValue(row.preconditionResult) } : {}),
    values: { ...(row.values.left ? { left: effectiveValue(row.values.left) } : {}), ...(row.values.right ? { right: effectiveValue(row.values.right) } : {}),
      ...(row.values.result ? { result: effectiveValue(row.values.result) } : {}) },
    factReads: row.factReads.map(read => ({ ...read, ...(read.normalizedValue === undefined ? {} : { normalizedValue: normalized(read.normalizedValue) }) })),
  };
}
export function registerResults(app: FastifyInstance): void {
  const secret = randomBytes(32), sign = (payload: string) => createHmac('sha256', secret).update(payload).digest('base64url');
  app.get<{ Params: { workspaceId: string; runId: string }; Querystring: Query }>('/api/v1/workspaces/:workspaceId/runs/:runId/results', {
    schema: { params: { type: 'object', additionalProperties: false, required: ['workspaceId', 'runId'], properties: { workspaceId: uuidSchema, runId: uuidSchema } },
      querystring: { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^(?:[1-9]|[1-9][0-9]|1[0-9]{2}|200)$' }, cursor: { type: 'string', maxLength: 8192 },
        status: { enum: ['pass', 'fail', 'not_applicable', 'not_evaluable', 'error'] }, code: { type: 'string', maxLength: 128 }, table: { type: 'string', maxLength: 128 } } },
      response: { 200: validationResultsPageSchema } },
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
    const key = resultOrderKey;
    const rows = bundle.results.filter((row) => (!query.status || row.status === query.status) && (!query.code || row.code.toLowerCase().includes(query.code.toLowerCase())) && (!query.table || row.tables.includes(query.table)))
      .map((row) => ({ row, key: key(row) })).sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
    if (after !== undefined && !rows.some((entry) => entry.key === after)) throw new ApiError('INVALID_CURSOR');
    const remaining = after === undefined ? rows : rows.filter((entry) => entry.key > after!); const entries = remaining.slice(0, Number(query.limit ?? 50));
    let nextCursor: string | null = null;
    if (remaining.length > entries.length) { const payload = Buffer.from(JSON.stringify({ fingerprint, after: entries.at(-1)!.key })).toString('base64url'); nextCursor = payload + '.' + sign(payload); }
    const snapshot = app.ce.store.snapshot(workspaceId, bundle.run.versionId), budget = new WorkBudget();
    const items = entries.map(entry => {
      const row = resultValues(entry.row);
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
      configuredDirections: snapshot.content.directions.map(({ instanceId, targetSide }) => ({ instanceId, targetSide })) };
  });
}
