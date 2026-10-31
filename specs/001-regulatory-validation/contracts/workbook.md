# Contrato de libros Excel

Versión: `ce-report-1`. Estado: diseño; la plantilla `.xlsx` se generará en implementación.
Todos los archivos son `.xlsx`. El catálogo EBA y los informes tienen formatos distintos.

## Plantilla de informes propia

Hojas exactas: `Instructions`, `Contexts`, `Coordinates`, `Facts`. Fila 1 contiene las cabeceras
exactas, sin celdas combinadas en tablas de datos. El orden de filas no tiene significado.
`Instructions` contiene instrucciones en español, versión, ejemplo sintético y explicación de
null/ausencia/precisión e indicadores de presentación declarados. No se importa como hechos.
No se ejecuta ninguna fórmula del libro.

### Contexts

| Columna | Tipo y validación |
| --- | --- |
| templateVersion | Texto literal `ce-report-1`. |
| contextId | Texto único en el lote, 1–64 caracteres alfanuméricos, guion o guion bajo. |
| entityId | Identificador textual de la entidad, no datos personales del analista. |
| referenceDate | Texto ISO `YYYY-MM-DD`, fecha válida sin hora ni zona. |
| submissionDate | ISO o vacío si ninguna vigencia aplicable lo necesita. |
| framework | Texto del contexto regulatorio, por ejemplo `COREP`. |
| moduleVersion | Identificador exacto, por ejemplo `COREP_OF_4.2`. |
| filingIndicators | Texto JSON: objeto de códigos exactos de indicador de presentación/unidad de reporte, sin prefijo `v_`, a valores booleanos; por ejemplo `{"C_01.00":true,"C_05.01":true}`. Celda vacía equivale a `{}`. |

Un lote tiene una entidad y fecha de referencia. Incluir varios módulos en Contexts constituye la
declaración expresa del usuario de que esos contextos forman el conjunto compatible que desea
validar; la importación muestra esa lista para comprobarla. No acredita compatibilidad regulatoria
por sí misma ni permite inferir módulos adicionales. Repetir el mismo contextId entre archivos exige que todos sus atributos
coincidan. No se fusionan contextos por semejanza. Si una regla requiere fecha de remisión y falta,
queda no evaluable; no se sustituye por la fecha del ordenador.

