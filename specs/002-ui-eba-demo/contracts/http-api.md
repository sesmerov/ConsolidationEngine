# Contrato HTTP de la ampliación

Diseño 2026-11-04, pendiente de implementación. Extiende `/api/v1` y el
[contrato anterior](../../001-regulatory-validation/contracts/http-api.md).
No modifica las garantías de sesión local, token, Host/Origin, ETag, idempotencia,
aplicación atómica, cancelación ni exportación histórica existentes.

## 1. Transporte y compatibilidad

- Servidor local, `X-CE-Session` en toda ruta salvo bootstrap; token solo en memoria.
- Esquemas JSON cerrados. Sin rutas de disco, AST, código ni mappings aportados por cliente.
- Mutaciones exigen `If-Match` vigente (`"empty"` o ETag fuerte de versión). Los POST
  que crean trabajos exigen `Idempotency-Key` UUID y devuelven un Job existente en replay.
- Idempotencia compara operación, workspace, clave y hash de cuerpo canónico antes de
  exigir base actual, inspección viva o TTL. Cuerpo distinto con la misma clave: 409.
- Un Job no terminal total y los límites existentes de recepción/worker/estado/archivos.
- No mezclar perfiles de libro en un lote nuevo. La ruta antigua `/imports` sigue siendo
  multipart para `ce-report-1`; rechaza los perfiles nuevos y no evita la revisión de alcance.

Los nuevos contratos de tipos son adiciones coordinadas de esquemas y proyecciones;
v1 conserva sus valores y consumidores. El perfil semántico se determina en el servidor
por el adaptador reconocido, no por un campo libre de la petición.

## 2. Capacidades y plantillas

GET `/capabilities` conserva campos anteriores y añade:

- `languageProfiles`: IDs, construcciones soportadas y política de recálculo de cada perfil.
- `reportProfiles`: ID, nombre, módulo, tablas, motor asociado, formas admitidas, campos de
  contexto y límites. Declara COREP C_01.00; no presenta el resto del libro como soportado.
- `importInspection`: `ttlSeconds:900`, `maxActive:1` y necesidad de confirmar exclusiones.

GET `/templates/report` mantiene la plantilla anterior. Se añaden descargas autenticadas:

| Ruta GET | Contenido |
|---|---|
| `/templates/corep-ca1` | Extracto vacío saneado CA1 con Contexto/Instrucciones y perfil identificado. |
| `/templates/demos/corep/catalog` | Catálogo de 16 reglas de la demo COREP. |
| `/templates/demos/corep/report` | Informe visual COREP con datos sintéticos. |
| `/templates/demos/types/catalog` | Catálogo de ocho reglas tipadas. |
| `/templates/demos/types/report` | Libro didáctico `ce-demo-types-1`. |

Las rutas anteriores del ejemplo guiado continúan siendo compatibles para uso avanzado;
la UI principal ofrece los nuevos conjuntos y sus expectativas. No se descarga material
externo en tiempo de ejecución ni se envían datos del informe a terceros.

## 3. Inspección de carga

### Crear inspección

POST `/workspaces/{w}/import-inspections`

Multipart: `catalog` exactamente uno, `reports` de uno a veinte, y un campo `context`
con JSON UTF-8, máximo 16 KiB. Cada parte se valida por nombre, cantidad, tipo y tamaño.
No se elige un formato por la extensión o MIME solamente. Las copias se generan en un
directorio propio, con nombres del servidor y hash calculado durante recepción.

`context` es una de estas formas cerradas:

- `{source:"workbook"}`: todos los informes deben contener Contexto válido de su perfil.
  No inventa valores ausentes. Los valores se muestran para confirmar en la inspección.
- `{source:"form", declaration:{entityId,referenceDate,submissionDate?,currency?,scaleExponent?,displayDecimals?,filingIndicators}}`:
  declaración común a los informes del lote; framework, módulo y alias de contexto los
  determina el perfil. Moneda/escala/precisión son obligatorias para COREP e inadmisibles
  para el complemento tipado. Los indicadores usan códigos exactos y booleanos.

