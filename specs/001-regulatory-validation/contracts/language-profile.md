# Contrato del perfil de lenguaje y cálculo

Identificador: `ce-dpmxl-0.9-closed-v1`. Estado: diseño; sin implementación comprobada.
Fuentes y alternativas: [research.md](../research.md), R2–R4 y R8.

## Frontera sintáctica

El texto original de `Expression` y `Precondtion` se analiza con las gramáticas EBA v0.9.
Se exige `start`, consumo completo y cero errores de lexer/parser. Un error recuperado produce
`SYNTAX_ERROR`, con línea, columna y tramo original; no se evalúa el árbol parcial.
El visitor construye un AST tipado de la siguiente lista; cualquier otra construcción genera
`UNSUPPORTED_CONSTRUCT` y resultado `not_evaluable`, aunque ANTLR la reconozca.

| Construcción admitida | Condición |
| --- | --- |
| Literal numérico y booleano | Número racional exacto; nunca código ejecutable. |
| Paréntesis, signos unarios, `+ - * /` | Operandos compatibles y límites numéricos respetados. |
| `= != < <= > >=`, `and or not` | Semántica inferior; se conserva la sintaxis que exige la gramática. |
| Referencia a celda dentro/entre tablas | Resolución inequívoca en el contexto seleccionado. |
| Selector de indicador de presentación | Solo `PRECONDITION_ELEMENT` de la gramática, como `{v_C_01.00}`, convertido en AST `filing_indicator`. |
| `with`, `default`, `interval` | Ámbito estático sobre tablas cerradas. |
| `isnull`, `nvl` | Tipos compatibles; no ocultan errores ni falta de soporte. |
| `sum` y rangos finitos | Solo coordenadas del catálogo; no joins ni agrupaciones generales. |
| `s*` | Binding por cada hoja declarada del catálogo cerrado. |

Una regla contiene una sola expresión cuyo resultado final es booleano o null. Scripts,
asignaciones `:=`/`<-`, variables genéricas, operaciones referenciadas, grupos de tablas, `where`, `group by`,
operadores temporales y selecciones dimensionales generales están fuera del perfil. Las direcciones
de recálculo se configuran aparte; reconocer un token de asignación no habilita escritura.

La gramática suministrada admite `default:null`, pero su regla `literal` no incluye
`NULL_LITERAL`: `null` como expresión independiente y `isnull(null)` son errores sintácticos.
No se modifica la gramática ni se elude el parser para admitirlos. Los nulos de datos y los
resultados nulos sí se conservan; las notaciones con argumentos null en la sección semántica
describen valores, no expresiones que deban aceptarse literalmente como entrada.

## Resolución de referencias y ámbito

La identidad de un hecho es `(contextId, tableCode, sheetCode, rowCode, columnCode)`, con un
contexto que fija entidad, fecha y módulo/versión. Los prefijos DPM `t/r/c/s` pertenecen a la
expresión y se separan de los códigos del [workbook](workbook.md).

Para selecciones de celdas, `with` aporta tabla, coordenadas, default e interval. Una selección parcial hereda las coordenadas
de la misma tabla; si declara una tabla distinta no hereda fila/columna/hoja de la anterior, aunque
sí las opciones default e interval. Un override más local prevalece. Una referencia ambigua entre
módulos no elige la primera coincidencia: `AMBIGUOUS_REFERENCE`.

Para crossModule se aplica una política **local** del perfil: se crea una instancia por cada
contexto aplicable, y las lecturas de hechos pueden resolverse en los contextos compatibles
declarados que requiera la regla. Tablas/coordenadas con más de una resolución posible producen
`AMBIGUOUS_REFERENCE`; no se escoge el primer contexto ni se unen hechos por parecido. Los
filingIndicators se consultan únicamente en el contexto de esa instancia, incluso cuando sus
hechos procedan de otros contextos; no se fusionan indicadores. Las claves canónicas del contexto
aplicable y del conjunto de contextos de resolución ordenado forman parte de la identidad, junto
al contenido de la regla y su binding; los alias contextId y el orden de importación no la cambian.
Esta decisión acota la ejecución del producto y no se atribuye a la EBA.

Los rangos son inclusivos sobre códigos existentes, ordenados ordinalmente por sus caracteres;
no son secuencias de enteros. `s*` recorre hojas finitas en ese mismo orden. El catálogo debe
contener las coordenadas y su metadato aunque falte el hecho. Coordenada válida sin fila en Facts
es null implícito; coordenada que no existe en Coordinates no es null: `UNKNOWN_COORDINATE`.
Una selección múltiple solo puede consumirse por `sum` o por el binding explícito de la regla.
No se elige una celda de ella ni se aplica un producto cartesiano implícito.

