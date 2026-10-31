# Modelo de datos

Diseño v1, 2026-10-31. Los modelos son contratos conceptuales; no existen todavía tablas,
migraciones, clases ni almacenamiento implementado. El motor recibe snapshots y devuelve valores.

## Convenciones e identidad

- IDs opacos de sesión, trabajo, snapshot y preview: UUID generados por el servidor.
- IDs semánticos: SHA-256 de JSON canónico con claves y conjuntos ordenados; nunca de la posición
  de una fila. Incluyen RecalculationDirection.directionId. Los campos de procedencia se conservan
  aparte del contenido semántico.
- Proposal.id es UUIDv5 estándar: SHA-1 de los bytes UUID de Preview.id como namespace, seguidos
  del directionId en UTF-8 como nombre, con los bits de versión/variante definidos por
  [RFC 9562 §5.5](https://www.rfc-editor.org/rfc/rfc9562.html#section-5.5). El mismo par
  previewId/directionId produce el mismo ID, aunque se permuten las direcciones. No es un
  SHA-256 etiquetado como UUIDv5; los UUID derivados de SHA-256 pertenecen a UUIDv8 según ese RFC.
- Fechas civiles: `YYYY-MM-DD`. Instantes de ejecución: ISO 8601 UTC.
- Dinero y otros números: racionales `{numerator: string, denominator: string}`; datos de entrada
  y salida del workbook son cadenas decimales. No se serializa `BigInt` como JSON number.
- `FactKey = (contextId, tableCode, sheetCode, rowCode, columnCode)`. ContextId identifica
  inequívocamente entidad, referencia y módulo/versión; la cadena vacía de sheetCode es significativa.
- Un contexto lógico tiene una clave canónica derivada de entidad, referencia, framework y módulo/versión. El alias contextId
  del workbook no altera la identidad semántica ni se usa para resolver versiones por parecido.
- El mapa filingIndicators pertenece al contenido del contexto y del snapshot: ordenar sus
  claves antes de calcular hashes conserva la identidad ante una permutación JSON. No se deriva
  de hechos/coordenadas; true, false y ausencia son contenidos distintos. Este mapa modifica el hash
  de contenido, no la identidad de la celda ni canonicalContextKey.

## Entidades

| Entidad | Campos principales | Invariantes y relaciones |
| --- | --- | --- |
| SourceFile | id, sha256, displayName, kind, size, expandedBytes, importedAt | Temporal local. size es el tamaño serializado y expandedBytes son bytes descomprimidos reales medidos durante preflight. displayName nunca es ruta. SourceLocator apunta a archivo/hoja/fila/celda. |
| RawRuleRecord | id, sourceLocator, originalFields, diagnostics, variantId? | Una entrada por fila importada; ninguna desaparece por ser inválida o duplicada. |
| RuleVariant | variantId, code, framework, modules[], crossModule, tables[], expression, precondition?, active, referenceWindow, submissionFrom?, severityOriginal, severity, sourceRecords[] | variantId no incluye fila/archivo. La vigencia y los módulos distinguen variantes. Un código puede tener varias. |
| RuleAnalysis | variantId, grammarVersion, profileId, syntaxStatus, supportStatus, AST?, diagnostics | Solo hay AST ejecutable con cero errores y construcciones soportadas. El árbol ANTLR no sale por HTTP. |
| ReportContext | canonicalContextKey, contextId, entityId, referenceDate, submissionDate?, framework, moduleVersion, filingIndicators | Una entidad/fecha por workspace. filingIndicators es un mapa de códigos exactos a booleanos; vacío significa no declarados. Repetir contexto con mapa inconsistente rechaza el lote. Contextos declarados compatibles; referencias ambiguas son diagnóstico. |
| Coordinate | factKey, dataType, unit, decimals, axes | Es parte del catálogo cerrado, incluso sin hecho. No admite claves repetidas. |
| ReportedFact | factKey, presence, originalText?, normalizedValue?, sourceLocator, derivation? | presence=value/null. Un null explícito tiene fila; ausencia de fila en coordenada válida es null implícito al resolver. derivation identifica un cálculo sin reemplazar el sourceLocator original. |
| Workspace | id, state, currentVersionId?, versionIds[], activeJobId?, sessionId | Un workspace por proceso; el hilo principal es el único propietario mutable del puntero vigente. |
| Snapshot | versionId, parentVersionId?, contentHash, catalogVersion, reportVersion, configVersion, profileId, contexts, coordinates, facts, directions, sources, createdAt | Inmutable. Versiona cualquier cambio de reglas, datos, contexto o direcciones. Conserva el original dentro de la sesión. |
| RuleInstance | instanceId, variantIds[], binding, applicableContext, diagnostic? | Clave estable por contenido de regla efectivo, binding completo, clave canónica del contexto aplicable y contextos de resolución ordenados; sin alias contextId ni ordinal de importación. Una precondición actual false/indeterminada no elimina una instancia estructural con cuerpo soportado y binding finito. |
| ValidationRun | id, versionId, profileId, status, startedAt, endedAt?, summary, resultIds[] | Los resultados pertenecen a un snapshot. Cambiar el vigente los hace históricos, no los reasigna. |
| RuleResult | id, runId, instanceId, status, severity, preconditionResult, operands, factReads, metadataReads, locators, diagnostics | Un estado terminal por instancia; valores incluyen nominal/intervalo/unidad o presencia de null. factReads conserva entradas originales leídas; metadataReads conserva contexto/código/valor o ausencia de indicadores y su procedencia. |
| FactRead | factKey, coordinate, presence, normalizedValue?, originalText?, sourceLocator, derivation? | presence=value/explicit_null/implicit_null. Valor racional exacto o booleano, cuando existe; coordinate conserva unidad/decimals/ejes y procedencia. Es la entrada del snapshot antes de default/interval, con derivation si procede de un cálculo. |
| RecalculationDirection | directionId, instanceId, targetSide, targetKey | Configurada expresamente para una igualdad; destino único number o boolean con identidad canónica. Un filingIndicator no es destino. |
| Preview | id, baseVersionId, profileId, policyId, state, createdAt, proposalIds[], graphSummary, appliedReceiptId? | Solo puede aplicarse contra la base que la produjo. createdAt se captura al comenzar la simulación y permanece en todas las transiciones. appliedReceiptId se publica atómicamente con state=applied, recibo y snapshot nuevo. Incluye resultados no disponibles y motivos. |
| Proposal | id, previewId, directionId, targetKey, before, exactNominal (solo number), derivedInterval (solo number), after, readKeys[], predecessorIds[], state, diagnostics | Para number, after es el valor cuantizado con precisión destino; para boolean, el booleano conocido propuesto sin unidad/decimals/redondeo. Los consumidores leen exactamente el valor que se aplicaría. |
| ApplyReceipt | id, previewId, acceptedIds[], closureHash, baseVersionId, newVersionId, beforeValidationRunId, validationRunId, appliedAt | beforeValidationRunId identifica la validación completa de la base; validationRunId la posterior. Constancia funcional del cambio, no un recibo de revisión gentle-ai. Solo existe tras publicar la versión completa. |
| Job | id, workspaceId, kind, baseVersionId?, status, progress, startedAt, deadline, resultRef?, diagnostics | kind=import/validate/preview/apply/export. Una tarea activa global; estado terminal no retrocede. |

`ApplyReceipt` es trazabilidad de negocio. El desarrollo con recibos continúa `disabled/unmanaged`.

El historial expone proyecciones explícitas de los registros conservados en la sesión:
RunSummary contiene id, versionId, profileId, status, startedAt y endedAt opcional;
PreviewSummary contiene id, baseVersionId, profileId, policyId, state y createdAt.
No incluyen resultIds, AST, propuestas ni rutas. Las páginas contienen items, total, nextCursor
y revision; ordenan por fecha descendente y, en empate, id descendente. El filtro status admite
running/completed/incomplete en runs y ready/applied/discarded/obsolete en previews. El cursor HMAC se vincula a la
revisión de la colección de resúmenes y sus filtros, y deja de ser válido si cambia la colección.
Estas consultas permiten recuperar el registro más reciente y navegar el historial después de
refrescar, sin IDs persistidos en localStorage. No prolongan la sesión tras cerrar/reiniciar ni
permiten modificar snapshots históricos. Véase el [contrato HTTP](contracts/http-api.md#formatos-comunes).

La página de propuestas mantiene el orden topológico del motor, incluidos sus filtros, y puede
incluir sourceFiles del snapshot base para explicar procedencia histórica. No ordena por UUID.

`RuleResult.factReads` siempre existe, como `[]` si no hubo lecturas. FactRead.sourceLocator
apunta a Facts para valores y null explícitos, y a Coordinates para null implícito; coordinate
conserva también su propia procedencia. Un default no altera la presencia original de esta
traza. Los operandos efectivos se conservan aparte; leer la misma celda con opciones distintas
no autoriza inventar un intervalo de origen común. Las lecturas del cuerpo omitido por una
precondición false no se registran como realizadas. Los DTO representan racionales mediante
cadenas, nunca BigInt, y permiten inspeccionar coordenadas, precisión y fuentes según FR-009.

ReportedFact y FactReadDTO admiten `derivation?: {receiptId,previewId,proposalId,baseVersionId}`.
Identifica el hecho calculado sin cambiar el sourceLocator de la celda original. La UI distingue
esa procedencia del valor importado; las lecturas posteriores conservan el enlace al cálculo.

La respuesta de consulta puede enriquecer RuleResultDTO con
`recalculation?: {left: DirectionEligibilityDTO, right: DirectionEligibilityDTO}`; cada lado es
`{eligible: boolean, target?: Coordinate, diagnostics: Diagnostic[]}`. Estos metadatos de petición
no modifican el resultado almacenado ni su snapshot. Se obtienen con el resolver estructural
compartido con el guardado de direcciones, sin ejecutar el cuerpo ni enviar AST a Angular.
Una precondición false conserva la estructura aunque no haya operandos calculados.

Un WorkBudget compartido por página acota las comprobaciones; su memoización es temporal de esa
petición. Al agotarlo, eligible=false lleva diagnóstico de comprobación incompleta sin eliminar
resultados. La consulta histórica es informativa; guardar exige una validación completa del
snapshot vigente y revalida la estructura. La elegibilidad no sustituye la comprobación de
precondición ni la simulación posterior de una propuesta aplicable.

`ValidationResultsPageDTO.configuredDirections?: readonly DirectionChoiceDTO[]` devuelve la
lista completa de elecciones `{instanceId, targetSide}` del snapshot del run; targetSide es
left/right. No se reduce por paginación ni filtros. La UI mantiene un borrador completo con
esas elecciones, incluidas las ocultas, y lo envía íntegro al PUT de reemplazo; una recarga
recupera la configuración del mismo snapshot. La ausencia del campo no equivale a una lista
vacía: impide guardar y requiere diagnóstico, evitando borrar elecciones no visibles.
La configuración de un run histórico se consulta en modo de solo lectura.

## Metadatos de presentación

`ReportContext.filingIndicators` procede exclusivamente de Contexts en ce-report-1. Sus códigos
son unidades de reporte/indicadores, sin el prefijo sintáctico `v_`; no se supone equivalencia con
tableCode ni Variable.Code. No declarado se evalúa como unknown y genera
`MISSING_FILING_INDICATOR` cuando impide decidir. Un false explícito puede dar `not_applicable`;
un true no requiere filas Facts. No se heredan coordenadas/default/interval al resolverlos.

Los snapshots y exportaciones conservan el mapa. Modificarlo versiona el contexto, su contenido
y el snapshot; las previews de la base anterior quedan obsoletas. Las trazas metadataReads no
forman parte de `Proposal.readKeys`: no producen FactKeys, aristas de productores ni destinos
de recálculo. La consistencia entre archivos se comprueba antes de publicar el lote completo.

## Catálogo y resolución de variantes

1. Cada fila genera RawRuleRecord con valores y localizador originales.
2. Canonicalizar campos admitidos y generar la variante sin incorporar el orden de origen.
3. Filas de contenido equivalente comparten variante, preservando todos los SourceLocator y
   un diagnóstico informativo de duplicación; la ejecución no se multiplica por duplicados exactos.
4. Filtrar por estado, contexto, módulo y fechas. Dos variantes de contenido incompatible que
   coinciden para el mismo código/contexto producen conflicto y no se elige una por orden.
5. Si variantes aplicables tienen igual contenido efectivo pero distinta procedencia/ventana,
   la instancia mantiene todos sus variantIds y se ejecuta una vez para ese binding.

El resumen distingue filas importadas, variantes distintas, variantes aplicables e instancias.
Su reconciliación informa explícitamente duplicados, no aplicables y registros sin instancia por error.
Un resultado `pass` nunca compensa un registro que no pudo interpretarse.

El resultado dinámico de una precondición false/indeterminada no borra una identidad de instancia
si el cuerpo está soportado y tiene binding finito. Con false se registra not_applicable sin
ejecutar el cuerpo; con indeterminación se conserva not_evaluable. Una construcción no soportada
o sin binding válido continúa en cobertura con diagnóstico, sin una instancia ejecutable falsa.
Las futuras direcciones usan validez estructural, actividad y vigencia, no un filtro pass/fail.
Su precondición debe reevaluarse como true sobre la versión simulada antes de ofrecer un cambio,
incluido el caso V09 donde un productor transforma false en true.

La política local crossModule crea una instancia por contexto aplicable. El conjunto de
resolución puede contener hechos de contextos compatibles declarados y requeridos; no unifica
sus identidades ni sus mapas filingIndicators. Estos últimos se leen solo en applicableContext.
Las claves canónicas de contextos ordenadas intervienen en la identidad de instancia; cambiar
alias o permutar filas no cambia esa identidad. Una tabla/coordenada con resolución ambigua es
diagnóstico, no una elección por orden de origen. Véase el
[perfil de resolución](contracts/language-profile.md#resolución-de-referencias-y-ámbito).

## Estados y transiciones

**Workspace:** `empty → ready → closed`. Un trabajo activo es un atributo, no sustituye ready.
Una importación fallida mantiene empty o la versión ready anterior. Cerrar es definitivo y cancela
el trabajo antes de limpiar copias temporales. La caída/reinicio del proceso termina la sesión;
no se garantiza recuperar snapshots y se comunica esa condición en la interfaz.

**Job:** `queued → running → succeeded | failed | cancelled | timed_out`.
Se admite como máximo un trabajo no terminal total: queued es un estado transitorio antes de
running, no una cola adicional. Cualquier trabajo nuevo mientras exista uno devuelve `WORKSPACE_BUSY`.
Cancelar un trabajo terminado devuelve su estado real.
Los contadores parciales se etiquetan incompletos; no son resultados finales.

**ValidationRun:** `running → completed | incomplete`. El Job puede terminar succeeded con reglas
fail/error/not_evaluable: eso significa que la ejecución del conjunto terminó, no que todas pasaron.
Una cancelación o cuota deja el run incomplete. Nunca se presenta un resumen total aprobado.

**RuleResult:** `pass`, `fail`, `not_applicable`, `not_evaluable`, `error`; `blocked` solo en la
simulación dependiente de recálculo. Las etiquetas visibles son las de la especificación española.

**Preview:** `ready → applied | discarded | obsolete`. Si cambia currentVersionId, solo una preview
ready de otra base pasa a obsolete; applied/discarded mantienen su estado histórico. Sus datos se
conservan para explicar lo sucedido durante la sesión. Tras aplicar un subconjunto, la preview queda
applied y las propuestas no elegidas quedan obsolete, pues ya no corresponden a la versión vigente.
Una preview puede contener propuestas available y blocked; en ready, solo available admite
selección. Si la preview queda obsolete, solo las propuestas antes available pasan a obsolete;
las blocked conservan estado/motivo. El cálculo de clausura de una preview obsolete es
informativo y devuelve state=obsolete: complete no implica aplicabilidad. Incluso una selección
vacía puede tener clausura completa, aunque no permita aplicar. Selection sobre discarded o
applied se rechaza; las consultas históricas se conservan.

El descarte explícito actualiza atómicamente ready→discarded y las propuestas
available→discarded; blocked mantiene su estado y motivo. El registro descartado permanece
durante la sesión sin modificar hechos, versión ni ETag. Repetirlo sobre discarded no muta;
applied y obsolete se conservan y rechazan el descarte con PREVIEW_NOT_APPLICABLE.
La operación HTTP requiere token, If-Match vigente y workspace sin Job no terminal
(WORKSPACE_BUSY en caso contrario; STALE_VERSION ante versión obsoleta). Devuelve PreviewDTO
y ETag actual, sin nuevo snapshot, Job ni Idempotency-Key. Véase el
[contrato HTTP](contracts/http-api.md#rutas).

**Proposal:** `available → accepted → applied`, o `available → discarded | obsolete`;
`blocked` conserva su motivo. `accepted` existe en el candidato de aplicación mientras se ejecuta
la revalidación; un fallo/cancelación conserva la preview ready sin mutar los datos vigentes.

El tipo de la coordenada destino determina la semántica de Proposal. Un destino number conserva
nominal exacto e intervalo derivado y aplica la política de cuantización numérica. Un destino
boolean exige un lado calculado true/false conocido del mismo tipo, sin unidad, decimals ni
half-even; no contiene exactNominal ni derivedInterval. Null, unknown o tipo incompatible
bloquean la propuesta, sin coerción. Antes de ofrecer cualquier tipo se revalida la igualdad
originaria con el candidato. Los indicadores de presentación no son hechos ni destinos.
Esta distinción es conceptual; la forma concreta del DTO de propuestas se fijará al implementarlo.

## Transacción de aplicación

La petición contiene previewId, baseVersionId y el conjunto exacto seleccionado. Se verifica
la clausura de antecesores, unicidad de destinos, vigencia y ausencia de bloqueos. El worker
construye un candidato con copia lógica de los hechos modificados; nunca cambia el snapshot base.
Una propuesta aceptada no crea factPatch si el hecho base tiene presence=value y coincide
exactamente en normalizedValue, unidad y precisión con el valor propuesto. Se conserva la
misma referencia del hecho, originalText y derivation previa, incluso para textos numéricos
equivalentes como `12` y `12.00`. Solo se copian los hechos con cambio real; el formato canónico
mostrado en preview no obliga a reescribir un dato equivalente.

La propuesta sigue en acceptedIds y pasa a applied; su entrada ApplyChange lleva `changed:false`.
Los cambios reales llevan `changed:true`; changeCount cuenta estos últimos, no las propuestas
aceptadas. El after auditado de un no-op refleja el texto realmente conservado. Una selección
no vacía puede publicar nueva versión y auditoría con cero parches, tras completar las mismas
comprobaciones y revalidación; no se omite del recibo por tener changeCount=0.

La validación completa anterior corresponde exactamente a la base: se reutiliza si existe o se
calcula dentro del Job. La validación anterior nueva y la posterior comparten presupuesto de
trabajo/plazo. Revalida todas las reglas aplicables sobre el candidato y devuelve ambos resultados
y trazabilidad; no publica la validación anterior por separado.

En una única sección del hilo principal se verifica de nuevo la versión, que la preview siga
ready, el token de cancelación y el plazo; se publican conjuntamente el nuevo snapshot completo,
ambos runs completos y ApplyReceipt, se fija Preview.state=applied con appliedReceiptId y se
cambia currentVersionId. Un run anterior reutilizado mantiene su identidad.
Una respuesta
perdida no repite los cambios: la clave de idempotencia devuelve el mismo Job/resultado.
Un fallo previo a la publicación deja el puntero y los valores anteriores intactos. Tras publicar,
cancelar no revierte un cambio ya confirmado; se devuelve su estado final.

Los fallos de reglas en la nueva validación se muestran y comparan con la anterior. Un error técnico
que impide completar la revalidación, un timeout o una cuota impiden publicar la aplicación.

La consulta de aplicación proyecta `{receipt,changeCount,beforeSummary,afterSummary}`, con
changeCount igual al número de entradas ApplyChange con changed=true y mínimo cero. La
comparación paginada contiene `{items,total,nextCursor,receipt,beforeSummary,afterSummary,sourceFiles?}`;
cada item `{key,before?,after?}` empareja resultados por identidad semántica independiente de runId.
No expone snapshots completos ni devuelve la colección completa de cambios en el resumen.
El historial restaura una aplicación a través de appliedReceiptId de la preview aplicada y
las consultas de aplicación/comparación, sin una colección HTTP adicional de aplicaciones.

## Procedencia acumulada de exportación

Para exportar report, la rama del conjunto se delimita mediante la firma de los pares (kind,id)
de sources ordenados. Una importación crea IDs de fuente nuevos y reemplaza sources; configuración
y aplicación conservan el array/IDs. Los archivos de una exportación no se añaden como fuentes.
Recorrer parentVersionId del snapshot elegido hasta la última importación permite incluir solo
los recibos/cambios de sus antecesores en esa rama, nunca aplicaciones posteriores ni otro conjunto.
El snapshot original exporta receipts y changes vacíos. Una cadena rota, fuentes ausentes o IDs
duplicados, o metadatos necesarios incompletos rechazan la exportación; no se reconstruyen por
suposición ni se considera expandedBytes ausente igual a cero.
Estos fallos de disponibilidad usan EXPORT_NOT_AVAILABLE (409) con reason cerrado:
MISSING_IMPORT_STATS, INVALID_REPORT_SOURCE o INCOMPLETE_VERSION_HISTORY. No revelan rutas.
EXPORT_LIMIT corresponde a límites de tamaño/carga medidos, no a una cadena de procedencia rota.

El manifiesto de report vincula cada XLSX con su SourceFile report, contextIds, hash, size y
expandedBytes. Se conservan también contextos sin coordenadas mediante su procedencia de Contexts.
Los cambios acumulados identifican recibo/propuesta/dirección/destino y valores antes/después;
los numéricos incluyen política de redondeo y evidencia numérica, los booleanos no inventan esos
campos. Forma completa y cuotas: [workbook](contracts/workbook.md#exportación-y-roundtrip).

## Capacidad y limpieza

Se conservan hasta 20 snapshots por workspace y hasta 512 MiB de estado contabilizado de sesión.
La métrica es la suma de bytes UTF-8 de la serialización canónica de snapshots, resultados,
propuestas, diagnósticos y caché de idempotencia, contando objetos compartidos una sola vez;
el cálculo se realiza antes de publicar cada incorporación. No es una promesa de límite RSS exacto.
La caché conserva hashes/referencias, no copias repetidas de cargas.

Las representaciones temporales del lector no forman parte del snapshot. En informes, el
preflight por bloques retiene cabeceras/sharedStrings/metadatos y la lectura por filas alimenta
el mismo normalizador Contexts → Coordinates → Facts; no conserva todos los RawCells de datos
ni una segunda matriz del libro. El catálogo mantiene su ruta raw. El estado normalizado se
transfiere para publicarse con la comprobación de versión del hilo principal; el cambio de lector
no altera la identidad/procedencia ni permite una publicación parcial.

Existe además una cuota **separada de 512 MiB de archivos propios por workspace**: suma de bytes
de staging de subidas, archivos de trabajo y exportaciones retenidas, más las reservas pendientes
de materialización; no se mezcla con la métrica de JSON canónico. Antes de crear/escribir archivos
o buffers grandes se reserva capacidad y se cuenta el tamaño real durante el trabajo. Las
reservas se ajustan al materializar los bytes sin contarlos dos veces; publicar un export cambia
su contabilidad de trabajo a retenido. Fallo/cancelación/timeout libera reservas y archivos
parciales propios; un export publicado continúa contabilizado hasta la limpieza de la sesión.
Superar el acumulado produce `SESSION_LIMIT`, conserva el snapshot y exports ya publicados y no
descarta el original para hacer espacio. No implica un límite exacto de RSS ni de espacio físico
reservado por el sistema de archivos.

Las exportaciones results tienen también límites individuales: 64 MiB por contenido serializado
(`results.json` / `results.xlsx`), con suma de contenidos y ZIP completo ≤100 MiB cada uno.
Report conserva ese máximo de paquete y admite 64 MiB por log changes.json/changes.xlsx,
pero cada informe ce-report-1 tiene máximo 10 MiB. Los informes junto con el catálogo original
deben caber en 50 MiB serializados y 100 MiB descomprimidos, además de las demás cuotas de
preflight, incluidos 64 MiB descomprimidos reales por entrada ZIP. Los informes ce-report-1 se
escriben incrementalmente con inlineStr/ZIP DEFLATE y se controlan por bytes reales, sin guard
XML estimado. Ese guard de 64 MiB permanece solo para results.xlsx y changes.xlsx. El worker
mantiene `maxOldGenerationSizeMb: 256`; no representa un límite exacto de RSS ni de buffers.
Excederlos produce `EXPORT_LIMIT`, sin truncar ni publicar una descarga parcial. La respuesta
413 previa a aceptar o el Job failed
posterior a 202, así como su exposición en capabilities, se fijan en
[HTTP](contracts/http-api.md#exportación-de-resultados-y-cuotas).
Además se aplican cuotas de
buffers, XML y recursos del worker descritas en los contratos. Si un nuevo candidato excede
cualquiera de las cuotas de sesión, se rechaza sin descartar el original.
La interfaz permite exportar y cerrar para iniciar otra sesión. Estos son límites locales
adicionales; no sustituyen las cuotas de importación o ejecución.

Temporales bajo un directorio propio del proceso, con marcador de sesión; los workers solo reciben
rutas internas emitidas por el servidor. Cierre elimina únicamente los archivos de ese directorio
verificado. La limpieza de restos de una sesión caída usa su marcador, no nombres proporcionados
por el usuario. No se borran originales elegidos para carga ni descargas ya guardadas.
