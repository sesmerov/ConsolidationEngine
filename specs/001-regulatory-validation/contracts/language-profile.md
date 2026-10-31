# Contrato del perfil de lenguaje y cálculo

Identificador: `ce-dpmxl-0.9-closed-v1`. Estado: diseño; sin implementación comprobada.
Fuentes y alternativas: [research.md](../research.md), R2–R4.

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
| `with`, `default`, `interval` | Ámbito estático sobre tablas cerradas. |
| `isnull`, `nvl` | Tipos compatibles; no ocultan errores ni falta de soporte. |
| `sum` y rangos finitos | Solo coordenadas del catálogo; no joins ni agrupaciones generales. |
| `s*` | Binding por cada hoja declarada del catálogo cerrado. |

Una regla contiene una sola expresión cuyo resultado final es booleano o null. Scripts,
asignaciones `:=`/`<-`, variables, operaciones referenciadas, grupos de tablas, `where`, `group by`,
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

`with` aporta tabla, coordenadas, default e interval. Una selección parcial hereda las coordenadas
de la misma tabla; si declara una tabla distinta no hereda fila/columna/hoja de la anterior, aunque
sí las opciones default e interval. Un override más local prevalece. Una referencia ambigua entre
módulos no elige la primera coincidencia: `AMBIGUOUS_REFERENCE`.

Los rangos son inclusivos sobre códigos existentes, ordenados ordinalmente por sus caracteres;
no son secuencias de enteros. `s*` recorre hojas finitas en ese mismo orden. El catálogo debe
contener las coordenadas y su metadato aunque falte el hecho. Coordenada válida sin fila en Facts
es null implícito; coordenada que no existe en Coordinates no es null: `UNKNOWN_COORDINATE`.
Una selección múltiple solo puede consumirse por `sum` o por el binding explícito de la regla.
No se elige una celda de ella ni se aplica un producto cartesiano implícito.

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
es `pure`. `default` adopta tipo/unidad de la coordenada. EUR y USD no son intercambiables;
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
Falta de soporte o metadatos → `not_evaluable`; aritmética inválida → `error`.
La precondición ausente equivale a true. La validación inicial nunca espera recálculos.

## Direcciones, simulación y aplicación

Solo una igualdad con un lado de una única celda puede tener dirección. El usuario selecciona
ese lado para una instancia concreta; el otro lado debe ser calculable sin leer el destino.
La regla debe estar activa/aplicable y su precondición ser true en la versión simulada.

El nominal exacto del lado calculado se cuantiza al `decimals` del destino con half-even.
Con `INF` se exige decimal finito; un racional periódico no tiene propuesta. Tanto con INF como
con precisión finita, el valor exportable debe respetar ce-report-1 (128 dígitos significativos y
128 posiciones decimales); en otro caso se devuelve `OUTPUT_VALUE_LIMIT`, aunque el racional interno
quepa en 4096 bits. La propuesta muestra
valor anterior, nominal exacto, intervalo derivado, valor cuantizado, precisión y política
`half-even-v1`. El dato que leerán los consumidores es el valor cuantizado con la precisión del
destino, exactamente como se exportaría. La regla originaria se reevalúa con el candidato:
si no pasa, se informa `CANDIDATE_DOES_NOT_SATISFY_RULE` y no se ofrece como aplicable.

Para obtener el grafo se expanden estáticamente todas las lecturas del lado calculado,
precondición y ámbito admitido. Se crean nodos por dirección/instancia y aristas del productor
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
| `1=1 @` | Error léxico, aunque una parte tenga árbol válido. |

Son resultados esperados para futuras pruebas, no pruebas ya ejecutadas.
