# Demostraciones visuales

En **Cargar → Demostraciones guiadas** hay dos ejemplos independientes. Descarga el
catálogo y el informe del mismo ejemplo y usa un conjunto distinto para cada uno.
Elegir una guía o descargar sus archivos no carga datos ni configura destinos.

| Ejemplo | Catálogo | Informe | Origen |
|---|---|---|---|
| COREP | `demo-corep-catalog.xlsx` | `demo-corep-report.xlsx` | Cinco reglas procedentes del catálogo EBA y once sintéticas; todos los datos son sintéticos. |
| Texto y fechas | `demo-types-catalog.xlsx` | `demo-types-report.xlsx` | Ocho reglas y un informe propios, sintéticos. No es una plantilla regulatoria EBA. |

Las descargas se sirven mediante `GET /api/v1/templates/demos/{corep|types}/{catalog|report}`
con la sesión de la aplicación. Las copias generadas están en `tests/fixtures/generated/`.
No es necesario editar los libros para completar la guía.

## Carga y revisión

1. Selecciona los dos archivos en **Catálogo de reglas** e **Informes**.
2. Conserva **Usar Contexto del libro**. Ambos incluyen la entidad `SYNTHETIC`, referencia
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

En **Validar**, pulsa **Preparar revisión de destinos**. Revisa los dos grupos en conflicto:

1. En r0070, pulsa **Conservar v0174_m**. `DEMO_RANGE` y `DEMO_PRECONDITION` también podrían escribir en esa celda y quedan omitidas.
2. En r0200, pulsa **Omitir grupo** para excluir de la configuración tanto `DEMO_ZERO` como `DEMO_INTERVAL`.
3. Comprueba **5 incluidas, 4 omitidas y 7 excluidas** de 16 reglas. Pulsa **Guardar configuración**. Se publica la configuración que se usará para simular. El cambio en los importes es posterior, cuando selecciones propuestas y confirmes su aplicación.

| Regla | Destino C_01.00, columna 0010 | Anterior → propuesto (EUR) |
|---|---|---|
| v0174_m | Fila 0070 | 5,00 → 60,00 |
| v0173_m | Fila 0030 | 100,00 → 185,00 |
| v0176_m | Fila 0150 | 10,00 → 50,00 |
| v0175_m | Fila 0130 | 20,00 → 100,00 |
| v0172_m | Fila 0020 | 1.000,00 → 285,00 |

En **Recalcular**, pulsa **Simular recálculos**. El ordenamiento de Kahn respeta dos
ramas con tres niveles:

```text
v0174_m → v0173_m ┐
                ├→ v0172_m
v0176_m → v0175_m ┘
```

Selecciona primero v0172_m: faltarán cuatro antecedentes. Puedes consultarlos sin
seleccionarlos; elige después cada uno expresamente. Comprueba los cinco cambios,
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

## Alcance y evidencia

Estas expectativas describen los archivos sin editar y no se toman como respuestas
del motor: cada carga se evalúa realmente. Las pruebas comparan sus resultados con el
oráculo congelado; la guía no configura reglas, interpreta expresiones ni suministra
valores a la simulación. La evidencia ejecutada se registra en
[verification-002.md](verification-002.md); una prueba automática no sustituye la
aceptación humana.

La cobertura regulatoria visual se limita a CA1. Los ejemplos no acreditan soporte
completo de COREP, FINREP o DPM-XL. Los errores deliberados de sintaxis, ciclos y otros
casos negativos se prueban aparte y no se incluyen en estos dos recorridos principales.

El importador de compatibilidad `ce-report-1` se utiliza por API en las regresiones del motor. El control de FINREP por esa vía conserva los mismos cuatro importes y dos reglas del ensayo de entrada visual. [Resultado y procedencia del ensayo](../specs/003-simplificar-flujo/evidencia.md)

## Guardar una versión o sus resultados

En **Descargar**, elige expresamente la versión. **Contenido de la versión elegida**
identifica si es vigente o histórica, sus perfiles y la cantidad de informes. Abre
**Ver informes y contexto** para consultar archivos de origen, hojas, entidad, fecha
y exclusiones. El resumen procede de esa versión; no se deduce del conjunto vigente.
Un informe con varios contextos muestra su cantidad y los valores comunes, sin ocultar
la existencia de entidades o fechas diferentes.

**Informes y registro de cambios** prepara un libro por archivo de origen en su perfil:
CA1 para COREP, Datos para la demostración tipada y el formato anterior cuando corresponda.
Los datos y el contexto pertenecen a la versión elegida; las hojas excluidas no se
reconstruyen. El registro de cambios se entrega separado. Son extractos de trabajo local
reimportables, no ficheros oficiales de remisión.

**Resultados de validación** permite elegir una ejecución de esa versión. Una ejecución
incompleta conserva su aviso y estado. Desde Validar, **Descargar resultados de esta
ejecución** usa la ejecución visible y su propia versión. Repetir esa descarga sólo
reutiliza un paquete que coincide en versión y ejecución.

Tras aplicar cambios, sigue **Siguiente paso** en **Descargar**. **Descargar informes aplicados** identifica la versión nueva del recibo y conserva la elección histórica del selector. También puedes usar **Descargar esta versión** desde la comparación. El último paquete disponible muestra la versión que contiene.
