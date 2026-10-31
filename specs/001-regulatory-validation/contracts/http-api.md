# Contrato HTTP local

Base: `/api/v1`. Estado: diseño. JSON UTF-8; esquemas cerrados con `additionalProperties:false`
para peticiones. Los esquemas son código de la aplicación, nunca contenido de los Excel.
Las entidades y estados están definidos en [data-model.md](../data-model.md).

## Sesión y transporte

El servidor escucha solo en `127.0.0.1:3000`. En producción sirve también el frontend; desarrollo
usa Angular en `127.0.0.1:4200` con proxy `/api` al backend. Host/Origin se limitan a esas direcciones
según el modo. No se permite CORS comodín ni orígenes `null`. El bootstrap comprueba Host y contexto
de origen; devuelve un token de sesión aleatorio de 256 bits que se mantiene solo en memoria.
Todas las demás rutas API requieren `X-CE-Session`. El token no aparece en URLs, logs ni exports.
Esto acota la interacción del navegador local; no es autenticación multiusuario. Si existe un
workspace activo, bootstrap incluye su identificador para recuperar la vista tras refrescar el
navegador. El token y los datos siguen sin persistirse en el cliente.

Cada snapshot tiene ETag fuerte, por ejemplo `"v-<versionId>"`. Mutaciones sobre un workspace
requieren `If-Match` del snapshot vigente, o `"empty"` antes de la primera carga. Los trabajos
se comparan contra esa misma base al iniciar y al publicar. Nunca se aplica sobre «la última»
versión por defecto. POST de trabajos requiere `Idempotency-Key` UUID. Tras autenticar, el servidor
consulta sesión, workspace, operación, clave y hash del cuerpo antes de rechazar un If-Match antiguo:
un replay idéntico de un trabajo aceptado devuelve el mismo Job/resultado sin reaplicar. Reutilizar
la clave con otro cuerpo da 409. Solo peticiones nuevas pasan a comprobar la versión vigente.
Para multipart el hash combina bytes de cada archivo y metadatos canónicos, no el boundary del
transporte. La caché conserva hashes y referencias, no uploads duplicados, durante la sesión.

## Rutas

Todas las rutas siguientes, salvo bootstrap, requieren token. `{w}` es workspaceId; `{j}` jobId.

| Método y ruta | Petición / respuesta satisfactoria |
| --- | --- |
| GET `/bootstrap` | 200 `{sessionToken, apiVersion, sessionPersistence:"ephemeral", activeWorkspaceId?}`. |
| GET `/capabilities` | 200 perfil/gramática, diferencias semánticas conocidas, soporte y cuotas de importación, ejecución, exportación y sesión detalladas en estos contratos. |
| GET `/templates/report` | 200 plantilla ce-report-1 con instrucciones y ejemplo sintético. |
| POST `/workspaces` | `{name}` → 201 workspace empty y ETag `"empty"`; 409 si ya hay uno activo. |
| GET `/workspaces/{w}` | 200 contexto, versión vigente, conteos y trabajo activo; ETag. |
| DELETE `/workspaces/{w}` | If-Match → 204 tras cancelar/limpiar; cierre explícito y definitivo. |
| POST `/workspaces/{w}/imports` | Multipart `catalog` (uno) y `reports` (1–20) → 202 Job. Sustituye todo el conjunto solo si la carga estructural es válida. |
| GET `/workspaces/{w}/rules` | Página de registros/variantes, diagnósticos y procedencia, fijada a versionId. |
| PUT `/workspaces/{w}/directions` | `{directions:[{instanceId,targetSide:"left"|"right"}]}` → 200 nuevo snapshot/ETag. Reemplazo completo de configuración; invalida previews. |
| POST `/workspaces/{w}/validations` | `{baseVersionId}` → 202 Job de validación. |
| POST `/workspaces/{w}/previews` | `{baseVersionId}` → 202 Job que simula las direcciones configuradas. |
| GET `/workspaces/{w}/runs` | Historial paginado de RunSummary, con filtro de estado opcional `status`; token, sin If-Match. |
| GET `/workspaces/{w}/previews` | Historial paginado de PreviewSummary, con filtro de estado opcional `status`; token, sin If-Match. |
| GET `/workspaces/{w}/jobs/{j}` | 200 estado/progreso/diagnósticos y resultRef cuando termina. |
| DELETE `/workspaces/{w}/jobs/{j}` | 202 si solicita cancelación; 200 estado final si ya terminó. |
| GET `/workspaces/{w}/runs/{runId}/results` | Página de resultados del run, aunque su snapshot ya sea histórico; cada resultado puede añadir recalculation con elegibilidad estructural por lado. |
| GET `/workspaces/{w}/previews/{previewId}` | Estado, base, resumen del grafo y conteos. |
| DELETE `/workspaces/{w}/previews/{previewId}` | Sin cuerpo; token e If-Match vigente → 200 PreviewDTO y ETag actual. Descarta la preview sin crear Job ni snapshot. |
| GET `/workspaces/{w}/previews/{previewId}/proposals` | Página de propuestas, dependencias, valores y bloqueos. |
| POST `/workspaces/{w}/previews/{previewId}/selection` | `{selectedIds}` → 200 `{selectedIds,requiredIds,closureHash,complete,state}` para ready/obsolete; informa clausura, no aplica ni acepta cambios. |
| POST `/workspaces/{w}/applications` | `{baseVersionId,previewId,selectedIds,closureHash}` → 202 Job de aplicación confirmada. |
| POST `/workspaces/{w}/exports` | `{versionId,runId?,kind}` → 202 Job; kind=`report` o `results`. Para results, runId es obligatorio y pertenece a versionId; produce el ZIP descrito abajo. |
| GET `/workspaces/{w}/exports/{exportId}` | 200 descarga producida, con Content-Disposition seguro; nunca una ruta del filesystem. |