Si el libro contiene Contexto y se envía formulario, los datos de negocio deben coincidir;
una discrepancia se diagnostica, no se sobrescribe silenciosamente. `contextId` es alias
generado por el perfil; nunca se pide al analista preparar una clave técnica. El tipado
de cada campo y las declaraciones admitidas están en los contratos de libro/demo.

Respuesta: 202 `JobDTO`, `kind:"inspect-import"`, mismo ETag de la base. La inspección
usa el worker y no incluye un snapshot previo completo en su entrada. Al terminar:

- Éxito: `resultRef:{type:"import-inspection",id}`; candidato privado y recurso ready
  publicados conjuntamente, sin versión nueva. El resultado no contiene el candidato.
- Fallo/cancelación/plazo: Job terminal con diagnósticos; limpia archivos/preparación
  sin sustituir el conjunto. No deja una inspección confirmable parcialmente.

Si existe una inspección ready/committing: 409 `IMPORT_INSPECTION_EXISTS`; se descarta
la anterior expresamente antes de preparar otra. No se acumulan lotes ocultos. El hash
multipart incluye bytes, orden de informes y declaración canónica, no el boundary.

### Consultar y recuperar

GET `/workspaces/{w}/import-inspections/{id}` → 200 `ImportInspectionDTO`:

`id, baseVersionId?, state, createdAt, expiresAt, inspectionHash, profiles, context,
reports, diagnostics, requiresPartialCoverageAcceptance, commitJobId?, committedVersionId?`.

Cada resumen de informe incluye identidad/nombre/hash de archivo, perfil, tablas/hojas
incluidas, hojas excluidas y número de coordenadas/valores reconocidos. No revela valores
de hojas excluidas, rutas, AST ni el candidato privado. Campos de contexto indican su
origen manual o libro. `inspectionHash` se considera opaco para el cliente.

GET `/workspaces/{w}/import-inspections` devuelve `{active: ImportInspectionDTO | null}`
para recuperar la revisión al refrescar. No es un historial paginado nuevo. GET no extiende
TTL ni necesita If-Match. Los recursos caducados/descartados conservan solo metadatos
mínimos durante la sesión, dentro de cuota, para informar de su estado.

### Confirmar

POST `/workspaces/{w}/import-inspections/{id}/commit`

Cuerpo cerrado: `{inspectionHash, acceptedExcludedSheets:boolean}`.
Exige `acceptedExcludedSheets:true` si la inspección contiene hojas oficiales fuera de
cobertura. La casilla se presenta sin marcar. Sin exclusiones se envía false; no existe
selección arbitraria de tablas, sustitución de contexto ni cambios de datos en este POST.

202 Job `kind:"import"`. Antes de aceptarlo se comprueba ready, base, hash, TTL, cierre,
cuotas y aceptación. El servidor verifica identidad/contenido de sus copias retenidas;
no vuelve a interpretar celdas para construir otro candidato. Al publicar vuelve a comprobar
base/cierre/cancelación/plazo/cuotas, crea una sola versión, marca committed y libera
los recursos privados. Responde por el Job con `newVersionId` y resultRef habitual de import.

Un commit aceptado antes de caducar transfiere la lease al Job por su plazo de 60 s.
Caducidad no interrumpe esa transferencia; cancelar/cerrar sí. Si falla sin publicar,
ready se restaura solo si conserva base, archivos y TTL válidos; de otro modo queda
expired/invalidated y se libera el lote. En todos los casos los datos anteriores quedan intactos.

Replay de una confirmación aceptada devuelve el mismo Job aunque el recurso ya esté
committed, los archivos liberados o el ETag haya cambiado. No crea una segunda versión.

### Descartar

DELETE `/workspaces/{w}/import-inspections/{id}` requiere token e If-Match; sin cuerpo
ni clave de idempotencia. Ready pasa a discarded y libera candidato/archivos, con 200 del
recurso mínimo. Repetición sobre discarded/expired/invalidated no modifica datos. Durante
committing devuelve 409 y señala el Job cancelable; sobre committed devuelve 409, sin
borrar el snapshot. Cerrar el workspace elimina todos sus recursos de forma coordinada.

