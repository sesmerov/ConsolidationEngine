# Contrato API y ejecución — 005

Contrato de diseño, no rutas ya implementadas. Base pública `/api/v1`; rutas internas `/internal`. Mantener contratos actuales del modo local, añadiendo proyección compacta usada por la UI en ambos modos. DTO cerrados, IDs opacos y errores públicos sin secretos, rutas internas o referencias ajenas.

API_BASE_URL del cliente es solo el origen backend, sin `/api/v1`; los paths de este contrato ya incluyen ese prefijo. PUBLIC_API_URL del servidor también es un origen sin path y determina la URL exacta de firma interna. Configuración normalizada y validada al iniciar, nunca una URL arbitraria proporcionada por el visitante.

## Autorización, concurrencia y tamaños

- Alojamientos: cada operación privada exige `X-CE-Session`; resolver hash y estado de sesión por petición e incluir propietario en toda consulta. Ningún `app.ce` mutable de sesión global. ID ajeno o inexistente responde 404 indistinguible; sesión inválida/caducada responde 401/410 sin revelar recursos.
- `If-Match` y `Idempotency-Key` en mutaciones que aceptan/publican trabajo; fingerprint de owner+método+ruta+cuerpo+base. Repetición idéntica recupera recibo **antes** de comprobar una base ya antigua; distinta409. Conservación hasta fin de sesión y limpieza.
- JSON público alojado ≤ 1 MiB UTF-8 serializado real; páginas ≤ 50 elementos y presupuesto de bytes, cursor estable firmado por owner/recurso/base/revisión/filtro/última clave. Consultar índices SQL y bloques necesarios, sin hidratar todos los resultados para recortarlos.
- No incluir arrays globales como `run.resultIds`, `proposalIds`, orden/grafo completo o todas las lecturas. Resúmenes escalares y páginas de reglas, resultados, decisiones, propuestas, dependencias y explicación conservan toda información pertinente.
- Un elemento o texto mayor del presupuesto usa descriptor `{valueRef,byteLength,sha256,mediaType}` y partes autorizadas; no truncar ni convertirlo en «no soportado». Lecturas/origen provienen de la ejecución retenida, no de hechos actuales reconstruidos.
- Partes binarias ≤ 3 MiB reales, sin base64/JSON; endpoints y manifiestos no devuelven URLs de Blob. Private responses: `Cache-Control: private, no-store`; CORS también en errores autorizados.
- Content parsers alojados separados: JSON ≤ 1 MiB y binario ≤ 3 MiB, contados durante lectura, sin confiar únicamente en Content-Length. Autenticar y comprobar reservas en onRequest antes de acumular el cuerpo privado; la creación de sesión solo exige formato/origen antes de crear autoridad.

## Sesiones y recuperación

| Método y recurso | Entrada | Resultado y efecto |
| --- | --- | --- |
| GET `/bootstrap` | Ninguna | Hosted: modo, versión pública y límites; nunca token global. Local mantiene respuesta compatible. |
| POST `/sessions` | `X-CE-Session`: candidato 32 bytes base64url; `{creationNonce}`; origen autorizado | 201 metadatos de sesión. Navegador genera ambos con WebCrypto y los persiste antes de enviar; servidor guarda hashes, controla IDs/cuotas y no mide entropía. Misma pareja recupera 200; nonce/token reutilizados con otra pareja 409; sesión cerrada/caducada 410, sin resurrección. |
| GET `/session` | Secreto privado | Metadatos, vencimiento efectivo y conjunto activo; no renueva actividad ni devuelve secreto. |
| DELETE `/session` | Secreto, idempotencia | Revocación transaccional inmediata, cancelación y tareas de limpieza; repetición no restaura nada. |
| GET `/operations/:operationId` | Sesión | Recibo compacto, fase/job/resultRefs; owner obligatorio. |
| GET `/operation-receipts/:key` | Sesión | Recuperar aceptación por clave ya conocida tras respuesta perdida; no adivinar otro trabajo ni crear uno. |

Registrar actividad significativa al aceptar una acción manual de creación de conjunto/carga, edición persistida, validación, simulación, aplicación o preparación de exportación. No en GET, foco, recarga, bootstrap, borrador automático, polling, reintentos idénticos o partes automáticas. Rate-limit renovación para no generar escrituras por cada frame/evento. Aviso UI con diez minutos restantes; no heartbeat de permanencia.

## Carga por fragmentos

