# Notas de las fuentes aportadas

Inspección de solo lectura realizada el 2026-10-31. Estas observaciones fundamentan la
especificación; no son una prueba de ejecución ni una declaración de cobertura del motor.

## Catálogo de reglas

Archivo: `(from 4.0) EBA_Validation_rules_2025-12-12.xlsx`, en la raíz del proyecto.
Hoja: `EBA_Validation_rules_2025-12-12`; rango inspeccionado: `A1:O12666`.

Se encontraron 12.665 registros, 7.794 códigos `VR Code` distintos, 11.127 registros `Active`
y 1.538 `Inactive`. Los códigos repetidos no son necesariamente duplicados: pueden corresponder
a versiones, módulos y ventanas de vigencia diferentes. La identidad requiere ese contexto.

| Columna | Cabecera literal |
| --- | --- |
| A | VR Code |
| B | Source |
| C | Framework |
| D | Modules |
| E | Cross module |
| F | Tables |
| G | Expression |
| H | Precondtion |
| I | Description |
| J | IsActive |
| K | FromReferenceDate |
| L | ToReferenceDate |
| M | Severity |
| N | FromSubmissionDate |
| O | Implemented in XBRL |

`Precondtion` es la grafía real de la cabecera. La expresión formal está en G y la precondición
en H; la descripción I puede contener lenguaje anterior y no debe usarse como entrada del parser.
La severidad contiene valores como `warning`, `Error` y `error`; las fechas aparecen como fechas
numéricas de Excel o el literal `NULL`. Hay que normalizar sin perder el valor original.

### Casos localizados

| Celda | Código | Observación |
| --- | --- | --- |
| G113 | v0002_h | Igualdad de suma dentro de C_18.00, con `s*`, `default: 0`, `interval: true`. |
| G169 | v0190_m | Igualdad entre C_01.00 y C_05.01, con `default: 0`, `interval: true`. |
| G190 | v0216_m | Comparación `>=` con suma de varias filas de C_02.00.a e intervalos. |
| G23 | e23673_e | `not`, `isnull`, rango `r0850-0860`, `default:null`, `interval:false`. |
| G790 | v0787_m | Condición, miembro enumerado y suma de rango; no toda la construcción entra en v1. |
| G350 | v0340_m | Agrupaciones por dimensiones; fuera del perfil inicial. |
| G3879 | v1226_m | `time_shift` y periodo de referencia; fuera del perfil inicial. |
| G13 | — | Filtro `where/in` y miembros `eba_qEC`; fuera del perfil inicial. |

Ejemplo formal exacto en G169:

```text
with {default: 0, interval: true}: {tC_01.00, r0230, c0010} = {tC_05.01, r0090, c0060}
```

Las filas 169 y 170 comparten código, pero D169 indica `COREP_OF_4.2` y D170 `COREP_OF_4.0`,
con estados y fechas distintos. Rechazar automáticamente un código repetido sería incorrecto.

Un conteo textual encontró `interval:true` en 9.791 registros y `interval:false` en 2.909;
13 no incluyen `interval:`. Las categorías se solapan porque puede haber selecciones locales.
Esto no acredita evaluación. Sí justifica incluir intervalos en el perfil numérico inicial:
incluso G169, una igualdad entre dos celdas, los declara.

Ninguna expresión de la columna G contiene `:=` o `<-`. Por tanto, este catálogo de validaciones
no proporciona por sí solo una dirección de escritura para los recálculos.

## Gramáticas

- `grammar/dpm_xlLexer-v0.9.g4` declara `dpm_xlLexer`.
- `grammar/dpm_xlParser-v0.9.g4` declara `dpm_xlParser` y usa el lexer anterior.
- El punto de entrada `start` del parser, línea 4, exige consumir hasta `EOF`.
- El lexer distingue `:=` (asignación temporal, línea 18), `<-` (asignación persistente,
  línea 19) y `=` (comparación, línea 22).
- Las copias de ambas gramáticas en `2. DPM-XL-docs-v0.9/grammar/` tienen los mismos hashes.

Los nombres de archivo con sufijo `-v0.9` y las declaraciones internas difieren. La generación
reproducible deberá preparar nombres compatibles en una salida derivada y mantener los originales.
No se ha compilado la gramática ni ejecutado ANTLR en esta fase.

## Semántica documentada

Los PDF locales corresponden a DPM-XL v0.9, release 2025-11-24:

- `2. DPM-XL-docs-v0.9/dpm-xl-information-model-v0.9.pdf`, página 15: el tipo numérico
  y sus intervalos dependen de la precisión; el radio indicado es `10^-p / 2`.
- El mismo documento, páginas 19–20: diferencia entre nulo explícito e implícito, generación
  de variables ausentes según tablas abiertas/cerradas, lógica ternaria y tratamiento de nulos.
  Los agregados excluyen nulos; `default` y `nvl` permiten sustituirlos según su semántica.
- `2. DPM-XL-docs-v0.9/dpm-xl-operators-v0.9.pdf`, página 20: los rangos se definen sobre
  códigos de cabeceras DPM existentes y su orden alfabético; no sobre enteros consecutivos
  ni posiciones físicas de Excel.
- El mismo documento, página 39: la igualdad de intervalos usa la distancia entre centros y
  la suma de radios. No equivale a comparar números puntuales con una tolerancia global arbitraria.

Consecuencias para la plantilla: se necesitan coordenadas válidas, contexto, tipo, unidad y
precisión suficientes para interpretar las selecciones. Si faltan, el motor debe comunicar
que no puede evaluar. No se debe sustituir cualquier ausencia por cero ni construir rangos
solo con los hechos cargados.

La dirección de recálculo y las dependencias productor→consumidor son decisiones del producto,
no metadatos deducidos del signo `=`. El orden mediante Kahn fue solicitado por el usuario.

## Integridad de los originales

SHA-256 de los archivos inspeccionados:

| Archivo | SHA-256 |
| --- | --- |
| Excel EBA de la raíz | `36636AFE42B2EF2247822A31AD710AFE1128B5B65A250B657E1F20D5A75BBA79` |
| Lexer de `grammar/` | `DDA7B8DE2C8E1430448CAD7A342C712D52BA1B5BD533730B4EAFEDE02BB5805A` |
| Parser de `grammar/` | `30FD37BDDFDD356294801E53C7CF4864547A71D0ED13D1B884A3D9C6B6D884B4` |
| PDF Information Model | `715ABD1ABBB64AC097DC728E1D68F9D189EF831C8D35FBD4A78693F53A700B33` |
| PDF Operators | `8E67A62B71BA7B82B94028FB14006092E1BB7278691977616A028EDEB94A0778` |

El plan deberá seleccionar casos reales del catálogo y datos sintéticos con expectativas
contrastadas con estas fuentes. Los ejemplos y requisitos actuales no acreditan todavía
compatibilidad del runtime, cobertura funcional, rendimiento ni conformidad regulatoria.
