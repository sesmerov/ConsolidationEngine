# Modelo de datos

Diseño v1, 2026-10-31. Los modelos son contratos conceptuales; no existen todavía tablas,
migraciones, clases ni almacenamiento implementado. El motor recibe snapshots y devuelve valores.

## Convenciones e identidad

- IDs opacos de sesión, trabajo, snapshot y propuesta: UUID generados por el servidor.
- IDs semánticos: SHA-256 de JSON canónico con claves y conjuntos ordenados; nunca de la posición
  de una fila. Los campos de procedencia se conservan aparte del contenido semántico.
- Fechas civiles: `YYYY-MM-DD`. Instantes de ejecución: ISO 8601 UTC.
- Dinero y otros números: racionales `{numerator: string, denominator: string}`; datos de entrada
  y salida del workbook son cadenas decimales. No se serializa `BigInt` como JSON number.
- `FactKey = (contextId, tableCode, sheetCode, rowCode, columnCode)`. ContextId identifica
  inequívocamente entidad, referencia y módulo/versión; la cadena vacía de sheetCode es significativa.
- Un contexto lógico tiene una clave canónica derivada de sus atributos. El alias contextId
  del workbook no altera la identidad semántica ni se usa para resolver versiones por parecido.

## Entidades

| Entidad | Campos principales | Invariantes y relaciones |
| --- | --- | --- |
| SourceFile | id, sha256, displayName, kind, size, importedAt | Temporal local. displayName nunca es ruta. SourceLocator apunta a archivo/hoja/fila/celda. |
| RawRuleRecord | id, sourceLocator, originalFields, diagnostics, variantId? | Una entrada por fila importada; ninguna desaparece por ser inválida o duplicada. |
| RuleVariant | variantId, code, framework, modules[], crossModule, tables[], expression, precondition?, active, referenceWindow, submissionFrom?, severityOriginal, severity, sourceRecords[] | variantId no incluye fila/archivo. La vigencia y los módulos distinguen variantes. Un código puede tener varias. |
| RuleAnalysis | variantId, grammarVersion, profileId, syntaxStatus, supportStatus, AST?, diagnostics | Solo hay AST ejecutable con cero errores y construcciones soportadas. El árbol ANTLR no sale por HTTP. |
| ReportContext | canonicalContextKey, contextId, entityId, referenceDate, submissionDate?, framework, moduleVersion | Una entidad/fecha por workspace. Contextos declarados compatibles; referencias ambiguas son diagnóstico. |
| Coordinate | factKey, dataType, unit, decimals, axes | Es parte del catálogo cerrado, incluso sin hecho. No admite claves repetidas. |
| ReportedFact | factKey, presence, originalText?, normalizedValue?, sourceLocator | presence=value/null. Un null explícito tiene fila; ausencia de fila en coordenada válida es null implícito al resolver. |
| Workspace | id, state, currentVersionId?, versionIds[], activeJobId?, sessionId | Un workspace por proceso; el hilo principal es el único propietario mutable del puntero vigente. |
| Snapshot | versionId, parentVersionId?, contentHash, catalogVersion, reportVersion, configVersion, profileId, contexts, coordinates, facts, directions, sources, createdAt | Inmutable. Versiona cualquier cambio de reglas, datos, contexto o direcciones. Conserva el original dentro de la sesión. |
| RuleInstance | instanceId, variantIds[], binding, applicableContext, diagnostic? | Clave estable por contenido de regla efectivo y binding completo, sin ordinal de importación. |
| ValidationRun | id, versionId, profileId, status, startedAt, endedAt?, summary, resultIds[] | Los resultados pertenecen a un snapshot. Cambiar el vigente los hace históricos, no los reasigna. |
| RuleResult | id, runId, instanceId, status, severity, preconditionResult, operands, locators, diagnostics | Un estado terminal por instancia; valores incluyen nominal/intervalo/unidad o presencia de null. |
| RecalculationDirection | directionId, instanceId, targetSide, targetKey | Configurada expresamente para una igualdad; destino único e identidad canónica. |
| Preview | id, baseVersionId, profileId, policyId, state, proposalIds[], graphSummary | Solo puede aplicarse contra la base que la produjo. Incluye resultados no disponibles y motivos. |
| Proposal | id, previewId, directionId, targetKey, before, exactNominal, derivedInterval, after, readKeys[], predecessorIds[], state, diagnostics | after es el valor ya cuantizado y la precisión que leerán sus consumidores y se exportará. |
| ApplyReceipt | id, previewId, acceptedIds[], closureHash, baseVersionId, newVersionId, validationRunId, appliedAt | Constancia funcional del cambio, no un recibo del sistema de revisión gentle-ai. Solo existe tras publicar la versión completa. |
| Job | id, workspaceId, kind, baseVersionId?, status, progress, startedAt, deadline, resultRef?, diagnostics | kind=import/validate/preview/apply/export. Una tarea activa global; estado terminal no retrocede. |

`ApplyReceipt` es trazabilidad de negocio. El desarrollo con recibos continúa `disabled/unmanaged`.

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
Una preview puede contener propuestas available y blocked; solo available admite selección.

**Proposal:** `available → accepted → applied`, o `available → discarded | obsolete`;
`blocked` conserva su motivo. `accepted` existe en el candidato de aplicación mientras se ejecuta
la revalidación; un fallo/cancelación conserva la preview ready sin mutar los datos vigentes.

## Transacción de aplicación

La petición contiene previewId, baseVersionId y el conjunto exacto seleccionado. Se verifica
la clausura de antecesores, unicidad de destinos, vigencia y ausencia de bloqueos. El worker
construye un candidato con copia lógica de los hechos modificados; nunca cambia el snapshot base.
Revalida todas las reglas aplicables y devuelve candidato, resultados y trazabilidad.

En una única sección del hilo principal se verifica de nuevo la versión, el token de cancelación
y el plazo, se registra el nuevo snapshot completo y se cambia currentVersionId. Una respuesta
perdida no repite los cambios: la clave de idempotencia devuelve el mismo Job/resultado.
Un fallo previo a la publicación deja el puntero y los valores anteriores intactos. Tras publicar,
cancelar no revierte un cambio ya confirmado; se devuelve su estado final.

Los fallos de reglas en la nueva validación se muestran y comparan con la anterior. Un error técnico
que impide completar la revalidación, un timeout o una cuota impiden publicar la aplicación.

## Capacidad y limpieza

Se conservan hasta 20 snapshots por workspace y hasta 512 MiB de estado contabilizado de sesión.
La métrica es la suma de bytes UTF-8 de la serialización canónica de snapshots, resultados,
propuestas, diagnósticos y caché de idempotencia, contando objetos compartidos una sola vez;
el cálculo se realiza antes de publicar cada incorporación. No es una promesa de límite RSS exacto.
La caché conserva hashes/referencias, no copias repetidas de cargas. Además se aplican cuotas de
buffers, XML y recursos del worker descritas en los contratos. Si un nuevo candidato excede
cualquiera de las cuotas de sesión, se rechaza sin descartar el original.
La interfaz permite exportar y cerrar para iniciar otra sesión. Estos son límites locales
adicionales; no sustituyen las cuotas de importación o ejecución.

Temporales bajo un directorio propio del proceso, con marcador de sesión; los workers solo reciben
rutas internas emitidas por el servidor. Cierre elimina únicamente los archivos de ese directorio
verificado. La limpieza de restos de una sesión caída usa su marcador, no nombres proporcionados
por el usuario. No se borran originales elegidos para carga ni descargas ya guardadas.
