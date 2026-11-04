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

En **Configurar destinos de recálculo**, elige **Izquierda** expresamente en las cinco
reglas de la tabla y pulsa **Guardar configuración**. Esta configuración no modifica
importes. No configures `DEMO_RANGE`: comparte destino con v0174_m y crearía otro
productor para la misma celda.

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

El ejemplo anterior de dos reglas sigue disponible en **Formato anterior ce-report-1 →
Empezar con el ejemplo guiado**, con su carga directa avanzada.
