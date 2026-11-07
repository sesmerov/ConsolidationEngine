import { isRationalValue } from '@ce/contracts';
import { ApiError } from '../errors.js';
import { COREP_MAPPING, COREP_MAPPING_SHA256, COREP_PROFILE_ID } from '../import/profiles/corep-ca1.js';
import { writeIncrementalParts } from './bounded-files.js';
import type { WrittenFile } from './bounded-files.js';
import type { ReportExportData } from './recalculated-report.js';
import { visualTemplateParts } from './visual-template.js';
import { assertVisualCoordinate, instructionsSheet, invalidVisualReport, literalCell, replaceVisualCell, serializeWorkbookAmount, visualCellStyle, visualFacts, visualPartitionContext } from './visual-report-shared.js';
import type { VisualReportPartition } from './visual-report-shared.js';

/** Preserve every template style attribute while adding right alignment for exact decimal text. */
export function rightAlignedStyles(styles: string) {
  const section = /<cellXfs\b([^>]*)>([\s\S]*?)<\/cellXfs>/.exec(styles); if (!section) throw new ApiError('INTERNAL_ERROR');
  const xfs = section[2]!.match(/<xf\b(?:[^>]*\/>|[^>]*>[\s\S]*?<\/xf>)/g) ?? [], declared = /\bcount="([0-9]+)"/.exec(section[1]!);
  if (!declared || Number(declared[1]) !== xfs.length) throw new ApiError('INTERNAL_ERROR');
  const added: string[] = [], indices = new Map<string, string>();
  return {
    style(original = '0'): string {
      const prior = indices.get(original); if (prior !== undefined) return prior;
      let xf = xfs[Number(original)]; if (!xf) throw new ApiError('INTERNAL_ERROR');
      if (xf.endsWith('/>')) xf = xf.slice(0, -2) + '></xf>';
      xf = xf.replace(/^<xf\b([^>]*)>/, (_match, attributes: string) => '<xf' + (/\bapplyAlignment="/.test(attributes) ? attributes.replace(/\bapplyAlignment="[^"]*"/, 'applyAlignment="1"') : attributes + ' applyAlignment="1"') + '>');
      if (/<alignment\b/.test(xf)) xf = xf.replace(/<alignment\b([^>]*)>/, (_match, attributes: string) => '<alignment' + (/\bhorizontal="/.test(attributes) ? attributes.replace(/\bhorizontal="[^"]*"/, 'horizontal="right"') : ' horizontal="right"' + attributes) + '>');
      else xf = xf.replace('</xf>', '<alignment horizontal="right"/></xf>');
      const index = String(xfs.length + added.length); added.push(xf); indices.set(original, index); return index;
    },
    xml(): string { return added.length ? styles.replace(section[0], '<cellXfs' + section[1]!.replace(/\bcount="[0-9]+"/, `count="${xfs.length + added.length}"`) + '>' + section[2] + added.join('') + '</cellXfs>') : styles; },
  };
}
export async function writeCorepReport(location: string, partition: VisualReportPartition, info: Pick<ReportExportData, 'versionId' | 'profileId' | 'synthetic'>, maximum: number,
  budget: { expandedBytes: number }, maxExpandedBytes: number, check: () => void): Promise<WrittenFile & { expandedBytes: number }> {
  const context = visualPartitionContext(partition, { profileId: COREP_PROFILE_ID, mappingSha256: COREP_MAPPING_SHA256, contextId: 'corep', framework: 'COREP', moduleVersion: 'COREP_OF_4.0', tableCode: 'C_01.00', selectedSheet: 'CA1' }, check);
  const binding = partition.binding, scale = binding.scaleExponent, precision = binding.displayDecimals, unit = partition.coordinates[0]?.unit;
  const excluded = binding.excludedSheets, officialExcluded = COREP_MAPPING.expectedFullWorkbookSheetNames.filter(name => name !== 'CA1');
  if (info.profileId !== 'ce-dpmxl-0.9-closed-v2' || ![0, 3, 6].includes(scale as number) || precision !== 'INF' && (!Number.isInteger(precision) || precision! < -18 || precision! > 18)
    || typeof unit !== 'string' || !/^[A-Z]{3}$/.test(unit) || partition.coordinates.length !== 110 || new Set(excluded).size !== excluded.length
    || excluded.length !== 0 && (excluded.length !== officialExcluded.length || excluded.some(name => !officialExcluded.includes(name)))) return invalidVisualReport();
  const decimals = precision === 'INF' ? 'INF' : String(precision! - scale!);
  if (decimals !== 'INF' && (Number(decimals) < -18 || Number(decimals) > 18)) return invalidVisualReport();
  const byRow = new Map(partition.coordinates.map(coordinate => [coordinate.rowCode, coordinate])); if (byRow.size !== 110) return invalidVisualReport();
  const coordinates = new Map(partition.coordinates.map(coordinate => [coordinate.factKey, coordinate])); if (coordinates.size !== 110) return invalidVisualReport();
  for (const mapping of COREP_MAPPING.mapping) { check(); const coordinate = byRow.get(mapping.rowCode); if (!coordinate) return invalidVisualReport(); assertVisualCoordinate(coordinate, context, partition.sourceFileId, { tableCode: mapping.tableCode, rowCode: mapping.rowCode, columnCode: mapping.columnCode, dataType: 'number', unit, decimals }); }
  const facts = visualFacts(partition, coordinates, check);
  const parts = await visualTemplateParts(COREP_PROFILE_ID, check), styles = rightAlignedStyles(parts.get('xl/styles.xml')!.toString('utf8'));
  let sheet = parts.get('xl/worksheets/sheet1.xml')!.toString('utf8'), textAmounts = 0;
  for (const mapping of COREP_MAPPING.mapping) {
    check(); const coordinate = byRow.get(mapping.rowCode)!, fact = facts.get(coordinate.factKey), originalStyle = visualCellStyle(sheet, mapping.amountCell);
    let cell: string;
    if (!fact) cell = `<c r="${mapping.amountCell}"${originalStyle === undefined ? '' : ` s="${originalStyle}"`}/>`;
    else {
      if (fact.presence !== 'value' || !isRationalValue(fact.normalizedValue)) return invalidVisualReport();
      const value = serializeWorkbookAmount(fact.normalizedValue, scale!, check);
      if (value.type === 'number') cell = `<c r="${mapping.amountCell}"${originalStyle === undefined ? '' : ` s="${originalStyle}"`} t="n"><v>${value.text}</v></c>`;
      else { cell = literalCell(mapping.amountCell, value.text, styles.style(originalStyle)); textAmounts++; }
    }
    sheet = replaceVisualCell(sheet, mapping.amountCell, cell);
  }
  parts.set('xl/worksheets/sheet1.xml', Buffer.from(sheet)); parts.set('xl/styles.xml', Buffer.from(styles.xml()));
  let contextSheet = parts.get('xl/worksheets/sheet2.xml')!.toString('utf8');
  const contextValues = [COREP_PROFILE_ID, 'COREP', 'COREP_OF_4.0', context.entityId, context.referenceDate, context.submissionDate ?? '', unit, String(scale), String(precision), String(context.filingIndicators['C_01.00'])];
  for (const [index, value] of contextValues.entries()) { check(); const address = 'B' + (index + 2); contextSheet = replaceVisualCell(contextSheet, address, literalCell(address, value)); }
  parts.set('xl/worksheets/sheet2.xml', Buffer.from(contextSheet));
  parts.set('xl/worksheets/sheet3.xml', instructionsSheet([
    'Informe COREP 4.0 · Fondos propios CA1', 'Extracto derivado para trabajo local; no es un fichero oficial de remisión.',
    'Versión seleccionada: ' + info.versionId, 'Entidad: ' + context.entityId + ' · Referencia: ' + context.referenceDate,
    `Importes en ${unit}; escala ${scale} (${scale === 0 ? 'unidades' : scale === 3 ? 'miles' : 'millones'}); precisión declarada ${precision}.`,
    'Los importes se reconstruyen exactamente desde esta versión, sin aplicar un nuevo redondeo.',
    'Una celda vacía significa ausencia de dato; un cero es un importe informado.',
    ...(textAmounts ? [`${textAmounts} importe(s) se conservan como texto decimal exacto, alineado a la derecha, para evitar pérdida de cifras en Excel.`] : []),
    `Hojas del archivo original excluidas del perfil: ${excluded.length}. Solo se reconstruye CA1.`,
    'El contexto figura en la hoja Contexto; confirma sus datos al reimportar.',
    'La reimportación conserva datos y contexto, pero crea nuevas fuentes y no restaura el historial de cambios.',
    ...(info.synthetic ? ['Datos sintéticos de demostración.'] : []),
  ]));
  return writeIncrementalParts(location, [...parts].map(([name, bytes]) => ({ name, chunks: [bytes] })), maximum, budget, maxExpandedBytes, check);
}
