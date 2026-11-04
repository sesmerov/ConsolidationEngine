# Contrato de demostraciones y expectativas

Fecha: 2026-11-04. Estado: diseño, no demo implementada. La fuente normativa de entradas,
expresiones completas, metadatos y expectativas es [demo-corpus.json](demo-corpus.json).
Los resultados esperados no se ajustarán a la salida de la implementación.

## 1. Dos conjuntos separados

| Conjunto | Informe | Reglas | Origen |
|---|---|---|---|
| COREP | `eba-corep-of-4.0-ca1-v1`, hoja CA1 | 16 | 5 del catálogo EBA y 11 sintéticas; todos los datos sintéticos. |
| Tipos | `ce-demo-types-1`, hoja Datos | 8 | Informe y reglas propios, claramente etiquetados como demostración. |

Cada conjunto entrega su catálogo de 15 cabeceras EBA, su informe ya cumplimentado y
guía breve. Un segundo ejemplo sustituye el conjunto tras confirmación de carga; no se
mezclan COREP y DEMO en un mismo contexto. Las reglas tipadas son solo de validación.

## 2. COREP: datos, fuente y periodo

Contexto: entidad `SYNTHETIC`, referencia y envío **2025-12-31**, framework `COREP`,
módulo `COREP_OF_4.0`, indicador `C_01.00=true`, EUR, escala 0 y precisión 2.
Las 110 posiciones de CA1 están declaradas. Quince llevan valor y 95 quedan vacías.
Vacío no significa cero: las reglas oficiales incorporan expresamente `default:0`.

| Filas | Valores iniciales respectivos |
|---|---|
| 0020, 0030, 0040, 0060, 0070 | 1000; 100; 100; 20; 5 |
| 0080, 0090, 0091, 0092 | 10; 20; 30; 5 |
| 0130, 0140, 0150, 0160, 0170 | 20; 50; 10; 20; 30 |
| 0200 | 0 informado |

Las variantes oficiales tienen vigencia **2025-03-31 a 2026-03-30** y fecha mínima de
envío 2025-03-31. Del catálogo original se conservan los 15 campos, incluida la grafía
`Precondtion`, `default:0`, `interval:true`, severidad, estado y el campo Source que dice
literalmente `user_defined`. Su procedencia del catálogo publicado, no el contenido de
ese campo, permite identificarlas como reglas oficiales. El JSON conserva hash y filas
135, 138, 139, 142 y 143 de la hoja fuente para v0172_m a v0176_m respectivamente.

## 3. Matriz de 24 reglas

«Antes/después» corresponde a aplicar exclusivamente las cinco direcciones indicadas
en la sección siguiente. Una expectativa Falla es un caso intencionado, no un test fallido.

| Código | Familia | Antes → después | Configurar en guía |
|---|---|---|---|
| v0172_m | Suma de componentes, intervalos/default oficiales | Falla → Pasa | Izquierda |
| v0173_m | Suma de componentes oficiales | Falla → Pasa | Izquierda |
| v0174_m | Suma de componentes oficiales | Falla → Pasa | Izquierda |
| v0175_m | Suma de componentes oficiales | Falla → Pasa | Izquierda |
| v0176_m | Suma de componentes oficiales | Falla → Pasa | Izquierda |
| DEMO_GT | Mayor que cero | Pasa → Pasa | No |
| DEMO_LT_FAIL | Menor que cero, falso intencionado | Falla → Falla | No |
| DEMO_LE | Menor o igual que límite | Pasa → Pasa | No |
| DEMO_NE | Distinto de cero | Pasa → Pasa | No |
| DEMO_NULL | Ausencia de r0180 | Pasa → Pasa | No |
| DEMO_ZERO | Cero informado | Pasa → Pasa | No |
| DEMO_RANGE | Suma de rango r0080–r0091 | Falla → Pasa | No; comparte destino con v0174_m |
| DEMO_PRECONDITION | Precondición numérica falsa | No aplica → No aplica | No |
| DEMO_IF_THEN | Condición verdadera sobre importes | Falla → Pasa | Prohibido: solo validación |
| DEMO_IF_ELSE | Condición falsa, rama de división por cero omitida | Pasa → Pasa | Prohibido: solo validación |
| DEMO_INTERVAL | Cero p2 comparado con 0,004 | Pasa → Pasa | No |
| DEMO_TEXT_EQ | Texto igual a Banco | Pasa → Pasa | Prohibido |
| DEMO_TEXT_CASE | Banco frente a banco | Falla → Falla | Prohibido |
| DEMO_TEXT_SPACE | Banco frente a Banco con espacio final | Falla → Falla | Prohibido |
| DEMO_TEXT_EMPTY | Cadena vacía informada | Pasa → Pasa | Prohibido |
| DEMO_DATE_EQUAL | Fecha bisiesta válida | Pasa → Pasa | Prohibido |
| DEMO_DATE_ORDER | Orden entre fechas civiles | Pasa → Pasa | Prohibido |
| DEMO_IF_TEXT | Condición de texto y comparación de fechas | Pasa → Pasa | Prohibido |
| DEMO_IF_DATE | Condición de fecha falsa y rama alternativa | Pasa → Pasa | Prohibido |