Directions utiliza instancias de una validación completa del snapshot actual. La configuración
solo elige un lado; no acepta una expresión nueva ni código. Al crear su nueva versión se conservan
las identidades semánticas de instancias. No se filtran destinos solo por status pass/fail:
una instancia estructuralmente válida, activa y vigente puede conservarse aunque su precondición
actual sea false o indeterminada. La configuración no significa que el cambio ya sea aplicable.
Se revalida su elegibilidad durante preview y se exige precondición true en la versión simulada,
incluidas las condiciones que pasen de false a true por un productor. Un cambio de contexto se realiza reimportando el
conjunto completo de forma atómica; no hay edición parcial de hechos en v1.

El campo opcional `RuleResultDTO.recalculation` tiene exactamente la forma
`{left: DirectionEligibilityDTO, right: DirectionEligibilityDTO}`; cada lado contiene
`{eligible: boolean, target?: Coordinate, diagnostics: Diagnostic[]}`. Es información calculada
para esa consulta con el mismo resolver estructural que PUT directions, sin evaluar valores
ni ejecutar el cuerpo de la regla. Una precondición false no elimina la instancia estructural ni obliga
a tener values para mostrar el destino. Angular presenta coordenadas/diagnósticos recibidos;
no recibe AST ni interpreta expresiones para decidir qué lado es elegible.

La página comparte un WorkBudget entre sus lados e instancias. La memoización vive únicamente
con ese presupuesto durante la petición; no se conserva como caché de sesión. Si se agota,
el lado devuelve eligible=false con diagnóstico de comprobación incompleta, conservando la fila
y el resultado de validación. En un run histórico la elegibilidad es informativa: guardar
direcciones exige una validación completa de la versión vigente y vuelve a comprobar cada lado
en el servidor. eligible=true expresa validez estructural, no que exista ya un cambio aplicable.

Imports, directions, validations, creación/descarte de previews, applications, exports y cierre de workspace exigen
If-Match. Consultas GET, cálculo de selection y cancelación por jobId están exentos; selection
se refiere a una preview fija y devuelve también su estado vigente/obsoleto. Cancelar un Job no
requiere conocer la versión que pudiera haber cambiado mientras corría.
La exportación puede referirse a una versión histórica existente: If-Match protege el workspace
contra cierre/cambio concurrente, y versionId indica exactamente los datos exportados.
Una aplicación requiere selección no vacía, completa y sin destinos en conflicto.
`selection` devuelve los antecesores que faltan; la interfaz debe mostrarlos y obtener una nueva
confirmación. El servidor nunca amplía selectedIds silenciosamente durante la aplicación.