## Indicadores de presentación

El visitor solo admite el caso sintáctico `PRECONDITION_ELEMENT` para crear un nodo
`filing_indicator`. Quita exactamente el prefijo `v_` del token y conserva el resto, incluidos
sufijos y mayúsculas: `{v_C_01.00}` consulta la clave `C_01.00` de
`ReportContext.filingIndicators`. Este soporte no habilita variables ni operaciones genéricas.
El código es una unidad de reporte/indicador declarada, no una equivalencia supuesta con
tableCode ni con Variable.Code. Una referencia se resuelve exclusivamente en el contexto de la
instancia; no se busca la primera coincidencia en otros contextos.

El indicador es metadato booleano explícito. No lee Facts ni Coordinates y no hereda tabla,
fila, columna, hoja, default o interval de `with`. Un true sin hechos sigue siendo true;
un false explícito puede hacer que la precondición sea false y la regla `not_applicable`.
Un código ausente produce unknown, con lógica ternaria: `false and unknown = false`,
`true or unknown = true`, `true and unknown = unknown`, `not(unknown) = unknown`.
Si el resultado desconocido impide decidir la aplicabilidad o el resultado, se devuelve
`not_evaluable` con `MISSING_FILING_INDICATOR`; no se convierte en false ni en null de un hecho. `default`, `nvl` e `isnull` no sustituyen
un indicador desconocido ni convierten su ausencia en un booleano conocido.
Si la lógica determina el resultado pese a la ausencia, se conserva esa ausencia en la traza
de metadatos, sin reemplazar el resultado determinista por `not_evaluable`.

Las trazas registran contexto, código, valor declarado o ausencia y localizador de Contexts.
Estas lecturas no generan FactKeys ni aristas del grafo de productores y nunca son destinos
recalculables. Cambiar indicadores crea otra versión del snapshot e invalida previews de la
base anterior. Las expresiones y precondiciones EBA se conservan intactas.

## Racionales, precisión y unidades

Representación interna normalizada `(n, d)`, `d > 0`, `gcd(abs(n), d) = 1`; cero es `0/1`.
En JSON ambos enteros son cadenas. No hay redondeo intermedio ni `NaN`/infinito numérico.
El lexema original se conserva separado del valor normalizado.

Cada valor numérico calculado mantiene `nominal`, `lo` y `hi`. Con `interval:false`,
`lo = hi = nominal`. Con `interval:true`, un hecho con precisión p tiene radio `10^-p/2`;
`p=INF` da radio cero. La precisión describe incertidumbre: importar un valor no exige que
ya sea múltiplo de `10^-p`. Los literales son puntos exactos. Si `interval` se omite, es false.
Precisión necesaria ausente produce `MISSING_PRECISION`, no un epsilon implícito.

La compatibilidad de unidades es una política local explícita: cada unidad es un mapa de
átomos a exponentes enteros; `pure` es el mapa vacío. Suma/resta y comparación de hechos requieren
unidades idénticas. Multiplicar/dividir suma/resta exponentes. Un literal numérico puede adoptar
la unidad del otro operando en suma, resta o comparación (`importe > 0`); como factor o divisor
es `pure`. `default` adopta tipo/unidad de la coordenada. En `nvl`, un literal numérico también
puede adoptar la unidad conocida de la otra rama, incluso si esta es un null tipado:
`nvl(nullEUR,0)` produce cero EUR; dos literales permanecen pure. Una vez adoptada la unidad,
el resultado no se trata como literal libre para otra unidad. Esta política local no sustituye
indicadores desconocidos ni oculta errores. EUR y USD no son intercambiables;
no hay conversión de moneda. Un resultado destinado a una celda debe coincidir con su unidad.

## Aritmética de intervalos

Para X=[a,b], Y=[c,d], cerrados y con a≤b, c≤d:

| Operación | Intervalo resultante |
| --- | --- |
| X + Y | [a+c, b+d] |
| X - Y | [a-d, b-c] |
| -X | [-b, -a] |
| X * Y | [min(ac,ad,bc,bd), max(ac,ad,bc,bd)] |
| X / Y | [min(a/c,a/d,b/c,b/d), max(a/c,a/d,b/c,b/d)], solo si 0 no pertenece a Y |

El nominal se calcula por separado usando los nominales. Un divisor puntual cero o cuyo intervalo
contenga cero produce `DIVISION_BY_ZERO`. Se aplica a intervalos mixtos punto/rango por igual.

**Diferencia conocida del perfil:** estas fórmulas de multiplicación/división usan extremos,
frente a las fórmulas inconsistentes observadas en Operators v0.9 p.34. El detalle y las fuentes
están en research R3. No se afirma equivalencia literal con toda la documentación EBA.

