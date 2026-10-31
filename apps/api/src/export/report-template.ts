import writeXlsxFile from 'write-excel-file/node';
import { CONTEXT_HEADERS, COORDINATE_HEADERS, FACT_HEADERS } from '@ce/contracts';
/** The example is synthetic; its two main coordinates match real EBA rule v0190_m (G169). */
export async function reportTemplate(): Promise<Buffer> {
  const sheets: { sheet: string; data: readonly (readonly string[])[] }[] = [
    { sheet: 'Instructions', data: [
      ['ce-report-1 · Plantilla de informes'],
      ['EJEMPLO SINTÉTICO: entidad SYNTHETIC, fecha 2026-06-30 y módulo COREP_OF_4.2. Sustituye estos datos por los de tu informe.'],
      ['Las dos primeras celdas corresponden a la regla EBA v0190_m (G169 del catálogo 2025-12-12). No son datos reales de una entidad.'],
      ['Conserva estas cuatro hojas y sus cabeceras. Antes de introducir filas nuevas, selecciona sus columnas y aplica formato Texto. Cambiar sólo el formato de un número ya redondeado no recupera sus dígitos.'],
      ['Contextos: usa un contextId único en el lote. Todos los informes del conjunto deben compartir entidad y fecha de referencia. submissionDate es opcional, pero algunas reglas la requieren.'],
      ['filingIndicators es JSON de códigos exactos sin v_ y valores true/false. Un código ausente es desconocido; no se deduce de los hechos. Ejemplo: {"C_01.00":true,"C_05.01":true}.'],
      ['Coordinates declara todas las celdas válidas, incluso las que no tienen valor. sheetCode vacío significa que la tabla no tiene eje de hoja; axes es un objeto JSON sin claves repetidas.'],
      ['Número: unit es EUR, USD, pure u otra unidad canónica. decimals indica precisión declarada entre -18 y 18; INF significa exacto. No se deduce de los ceros finales del valor.'],
      ['Importes: decimal con punto y sin separadores de miles, hasta 128 dígitos significativos y 128 posiciones decimales. Mantén 0010 y 0230 como texto para conservar ceros.'],
      ['Facts: presence=value requiere un valor textual. El cero se escribe 0. presence=null exige valor vacío y representa null explícito. Una coordenada sin fila Facts representa null implícito; una celda no declarada no existe.'],
      ['Booleanos: dataType=boolean, unit y decimals vacíos, y value textual true o false. No uses fórmulas, macros ni enlaces de datos externos.'],
      ['El perfil local usa intervalos cerrados conservadores y racionales exactos; no declara conformidad completa con la semántica EBA. La carga analiza las reglas; no las evalúa.'],
    ] },
    { sheet: 'Contexts', data: [CONTEXT_HEADERS, ['ce-report-1', 'demo', 'SYNTHETIC', '2026-06-30', '2026-06-30', 'COREP', 'COREP_OF_4.2', '{"C_01.00":true,"C_05.01":true}']] },
    { sheet: 'Coordinates', data: [COORDINATE_HEADERS,
      ['demo', 'C_01.00', '', '0230', '0010', 'number', 'EUR', '2', '{}'], ['demo', 'C_05.01', '', '0090', '0060', 'number', 'EUR', '2', '{}'],
      ['demo', 'C_01.00', '', '0240', '0010', 'number', 'EUR', 'INF', '{}'], ['demo', 'C_01.00', '', '0250', '0010', 'number', 'EUR', '2', '{}'],
      ['demo', 'C_01.00', '', '0260', '0010', 'number', 'EUR', '2', '{}'], ['demo', 'C_01.00', '', '0270', '0010', 'number', 'EUR', '2', '{}']] },
    { sheet: 'Facts', data: [FACT_HEADERS,
      ['demo', 'C_01.00', '', '0230', '0010', 'value', '10.00'], ['demo', 'C_05.01', '', '0090', '0060', 'value', '10.00'],
      ['demo', 'C_01.00', '', '0240', '0010', 'value', '123456789012345678901234567890.123456789'], ['demo', 'C_01.00', '', '0250', '0010', 'value', '0'],
      ['demo', 'C_01.00', '', '0260', '0010', 'null', '']] },
  ];
  return writeXlsxFile(sheets.map((sheet) => ({ sheet: sheet.sheet, stickyRowsCount: 1,
    columns: Array.from({ length: sheet.data[0]!.length }, (_, index) => ({ width: sheet.sheet === 'Instructions' ? 110 : index === sheet.data[0]!.length - 1 ? 48 : 22 })),
    data: sheet.data.map((row) => row.map((value) => ({ type: String, value, format: '@', wrap: true, ...(sheet.sheet === 'Instructions' ? { height: 48 } : {}) }))) }))).toBuffer();
}
