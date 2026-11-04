import { isCivilDateV2 } from '@ce/contracts';
import { DEMO_TYPES_MAPPING, DEMO_TYPES_MAPPING_SHA256, DEMO_TYPES_PROFILE_ID } from '../import/profiles/demo-types.js';
import { writeIncrementalParts } from './bounded-files.js';
import type { WrittenFile } from './bounded-files.js';
import type { ReportExportData } from './recalculated-report.js';
import { visualTemplateParts } from './visual-template.js';
import { assertVisualCoordinate, instructionsSheet, invalidVisualReport, literalCell, replaceVisualCell, visualFacts, visualPartitionContext } from './visual-report-shared.js';
import type { VisualReportPartition } from './visual-report-shared.js';

export async function writeTypedReport(location: string, partition: VisualReportPartition, info: Pick<ReportExportData, 'versionId' | 'profileId' | 'synthetic'>, maximum: number,
  budget: { expandedBytes: number }, maxExpandedBytes: number, check: () => void): Promise<WrittenFile & { expandedBytes: number }> {
  const context = visualPartitionContext(partition, { profileId: DEMO_TYPES_PROFILE_ID, mappingSha256: DEMO_TYPES_MAPPING_SHA256, contextId: 'demo_types', framework: 'DEMO', moduleVersion: 'DEMO_TYPES_1', tableCode: 'DEMO_TYPES', selectedSheet: 'Datos' }, check);
  if (info.profileId !== 'ce-dpmxl-0.9-closed-v2' || partition.binding.scaleExponent !== undefined || partition.binding.displayDecimals !== undefined || partition.binding.excludedSheets.length
    || partition.coordinates.length !== 6 || partition.facts.length !== 6) return invalidVisualReport();
  const byRow = new Map(partition.coordinates.map(coordinate => [coordinate.rowCode, coordinate])), coordinates = new Map(partition.coordinates.map(coordinate => [coordinate.factKey, coordinate]));
  if (byRow.size !== 6 || coordinates.size !== 6) return invalidVisualReport();
  for (const field of DEMO_TYPES_MAPPING.fields) { check(); const coordinate = byRow.get(field.rowCode); if (!coordinate) return invalidVisualReport(); assertVisualCoordinate(coordinate, context, partition.sourceFileId, { tableCode: 'DEMO_TYPES', rowCode: field.rowCode, columnCode: '0010', dataType: field.type, unit: '', decimals: '' }); }
  const facts = visualFacts(partition, coordinates, check), parts = await visualTemplateParts(DEMO_TYPES_PROFILE_ID, check);
  let dataSheet = parts.get('xl/worksheets/sheet2.xml')!.toString('utf8');
  for (const field of DEMO_TYPES_MAPPING.fields) {
    check(); const coordinate = byRow.get(field.rowCode)!, fact = facts.get(coordinate.factKey); if (!fact) return invalidVisualReport();
    let value = '', state = 'Sin dato';
    if (fact.presence === 'value') {
      const normalized = fact.normalizedValue;
      if (!normalized || typeof normalized !== 'object' || !('kind' in normalized) || normalized.kind !== field.type || typeof normalized.value !== 'string'
        || field.type === 'date' && !isCivilDateV2(normalized.value)) return invalidVisualReport();
      value = normalized.value; state = 'Informado';
    }
    dataSheet = replaceVisualCell(dataSheet, field.valueCell, literalCell(field.valueCell, value));
    dataSheet = replaceVisualCell(dataSheet, field.stateCell, literalCell(field.stateCell, state));
  }
  parts.set('xl/worksheets/sheet2.xml', Buffer.from(dataSheet));
  let contextSheet = parts.get('xl/worksheets/sheet3.xml')!.toString('utf8');
  const values = [context.entityId, context.referenceDate, context.submissionDate ?? '', 'DEMO', 'DEMO_TYPES_1', DEMO_TYPES_PROFILE_ID, context.filingIndicators.DEMO_TYPES ? 'Sí' : 'No'];
  for (const [index, value] of values.entries()) { check(); const address = 'B' + (index + 4); contextSheet = replaceVisualCell(contextSheet, address, literalCell(address, value)); }
  parts.set('xl/worksheets/sheet3.xml', Buffer.from(contextSheet));
  parts.set('xl/worksheets/sheet1.xml', instructionsSheet([
    DEMO_TYPES_MAPPING.instructionsTitle, DEMO_TYPES_PROFILE_ID, 'Libro propio de trabajo; no es una plantilla EBA ni un fichero oficial de remisión.',
    'Versión seleccionada: ' + info.versionId, 'Entidad: ' + context.entityId + ' · Referencia: ' + context.referenceDate,
    'Los textos se conservan literalmente, con mayúsculas, espacios y caracteres originales; no se ejecutan como fórmulas.',
    'Informado con valor vacío es una cadena vacía. Sin dato con valor vacío es un nulo explícito.',
    'Las fechas civiles se escriben en formato AAAA-MM-DD, sin hora ni zona horaria.',
    'Las reglas de texto, fechas y condicionales solo validan; no ofrecen recálculos.',
    'Confirma la hoja Contexto al reimportar. Se conservan los datos, pero se crean nuevas fuentes y no se restaura el historial.',
    ...(info.synthetic ? ['Datos sintéticos de demostración.'] : []),
  ]));
  return writeIncrementalParts(location, [...parts].map(([name, bytes]) => ({ name, chunks: [bytes] })), maximum, budget, maxExpandedBytes, check);
}
