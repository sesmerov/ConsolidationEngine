# Demostraciones visuales

En **Cargar → Demostraciones guiadas** hay tres ejemplos independientes. Descarga el
catálogo y el informe del mismo ejemplo y usa un conjunto distinto para cada uno.
Elegir una guía o descargar sus archivos no carga datos ni configura destinos.

| Ejemplo | Catálogo | Informe | Origen |
|---|---|---|---|
| COREP | `demo-corep-catalog.xlsx` | `demo-corep-report.xlsx` | Cinco reglas procedentes del catálogo EBA y once sintéticas; todos los datos son sintéticos. |
| Texto y fechas | `demo-types-catalog.xlsx` | `demo-types-report.xlsx` | Ocho reglas y un informe propios, sintéticos. No es una plantilla regulatoria EBA. |
| FINREP | `demo-finrep-catalog.xlsx` | `demo-finrep-report.xlsx` | Hoja 1.1 del layout EBA 4.0; cinco reglas propias y todos los importes sintéticos. |

Las descargas se sirven mediante `GET /api/v1/templates/demos/{corep|types|finrep}/{catalog|report}`
con la sesión de la aplicación. Las copias generadas están en `tests/fixtures/generated/`.
No es necesario editar los libros para completar la guía.

## Carga y revisión

1. Selecciona los dos archivos en **Catálogo de reglas** e **Informes**.
2. Conserva **Usar Contexto del libro**. Los tres incluyen la entidad `SYNTHETIC`, referencia
   y envío `2025-12-31`; no hay que escribir coordenadas del informe.
3. Pulsa **Inspeccionar archivos** y revisa el contexto, las hojas incluidas y la cantidad
   de valores. Este paso prepara un candidato, todavía no publica datos.
4. Pulsa **Confirmar carga**. El panel **Datos cargados · Versión N** identifica la versión
   publicada; la revisión de una carga candidata permanece diferenciada.
5. Ve a **Validar** y pulsa **Validar informes**.

Cambiar de guía conserva los archivos seleccionados y la revisión en curso. Cambiar
archivos o contexto sí invalida la revisión local: hay que descartarla y repetir la
inspección. Los libros se identifican por sus perfiles en el servidor.

## COREP: validación y cinco cambios explícitos

El informe usa la presentación de **C_01.00 / CA1** del módulo `COREP_OF_4.0`. Declara
110 posiciones: 15 con valor y 95 vacías. Un vacío no es cero. El contexto declara EUR,
escala en unidades y dos decimales; la fecha del ejemplo está dentro de la vigencia
de las cinco variantes EBA, del 31/03/2025 al 30/03/2026.

Las reglas v0172_m–v0176_m conservan los quince campos del catálogo original, incluidas
las grafías `Precondtion`, `default:0`, `interval:true` y el valor literal `user_defined`
de Source. Su procedencia del catálogo publicado identifica su origen EBA; ese campo
no convierte las otras once reglas del ejemplo en oficiales. Las fuentes y expectativas
congeladas están en [el contrato del corpus](../specs/002-ui-eba-demo/contracts/demo-corpus.md)
y [su JSON](../specs/002-ui-eba-demo/contracts/demo-corpus.json).

Sin editar el ejemplo, se esperan **7 reglas que pasan, 8 que fallan y 1 que no aplica**.
Los fallos son casos de demostración, no una señal de que los archivos estén dañados.

Ve a **Recalcular**. Al inicio, **Elegir qué celdas recalcular** prepara los destinos y muestra las decisiones pendientes. Revisa los dos grupos en conflicto:

1. En r0070, elige **v0174_m** en las opciones y pulsa **Confirmar elección**. Puedes revisar la decisión con **Cambiar elección**. `DEMO_RANGE` y `DEMO_PRECONDITION` también podrían escribir en esa celda y quedan omitidas.
2. En r0200, elige **No recalcular esta celda** y pulsa **Confirmar elección** para excluir de la configuración tanto `DEMO_ZERO` como `DEMO_INTERVAL`.
3. Quedan **5 incluidas, 4 omitidas y 7 excluidas** de16 reglas. Cuando no haya decisiones pendientes, pulsa **Simular recálculos**: guarda la configuración y prepara las propuestas en una operación. Los importes solo cambian después de seleccionar propuestas y confirmar su aplicación.

| Regla | Destino C_01.00, columna 0010 | Anterior → propuesto (EUR) |
|---|---|---|
| v0174_m | Fila 0070 | 5,00 → 60,00 |
| v0173_m | Fila 0030 | 100,00 → 185,00 |
| v0176_m | Fila 0150 | 10,00 → 50,00 |
| v0175_m | Fila 0130 | 20,00 → 100,00 |
| v0172_m | Fila 0020 | 1.000,00 → 285,00 |