COREP: **7 pasan, 8 fallan y 1 no aplica → 14 pasan, 1 falla y 1 no aplica**.
Tipos: **6 pasan y 2 fallan**, sin propuestas ni aplicación. No hay casos positivos
que dependan de contabilizar `not_evaluable` como soporte.

## 4. Recálculos numéricos elegidos expresamente

Configurar solo v0172_m, v0173_m, v0174_m, v0175_m y v0176_m, todas hacia la izquierda.
La configuración es una selección de demostración, no una propiedad implícita de EBA.

| Productor | Destino C_01.00/c0010 | Cambio esperado |
|---|---|---|
| v0174_m | r0070 | 5 → 60,00 |
| v0173_m | r0030 | 100 → 185,00 |
| v0176_m | r0150 | 10 → 50,00 |
| v0175_m | r0130 | 20 → 100,00 |
| v0172_m | r0020 | 1000 → 285,00 |

Aristas: v0174_m → v0173_m → v0172_m y v0176_m → v0175_m → v0172_m.
Seleccionar v0172_m aisladamente debe mostrar los cuatro antecedentes pendientes;
el usuario los elige expresamente. Aplicar la selección completa cambia cinco datos,
crea una versión y revalida las 16 reglas, incluidas las dos condicionales.
No se configura DEMO_RANGE para evitar un segundo productor del mismo destino.

## 5. Libro propio de tipos `ce-demo-types-1`

Hojas exactas: `Instrucciones`, `Datos`, `Contexto`; sin macros, fórmulas, vínculos externos,
celdas fusionadas en las tablas ni columnas de coordenadas. Se aplican las protecciones
y cuotas del formato estricto, sin la excepción del paquete oficial COREP.

- `Instrucciones!A1`: «Demostración sintética de texto y fechas»; A2: `ce-demo-types-1`. Las instrucciones explican resultados, estado Informado/Sin dato y ausencia de recálculos.
- `Datos!A3:C3`: `Campo`, `Valor`, `Estado`. Filas 4–9 y etiquetas fijas según el JSON. El usuario cambia valores B y estado C; tipo y coordenada se obtienen del perfil del servidor.
- Filas 4–7: Categoría=`Banco`; Categoría en minúsculas=`banco`; Categoría con espacio final=`Banco `; Observación vacía=`""`. Son textos, incluido el último con longitud cero.
- Filas 8–9: Fecha inicial=`2024-02-29`; Fecha final=`2025-12-31`. Son fechas civiles. El ejemplo las entrega como texto ISO; el adaptador también admite fecha XML o serial entero según el contrato semántico.
- Todas las filas de ejemplo tienen C=`Informado`. Para texto, B vacío e Informado significa cadena vacía; C=`Sin dato` y B vacío significa nulo explícito. Fecha Informado requiere un valor válido; Sin dato con B no vacío es incompatible. Estado ausente o desconocido se rechaza.
- Tabla interna `DEMO_TYPES`, columna `0010`, filas internas `0010`…`0060`; estos identificadores pertenecen al adaptador y al catálogo de reglas, no se exigen al usuario en Excel. Unidad y precisión vacías.
- `Contexto!A3:B3`: `Campo`, `Valor`. A4:A10: `Entidad`, `Fecha de referencia`, `Fecha de envío`, `Marco`, `Módulo`, `Formato`, `Tabla declarada`. B4:B10: `SYNTHETIC`, `2025-12-31`, `2025-12-31`, `DEMO`, `DEMO_TYPES_1`, `ce-demo-types-1`, `Sí`. El contexto se confirma en la inspección de carga.
- El perfil reconoce etiquetas, posiciones y cabeceras fijas; solo valores y estados declarados son editables. Filas desplazadas, campos duplicados, tipos de celda incompatibles o contenido de datos adicional se rechazan con localizador.
- Exportar reconstruye estas tres hojas desde la plantilla segura, con datos y contexto de la versión seleccionada. Las cadenas vacías se conservan mediante Estado; las fechas se escriben en ISO. Reimportar preserva valores normalizados, tipo y presencia, sin restaurar historial.

## 6. Negativos y evidencia

El JSON separa fechas inválidas, literal temporal no admitido, condición nula o de tipo
incorrecto, ramas incompatibles, destino numérico con condicional, texto solo en precondición,
exclusión en rama inactiva, productor duplicado y ciclo numérico. Se añaden pruebas de
petición directa y configuración/preview obsoletos según [language-profile.md](language-profile.md).
Estos casos no se incluyen en los libros principales para que la guía pueda completarse.

Verificado en planificación: **30 análisis de sintaxis** (24 expresiones y seis
precondiciones) con ANTLR 4.13.2, EOF y expresión única, sin errores; y los cinco importes
finales mediante sumas independientes con enteros BigInt en céntimos, sin usar el motor.
No se han probado todavía semántica v2, importación de las demos, Material ni recorrido E2E.