| Método y recurso | Contrato |
| --- | --- |
| POST `/workspaces/:w/upload-batches` | `{baseVersionId,files:[{clientFileId,role,name,byteLength,sha256}]}`; `baseVersionId` es obligatorio UUID o `null` para un conjunto vacío, con If-Match también en ese caso. Un catálogo+ 1–20 informes, cada ≤ 10 MiB y total ≤ 50 MiB. Reserva lote/cuotas antes de 201; devuelve IDs servidor, partSize 3 MiB e índices esperados. |
| POST `/workspaces/:w/upload-batches/:b/files/:f/parts/:index` | Cuerpo binario y `X-CE-Part-SHA256`; autenticación, owner, reserva, índice y longitud antes de escribir; calcular SHA real. Segunda comprobación de sesión antes de registrar. Repetición misma parte devuelve mismo recibo; hash/tamaño distinto 409. |
| GET `/workspaces/:w/upload-batches/:b` | Estado y manifiesto compacto de partes registradas, sin rutas/URLs. Permite reanudar un archivo reeleccionado cuyo tamaño/hash coincide. |
| POST `/workspaces/:w/upload-batches/:b/seal` | Base+idempotencia; job durable comprueba totalidad/orden/hash, reconstruye con presupuesto y ejecuta preflight XLSX/ZIP existente. Ninguna fórmula, macro o enlace se ejecuta. |
| DELETE `/workspaces/:w/upload-batches/:b` | Cancela/revoca partes futuras y programa limpieza, sin borrar originales promovidos que otras versiones referencian. |

Un lote sellado sirve como referencia de entrada de inspección/importación; los endpoints de inspección aceptan `uploadBatchId` en modo alojado, excluyente con multipart. El perfil, contexto y aceptación de exclusiones conservan sus contratos. Confirmar una inspección promueve originales retenidos en la misma publicación. Un fallo no devuelve una versión parcial ni libera reservas de objetos inciertos sin reconciliación.

Compatibilidad: multipart local existente sigue disponible únicamente en modo local. El adaptador local también implementa fragmentos para probar la nueva UI sin servicios externos. Rechazar hosted multipart grande con diagnóstico de protocolo, no rebajando el máximo de archivo del producto.

## Estado, decisiones y simulación compuesta

GET `/workspaces/:w/recalculation-state` devuelve `{workspaceId,currentVersionId,validationBasisId,compatibleRun?,configuration,review?,counts,state}` con estados `needs_validation|no_candidates|preparation_required|pending|ready`. Es lectura; no prepara ni publica. La selección histórica de Validar no interviene.

POST `/workspaces/:w/recalculation-reviews` con `{baseVersionId,validationBasisId,runId}` prepara/reutiliza borrador de manera idempotente; no publica versión. Mantener revisión, mutationId, paginación/candidatos y guardas existentes. GET de filas acepta ámbito `pending|resolved|all`, calculado globalmente; cuenta y pagina antes de serializar. Las decisiones de productor/lado/omisión se persisten, pero no se aplican a informes.

POST `/workspaces/:w/recalculation-operations`:

- Entrada cerrada: `{baseVersionId,validationBasisId,runId,reviewId,expectedRevision}` más ETag y clave. Rechazar pendientes, revisión caducada, resultado incompatible u obsolescencia antes de aceptar.
- Reservar operation/job y, si configuración cambió, effectiveVersionId; si es igual, reutilizar versión actual. Reservar previewId y recibos en la aceptación, recuperables con la misma clave.
- Un solo job de 60 s construye snapshot de configuración virtual y calcula preview. Publicación final atómica: configuración/version/puntero solo si cambió, preview, selección inicial, recibo y job terminal. Fallo/cancelación no modifica versión ni importes; borrador permanece para nueva acción.
- Respuesta 202 tras envío de cola confirmado: `{operationId,jobId,inputVersionId,effectiveVersionId,reservedPreviewId}`; los dos últimos IDs están reservados, no acreditan versión/preview publicados. `job.resultRef` solo se emite tras éxito terminal. Envío incierto:503 con código y mismos IDs recuperables. GET operación permite rehidratar UI; nueva ejecución tras fallo terminal requiere acción y clave nuevas.

El commit antiguo de direcciones puede permanecer compatible en modo local; la UI nueva usa operación compuesta en ambos modos. La versión de configuración conserva `validationBasisId`; importar/aplicar crean otra. Elegibilidad y Kahn siguen en motor, no en Angular ni SQL.

Aplicación conserva `selectionRef` revision/hash y confirmación explícita; recibo compacto, revisión CAS y contratos004. La unión con arrays legados permanece excluyente. Preview+selección y aplicación+revalidación mantienen publicaciones atómicas.

## Resultados, explicación y descarga

GET de resultados alojados usa proyección compacta explícita: run sin `resultIds`, filas sin todas las lecturas, valores/presentación acotados y contadores. Explicación por resultado se divide en resumen y páginas `operands|reads|origins|diagnostics|descriptions`; valores grandes usan `/values/:valueRef/parts/:index`, propietario y hash. La UI consume el mismo formato en local; la variante legacy local conserva el contrato anterior.

POST `/workspaces/:w/exports` mantiene tipos de contenido actuales y recibe intención `{versionId,kind,runId?}` con ETag/clave; resultados exigen `run.versionId === versionId`, no basta compartir `validationBasisId`. Una versión de configuración sin ejecución propia permite elegir la original o validar expresamente para exportar resultados ahí, sin exigirlo para Simular. Reservar salida; el job genera ZIP con guardas vigentes, lo divide y verifica; solo publica artefacto/manifiesto al persistir todas las partes.

