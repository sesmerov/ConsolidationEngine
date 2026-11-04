import type { FastifyInstance } from 'fastify';
import { emptyQuerySchema, JOB_DEADLINE_MS, MAX_SNAPSHOTS, SESSION_LIMIT_BYTES } from '@ce/contracts';
import { ENGINE_PROFILE_ID, PARSER_LIMITS } from '@ce/engine';
import { UPLOAD_LIMITS } from '../import/multipart-staging.js';
import { GRAMMAR_VERSION } from '../import/import-workspace.js';
import { reportTemplate } from '../export/report-template.js';
import { guidedExample } from '../export/guided-example.js';
import { visualDemo } from '../export/visual-demos.js';
import { EXPORT_LIMITS } from '../export/results-export.js';
import { FILE_SESSION_LIMIT } from '../storage/session-files.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApiError } from '../errors.js';
export function registerCapabilities(app: FastifyInstance): void {
  app.get('/api/v1/capabilities', { schema: { querystring: emptyQuerySchema } }, async () => ({ profileId: ENGINE_PROFILE_ID, grammarVersion: GRAMMAR_VERSION,
    languageProfiles: [
      { id: 'ce-dpmxl-0.9-closed-v1', support: ['number', 'boolean'], recalculationPolicy: 'Igualdades numéricas y booleanas elegibles.' },
      { id: 'ce-dpmxl-0.9-closed-v2', support: ['number', 'boolean', 'text', 'date', 'if'], recalculationPolicy: 'Solo igualdades numéricas elegibles. Las reglas con texto, fechas o condicionales solo admiten validación.' },
    ], reportProfiles: [{ id: 'ce-report-1', name: 'Formato avanzado de coordenadas', moduleVersion: 'declarado en el libro', supportedTables: [], languageProfileId: 'ce-dpmxl-0.9-closed-v1', forms: ['ce-report-1'], contextFields: ['workbook'] },
      { id: 'eba-corep-of-4.0-ca1-v1', name: 'COREP 4.0 · Fondos propios CA1', moduleVersion: 'COREP_OF_4.0', supportedTables: ['C_01.00'], languageProfileId: 'ce-dpmxl-0.9-closed-v2', forms: ['official-full', 'CA1-extract'], contextFields: ['entityId', 'referenceDate', 'submissionDate', 'currency', 'scaleExponent', 'displayDecimals', 'filingIndicators'] },
      { id: 'ce-demo-types-1', name: 'Demostración sintética de texto y fechas', moduleVersion: 'DEMO_TYPES_1', supportedTables: ['DEMO_TYPES'], languageProfileId: 'ce-dpmxl-0.9-closed-v2', forms: ['ce-demo-types-1'], contextFields: ['entityId', 'referenceDate', 'submissionDate', 'filingIndicators'] }],
    importInspection: { ttlSeconds: 900, maxActive: 1 },
    support: ['Referencias a celdas de tablas cerradas', 'Ámbitos with, rangos y hojas finitas', 'Indicadores de presentación explícitos', 'Aritmética y comparaciones', 'and, or, not, isnull, nvl y sum'],
    knownDifferences: ['El perfil local usa racionales exactos e intervalos cerrados conservadores, y puede dar resultados distintos de las fórmulas de intervalos del documento EBA.', 'La cobertura de carga describe sintaxis y soporte; el cumplimiento se consulta en los resultados de validación. Este perfil no implica conformidad completa con DPM-XL.', 'Las vistas results.xlsx y changes.xlsx tienen un límite de 64 MiB en la estimación conservadora de carga XML. Los informes ce-report-1 se escriben de forma incremental y comprueban tamaños reales: 10 MiB por informe, 50 MiB comprimidos y 100 MiB expandidos por lote, incluido el catálogo original.'],
    limits: { ...UPLOAD_LIMITS, jobDeadlineMs: JOB_DEADLINE_MS, sessionBytes: SESSION_LIMIT_BYTES, maxSnapshots: MAX_SNAPSHOTS, maxRules: 500, maxFacts: 100_000, maxCoordinates: 100_000,
      expandedBatchBytes: 100 * 1024 * 1024, entryBytes: 64 * 1024 * 1024, exportContentBytes: EXPORT_LIMITS.maxContentBytes, exportTotalBytes: EXPORT_LIMITS.maxTotalBytes, exportXmlWorkloadBytes: EXPORT_LIMITS.maxContentBytes, fileSessionBytes: FILE_SESSION_LIMIT, ...PARSER_LIMITS } }));
  app.get('/api/v1/templates/report', { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="ce-report-1.xlsx"').send(await reportTemplate()));
  app.get('/api/v1/templates/corep-ca1', { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => {
    const directory = new URL(import.meta.url.endsWith('.ts') ? '../../../../assets/templates/' : '../assets/templates/', import.meta.url);
    const manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as { profiles?: { profileId: string; file: string; sha256: string; size: number }[] };
    const entry = manifest.profiles?.find(profile => profile.profileId === 'eba-corep-of-4.0-ca1-v1');
    if (!entry || entry.file !== 'corep-ca1.xlsx') throw new ApiError('INTERNAL_ERROR');
    const bytes = await readFile(new URL('corep-ca1.xlsx', directory));
    if (bytes.length !== entry.size || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new ApiError('INTERNAL_ERROR');
    return reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="corep-ca1.xlsx"').send(bytes);
  });
  for (const kind of ['catalog', 'report'] as const) app.get('/api/v1/templates/guided-' + kind, { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', 'attachment; filename="' + (kind === 'catalog' ? 'ejemplo-catalogo.xlsx' : 'ejemplo-informe.xlsx') + '"').send(await guidedExample(kind)));
  for (const demo of ['corep', 'types'] as const) for (const kind of ['catalog', 'report'] as const) app.get(`/api/v1/templates/demos/${demo}/${kind}`, { schema: { querystring: emptyQuerySchema } }, async (_request, reply) => reply
    .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="demo-${demo}-${kind}.xlsx"`).send(await visualDemo(demo, kind)));
}