### Diagnósticos y errores

| Situación | Respuesta / efecto |
|---|---|
| Esquema/partes desconocidas | 400; no Job/candidato publicable. |
| Archivo/cuota de recepción excesivos | 413 o error de cuota existente; cleanup completo. |
| Perfil/estructura/celda inválidos durante worker | Job failed, diagnósticos con archivo/hoja/celda; conjunto intacto. |
| Contexto ausente o discrepante | `MISSING_CONTEXT` / `CONTEXT_MISMATCH` en diagnóstico, sin candidato ready. |
| Otra inspección viva | 409 `IMPORT_INSPECTION_EXISTS`. |
| Exclusiones no aceptadas | 409 `PARTIAL_COVERAGE_NOT_ACCEPTED`. |
| Hash no coincide / recurso no ready | 409 `IMPORT_INSPECTION_NOT_APPLICABLE`. |
| Caducada | 410 `IMPORT_INSPECTION_EXPIRED` al confirmar; GET informa expired. |
| Base cambió | 412 `STALE_VERSION`; inspección invalidated y recursos liberados. |
| Trabajo activo / cierre iniciado | 409 `WORKSPACE_BUSY`. |
| Recurso ajeno/inexistente | 404, sin filtrar información. |

Los códigos nuevos se incorporarán al registro allowlist y a los esquemas de errores;
los mensajes no incluirán stacks ni rutas locales. Límites de diagnósticos siguen acotados.

## 4. Resultados, elegibilidad y recálculo

GET resultados conserva `recalculation.left/right` y añade
`recalculation.policy:{profileId,mode,reasons}` según [data-model.md](../data-model.md).
V2 siempre lo devuelve, incluso con modo undetermined si falla el presupuesto de consulta.
El backend proyecta también política standard/undetermined para resultados v1 para que la
interfaz nueva no deduzca permisos de un campo ausente; no cambia su semántica booleana.

`presentation?:{description?,conceptLabel?}` añade etiquetas no autoritativas, como texto.
Las descripciones alternativas y las fuentes permanecen consultables en detalle.
FactRead/operandos/JSON de resultados admiten las uniones tipadas del modelo; no se
exponen tipos nuevos en un snapshot v1 ni se envía el AST.

| Punto de control | Requisito |
|---|---|
| GET resultados | Regla excluida: ambos lados false, sin target, `RULE_VALIDATION_ONLY` y motivos. |
| PUT directions | Rechazar toda la petición con 422 `INVALID_DIRECTION` y diagnóstico por regla excluida; no quitarla silenciosamente. |
| POST previews | Prevalidar todas las direcciones antes del grafo. Si hay una excluida, rechazar/fallar sin publicar preview ni propuestas, tampoco blocked. |
| POST applications | Comprobar perfil y elegibilidad de la selección guardada, además de base/clausura. El worker repite el control y el hilo principal exige el mismo perfil/política al publicar. |

Errores descubiertos antes de aceptar un Job son HTTP 422; descubiertos dentro del worker
terminan el Job failed con `INVALID_DIRECTION`/`RULE_VALIDATION_ONLY`, sin publicar recursos
parciales. No se admite un parámetro para forzar cálculos de una regla solo de validación.
Las desigualdades pueden tener política standard y ambos lados inelegibles por no ser
igualdad; no se confunden con exclusión absoluta por condicionales/texto/fecha.

Las rutas de selección/aplicación siguen exigiendo un conjunto explícito no vacío y cerrado.
Solo direcciones elegibles generan nodos Kahn. La validación completa posterior incluye
también las reglas excluidas del recálculo, con sus lecturas reales.

## 5. Paginación y consulta de detalles

Se mantienen filtros, cursores HMAC, orden semántico y orden Kahn existentes. La UI nueva
usa páginas de 50; la API conserva su rango 1–200. No se añade ordenación interactiva,
offset, salto arbitrario ni filtrado de una página presentado como global.

El cursor está vinculado a recurso/versión/filtros/revisión y conserva el límite
existente de 8 192 caracteres ASCII en esquema; un cursor inválido nunca reinicia silenciosamente la consulta.
Hasta 20 001 referencias a cursores visitados en cliente para un máximo de 1 000 000 de
resultados; solo la página visible y detalles seleccionados conservan payloads.

