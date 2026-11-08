# Modelo de datos — 005

Diseño propuesto tras [research.md](research.md). El motor y sus contratos numéricos no cambian de significado. Todos los recursos alojados pertenecen a una sesión; una referencia nunca concede autorización.

## Identidades e invariantes

- `sessionId`: UUID del servidor; `tokenHash` único y `creationNonceHash` único, vinculados para creación idempotente. Nunca persistir el secreto en claro.
- `workspaceId`, `versionId`, `runId`, `reviewId`, `previewId`, `jobId`, `artifactId`: identidades del servidor, siempre consultadas junto con `sessionId` y, cuando corresponde, `workspaceId`.
- `validationBasisId`: UUID de catálogo, datos, contextos y perfiles inmutables; cambia con importación/aplicación, se conserva al cambiar solo direcciones. Una ejecución compatible debe estar completa y tener esa base, no necesariamente la misma versión de configuración.
- `revision` y ETag: concurrencia de workspace, decisión, selección u operación. Idempotencia comprueba el recibo anterior **antes** de rechazar una base actualmente antigua; misma clave con fingerprint distinto es conflicto.
- `canonicalHash`: digest de representación canónica versionada. Mantener cadenas exactas de numerador/denominador, unidades, precisión, ausencias, orden y fuentes; no transformar cantidades a `number` ni persistir Map/Set/Date/BigInt/ciclos.

## Entidades de autoridad en PostgreSQL

| Entidad | Campos esenciales y validación |
| --- | --- |
| `DemoSession` | id, tokenHash, creationNonceHash, createdAt, lastMeaningfulActivityAt, expiresAt, absoluteExpiresAt, revokedAt, reason, quotaUsage. Máximo inactivo 60 min/absoluto 24 h; polling/GET/recarga/partes no renuevan. |
| `WorkspaceRecord` | sessionId, id, currentVersionId, currentBasisId, revision, status; un conjunto activo por sesión, conservando el alcance local. |
| `ValidationBasis` | id, owner, catalogRef, dataRef, contextsRef, profileIds, hashes. Inmutable; referencias completas a las entradas que afectan cumplimiento. |
| `WorkspaceVersion` | id, owner, parentId, basisId, directionsRef, contentManifestRef, reason, createdAt, revision. Razón import/configuration/application; máximo 20 snapshots retenidos. |
| `ValidationRunRecord` | id, owner, versionId, basisId, status, summary compacto, resultIndexRef, diagnosticsRef. Índices ordenados permiten páginas sin cargar resultados completos. |
| `DirectionReviewRecord` | id, owner, basisId, sourceRunId, baseVersionId, revision, state, counts, choicesRef, expiresAt. Conserva elegidos/omitidos; pendiente no equivale a omisión. |
| `RecalculationOperation` | id, owner, requestFingerprint, inputVersionId, basisId, runId, reviewId/revision, reservedEffectiveVersionId, configChanged, reservedPreviewId, jobId, phase. Un job construye snapshot virtual y publica configuración+preview+selección+recibo juntos; configuración igual reutiliza versión. |
| `PreviewRecord` / `ProposalSelectionRecord` | identidades y contratos004 conservados, base efectiva, basisId, manifestRefs, revisión y máscara compacta, counters, hash, estado. Publicación inicial de preview+selección atómica. |
| `JobRecord` | id, owner, kind, inputRefs, base/revisión, acceptedAt, queueExpiresAt, startedAt?, deadlineAt?, terminalAt?, status, cancelRequestedAt?, fence, attemptId?, resultRefs, diagnostics. Sin closures ni objetos de proceso persistidos. |
| `OperationReceipt` | owner, keyHash, method/path, requestFingerprint, expectedBase, responseStatus, jobId/operationId/resultRefs. Duración hasta revocación/limpieza; no depende de la deduplicación de diez minutos de la cola. |
| `OutboxEntry` | id, owner, jobId, dispatchState, attempts, nextAttemptAt, publishedMessageId?, lastError. Commit junto al job; referencias pequeñas, sin contenido de archivos. |
| `CpuPermit` / `Lease` | scope global/workspace, jobId, fence monotónico, claimedAt, safeReleaseAt. Un CPU global y por conjunto; nunca reasignar un permiso de proceso posiblemente vivo antes de 120 s desde claim. |
| `QuotaReservation` / `UsageLedger` | owner/scope, recurso, unidades reservadas/consumidas, operación, vencimiento y estado; incluye provisional, reintento, transferencia y limpieza. Contadores atómicos y ventanas UTC/móviles definidas en deployment. |
| `CleanupTask` | owner, objeto/ref, motivo, notBefore, deadline, attempts, lastError, state. Persiste aunque sesión esté revocada; no requiere token del visitante. |

No guardar una sesión entera en una fila JSON ni abrir transacciones durante cálculo/red larga. `pg` usa un cliente para BEGIN/COMMIT/ROLLBACK y lo libera antes de ejecutar el worker; publicación final usa otra transacción corta.

## Archivos y bloques privados