Las comparaciones siguientes reflejan Operators pp.39–43 para intervalos simétricos y se extienden
a los límites calculados por este perfil:

| Expresión | Resultado, si ambos operandos son conocidos |
| --- | --- |
| X = Y | a≤d y c≤b: hay solape, incluidos los extremos. |
| X != Y | Negación del solape. |
| X > Y | b>c |
| X >= Y | b≥c |
| X < Y | a<d |
| X <= Y | a≤d |

No es un orden total: X>Y y X<Y pueden ser verdaderas a la vez. La igualdad no es transitiva.
No se simplifica `not(X>Y)` a `X<=Y`. Claves, hashes, conflictos y orden usan identidad exacta,
nunca estas comparaciones de intervalos.

## Nulos y resultados

Null explícito e implícito tienen igual semántica, pero distinta procedencia. Aritmética y
comparación con null producen null. `isnull(null)=true`; `isnull(valor)=false`.
`nvl(a,b)` devuelve b solo cuando a es null y exige tipo/estructura compatibles.
Una opción `default` sustituye null al resolver la selección; `default:null` conserva null.
Un error, una referencia inexistente o una función no soportada no se convierten en null.

| A | B | A and B | A or B |
| --- | --- | --- | --- |
| true | true | true | true |
| true | false | false | true |
| true | null | null | true |
| false | false | false | false |
| false | null | false | null |
| null | null | null | null |

Las operaciones son conmutativas; `not(null)=null`. `sum` excluye null. Para una selección vacía
o cuyos elementos son todos null, el perfil devuelve null con diagnóstico `EMPTY_AGGREGATION`;
es una decisión local documentada, no una regla EBA inferida. Una expresión exterior como
`isnull(sum(...))` puede seguir siendo determinista.

Aplicabilidad se resuelve antes del resultado: inactiva/fuera de contexto/fuera de vigencia o
precondición false → `not_applicable`; precondición null → `not_evaluable`; precondición con error
→ `error`. Una regla aplicable true → `pass`, false → `fail`, null → `not_evaluable`.
Falta de soporte o metadatos necesarios para decidir → `not_evaluable`; aritmética inválida → `error`.
La precondición ausente equivale a true. La validación inicial nunca espera recálculos.

La identidad estructural de instancia es independiente del resultado de su precondición actual.
Si el cuerpo está soportado y su binding finito puede determinarse, false o indeterminado no
eliminan esa identidad. La validación con precondición false no ejecuta el cuerpo: conserva la
instancia con `not_applicable`; una indeterminada conserva `not_evaluable`, sin suponer true.
La falta de soporte, los errores sintácticos o la imposibilidad de obtener un binding válido
siguen visibles en cobertura y no se convierten en instancias ejecutables ficticias.

