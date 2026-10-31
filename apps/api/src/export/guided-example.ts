import writeXlsxFile from 'write-excel-file/node';
import { CONTEXT_HEADERS, COORDINATE_HEADERS, EBA_HEADERS, FACT_HEADERS } from '@ce/contracts';
const instructions = [
  ['Ejemplo guiado · datos y reglas 100 % SYNTHETIC'],
  ['Este ejemplo didáctico no contiene reglas EBA reales ni datos de una entidad. Descarga ejemplo-catalogo.xlsx y ejemplo-informe.xlsx desde la aplicación. No necesitas editar ninguno.'],
  ['1. Crea un conjunto y carga ejemplo-catalogo.xlsx como catálogo y ejemplo-informe.xlsx como informe. La carga reemplaza el conjunto si ya contenía otros archivos.'],
  ['2. Pulsa Validar informes. Resultado inicial: una regla falla (SYNTHETIC_A, A = B + C) y una pasa (SYNTHETIC_D, D = A × 2). A=11, B=5, C=7 y D=22.'],
  ['3. En Configurar destinos de recálculo, elige Izquierda para SYNTHETIC_A y SYNTHETIC_D y pulsa Guardar configuración. Esto todavía no cambia los valores.'],
  ['4. Pulsa Simular recálculos. Las propuestas serán A=12.00 y D=24.00; D usa el A propuesto.'],
  ['5. Selecciona primero SYNTHETIC_D: faltará su predecesor SYNTHETIC_A. Selecciona también SYNTHETIC_A expresamente. El sistema no añade cambios por ti.'],
  ['6. Revisa los dos cambios, marca He revisado cada propuesta… y pulsa Aplicar cambios seleccionados. Se crea una nueva versión y se revalida todo el catálogo.'],
  ['7. En la comparación, comprueba una regla pasa/una falla antes y dos pasan/cero fallan después. A cambia de 11 a 12.00 y D de 22 a 24.00; B y C permanecen 5 y 7.'],
  ['8. En Guardar informes y resultados, elige la versión marcada vigente, el contenido Informes y registro de cambios y pulsa Preparar y descargar ZIP. Cerrar el conjunto o reiniciar el servidor elimina la sesión temporal; las descargas guardadas permanecen.'],
  ['Coordenadas: todas pertenecen a C_01.00, columna 0010 y sin hoja. A = fila 0230, B = fila 0250, C = fila 0260, D = fila 0270. Unidad EUR, precisión 2 y comparación puntual (interval:false).'],
  ['Entidad SYNTHETIC · referencia 30/06/2026 · módulo COREP_OF_4.2. Todos los códigos e importes son texto. Si creas otros informes, conserva las cuatro hojas ce-report-1 y formatea Texto antes de introducir datos.'],
  ['Si algo no resulta claro, anota el paso y la ayuda necesaria. Un recorrido automático no sustituye la evaluación de una persona analista.'],
];
/** Generated entirely from fixed teaching data; never reads a test fixture or original EBA file. */
export async function guidedExample(kind: 'catalog' | 'report'): Promise<Buffer> {
  const sheets: { sheet: string; data: readonly (readonly string[])[] }[] = [{ sheet: 'Instructions', data: instructions }];
  if (kind === 'catalog') {
    const rule = (code: string, expression: string, description: string) => EBA_HEADERS.map(header => ({
      'VR Code': code, Source: 'SYNTHETIC · ejemplo didáctico', Framework: 'COREP', Modules: 'COREP_OF_4.2', 'Cross module': 'No', Tables: 'C_01.00', Expression: expression,
      Precondtion: '', Description: description, IsActive: 'Active', FromReferenceDate: '2026-01-01', ToReferenceDate: '', Severity: 'Error', FromSubmissionDate: '', 'Implemented in XBRL': 'No',
    }[header] ?? ''));
    sheets.push({ sheet: 'Synthetic_rules', data: [EBA_HEADERS,
      rule('SYNTHETIC_A', 'with {tC_01.00,c0010,interval:false}: {r0230}={r0250}+{r0260}', 'A = B + C. Inicialmente 11 ≠ 5 + 7; propuesta A = 12.'),
      rule('SYNTHETIC_D', 'with {tC_01.00,c0010,interval:false}: {r0270}={r0230}*2', 'D = A × 2. Inicialmente 22 = 11 × 2; al aceptar A = 12, propuesta D = 24.'),
    ] });
  } else {
    sheets.push({ sheet: 'Contexts', data: [CONTEXT_HEADERS, ['ce-report-1', 'demo', 'SYNTHETIC', '2026-06-30', '2026-06-30', 'COREP', 'COREP_OF_4.2', '{}']] },
      { sheet: 'Coordinates', data: [COORDINATE_HEADERS, ...['0230', '0250', '0260', '0270'].map(row => ['demo', 'C_01.00', '', row, '0010', 'number', 'EUR', '2', '{}'])] },
      { sheet: 'Facts', data: [FACT_HEADERS, ...[['0230', '11'], ['0250', '5'], ['0260', '7'], ['0270', '22']].map(([row, value]) => ['demo', 'C_01.00', '', row!, '0010', 'value', value!])] });
  }
  return writeXlsxFile(sheets.map(sheet => ({ sheet: sheet.sheet, stickyRowsCount: 1, columns: sheet.data[0]!.map(() => ({ width: sheet.sheet === 'Instructions' ? 110 : 24 })),
    data: sheet.data.map(row => row.map(value => ({ type: String, value, format: '@', wrap: true, ...(sheet.sheet === 'Instructions' ? { height: 60 } : {}) }))) }))).toBuffer();
}