| Entidad | Campos y reglas |
| --- | --- |
| `UploadBatch` | owner, id, baseVersionId (UUID o null para conjunto vacío), catalogFileId, reportFileIds, declaredTotalBytes, state, reservationId, expiresAt. Un catálogo+ 1–20 informes, total ≤ 50 MiB. |
| `StoredFile` | owner, id, batchId?, name público sanitizado, mime, byteLength, sha256, partCount, state, retainedByRefs. Cada entrada ≤ 10 MiB; nunca ruta del cliente. |
| `ObjectPart` | owner, file/artifact/block, index, size ≤ 3 MiB, sha256, privateObjectKey, status. Único(owner, recurso, index); mismo hash/tamaño reintenta, distinto 409. |
| `ObjectManifest` | codecVersion, owner, orderedParts, wholeSize/hash, sealedAt, refs, state. Sellar verifica continuidad, totalidad, hash completo y guardasZIP; nunca publicar un manifiesto parcial. |
| `CanonicalBlock` | owner, codecVersion, hash, byteLength, privateObjectKey, refCount, reservation. Contenido inmutable, deduplicado solo dentro de la sesión; partes grandes con representación fragmentada. |
| `SnapshotManifest` | owner, versionId, codecVersion, rootRefs, sharedRefs, accountedBytes. Referencias estables conservan compartición entre versiones sin duplicar20copias. |
| `ExportArtifact` | owner, id, intent={workspaceId, versionId, kind, runId?}, jobId, manifestRef, status, expiresAt, sourceHashes. ZIP final ≤ 100 MiB real incluido overhead; máximo 34 partes. |

Estado retenido ≤ 512 MiB y archivos ≤ 512 MiB son presupuestos separados; no sumarlos como si fueran una única cuota actual. Contar bloques únicos, manifiestos/índices y reservas según su categoría; medir bytes reales de la codificación. La cuota global gratuita puede impedir admisión con diagnóstico explícito aunque la petición respete su límite individual.

Originales FINREP/COREP siguen inmutables mientras cualquier versión los referencia. Promover staging a original retenido cambia referencias en la misma publicación; no eliminar sus partes al cerrar la inspección. Para exportar, reconstruir solo lo necesario en `/tmp` y verificar tamaño/SHA antes de `retainedSource`/`verifySource`; no confiar en un archivo temporal previo.

## Transiciones

- Sesión: `active → revoked|expired → cleanup_pending → deleted`. Revocación en la autoridad antes de responder; todo commit vuelve a comprobarla. Bytes ya recibidos/en tránsito no son revocables.
- Archivo: `reserved → receiving → sealing → sealed → retained`; cualquiera puede pasar a `cleanup_pending → deleted` por cancelación, exceso, caducidad o fallo. Reservas de objetos inciertos no se liberan antes de reconciliar.
- Job: `queued/dispatch_pending → running → succeeded|failed|cancelled|timed_out`; cola vence a 10 min, ejecución a 60 s desde primer claim. No reiniciar un intento iniciado tras perder su worker. Reentrega terminal devuelve estado existente.
- Recalcular: `needs_validation|no_candidates|pending|ready → simulating → completed|failed`. Entrar crea/reusa borrador sin versión; Simular requiere cero pendientes y calcula contra snapshot virtual. Solo el éxito publica configuración cambiada y preview juntos; fallo/cancelación conserva versión y borrador previos.
- Descarga UI: `idle → accepting → preparing → ready → transferring → ready`, con `uncertain|failed|cancelled|expired` recuperables. Intención y operación son identidades distintas: cambiar intención no altera el trabajo antiguo ni autoriza descargarlo como actual.

## Publicación, concurrencia y proyecciones

1. Reservar y persistir job/outbox en transacción con recibo; escribir bloques provisionales privados fuera de transacción.
2. Claim transaccional verifica sesión, cola, cuotas y permisos; obtiene fence. Worker recibe referencias, rehidrata solo entrada y devuelve referencias compactas.
3. Commit final compara sesión activa, base/ETag, fence, cancelación y deadline; publica versión/punteros/recibo/job terminal juntos. Configurar-y-simular publica su nueva configuración solo si cambió, preview y selección inicial juntos; aplicación incluye revalidación y originales retenidos.
4. Fallar no publica prefijos; objetos sin referencia quedan en cleanup. Un callback antiguo no puede publicar aunque termine correctamente.
5. Índices SQL contienen claves de orden y contadores, sin arrays globales de IDs/lecturas. Cursor firmado vincula owner, recurso, base/revisión, filtro y última clave; máximo 50 filas y 1 MiB real por respuesta. Valor individual mayor se presenta por descriptor fragmentado, nunca truncado.

## Estado mínimo del navegador

`sessionStorage` conserva token, nonce y perfil de conexión; además puede conservar ID de operación/job y el intento mínimo necesario para reintentar exactamente (workspace/version/kind/run, key, ETag, revisión). No guarda Excel, reglas, hechos, blobs, respuestas de negocio ni secretos de proveedor. Cambiar el perfil/URL usa otro namespace; cierre/caducidad borra credenciales y operaciones locales. Una subida parcial tras recarga requiere reelección del mismo archivo y verificación de hash o descarte explícito; no se inventan bytes perdidos.