La evidencia distingue los operandos/resultados efectivos de las lecturas originales `factReads`.
Cada lectura conserva coordenada, presencia, valor exacto cuando exista, precisión y procedencia
del snapshot antes de default/interval. No se fabrican lecturas de un cuerpo que no se ejecutó,
ni un intervalo único de origen si una celda se consulta con opciones distintas. Las lecturas de
indicadores siguen en metadataReads, conforme al [contrato HTTP](http-api.md#formatos-comunes).

## Direcciones, simulación y aplicación

Solo una igualdad con un lado de una única celda puede tener dirección. El usuario selecciona
ese lado para una instancia concreta; el otro lado debe ser calculable sin leer el destino.
El destino puede ser una coordenada `number` o `boolean` de ce-report-1; un indicador de
presentación es metadato y nunca es un destino recalculable.
La elegibilidad de la dirección se basa en estructura, actividad y vigencia; no se reduce a
instancias cuyo resultado inicial sea pass/fail. Conservar una instancia con precondición false
o indeterminada permite volver a comprobarla durante la simulación, después de sus productores.
Solo se ofrece un cambio aplicable cuando la regla y su contexto siguen siendo válidos y la
precondición es true en esa versión simulada; esto permite el caso V09 false→true por productor.

Para un destino number, el nominal exacto del lado calculado se cuantiza al `decimals` del
destino con half-even.
Con `INF` se exige decimal finito; un racional periódico no tiene propuesta. Tanto con INF como
con precisión finita, el valor exportable debe respetar ce-report-1 (128 dígitos significativos y
128 posiciones decimales); en otro caso se devuelve `OUTPUT_VALUE_LIMIT`, aunque el racional interno
quepa en 4096 bits. La propuesta muestra
valor anterior, nominal exacto, intervalo derivado, valor cuantizado, precisión y política
`half-even-v1`. El dato que leerán los consumidores es el valor cuantizado con la precisión del
destino, exactamente como se exportaría.

Para un destino boolean, el lado calculado debe producir un booleano conocido, true o false,
del mismo tipo que la coordenada. Se propone ese valor directamente: no tiene unidad, decimals,
cuantización ni política half-even. `exactNominal` y `derivedInterval` solo existen en propuestas
numéricas. Un resultado null, unknown o de tipo incompatible bloquea la propuesta con su motivo;
no se convierte a booleano ni se interpreta cero/uno como false/true. Los consumidores leen el
booleano que se aplicaría. Estas condiciones no convierten indicadores en destinos de escritura.

Para ambos tipos, la regla originaria se reevalúa con el candidato:
si no pasa, se informa `CANDIDATE_DOES_NOT_SATISFY_RULE` y no se ofrece como aplicable.

Para obtener el grafo se expanden estáticamente todas las lecturas de hechos del lado calculado,
precondición y ámbito admitido. Las lecturas de indicadores se conservan aparte como metadatos
de la versión, sin aristas ni productores de hechos. Se crean nodos por dirección/instancia y aristas del productor
al consumidor. Dos productores de la misma clave son conflicto incluso si proponen igual valor.
Se bloquean sus consumidores antes de ejecutar Kahn. La cola de Kahn ordena claves canónicas,
no filas de origen. En el residuo, Tarjan identifica SCC de más de un nodo o con autociclo;
los demás nodos son descendientes bloqueados. Las ramas independientes continúan.

Un productor cuya precondición no resulte true no habilita consumidores que lo esperaban;
estos quedan bloqueados con causa. No se usa su valor anterior como sustitución silenciosa.
Una lectura propia en precondición crea autociclo conservador. No se itera hasta converger.
La selección aceptada debe contener toda su clausura de antecesores. Tras la confirmación,
se revalida el conjunto aplicable completo sobre el candidato antes de publicar la nueva versión.

## Límites y casos de referencia

Límites locales por expresión: 32.768 caracteres, 8.192 tokens/nodos AST, profundidad 128.
Racionales normalizados: 4.096 bits por numerador/denominador; comprobar también crecimiento antes
de operar. Un trabajo admite hasta 1.000.000 instancias o aristas expandidas y 10.000.000 lecturas
de hechos, además del límite temporal de 60 segundos. Exceder una cuota produce diagnóstico
`RESOURCE_LIMIT` y ejecución incompleta; nunca resultado global aprobado.

| Caso | Esperado |
| --- | --- |
| 0.1 + 0.2; (1/3)*3, puntuales | 3/10; 1 exactos. |
| [-3,-2]*[4,5] | [-15,-8]. |
| [4,6]/[2,3]; [1,1]/[3,3] | [4/3,3]; [1/3,1/3]. |
| División por [-1,1] | Error. |
| [0,1]=[1,2] | true, borde incluido. |
| [0,1]=[.5,1.5], [.5,1.5]=[1.25,2.25], [0,1]=[1.25,2.25] | true, true, false. |
| half-even de 1.005 y 1.015 a p=2 | 1.00 y 1.02. |
| A=1/3 a p=2; D=A*3 a p=2, con interval:true | A=0.33; D=0.99; ambas igualdades pasan al revalidar sus intervalos. |
| A=1/3 a p=2, con interval:false | Sin propuesta aplicable: 0.33 no satisface la igualdad puntual con 1/3. |
| Igualdad con destino boolean false y lado calculado true conocido | Propuesta true sin precisión ni redondeo; revalidar la igualdad antes de ofrecerla. |
| Destino boolean con lado calculado null, unknown o number | Propuesta bloqueada; no conversión implícita a booleano. |
| `1=1 @` | Error léxico, aunque una parte tenga árbol válido. |
| Indicador declarado true/false | La selección devuelve respectivamente true/false; false en la precondición puede dar `not_applicable`. |
| Indicador ausente necesario para decidir | unknown y `not_evaluable`, con `MISSING_FILING_INDICATOR`. |
| Indicador true sin ninguna fila Facts | El indicador sigue siendo true; los hechos de la expresión se resuelven por separado. |
| false and indicador ausente, en precondición | false y `not_applicable`, conservando la ausencia en la traza de metadatos. |
| crossModule con dos contextos aplicables e indicadores distintos | Instancias separadas; cada una usa su propio mapa y solo resuelve hechos inequívocos de contextos compatibles requeridos. |
| Renombrar alias contextId o permutar contextos/filas sin cambiar contenido | Identidades y resultados semánticos iguales; una resolución ambigua sigue siendo diagnóstico. |

Son resultados esperados para futuras pruebas, no pruebas ya ejecutadas.
