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
| GET `/capabilities` | 200 perfil/gramática, diferencias semánticas conocidas, soporte y cuotas. |
| GET `/templates/report` | 200 plantilla ce-report-1 con instrucciones y ejemplo sintético. |
| POST `/workspaces` | `{name}` → 201 workspace empty y ETag `"empty"`; 409 si ya hay uno activo. |
| GET `/workspaces/{w}` | 200 contexto, versión vigente, conteos y trabajo activo; ETag. |
| DELETE `/workspaces/{w}` | If-Match → 204 tras cancelar/limpiar; cierre explícito y definitivo. |
| POST `/workspaces/{w}/imports` | Multipart `catalog` (uno) y `reports` (1–20) → 202 Job. Sustituye todo el conjunto solo si la carga estructural es válida. |
| GET `/workspaces/{w}/rules` | Página de registros/variantes, diagnósticos y procedencia, fijada a versionId. |
| PUT `/workspaces/{w}/directions` | `{directions:[{instanceId,targetSide:"left"|"right"}]}` → 200 nuevo snapshot/ETag. Reemplazo completo de configuración; invalida previews. |
| POST `/workspaces/{w}/validations` | `{baseVersionId}` → 202 Job de validación. |
| POST `/workspaces/{w}/previews` | `{baseVersionId}` → 202 Job que simula las direcciones configuradas. |
| GET `/workspaces/{w}/jobs/{j}` | 200 estado/progreso/diagnósticos y resultRef cuando termina. |
| DELETE `/workspaces/{w}/jobs/{j}` | 202 si solicita cancelación; 200 estado final si ya terminó. |
| GET `/workspaces/{w}/runs/{runId}/results` | Página de resultados del run, aunque su snapshot ya sea histórico. |
| GET `/workspaces/{w}/previews/{previewId}` | Estado, base, resumen del grafo y conteos. |
| GET `/workspaces/{w}/previews/{previewId}/proposals` | Página de propuestas, dependencias, valores y bloqueos. |
| POST `/workspaces/{w}/previews/{previewId}/selection` | `{selectedIds}` → 200 `{selectedIds,requiredIds,closureHash,complete}`; no aplica ni acepta cambios. |
| POST `/workspaces/{w}/applications` | `{baseVersionId,previewId,selectedIds,closureHash}` → 202 Job de aplicación confirmada. |
| POST `/workspaces/{w}/exports` | `{versionId,runId?,kind}` → 202 Job; kind=`report` o `results`. |
| GET `/workspaces/{w}/exports/{exportId}` | 200 descarga producida, con Content-Disposition seguro; nunca una ruta del filesystem. |

Directions utiliza instancias de una validación completa del snapshot actual. La configuración
solo elige un lado; no acepta una expresión nueva ni código. Al crear su nueva versión se conservan
las identidades semánticas de instancias. Se revalida su elegibilidad durante preview, incluidas
las precondiciones que cambien por un productor. Un cambio de contexto se realiza reimportando el
conjunto completo de forma atómica; no hay edición parcial de hechos en v1.

Imports, directions, validations, previews, applications, exports y cierre de workspace exigen
If-Match. Consultas GET, cálculo de selection y cancelación por jobId están exentos; selection
se refiere a una preview fija y devuelve también su estado vigente/obsoleto. Cancelar un Job no
requiere conocer la versión que pudiera haber cambiado mientras corría.
La exportación puede referirse a una versión histórica existente: If-Match protege el workspace
contra cierre/cambio concurrente, y versionId indica exactamente los datos exportados.
Una aplicación requiere selección no vacía, completa y sin destinos en conflicto.
`selection` devuelve los antecesores que faltan; la interfaz debe mostrarlos y obtener una nueva
confirmación. El servidor nunca amplía selectedIds silenciosamente durante la aplicación.

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

Página: `{items:[],nextCursor:null|"opaque",total,versionId}`. Parámetros `limit` (1–200,
por defecto 50), `cursor`, `status`, `code` y `table`. Cursor opaco vinculado a recurso, filtro y
versión; filtros incompatibles dan 400. Orden estable por código de regla, variante y binding
canónico. El cursor no usa un offset que cambie al aplicar una versión nueva.

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
| 413 | UPLOAD_LIMIT, EXPANSION_LIMIT, SESSION_LIMIT: conservar estado anterior. |
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

La ayuda de capacidades explica el subconjunto y las diferencias numéricas conocidas en términos
de cálculo. No presenta hashes, AST ni configuración interna como pasos que el analista deba ejecutar.
