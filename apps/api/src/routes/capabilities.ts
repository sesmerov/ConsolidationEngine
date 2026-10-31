import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, JOB_DEADLINE_MS, MAX_SNAPSHOTS, SESSION_LIMIT_BYTES } from '@ce/contracts';
import { ENGINE_PROFILE_ID, PARSER_LIMITS } from '@ce/engine';
import { UPLOAD_LIMITS } from '../import/multipart-staging.js';
import { GRAMMAR_VERSION } from '../import/import-workspace.js';
import { reportTemplate } from '../export/report-template.js';
import { guidedExample } from '../export/guided-example.js';
import { EXPORT_LIMITS } from '../export/results-export.js';
import { FILE_SESSION_LIMIT } from '../storage/session-files.js';
export function registerCapabilities(app: FastifyInstance): void {
  app.get('/api/v1/capabilities', { schema: { querystring: emptyQuerySchema } }, async () => ({ profileId: ENGINE_PROFILE_ID, grammarVersion: GRAMMAR_VERSION,
    support: ['Referencias a celdas de tablas cerradas', 'Ámbitos with, rangos y hojas finitas', 'Indicadores de presentación explícitos', 'Aritmética y comparaciones', 'and, or, not, isnull, nvl y sum'],
    knownDifferences: ['El perfil local usa racionales exactos e intervalos cerrados conservadores, y puede dar resultados distintos de las fórmulas de intervalos del documento EBA.', 'La cobertura de carga describe sintaxis y soporte; el cumplimiento se consulta en los resultados de validación. Este perfil no implica conformidad completa con DPM-XL.', 'Las vistas results.xlsx y changes.xlsx tienen un límite de 64 MiB en la estimación conservadora de carga XML. Los informes ce-report-1 se escriben de forma incremental y comprueban tamaños reales: 10 MiB por informe, 50 MiB comprimidos y 100 MiB expandidos por lote, incluido el catálogo original.'],
    limits: { ...UPLOAD_LIMITS, jobDeadlineMs: JOB_DEADLINE_MS, sessionBytes: SESSION_LIMIT_BYTES, maxSnapshots: MAX_SNAPSHOTS, maxRules: 500, maxFacts: 100_000, maxCoordinates: 100_000,
      expandedBatchBytes: 100 * 1024 * 1024, entryBytes: 64 * 1024 * 1024, exportContentBytes: EXPORT_LIMITS.maxContentBytes, exportTotalBytes: EXPORT_LIMITS.maxTotalBytes, exportXmlWorkloadBytes: EXPORT_LIMITS.maxContentBytes, fileSessionBytes: FILE_SESSION_LIMIT, ...PARSER_LIMITS } }));
  app.get('/api/v1/templates/report', { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="ce-report-1.xlsx"').send(await reportTemplate()));
  for (const kind of ['catalog', 'report'] as const) app.get('/api/v1/templates/guided-' + kind, { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="' + (kind === 'catalog' ? 'ejemplo-catalogo.xlsx' : 'ejemplo-informe.xlsx') + '"').send(await guidedExample(kind)));
}