En ready, selection admite propuestas available. En obsolete responde 200 informativo con
`state:"obsolete"`: las propuestas que eran available pasan a obsolete y las blocked conservan
su estado/motivo. `complete` solo indica clausura, nunca aplicabilidad; una selección vacía puede
ser complete=true, pero aplicar siempre exige selección no vacía y preview válida. Selection sobre
discarded/applied devuelve 409 `PREVIEW_NOT_APPLICABLE`; las consultas GET conservan el historial.

El descarte mediante DELETE no requiere Idempotency-Key. En una actualización atómica cambia
la preview ready a discarded y sus propuestas available a discarded; las blocked conservan
estado y motivo. Se conserva el registro durante la sesión, con hechos, versión y ETag intactos.
Repetir el descarte de una preview discarded devuelve 200 sin mutarla, con If-Match vigente.
Una preview applied u obsolete devuelve 409 `PREVIEW_NOT_APPLICABLE` y conserva su estado.
La operación exige que no exista ningún Job no terminal: en caso contrario responde 409
`WORKSPACE_BUSY` para evitar una carrera con la aplicación. Un If-Match obsoleto produce 412
`STALE_VERSION`; ningún rechazo altera la preview ni el snapshot.

## Exportación de resultados y cuotas

`kind=results` genera una única descarga ZIP, `Content-Type: application/zip`, con dos entradas
de nombres fijos en su raíz: `results.json` y `results.xlsx`. JSON conserva valores exactos,
racionales como cadenas, estados, diagnósticos, versiones y procedencias del run solicitado;
XLSX presenta esos resultados mediante celdas literales, sin fórmulas ni enlaces activos. No se
truncan filas ni valores para completar el trabajo. El nombre de descarga lo genera el servidor
y nunca procede de una ruta o nombre aportado por el usuario. `kind=report` mantiene el informe
ce-report-1 definido en [workbook](workbook.md#exportación-y-roundtrip); este ZIP corresponde
exclusivamente a results y no redefine el formato de report.

Las capacidades publican separadamente estos límites locales (1 MiB = 1.048.576 bytes):

| Límite | Valor y métrica |
| --- | --- |
| Cada contenido de results | 64 MiB por `results.json` (bytes UTF-8) y por `results.xlsx` (bytes del XLSX). |
| Paquete results | Tanto la suma de los dos contenidos serializados como el ZIP completo deben ser ≤100 MiB. |
| Carga XML previa de XLSX | `limits.exportXmlWorkloadBytes = 64 MiB`: estimación conservadora antes de construir las celdas. |
| Estado de sesión | 512 MiB de JSON canónico contabilizado, según el modelo. |
| Archivos propios del workspace | 512 MiB acumulados, incluidos staging, archivos de trabajo y exports retenidos. |

La estimación XML es `64 KiB + 128 × filas + 128 × celdas + 6 × bytes UTF-8 de los valores`,
sumando todas las filas/celdas previstas del libro, incluidas cabeceras. Es una comprobación
previa a reservar las estructuras de celdas del escritor, separada de los límites de contenidos
serializados y del ZIP final. Un XLSX comprimido inferior a 64 MiB puede exceder esta estimación.
El motivo `XML_WORKLOAD_LIMIT` explica ese caso; el error público continúa siendo `EXPORT_LIMIT`:
413 si se conoce antes de aceptar o Job failed si se detecta tras el 202. Capabilities publica
el límite y explica esta diferencia; no se sustituyen los controles de bytes reales de salida.

Se comprueba/reserva capacidad antes de crear buffers grandes y se cuentan los bytes reales
durante la generación; una estimación inicial no autoriza exceder el límite. La compresión no
permite exceder el presupuesto: se verifican la suma de contenidos y el ZIP final. Superar una
cuota de contenido/paquete produce `EXPORT_LIMIT`; superar el total de archivos propios produce
`SESSION_LIMIT`. Si se detecta antes de aceptar la petición se devuelve 413; si ya se respondió
202, el Job termina failed con ese código, sin publicar una descarga parcial. Fallo, cancelación
o timeout liberan las reservas al limpiar los archivos de trabajo. Publicar convierte la reserva
en bytes retenidos, ajustándola al tamaño real sin contarlos dos veces. Los exports de la sesión
siguen ocupando cuota mientras se conserven; el cierre solo elimina copias propias de la sesión,
nunca archivos originales ni exportaciones ya guardadas por el usuario. Véase
[capacidad y limpieza](../data-model.md#capacidad-y-limpieza).

## Formatos comunes

Respuesta 202:

```json
{
  "jobId": "<uuid>",
  "kind": "preview",
  "status": "queued",
  "baseVersionId": "<uuid>",
  "pollAfterMs": 1000
}
```

Job terminado: campos anteriores más `startedAt`, `endedAt`, `progress:{completed,total}`,
`resultRef:{type,id}`, `diagnostics:[]`. No devuelve todos los hechos o resultados en polling.
Un job succeeded puede contener reglas que fallan; el resultado de negocio se consulta en el run.

Página asociada a resultados: `{items:[],nextCursor:null|"opaque",total,versionId}`. Parámetros `limit` (1–200,
por defecto 50), `cursor`, `status`, `code` y `table`. Cursor opaco vinculado a recurso, filtro y
versión; filtros incompatibles dan 400. Orden estable por código de regla, variante y binding
canónico. El cursor no usa un offset que cambie al aplicar una versión nueva.

Las listas de historial runs/previews usan `{items,total,nextCursor,revision}`, con `limit`
entre 1 y 200 (por defecto 50), cursor opcional y filtro de estado opcional `status`. Sus elementos son
proyecciones explícitas, no registros completos:

| Elemento | Campos |
| --- | --- |
| RunSummary | id, versionId, profileId, status, startedAt, endedAt? |
| PreviewSummary | id, baseVersionId, profileId, policyId, state, createdAt |

No incluyen resultIds, AST, propuestas ni rutas. El orden es estable por fecha (startedAt en
runs, createdAt en previews) e id. El cursor está firmado con HMAC y vinculado a la revisión de
la colección de resúmenes y sus filtros. Un cambio de colección/revisión invalida el cursor
anterior (`INVALID_CURSOR`); el cliente vuelve a consultar desde la primera página.
Preview.createdAt se captura al comenzar la simulación y se conserva al cambiar su estado.

La página de resultados `ValidationResultsPageDTO` añade `run` y, opcionalmente,
`sourceFiles: SourceFile[]`. Estos archivos pertenecen al snapshot de ese run, aunque ya sea
histórico: permiten resolver los fileId de los locadores a displayNames y procedencia correctos,
sin usar los nombres de la versión vigente. sourceFiles no contiene rutas locales ni autoriza
acceso al filesystem; su ausencia no se sustituye por archivos de otro snapshot.

La misma página puede incluir `configuredDirections?: readonly DirectionChoiceDTO[]`, donde
cada elemento es `{instanceId, targetSide:"left"|"right"}`. Contiene la configuración **completa**
del snapshot del run, independiente de la página y los filtros de resultados. La UI recupera
con ella el borrador completo al cargar/recargar, conserva las elecciones al navegar o filtrar
y muestra el total y las elecciones ocultas conservadas. PUT directions envía ese borrador
completo porque reemplaza la configuración, no solo las elecciones de la página visible.
Si el campo está ausente, no significa configuración vacía: se bloquea guardar y se muestra
un diagnóstico para evitar un reemplazo incompleto. En resultados históricos es de solo lectura.

Resultado abreviado:

```json
{
  "instanceId": "<sha256>",
  "status": "fail",
  "severity": "error",
  "versionId": "<uuid>",
  "profileId": "ce-dpmxl-0.9-closed-v1",
  "values": {
    "left": {"nominal":{"numerator":"11","denominator":"1"}},
    "right": {"nominal":{"numerator":"12","denominator":"1"}}
  },
  "diagnostics": [],
  "sources": [{"fileId":"<uuid>","sheet":"Facts","row":2,"column":"G"}]
}
```

El contrato completo de valor es `{nominal, interval:{lo,hi}, unit}` con racionales en cadenas,
o `{presence:"explicit_null"|"implicit_null",coordinate}`. El ejemplo abreviado omite campos
para legibilidad; la implementación devolverá los campos del modelo, con expresión/precondición,
variante, coordenadas y locadores. No serializa el AST ni rutas locales.

FR-009 incluye además `factReads`, obligatorio aunque sea `[]`, para explicar cada hecho leído:
`{factKey, coordinate, presence, normalizedValue?, originalText?, sourceLocator}`. Presence es
`value`, `explicit_null` o `implicit_null`; normalizedValue es racional con enteros en cadenas
o booleano cuando existe valor. Coordinate conserva la clave completa, unidad, `decimals`, ejes
y su localizador de Coordinates. El sourceLocator principal apunta a Facts para un valor/null
explícito y a Coordinates para un null implícito. No se inventa una fila Facts ausente.

Estas lecturas describen las entradas originales del snapshot, anteriores a default/interval:
no se cambia su presencia por haber usado un default ni se les asigna un único intervalo si la
misma celda se usa con opciones distintas. `values` conserva los operandos/resultados efectivos;
`factReads` permite reconstruir sus entradas, precisión y fuentes, incluidas las de agregados.
Solo se informan lecturas realmente realizadas: una precondición false no genera lecturas del
cuerpo omitido. Los indicadores se conservan separados en metadataReads. JSON usa valores exactos,
sin BigInt ni AST serializados. Esta trazabilidad también forma parte de la exportación results.

Error común:

```json
{
  "error": {
    "code": "STALE_VERSION",
    "message": "La propuesta pertenece a una versión anterior. Vuelve a generarla.",
    "requestId": "<uuid>",
    "locator": null,
    "details": {"expectedVersionId":"<uuid>","currentVersionId":"<uuid>"}
  }
}
```

`locator`, cuando existe, contiene fileId, sheet, row, column y/o ruleCode. Los errores HTTP
describen peticiones/operaciones; los diagnósticos individuales de reglas van en sus registros.
El frontend traduce estados y mensajes al español sin recalcular valores.

## Errores y concurrencia

| HTTP | Códigos y efecto |
| --- | --- |
| 400 | INVALID_REQUEST, INVALID_CURSOR: petición sin efecto. |
| 403 | INVALID_SESSION, ORIGIN_NOT_ALLOWED: no revela datos de sesión. |
| 404 | RESOURCE_NOT_FOUND: ID desconocido, cerrado o de otra sesión. |
| 409 | WORKSPACE_BUSY, ACTIVE_WORKSPACE_EXISTS, IDEMPOTENCY_CONFLICT, SELECTION_NOT_CLOSED, PREVIEW_NOT_APPLICABLE. |
| 412 | STALE_VERSION: If-Match/baseVersion/preview no concuerdan. |
| 413 | UPLOAD_LIMIT, EXPANSION_LIMIT, EXPORT_LIMIT, SESSION_LIMIT: conservar estado anterior; no publicar archivos parciales. |
| 415 | UNSUPPORTED_FILE_TYPE: solo XLSX admitido. |
| 422 | INVALID_WORKBOOK, INVALID_DIRECTION: errores de datos con locador. |
| 428 | PRECONDITION_REQUIRED: falta If-Match en mutación. |
| 500 | INTERNAL_ERROR: mensaje sin stack/rutas; requestId para diagnóstico local. |

Errores descubiertos después del 202 se comunican como Job failed/timed_out con el mismo esquema
de código y diagnóstico, no como una respuesta HTTP retroactiva. Worker terminado o cancelado
antes de publicar no altera la versión. El plazo de 60 segundos incluye el trabajo CPU desde su
inicio; la subida tiene límite de recepción separado de 120 segundos y cuotas de bytes.

La publicación es una operación única del hilo principal tras comprobar versión, cancelación y
resultado completo. Si ya se publicó, la cancelación devuelve succeeded y newVersionId; no promete
deshacerlo. La misma Idempotency-Key recupera ese resultado sin aplicar por segunda vez.

## Experiencia de usuario vinculada al contrato

Flujo: crear conjunto → descargar/rellenar plantilla → cargar catálogo e informes → revisar
diagnósticos/cobertura → validar → filtrar y abrir detalle → elegir destinos → previsualizar →
ver clausura de cambios → confirmar → comparar resultados → exportar. La pantalla mantiene
visible entidad/fecha/versión y señala datos sintéticos del ejemplo. Durante un trabajo muestra
progreso/cancelación; un resultado incompleto nunca usa el mensaje «todo correcto».

Tras refrescar el navegador, bootstrap permite recuperar el workspace y estas listas restauran
el run/preview más reciente disponible y el acceso al historial paginado. Los IDs se recuperan
del servidor durante la sesión; no se depende de Signals anteriores ni se guardan en localStorage.
Consultar historial no habilita cambios sobre una versión histórica.

La ayuda de capacidades explica el subconjunto y las diferencias numéricas conocidas en términos
de cálculo. No presenta hashes, AST ni configuración interna como pasos que el analista deba ejecutar.