Para resolver dependencias fuera de la página sin recorrer todo el conjunto se añade
GET `/workspaces/{w}/previews/{previewId}/proposals/{proposalId}` → `ProposalDTO` con
fuentes y etiquetas de presentación. Solo devuelve una propuesta de esa preview;
404 para asociación incorrecta. Es consulta, no aceptación ni selección de antecesores.

El detalle incluye `calculation?` según el modelo: expresión/precondición, valores
efectivos de fuente/precondición y lecturas capturadas del estado simulado real, con
identificación del productor previo cuando corresponda. Las páginas omiten este campo;
no se derivan entradas de una propuesta consultando los valores originales del informe.
La evidencia se conserva en el bundle contabilizado, no en un caché fuera de cuota.

La comparación mantiene el emparejado semántico de resultados e incluye un filtro nuevo
`changedOnly:boolean` (por defecto false por compatibilidad). Cambiado significa distinto
estado, operandos efectivos, diagnósticos o datos leídos; incluye «Pasa → Pasa» con distinto
valor. El filtro se aplica sobre todo el conjunto antes de paginar y forma parte del cursor.
No compara IDs/tiempos generados ni cambios meramente cosméticos de etiquetas.

## 6. Exportación

Para describir la versión elegida sin deducirla del contexto vigente, GET
`/workspaces/{w}/versions/{versionId}/export-summary` devuelve un DTO cerrado:
`{versionId,profileId,createdAt,reports}`. Requiere sesión y pertenencia de la versión;
404 para versión ajena/inexistente. Es lectura de snapshot inmutable, sin If-Match.
Cada informe contiene `sourceFileId`, `displayName`, `profileId`, `contextCount`,
`commonEntityId?`, `commonReferenceDate?`, `contextOrigin:"form"|"workbook"`,
`selectedSheets`, `excludedSheets`, `scaleExponent?` y `displayDecimals?`.
Hay como máximo 20 informes; cada lista de hojas tiene como máximo 256 nombres de
hasta 31 caracteres. Los valores comunes se calculan sobre todos los contextos de
su informe; si difieren, se omiten y la UI indica varios valores. No se recortan
listas silenciosamente ni se envían todos los contextIds/contextos, hechos, AST,
mappingSHA o rutas privadas. El formato anterior se agrupa por archivo de origen y
cuenta sus contextos, sin obligar a renderizarlos. Este resumen informativo no permite
al cliente elegir el escritor ni modificar los bindings de una exportación.

POST `/exports` conserva `{versionId,runId?,kind}` y sus guardias. El perfil y bindings
del snapshot elegido determinan el escritor; el cliente no puede imponer otro mapping.
`report.zip` incluye el libro visual de cada informe admitido, cambios y manifiesto de
perfil/huellas/contexto/exclusiones. Los informes v1 conservan su salida anterior.
`results.zip` representa los nuevos tipos de forma exacta en JSON y legible en XLSX.

«Descargar esta versión» tras aplicar envía `receipt.newVersionId`. No reemplaza la
selección del histórico ni usa automáticamente currentVersionId. El ETag protege el
workspace; `versionId` indica los datos exactos exportados.
Un artefacto listo conserva su identidad `kind`, `versionId` y `runId?`; repetir
la descarga de resultados desde una ejecución sólo puede reutilizar su propio
artefacto, nunca un report.zip o resultados de otra ejecución.

## 7. Verificación del contrato prevista

Schemas cerrados para todos los campos/rutas; candidato y rutas ausentes de respuestas;
token/Host/Origin; replay anterior a CAS/TTL; doble confirmación y nueva clave; caducidad,
cuotas, cancelación y cierre durante recepción/parsing/commit; excepción de enlaces solo
en perfil admitido; rechazo de v2 por ruta antigua; cero propuestas excluidas aun con
direcciones internas obsoletas; tipos y cursores; dependencia fuera de página; comparación
changedOnly global; exportación histórica y de versión aplicada sin cambios de selección.