La simulación utiliza el ordenamiento de Kahn y respeta dos
ramas con tres niveles:

```text
v0174_m → v0173_m ┐
                ├→ v0172_m
v0176_m → v0175_m ┘
```

Las cinco propuestas aparecen preseleccionadas. Para comprobar sus dependencias, desmarca un antecedente: Aplicar quedará bloqueado. Puedes consultarlos sin
seleccionarlos; vuelve a incluir el antecedente antes de continuar. Comprueba los cinco cambios,
marca la confirmación y pulsa **Aplicar cambios seleccionados**. Se crea una nueva
versión y se vuelven a validar las dieciséis reglas.

Se esperan **14 que pasan, 1 que falla y 1 que no aplica**. `DEMO_LT_FAIL` sigue fallando
intencionadamente y `DEMO_PRECONDITION` sigue sin aplicar. Los dos condicionales COREP,
`DEMO_IF_THEN` y `DEMO_IF_ELSE`, son **sólo de validación**: no ofrecen destinos ni
propuestas, aunque sus resultados puedan cambiar al revalidar datos recalculados por
otras reglas numéricas.

| Familia del ejemplo COREP | Códigos | Resultado esperado antes → después |
|---|---|---|
| Sumas EBA con intervalos y valores por defecto | v0172_m–v0176_m | Falla → Pasa |
| Desigualdades | DEMO_GT, DEMO_LE, DEMO_NE | Pasa → Pasa |
| Desigualdad falsa intencionada | DEMO_LT_FAIL | Falla → Falla |
| Ausencia y cero informado | DEMO_NULL, DEMO_ZERO | Pasa → Pasa |
| Suma de rango | DEMO_RANGE | Falla → Pasa |
| Precondición falsa | DEMO_PRECONDITION | No aplica → No aplica |
| Condición verdadera | DEMO_IF_THEN | Falla → Pasa |
| Condición falsa con rama omitida | DEMO_IF_ELSE | Pasa → Pasa |
| Comparación con intervalos | DEMO_INTERVAL | Pasa → Pasa |

## Texto y fechas: ocho validaciones sin recálculos

El libro propio `ce-demo-types-1` contiene **Instrucciones**, **Datos** y **Contexto**.
La hoja Datos presenta nombres de campo, valores y estado **Informado / Sin dato**;
el servidor resuelve sus tipos y posiciones. El contexto muestra `DEMO / DEMO_TYPES_1`
y su tabla declarada `DEMO_TYPES`, sin atribuirlos a COREP.

Se esperan **6 reglas que pasan y 2 que fallan**:

| Regla | Caso | Resultado |
|---|---|---|
| DEMO_TEXT_EQ | Texto igual a «Banco» | Pasa |
| DEMO_TEXT_CASE | «Banco» frente a «banco» | Falla |
| DEMO_TEXT_SPACE | «Banco» frente a «Banco » con espacio final | Falla |
| DEMO_TEXT_EMPTY | Texto vacío informado | Pasa |
| DEMO_DATE_EQUAL | Fecha válida 29/02/2024 | Pasa |
| DEMO_DATE_ORDER | 29/02/2024 anterior a 31/12/2025 | Pasa |
| DEMO_IF_TEXT | Condición de texto y comparación de fechas | Pasa |
| DEMO_IF_DATE | Condición de fecha falsa y rama alternativa | Pasa |

Las comparaciones son exactas: no eliminan espacios ni igualan mayúsculas. Texto vacío
con estado **Informado** no equivale a **Sin dato**. Las fechas son civiles, sin hora ni
zona horaria. Las ocho reglas son sólo de validación; no existen controles de destino
para ellas y una simulación sin direcciones produce cero propuestas.

## FINREP F 01.01: dos cambios encadenados

El informe contiene las **38 posiciones** de `F_01.01`, columna `0010`, en la hoja
**1.1** del anexo fijado EBA 4.0. El contexto declara `FINREP / FINREP_F0101_4.0`:
el módulo es un alias local, no una denominación oficial de remisión XBRL.

1. Carga el catálogo y el informe FINREP en un conjunto propio, conservando el contexto
   del libro. Confirma la carga y sigue el realce de **Validar**.
2. Valida: aparecen **2 reglas que pasan y 3 que fallan**.
3. Sigue el realce de **Recalcular**. Las dos igualdades tienen un único destino disponible, elegido automáticamente; simula sin guardar una configuración por separado. Ambas propuestas comienzan seleccionadas.
   Revisa **90 → 100** para efectivo y **105 → 120** para el total de activos del ejemplo.
   La segunda lee el efectivo ya propuesto: **100 + 20 = 120**.