| Recurso | Resultado |
| --- | --- |
| GET `/workspaces/:w/exports/:artifactId` | Resumen compacto e intención exacta, estado, tamaño/hash, caducidad y filename sanitizado. |
| GET `/workspaces/:w/exports/:artifactId/manifest` | Intención, tamaño/hash ZIP y hasta 34 partes ordenadas con índice/tamaño/SHA; sin credenciales, claves privadas o URLs externas. |
| GET `/workspaces/:w/exports/:artifactId/parts/:index` | ≤ 3 MiB binarios autorizados en cada petición; Content-Disposition controlado. El cliente verifica y ensambla, no confía solo en extensión. |

ZIP final ≤ 100 MiB incluido overhead; informes exportados conservan cada XLSX ≤ 10 MiB, lote ≤ 50 MiB comprimido y ≤ 100 MiB expandido, y guardas adicionales actuales de 64 MiB donde proceden. Descarga fallida reintenta parte/artefacto, no recalcula. Cerrar impide nuevas peticiones/publicaciones; no puede retirar bytes ya recibidos o en tránsito. Endpoint legado de archivo completo solo local, nunca vía alojada ordinaria.

## Cola, worker y publicación

1. Transacción corta: autenticar/actividad, comprobar base/cola/cuotas, reservar recursos, job, operation/recibo y outbox. Cola vence a 10 min. No cerrar transacción con cálculo dentro.
2. Esperar publicación QStash de referencias pequeñas. Confirmada→202; perdida/fallida→503 `JOB_DISPATCH_UNCERTAIN` con jobId y key recuperables. Misma clave republica outbox si procede; nunca crea otro trabajo.
3. POST `/internal/jobs/execute`: verificar firma actual/siguiente, URL pública exacta y raw body antes de parsear; mensajes sin Origin válidos solo por esa autenticación. Claim SQL verifica vigencia, plazo, cancelación y permisos/fence. Flow control de cola global 1 es protección adicional.
4. Ejecución esperada, no fire-and-forget: worker hidrata solo entrada, deadline 60 s desde primer claim incluye I/O y publicación. Callback maxDuration 120 s; timeout QStash 120 s. Reintentos de entrega máximos 3, backoff corto y acotado dentro del TTL; SQL decide si aún es ejecutable, no el temporizador del proveedor.
5. Cancelación persistida, consulta coordinador cada 750–1000 ms, señal al worker y terminación. Finalización vuelve a comprobar owner/sesión/base/fence/cancel/deadline y publica referencias+recibo+terminal atómicamente; responde 2xx después.
6. Duplicado terminal→200 resultado anterior. Duplicado en ejecución no inicia worker. Intento iniciado perdido se cierra como fallo/timeout, sin reiniciar plazo; permiso huérfano no se reasigna antes de 120 s desde claim salvo terminación acreditada.
7. GET estado calcula expiración inmediatamente y puede materializarla por CAS sin iniciar trabajo ni renovar actividad. El mantenimiento horario reconcilia lo pendiente; una cola vencida no ejecuta por llegar tarde su mensaje.

POST `/internal/maintenance/sweep` autentica QStash, usa lease y lotes limitados; reconcilia outbox, deadlines, reservas, referencias y limpieza. No depende del navegador ni consume el presupuesto público reservado a trabajos; mantiene su propia reserva de mantenimiento.

## Errores y CORS

Conservar errores de dominio existentes. Nuevos códigos: `SESSION_EXPIRED`, `SESSION_CREATION_CONFLICT`, `PUBLIC_CAPACITY_EXCEEDED`, `JOB_DISPATCH_UNCERTAIN`, `JOB_QUEUE_EXPIRED`, `TRANSFER_PART_CONFLICT`, `TRANSFER_INCOMPLETE`, `ARTIFACT_EXPIRED`, `INCOMPATIBLE_VALIDATION_BASIS`. Cuota devuelve429/503 según límite o proveedor, con motivo público y Retry-After cuando tenga sentido; formato, tamaño y referencia ajena mantienen400/413/404. Nunca etiquetar falta de capacidad como validación aprobada.

Allowlist exacta por entorno. Métodos GET, POST, PATCH, PUT, DELETE y OPTIONS según rutas efectivas; cabeceras Content-Type, X-CE-Session, If-Match, Idempotency-Key, X-CE-Part-SHA256. Exponer ETag, Content-Disposition y X-CE-Part-SHA256 si se emite. `Vary: Origin`; no `Access-Control-Allow-Credentials` ni cookies entre orígenes. Preflight comprueba origen/método/cabeceras sin token; petición real autentica. Origen ajeno no recibe permiso, incluidos errores. Los errores generados por la aplicación conservan CORS autorizado; no se prometen cabeceras sobre rechazos de la plataforma anteriores a ejecutar código. Los tamaños elegidos evitan depender de esos rechazos. No publicar secretos de bypass de previews en Angular.
