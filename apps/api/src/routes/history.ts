import type { FastifyInstance } from 'fastify';
import { workspaceParamsSchema } from '@ce/contracts';
import type { PreviewBundle, PreviewSummaryDTO, RunSummaryDTO, ValidationBundle } from '@ce/contracts';
import { canonicalHash } from '../session/canonical-state.js';
import { createPager, paginationProperties } from './pagination.js';
export function registerHistory(app: FastifyInstance): void {
  const page = createPager();
  for (const resource of ['runs', 'previews'] as const) app.get<{ Params: { workspaceId: string }; Querystring: { status?: string; limit?: string; cursor?: string } }>('/api/v1/workspaces/:workspaceId/' + resource, {
    schema: { params: workspaceParamsSchema, querystring: { type: 'object', additionalProperties: false, properties: { ...paginationProperties, status: { enum: resource === 'runs' ? ['running', 'completed', 'incomplete'] : ['ready', 'applied', 'discarded', 'obsolete'] } } } },
  }, async request => {
    const { workspaceId } = request.params, query = request.query; app.ce.store.get(workspaceId);
    const rows: (RunSummaryDTO | PreviewSummaryDTO)[] = resource === 'runs'
      ? app.ce.store.listRecords<ValidationBundle>('validation:' + workspaceId + ':').map(({ value: { run } }) => ({ id: run.id, versionId: run.versionId, ...(run.validationBasisId ? { validationBasisId: run.validationBasisId } : {}), profileId: run.profileId, status: run.status, startedAt: run.startedAt, ...(run.endedAt ? { endedAt: run.endedAt } : {}) }))
      : app.ce.store.listRecords<PreviewBundle>('preview:' + workspaceId + ':').map(({ value: { preview } }) => ({ id: preview.id, baseVersionId: preview.baseVersionId, profileId: preview.profileId, policyId: preview.policyId, state: preview.state, createdAt: preview.createdAt }));
    const key = (row: RunSummaryDTO | PreviewSummaryDTO) => ('startedAt' in row ? row.startedAt : row.createdAt) + ':' + row.id;
    rows.sort((a, b) => key(a) < key(b) ? 1 : key(a) > key(b) ? -1 : 0); const revision = canonicalHash(rows);
    const filtered = rows.filter(row => !query.status || ('status' in row ? row.status : row.state) === query.status);
    return { ...page(filtered, key, canonicalHash({ resource, workspaceId, revision, status: query.status ?? '' }), Number(query.limit ?? 50), query.cursor), revision };
  });
}