Para reglas crossModule, el perfil local crea una instancia por contexto aplicable. Esa instancia
puede resolver hechos de los contextos compatibles declarados y requeridos por la regla; sus
indicadores de presentación proceden solo de su propio contexto, sin fusionar mapas. Una tabla
o coordenada ambigua entre contextos produce diagnóstico, nunca selección por orden de archivo.
La identidad usa claves canónicas y contextos ordenados, no los alias contextId; el detalle es
política local del [perfil](language-profile.md#resolución-de-referencias-y-ámbito), no una
afirmación de equivalencia regulatoria.

`filingIndicators` es la última columna de Contexts; la plantilla conserva sus cuatro hojas y
su versión `ce-report-1`, todavía en desarrollo. El objeto admite únicamente claves no vacías
y valores JSON `true`/`false`: no cadenas, números, null ni claves duplicadas. Se conservan
mayúsculas y sufijos del código, sin añadir ni quitar prefijos de tabla. Un código identifica
la unidad de reporte indicada por la precondición; no se presupone que sea un tableCode ni un
Variable.Code del modelo DPM.

Un mapa vacío o un código ausente significa **no declarado**, nunca false. La presencia de
Coordinates, Facts o un importe distinto de cero no permite deducir el indicador. Un true
explícito sigue siendo true aunque no existan hechos. El lector conserva procedencia de esta
celda como metadato de contexto; el [perfil](language-profile.md#indicadores-de-presentación)
define su lógica ternaria y `MISSING_FILING_INDICATOR`. Repetir un contexto exige el mismo mapa
canónico, además de los restantes atributos; un mapa inconsistente rechaza el lote. El orden de
claves JSON no cambia su contenido. Cualquier cambio del mapa versiona el snapshot y su hash.

### Coordinates

Una fila declara una coordenada válida, aunque carezca de hecho en Facts.

| Columna | Tipo y validación |
| --- | --- |
| contextId | Referencia a Contexts. |
| tableCode | Código textual sin prefijo `t`, por ejemplo `C_01.00`. |
| sheetCode | Código textual sin prefijo `s`; vacío significa tabla sin eje de hoja. |
| rowCode | Texto sin prefijo `r`, por ejemplo `0230`; conservar ceros. |
| columnCode | Texto sin prefijo `c`, por ejemplo `0010`; conservar ceros. |
| dataType | `number` o `boolean`. Otros tipos se diagnostican como fuera del perfil. |
| unit | Para number: `pure` o unidad canónica, por ejemplo `EUR`; boolean: vacío. |
| decimals | Para number: texto entero -18…18 o `INF`; boolean: vacío. |
| axes | Objeto JSON de claves/miembros DPM como texto, o `{}`; metadatos de la hoja. |

Unit usa `pure` o una composición de átomos ASCII `[A-Z][A-Z0-9_]{0,15}` con exponentes enteros
de -8 a 8, separados por `*`; se omite `^1`. Ejemplos: `EUR`, `EUR*SHARE^-1`.
Los átomos deben ser únicos, ordenados alfabéticamente y sin exponentes cero; un mapa vacío se
escribe `pure`. Espacios, átomos repetidos o sintaxis distinta producen `INVALID_UNIT`.
El parser interno obtiene el mapa de exponentes; no se interpreta texto libre ni se convierte moneda.

Las tablas de esta versión son cerradas. La clave completa debe ser única en todo el lote.
El catálogo declara todas las coordenadas necesarias para cada rango o `s*` usado: nunca se
construye solo con los hechos presentes. Una tabla sin eje de hoja usa exclusivamente sheetCode
vacío; una tabla con hojas usa códigos no vacíos. Todos los registros de una misma hoja tienen
los mismos axes; sus claves se ordenan canónicamente. Conservar axes no habilita filtros por miembros.

Los códigos de fila/columna/hoja son alfanuméricos y sensibles a mayúsculas, conforme al lexer.
No se rellenan con ceros ni se corrigen códigos numéricos automáticamente: un código guardado
como número Excel se rechaza, porque ya podría haber perdido sus ceros iniciales.

### Facts

| Columna | Tipo y validación |
| --- | --- |
| contextId, tableCode, sheetCode, rowCode, columnCode | Referencia exacta a Coordinates. |
| presence | Texto `value` o `null`. |
| value | Texto decimal para number, texto `true`/`false` para boolean; vacío para null. |

`presence=null` con value vacío es null explícito. Una coordenada de Coordinates sin fila en
Facts es null implícito. Una clave ausente de Coordinates es inválida, no null. `presence=value`
con blanco es un dato inválido. El cero se escribe `presence=value`, `value=0`; nunca se omite.
No se aceptan dos filas Facts para la misma clave, aunque sus valores coincidan.

Formato decimal de entrada: signo menos opcional, dígitos, punto decimal opcional; sin separadores
de miles, moneda, espacios ni notación porcentual. Hasta 128 dígitos significativos y 128 posiciones
decimales; el perfil limita por separado la precisión declarada. Se conserva el texto original y
se obtiene un racional exacto. Los valores se guardan como **texto Excel**, incluidos los ejemplos,
para no perder cifras por el límite numérico de Excel. Se rechaza una celda numérica en Facts.value
con explicación de cómo volver a introducirla como texto; no basta cambiar su formato visual.

Un dato number no se considera inválido por tener más decimales que su precisión: decimals describe
incertidumbre, no una obligación de redondear la entrada. Los cambios calculados sí se cuantizan
según la política de recálculo antes de proponerse.

### Ejemplo mínimo sintético

Context `demo`, entidad `SYNTHETIC`, referencia y remisión `2026-06-30`, framework `COREP`, módulo
`COREP_OF_4.2`, con filingIndicators `{"C_01.00":true,"C_05.01":true}` declarado expresamente.
Coordinates declara C_01.00/r0230/c0010 y C_05.01/r0090/c0060, ambas sin hoja,
number/EUR/decimals=2. Facts contiene valores textuales `10.00` y `10.00` con presence=value.
La expresión y la precondición reales de G169 se conservan con su fuente; los importes, la entidad
y la declaración de indicadores son sintéticos.

## Adaptador del catálogo de reglas EBA

Se localiza una única hoja con estas 15 cabeceras (independientes de su posición):
`VR Code`, `Source`, `Framework`, `Modules`, `Cross module`, `Tables`, `Expression`, `Precondtion`,
`Description`, `IsActive`, `FromReferenceDate`, `ToReferenceDate`, `Severity`, `FromSubmissionDate`,
`Implemented in XBRL`. La grafía `Precondtion` se conserva. No se admite un alias silencioso;
un formato alternativo requerirá una versión de adaptador. Cabecera ausente/duplicada o varias
hojas candidatas rechaza la carga. Columnas extra se preservan como metadatos, no como instrucciones.

Solo Expression y Precondtion alimentan el lenguaje; Description es texto humano. Una precondición
vacía o literal `NULL` significa ausente. Los errores por registro no eliminan las reglas válidas.
Se conserva archivo/hash, hoja/fila, valores originales y diagnóstico de cada registro.

Fechas: aceptar fecha ISO, fecha Excel o literal `NULL`/vacío. Para estas columnas el preflight
conserva lexema XML, tipo, estilo y date1904; la conversión usa esos datos, no un Date que el lector
haya transformado. También se conserva el tipo XML original para exigir texto en códigos y Facts.value.
La conversión de serial respeta
`date1904` del libro; usa días civiles sin zona local. Serial 60 del sistema 1900, fecha inválida
o fracción horaria no nula son diagnóstico, no corrección silenciosa. Ventanas From/To son
inclusivas; un límite NULL significa sin límite de ese lado. `FromSubmissionDate` es límite mínimo.
Si un atributo indispensable no puede interpretarse, el registro es no evaluable.

IsActive reconoce `Active`/`Inactive` sin distinción de mayúsculas, conservando original;
otros valores son diagnóstico. Severity normaliza `error`/`warning`; un valor desconocido se
conserva con categoría `unknown`, sin convertirlo en éxito. Framework y versiones de Modules
son identificadores exactos. Modules y Tables se separan por coma y se quitan espacios exteriores
de cada token; se rechazan tokens vacíos y se conserva el raw original. Los conjuntos se ordenan
canónicamente. No se decide pertenencia por substring ni se divide por espacios genéricos.
Esta regla corresponde a los separadores verificados en el archivo aportado.

La clave semántica de variante combina código, framework, conjunto ordenado de módulos y ventanas
de vigencia; su contenido incluye expresión, precondición y metadatos aplicables. Filas exactamente
equivalentes comparten variante e instancias de ejecución, conservan todas sus procedencias y
se muestran como duplicados informativos. Variantes incompatibles que coinciden en un contexto
se marcan en conflicto. Reordenar filas no cambia la variante seleccionada ni el orden del motor.

El catálogo completo de referencia supera 500 registros: la aplicación v1 exigirá un subconjunto.
Las herramientas futuras de fixture podrán extraerlo sin modificar el original.

## Preflight y cuotas de archivos

Multipart se recibe como stream en archivo temporal de nombre interno UUID, calculando SHA-256.
El nombre proporcionado por el usuario nunca se usa como ruta. Antes de leer tablas:

1. Validar contenedor ZIP y contenido `.xlsx`; rechazar cifrado, rutas absolutas/`..`, enlaces
   simbólicos, entradas duplicadas o nombres que colisionen tras normalizar.
2. Abrir con yauzl en modo lazy, validación de tamaños y nombres estrictos; no extraer a disco.
   Contar bytes reales descomprimidos y abortar streams al exceder cuota.
3. Analizar XML y relaciones con sax estricto, namespaces y entidades estrictas. Rechazar DOCTYPE,
   declaraciones SGML y XML inválido; no recuperar y continuar tras un error.
4. Rechazar fórmulas de cualquier hoja, macros/VBA, ActiveX/OLE y relaciones externas de datos.
   Los hipervínculos informativos se conservan como texto o se ignoran, sin acceder a sus destinos.
   Ninguna relación puede leer red o filesystem. Resolver relaciones internas dentro del ZIP.
5. Comprobar índices sharedStrings, coordenadas dispersas y dimensiones reales antes de normalizar
   filas. La dimensión declarada en el XML no autoriza reservar memoria sin límites.

Para informes ce-report-1, el preflight usa SAX por bloques y modo metadata: conserva cabeceras
de la fila 1, sharedStrings decodificados y metadatos ZIP/hojas, sin retener todas las celdas raw
de datos. Después lee filas en orden lógico Contexts → Coordinates → Facts con el mismo
normalizador de dominio; no crea la matriz adicional de read-excel-file. El catálogo EBA conserva
su ruta raw/read-excel-file para lexemas, tipos, estilos y fechas.

En los informes, la identidad de celda/fila y las cabeceras prevalecen sobre el orden físico de
los elementos XML. Se admiten filas/celdas fuera de orden; fragmentos disjuntos de una misma fila
se reúnen y repetir la misma celda se rechaza, aunque el contenido coincida. El resultado se
ordena por fila de origen, conservando locadores. Esta admisión es una decisión explícita de la
ruta incremental; el lector anterior rechazaba filas desordenadas y no se presenta como equivalente
en ese caso. No cambian las reglas de tipos, presencia, precisión, unidades ni cuotas.

| Cuota | Límite |
| --- | --- |
| Catálogo / informes / hechos | 500 registros / 20 archivos / 100.000 hechos |
| Archivos por lote / tamaño comprimido | 21 / 10 MiB por archivo y 50 MiB por lote |
| Bytes descomprimidos reales | 100 MiB por lote; 64 MiB por entrada |
| Entradas ZIP / hojas / sharedStrings | 2.048 / 64 / 500.000 por archivo |
| Texto por celda / profundidad XML | 32.767 caracteres / 64 niveles |
| Filas por hoja tabular / columnas | 200.001 incluyendo cabecera / 64 |

La cuota de hechos excluye metadatos de coordenadas, cuyo máximo también es 100.000 por lote.
Los errores estructurales rechazan todo el lote y conservan el snapshot previo. Los errores de
reglas individuales quedan registrados y no impiden importar otras reglas válidas.
El preflight conserva por archivo `SourceFile.expandedBytes`, suma de bytes descomprimidos reales,
además de size y sha256. Ese dato permite verificar después las cuotas del lote reimportable;
un valor ausente no se interpreta como cero.

## Exportación y roundtrip

`kind=results` descarga un ZIP con entradas fijas `results.json` (valores exactos y racionales
en cadenas) y `results.xlsx` (vista literal). `kind=report` descarga `report.zip`, con MIME
`application/zip` y nombres controlados: `reports/report-001.xlsx`, `reports/report-002.xlsx`,
etc., más `changes.json` y `changes.xlsx`. Cada XLSX de reports corresponde a una SourceFile de
tipo report del conjunto original: se mantienen entre 1 y 20 informes. El catálogo original no
se incluye en el ZIP. Para reimportar se cargan los XLSX extraídos de reports junto al catálogo
original por separado; changes.json/changes.xlsx no son informes de entrada.

Cada informe exportado sigue ce-report-1 y conserva contextIds, contextos, coordenadas, hechos,
unidades y precisión. Conserva también los contextos sin coordenadas/hechos, identificados por
la procedencia de Contexts (`filingIndicatorsLocator.fileId`), y su mapa filingIndicators
explícito: true, false y no declarado siguen siendo distintos. Los importes se escriben como
texto; no se reconstruyen indicadores a partir de los hechos. Se mantienen presencia/null y
ceros iniciales. La versión original no se sobrescribe. Ninguna vista XLSX ejecuta fórmulas ni
contiene enlaces activos; ningún paquete se presenta como fichero oficial de remisión.

El texto OOXML se trata como ST_Xstring tanto al importar inlineStr/str/sharedStrings como al
exportar texto nuevo. Tras el procesamiento XML, el lector decodifica `_xHHHH_` en una sola
pasada, nunca recursivamente. El escritor protege el guion bajo inicial de una secuencia literal
con `_x005F_`; así, `_x005F_x0041_` se importa como el literal `_x0041_`, no como `A`.
Codifica CR como `_x000D_` y conserva LF, tabulaciones y espacios iniciales/finales mediante
`xml:space="preserve"`. Los controles no representables en XML 1.0 y los surrogates sin pareja
se rechazan con diagnóstico, sin eliminarlos ni normalizar silenciosamente el contenido.

Los XLSX ce-report-1 se escriben incrementalmente, con celdas `inlineStr` y entradas ZIP
comprimidas con DEFLATE, sin construir una matriz completa de objetos de celda. Durante la
escritura se cuentan los bytes reales serializados y descomprimidos, por archivo/entrada/lote.
El worker conserva `maxOldGenerationSizeMb: 256`; esto limita su heap V8 configurado, no el RSS
ni todos los buffers, que siguen sujetos a las cuotas de bytes.

### Manifiesto y cambios acumulados de report

changes.json contiene los campos `versionId`, `profileId`, `policyId`, `contentHash`, `synthetic`,
`reports`, `receipts` y `changes`. reports es el manifiesto con entradas
`{entryName,sourceFileId,contextIds,size,sha256,expandedBytes}`: el nombre controlado identifica
el XLSX generado, sourceFileId su fuente original y los tamaños/hash corresponden al archivo
exportado. size son bytes serializados; expandedBytes son bytes descomprimidos reales.
receipts contiene ApplyReceipt, incluidos beforeValidationRunId y validationRunId.

Cada entrada ApplyChange contiene `{receiptId,proposalId,directionId,targetKey,before,after,sources,changed}`;
before es FactReadDTO y after es ProposalAfterDTO. Los cambios numéricos incluyen exactNominal,
derivedInterval y policyId de cuantización obligatorio. Los booleanos omiten evidencia numérica
y policyId de redondeo. changes.xlsx presenta el mismo registro mediante celdas literales.
Las versiones, procedencias y datos sintéticos quedan identificados.

changed es booleano obligatorio: true para cambios reales y false para una propuesta aceptada
cuyo valor normalizado exacto ya coincide con un hecho presente de igual unidad/precisión.
Esta última se audita y figura aplicada, pero no reescribe el hecho ni su originalText/derivation.
Por ejemplo, un valor `12` no se convierte en `12.00` solo por el formato de preview; after en
el registro refleja el texto `12` realmente preservado. changeCount solo cuenta changed=true.
Una aplicación con selección no vacía y cero cambios reales conserva recibo y revalidación;
su log incluye las entradas changed=false y no se confunde con el snapshot original sin aplicaciones.

El registro es acumulado **hasta el snapshot exportado**, desde la última importación de su
conjunto: incluye recibos/cambios aplicados en su cadena de antecesores, nunca posteriores ni
de otro conjunto. La frontera se determina por la firma ordenada de pares (kind,id) de sources:
importar reemplaza sources con IDs nuevos; configuración y aplicación preservan ese array/IDs.
Los archivos exportados no se incorporan a sources. Al exportar el snapshot original, receipts
y changes están vacíos. Una cadena rota, fuentes ausentes/duplicadas o metadatos necesarios
incompletos rechazan la exportación; no se fabrica un historial parcial ni se supone cero para
expandedBytes ausente.

### Cuotas de salida y reimportación

| Contenido | Límite |
| --- | --- |
| Cada XLSX dentro de reports | 10 MiB; entre 1 y 20 informes. |
| Informes exportados + catálogo original | 50 MiB serializados y 100 MiB descomprimidos reales, usando size/expandedBytes del catálogo. |
| results.json/results.xlsx o changes.json/changes.xlsx | 64 MiB por contenido serializado. |
| Cada paquete results/report | Suma de contenidos y ZIP completo ≤100 MiB cada uno. |
| Carga XML previa estimada | 64 MiB por results.xlsx o changes.xlsx; no se aplica a los informes ce-report-1 incrementales. |
| Archivos propios de sesión | 512 MiB acumulados, incluidos staging, trabajo y exports retenidos. |

Antes de publicar, cada informe generado debe cumplir también las restantes cuotas del preflight
de entrada: entradas ZIP, hojas, sharedStrings, dimensiones, longitud de celdas, XML y datos.
Sigue vigente el máximo de 64 MiB descomprimidos reales por entrada ZIP, además de 100 MiB por
lote con el catálogo; el escritor incremental no elimina esos límites.
El catálogo original se contabiliza para verificar el lote reimportable aunque no viaje en el
paquete. Los logs de cambios cuentan para la cuota del paquete, pero no se cargan como informes.

Solo para results.xlsx y changes.xlsx, el guard de carga XML previa es
`64 KiB + 128 × filas + 128 × celdas + 6 × bytes UTF-8 de los valores`, incluidas cabeceras,
antes de generar el XLSX. Excederlo explica `XML_WORKLOAD_LIMIT` dentro de
`EXPORT_LIMIT`. Esta estimación no se aplica al escritor incremental de informes ce-report-1;
en ellos gobiernan los bytes reales y las cuotas de preflight. En todos los formatos se comprueban
también los bytes reales de salida.
No se truncan archivos ni historiales para cumplir cuotas: el exceso de exportación produce
EXPORT_LIMIT; el acumulado de archivos de sesión, SESSION_LIMIT. Reservas, respuestas HTTP/Job
y limpieza están en el [contrato HTTP](http-api.md#exportación-de-resultados-y-cuotas) y el
[modelo de sesión](../data-model.md#capacidad-y-limpieza). Estos contratos no acreditan pruebas
de exportación o roundtrip ejecutadas.
