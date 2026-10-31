# Contrato de libros Excel

Versión: `ce-report-1`. Estado: diseño; la plantilla `.xlsx` se generará en implementación.
Todos los archivos son `.xlsx`. El catálogo EBA y los informes tienen formatos distintos.

## Plantilla de informes propia

Hojas exactas: `Instructions`, `Contexts`, `Coordinates`, `Facts`. Fila 1 contiene las cabeceras
exactas, sin celdas combinadas en tablas de datos. El orden de filas no tiene significado.
`Instructions` contiene instrucciones en español, versión, ejemplo sintético y explicación de
null/ausencia/precisión. No se importa como hechos. No se ejecuta ninguna fórmula del libro.

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

Un lote tiene una entidad y fecha de referencia. Incluir varios módulos en Contexts constituye la
declaración expresa del usuario de que esos contextos forman el conjunto compatible que desea
validar; la importación muestra esa lista para comprobarla. No acredita compatibilidad regulatoria
por sí misma ni permite inferir módulos adicionales. Repetir el mismo contextId entre archivos exige que todos sus atributos
coincidan. No se fusionan contextos por semejanza. Si una regla requiere fecha de remisión y falta,
queda no evaluable; no se sustituye por la fecha del ordenador.

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
`COREP_OF_4.2`. Coordinates declara C_01.00/r0230/c0010 y C_05.01/r0090/c0060, ambas sin hoja,
number/EUR/decimals=2. Facts contiene valores textuales `10.00` y `10.00` con presence=value.
La regla real de G169 se conserva con su fuente; los importes y la entidad son sintéticos.

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
5. Comprobar índices sharedStrings, coordenadas dispersas y dimensiones reales antes de materializar
   tablas. La dimensión declarada en el XML no autoriza reservar memoria sin límites.

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

## Exportación y roundtrip

El informe recalculado usa ce-report-1, conserva contextos/coordenadas y escribe importes como texto.
La versión original no se sobrescribe. Los resultados y cambios se exportan como JSON con racionales
en cadenas; una vista Excel adicional de resultados usa texto literal, nunca fórmulas ni enlaces
activos. La exportación incluye perfil, versiones, procedencias, redondeos y datos sintéticos
identificados cuando corresponda. No se presenta como fichero oficial de remisión.
