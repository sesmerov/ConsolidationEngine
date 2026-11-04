# Contrato del perfil semántico ampliado

Fecha: 2026-11-04. Estado: diseño, pendiente de implementación y pruebas del motor.
Requisitos principales: FR-024–029, FR-036 y SC-004/006 de [spec.md](../spec.md).

## 1. Perfiles y selección

- `ce-dpmxl-0.9-closed-v1`: conserva el [contrato anterior](../../001-regulatory-validation/contracts/language-profile.md), incluido el recálculo booleano existente y el rechazo de condicionales/texto/fechas. Sigue asociado a `ce-report-1`.
- `ce-dpmxl-0.9-closed-v2`: usado por `eba-corep-of-4.0-ca1-v1` y `ce-demo-types-1`. Añade evaluación de los tipos y construcciones definidos aquí. Solo permite recálculos numéricos que superen las comprobaciones de elegibilidad.
- El adaptador del servidor selecciona el perfil; un campo aportado por el cliente no permite cambiarlo. No hay migración silenciosa de snapshots ni equivalencia entre perfiles.
- Resultado, configuración, previsualización y aplicación conservan `profileId`. Cachés de parseo, tipado y elegibilidad incluyen el perfil y la identidad del snapshot cuando dependen de coordenadas.
- Se conserva ANTLR 4.13.2, gramática original, expresión única y EOF. Una recuperación sintáctica nunca autoriza ejecución.

## 2. Valores y tipos

| Tipo | Valor normalizado de intercambio | Unidad / precisión |
|---|---|---|
| `number` | `{numerator:string, denominator:string}` reducido, denominador positivo | Las actuales, con cálculo racional exacto. |
| `boolean` | `true` o `false` | Reglas del formato existente; no se recalcula en v2. |
| `text` | `{kind:"text", value:string}` | `unit:""`, `decimals:""`. |
| `date` | `{kind:"date", value:"YYYY-MM-DD"}` | `unit:""`, `decimals:""`. |

La ausencia se mantiene como `presence:"null"` o ausencia de hecho para una coordenada
declarada, nunca como la cadena `"null"`. El tipo sigue en `Coordinate.dataType`.
Un hecho nulo no lleva `normalizedValue`. Se conservan `originalText` y localizador para
los valores presentes. Las fechas exportadas pueden cambiar de representación física
—serial Excel a ISO— sin cambiar su valor civil; el original permanece en la trazabilidad.

No se permite coerción texto→número, número→fecha ni booleano→número. Los formatos de
Excel no cambian el tipo declarado por el perfil. No se usan `Number` ni `Date` para
representar importes. Un objeto de tipo nuevo dentro de un snapshot v1 se rechaza.

## 3. Texto

- Se admiten `STRING_LITERAL` y `EMPTY_LITERAL`, usando comillas simples o dobles según la gramática. Se retira únicamente el delimitador; no se inventa un sistema de escapes.
- El contenido conserva mayúsculas, espacios, saltos de línea y Unicode. No se aplica `trim`, cambio de mayúsculas, normalización Unicode ni reglas de colación.
- `=` y `!=` comparan el contenido exacto de dos textos. `"Banco"`, `"banco"` y `"Banco "` son distintos; `""` es un valor informado distinto de nulo.
- `<`, `<=`, `>`, `>=`, aritmética, concatenación, regex y funciones de cadena fuera de este contrato producen diagnóstico; no se implementan por coerción.
- Se mantiene el límite de 32 767 caracteres por celda y la protección XML. Los valores con apariencia de fórmula se conservan como texto y se exportan como celdas literales.

## 4. Fecha civil

- Literal admitido: `#YYYY-MM-DD#`, años 0001–9999, mes y día válidos en calendario gregoriano, incluyendo bisiestos. La validez se comprueba semánticamente: la gramática por sí sola acepta algunas fechas imposibles.
- `#2025-02-29#`, día 00 y año 0000 producen `INVALID_DATE`. La restricción de v2 no modifica retroactivamente el validador administrativo de v1.
- La forma con hora `#2025-12-31T12:00:00#`, los periodos y los intervalos temporales siguen siendo construcciones no admitidas, aunque tengan sintaxis válida.
- Dos fechas admiten `=`, `!=`, `<`, `<=`, `>`, `>=` según su orden civil. No hay zona horaria, hora local, aritmética de fechas ni conversión implícita desde texto.
- La importación conoce el tipo por el perfil. Puede convertir un serial entero Excel mediante la política 1900/1904 existente; rechaza serial 60 del sistema 1900, fracciones de día, fechas fuera de rango y formatos ambiguos. El formato visual de una celda no basta para inferir una fecha.