4. Confirma la selección y aplica. La validación pasa a **4 reglas que pasan y 1 que falla**.
   La desigualdad falsa permanece así intencionadamente.
5. Sigue el realce de **Descargar** y descarga los informes de la versión aplicada.
   Puedes cargar el Excel descargado con el mismo catálogo en otro conjunto: conserva
   las 38 posiciones, el contexto de negocio y los dos importes recalculados.

| Regla propia | Expresión resumida | Antes → después |
|---|---|---|
| FIN_TOTAL_CASH | r0010 = r0020 + r0030 + r0040 | Falla → Pasa; 90 → 100 |
| FIN_TOTAL_ASSETS_DEMO | r0380 = r0010 + r0050 | Falla → Pasa; 105 → 120 |
| FIN_GREATER_PASS | r0020 > r0030 | Pasa → Pasa |
| FIN_GREATER_FAIL | r0040 > r0020 | Falla → Falla |
| FIN_CONDITIONAL | Si r0020 > 0, r0030 ≥ 0; si no, r0040 = 0 | Pasa → Pasa |

Las desigualdades y el condicional solo validan. Las fórmulas del ejemplo simplifican
el contenido del balance para mostrar la dependencia entre dos cálculos; no son reglas
oficiales FINREP. Los cuatro sumandos son 40, 35, 25 y 20; las demás posiciones se
informan a cero, salvo los dos totales iniciales indicados.

Al cargar el anexo completo, elige **FINREP F 01.01** cuando el libro también contenga
un perfil COREP reconocido y acepta sus hojas excluidas antes de confirmar. En FINREP,
la descarga conserva esas hojas y las partes ajenas al cálculo del libro original.
El formato, la estructura y los importes se verifican de nuevo antes de publicar el
archivo. La plantilla vacía está disponible como **Plantilla FINREP F 01.01**.

## Alcance y evidencia

Estas expectativas describen los archivos sin editar y no se toman como respuestas
del motor: cada carga se evalúa realmente. Las pruebas comparan sus resultados con el
oráculo congelado; la guía no configura reglas, interpreta expresiones ni suministra
valores a la simulación. La evidencia ejecutada se registra en
[verification-002.md](verification-002.md) y [verification-004.md](verification-004.md); una prueba automática no sustituye la
aceptación humana.

La cobertura regulatoria visual se limita a CA1 y F 01.01 del layout EBA 4.0 fijado. Los ejemplos no acreditan soporte
completo de COREP, FINREP o DPM-XL. Los errores deliberados de sintaxis, ciclos y otros
casos negativos se prueban aparte y no se incluyen en estos tres recorridos principales.

El importador de compatibilidad `ce-report-1` se utiliza por API en las regresiones del motor. El ensayo FINREP de la iteración 003 documenta el rechazo visual anterior y su control por compatibilidad; no describe el nuevo soporte de F 01.01. [Resultado histórico y procedencia](../specs/003-simplificar-flujo/evidencia.md)

## Guardar una versión o sus resultados

En **Descargar**, elige expresamente la versión. **Contenido de la versión elegida**
identifica si es vigente o histórica, sus perfiles y la cantidad de informes. Abre
**Ver informes y contexto** para consultar archivos de origen, hojas, entidad, fecha
y exclusiones. El resumen procede de esa versión; no se deduce del conjunto vigente.
Un informe con varios contextos muestra su cantidad y los valores comunes, sin ocultar
la existencia de entidades o fechas diferentes.

**Informes y registro de cambios** prepara un libro por archivo de origen en su perfil:
CA1 para COREP, 1.1 para FINREP, Datos para la demostración tipada y el formato anterior cuando corresponda.
Los datos y el contexto pertenecen a la versión elegida. FINREP conserva las partes del
original y modifica únicamente sus importes autorizados y el contexto necesario;
COREP y la demo tipada generan un extracto de las hojas admitidas. El registro de
cambios se entrega separado. Son libros de trabajo local reimportables, no ficheros
oficiales de remisión.

**Resultados de validación** permite elegir una ejecución de esa versión. Una ejecución
incompleta conserva su aviso y estado. Desde Validar, **Descargar resultados de esta
ejecución** lleva a Descargar con la ejecución visible y su propia versión. Repetir esa descarga sólo
reutiliza un paquete que coincide en versión y ejecución.

Tras aplicar cambios, sigue el realce de **Descargar**. Elige versión y contenido y utiliza el único botón de descarga. Ese botón prepara el paquete, descarga sus bytes o reintenta la misma transferencia según su estado; conserva la versión que hayas elegido. La comparación de Recalcular no ofrece descargas. Para cambiar los destinos de una simulación, utiliza **Revisar destinos** de forma explícita.
