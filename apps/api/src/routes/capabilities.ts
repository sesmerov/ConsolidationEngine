import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, JOB_DEADLINE_MS, MAX_SNAPSHOTS, SESSION_LIMIT_BYTES } from '@ce/contracts';
import { ENGINE_PROFILE_ID, PARSER_LIMITS } from '@ce/engine';
import { UPLOAD_LIMITS } from '../import/multipart-staging.js';
import { GRAMMAR_VERSION } from '../import/import-workspace.js';
import { reportTemplate } from '../export/report-template.js';
export function registerCapabilities(app: FastifyInstance): void {
  app.get('/api/v1/capabilities', { schema: { querystring: emptyQuerySchema } }, async () => ({ profileId: ENGINE_PROFILE_ID, grammarVersion: GRAMMAR_VERSION,
    support: ['Referencias a celdas de tablas cerradas', 'Ámbitos with, rangos y hojas finitas', 'Indicadores de presentación explícitos', 'Aritmética y comparaciones', 'and, or, not, isnull, nvl y sum'],
    knownDifferences: ['El perfil local usa racionales exactos e intervalos cerrados conservadores, y puede dar resultados distintos de las fórmulas de intervalos del documento EBA.', 'Una regla importada y soportada aún no ha sido evaluada. El soporte de este perfil no implica conformidad completa con DPM-XL.'],
    limits: { ...UPLOAD_LIMITS, jobDeadlineMs: JOB_DEADLINE_MS, sessionBytes: SESSION_LIMIT_BYTES, maxSnapshots: MAX_SNAPSHOTS, maxRules: 500, maxFacts: 100_000, maxCoordinates: 100_000,
      expandedBatchBytes: 100 * 1024 * 1024, entryBytes: 64 * 1024 * 1024, ...PARSER_LIMITS } }));
  app.get('/api/v1/templates/report', { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="ce-report-1.xlsx"').send(await reportTemplate()));
}