## 5. Condicionales y tipado

Nuevo nodo de expresión: `if`, con condición, rama `then`, rama `else` opcional y spans
de origen. Nuevos nodos literales: `text` y `date`. Todos los recorridos cerrados del AST
deben reconocerlos explícitamente; no se permite traversal genérico que omita controles.

1. El parseo comprueba los tipos que se conocen por los literales y operadores.
2. Tras resolver una instancia, el tipado usa los tipos de sus coordenadas. Comprueba condición y ambas ramas, incluidas las inactivas, sin leer ni ejecutar valores de esas ramas.
3. La condición debe ser booleana; las ramas deben tener el mismo tipo, con ausencia tipada compatible. Una referencia inexistente o tipo indeterminado impide completar la comprobación y no se convierte en permiso de recálculo.
4. Con condición `true`, se evalúa solo `then`; con `false`, solo `else`. Un error dinámico en la rama omitida —por ejemplo `1/0`— no se ejecuta. Una incompatibilidad estructural de tipos sí se diagnostica aunque afecte a esa rama.
5. Si falta `else` y la condición es falsa, el condicional devuelve ausencia derivada del tipo de `then`. La gramática permite esta forma; no se transforma en `false` ni cero.
6. Condición nula o desconocida devuelve un resultado desconocido del tipo de las ramas y `CONDITIONAL_NOT_EVALUABLE`, sin elegir rama. El desconocimiento no se rescata mediante `default` o `nvl`; la regla queda `not_evaluable`.
7. Una condición no booleana o ramas incompatibles producen `TYPE_MISMATCH`. La expresión completa de una regla o precondición debe producir booleano o ausencia; un texto, fecha o número sin comparación no es una regla válida.

Las lecturas de la explicación son las realizadas por la condición y la rama ejecutada;
no se fabrican lecturas de valores de la rama omitida. El análisis estructural puede
consultar declaraciones de coordenadas de ambas ramas sin registrarlas como hechos leídos.

## 6. Ausencia, opciones y operaciones existentes

- Comparar un dato nulo produce ausencia booleana, no aprobación. Se conservan Kleene y la distinción entre un hecho ausente y metadatos desconocidos.
- `isnull` admite los cuatro tipos. `nvl` admite dos operandos del mismo tipo, conservando la distinción entre nulo y desconocido. No convierte tipos para lograr compatibilidad.
- Los valores `default` de texto o fecha deben ser literales válidos del mismo tipo de la coordenada; `default:null` conserva la ausencia tipada. `default:0` no es un valor por defecto válido para texto o fecha.
- `sum` y los operadores aritméticos siguen siendo exclusivamente numéricos. Las políticas de racionales, unidades, promoción contextual de literales numéricos, precisión, redondeo al par e intervalos se heredan sin cambios.
- `interval:true` sobre referencias de texto o fecha produce `TYPE_MISMATCH`; `interval:false` no cambia su valor. Las opciones numéricas no crean tolerancias para textos o fechas.
- No se añade un literal nulo independiente si la gramática no lo admite. No se añaden variables supuestamente estándar para entidad o fecha del contexto.

## 7. Política de recálculo y elegibilidad

La política se calcula sobre **toda** la expresión y su precondición formal, después
de resolver los tipos necesarios, antes de aceptar cualquier dirección. Se consideran
opciones de selección y literales por defecto, referencias, llamadas y ramas inactivas.
El destino numérico o el resultado de una ejecución no permiten eludir esta clasificación.

| Motivo | Detección |
|---|---|
| `CONDITIONAL` | Cualquier nodo `if` en expresión o precondición, incluso anidado. |
| `TEXT` | Literal, opción, operación o referencia resuelta de tipo texto, incluso dentro de `isnull`. |
| `DATE` | Literal, opción, operación o referencia resuelta de tipo fecha. |

Con cualquiera de esos motivos: `mode:"validation_only"`, razón estable
`RULE_VALIDATION_ONLY` y motivos ordenados `CONDITIONAL`, `TEXT`, `DATE` sin duplicados.
La interfaz presenta «Solo validación» y ambos lados son inelegibles. Nunca se inspeccionan
descripciones, campos de procedencia ni fechas administrativas de vigencia para decidirlo.

Sin exclusiones y con tipos resueltos: `mode:"standard"`. Esto solo autoriza a comprobar
las restricciones numéricas normales, no garantiza un destino. Una desigualdad, un
destino compuesto, una autorreferencia o un resultado incompatible siguen siendo
inelegibles por sus diagnósticos habituales. Si el AST o los tipos no se pueden resolver:
`mode:"undetermined"`, ambos lados inelegibles y diagnóstico explicativo.

Para v2, una dirección requiere igualdad en la raíz tras retirar grupos/`with`, una
sola celda numérica como destino, fuente numérica compatible, ausencia de autorlectura
prohibida y todas las comprobaciones existentes de instancia/contexto/vigencia.
Las reglas v1 siguen sus comprobaciones anteriores, sin aceptar nodos ni tipos v2.

## 8. Aplicación en todas las entradas del sistema

| Entrada | Comportamiento obligatorio |
|---|---|
| Consulta de resultados/destinos | Política calculada por el servidor, sin controles de recálculo para exclusiones. |
| Guardar configuración | `resolveDirection` aplica la política común. `INVALID_DIRECTION`, con diagnóstico `RULE_VALIDATION_ONLY`, rechaza el reemplazo completo sin publicar snapshot. |
| Simular | Antes del grafo, comprobar todas las direcciones configuradas. Si alguna es excluida o indeterminada, abortar sin publicar previsualización ni propuestas, ni siquiera bloqueadas. |
| Aplicar | Repetir la comprobación con snapshot/perfil actuales; un preview antiguo o manipulado no concede elegibilidad. Sin parches ni publicación parcial al fallar. |
| Publicación principal | Comprobar de nuevo identidad de base, perfil, configuración y selección junto a cancelación/cuotas; mantener la publicación atómica existente. |
| Revalidación | Tras cambios numéricos, evaluar también las reglas solo de validación con los nuevos datos; no convertirlas en productores del grafo. |

No se eliminará silenciosamente una dirección prohibida de una petición mixta: se
rechaza toda esa operación. El usuario conserva la versión anterior y recibe un motivo.
Una exclusión absoluta es distinta de un conflicto numérico o ciclo: estos últimos
siguen teniendo las propuestas bloqueadas explicativas y ramas independientes del modelo anterior.

## 9. Casos de aceptación obligatorios

- Condicional verdadero/falso, anidado, sin `else`, condición nula/desconocida, error dinámico en rama inactiva, incompatibilidad estática en rama inactiva y presupuesto de profundidad/trabajo.
- Texto vacío/nulo, mayúsculas, espacios, acentos y contenido literal parecido a fórmula; igualdad sin coerción y rechazo de ordenación o funciones no soportadas.
- Fecha bisiesta válida/inválida, días y años límite, orden civil, literal con hora no admitido y conversión 1900/1904 sin diferencias de zona horaria.
- Igualdad con destino numérico y condicional numérico en la fuente; texto/fecha solo en precondición; referencia tipada sin literal textual; exclusión en rama inactiva. Todos validan cuando corresponda, pero no generan destinos ni propuestas.
- Petición directa, configuración mixta, configuración obsoleta, preview manipulado y entrada interna del worker: rechazo sin mutar datos. Ninguna prueba se limita a ocultar un botón.
- Regla puramente numérica con descripción textual y fechas de vigencia: puede seguir siendo elegible. Estas fechas no cuentan como operaciones de fecha.
- Regresiones v1, incluidas sus propuestas booleanas, exactitud, nulos, intervalos, Kahn, ciclos, cancelación y exportaciones anteriores.

El [corpus de diseño](demo-corpus.json) fija ejemplos y oráculos. La sintaxis verificada
en planificación no acredita implementación de este contrato ni conformidad DPM-XL completa.
