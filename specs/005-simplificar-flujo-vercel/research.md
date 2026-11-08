# Investigación y decisiones — 005

Fecha: 2026-11-08. Fase 0 de planificación; no se ha instalado, publicado ni ejecutado el diseño. La aclaración de Diego es **priorizar planes gratuitos, con cuotas públicas y comprobación de capacidad**. Una capacidad no demostrada se registra como pendiente; no autoriza rebajar límites de archivo ni contratar un plan superior.

## D1. Destinos vinculados a datos, no a la última pantalla visitada

**Decisión:** introducir `validationBasisId`, identidad inmutable de catálogo, datos, contexto y perfiles, excluyendo direcciones. Importar y aplicar producen una base nueva; cambiar solo configuración la conserva. Recalcular consulta en servidor una ejecución completa compatible con esa base, sin depender de la ejecución histórica seleccionada en Validar. Si no existe, ofrece ir a Validar.

**Motivo:** hoy guardar configuración crea una versión sin alterar importes; exigir una validación de cada versión de configuración provocaría un bucle. Preparar un borrador al entrar no publica versión. La acción Simular ejecuta un único job de 60 s: reserva ID de versión solo si cambia configuración, construye un snapshot virtual y calcula la simulación; una transacción final publica configuración, preview, selección inicial, recibo y terminal del job juntos. Configuración igual reutiliza versión. Fallo/cancelación deja intacta la versión vigente y conserva el borrador; la misma clave recupera IDs/resultado reservados. Se respetan omisiones previas y solo se pregunta por ambigüedades/conflictos pendientes.

**Alternativas descartadas:** mover únicamente el componente, utilizar `selectedRunId` del navegador, encadenar desde Angular o publicar configuración antes de una simulación que pueda fallar. No garantizan entrada directa, compatibilidad de base, atomicidad o recuperación. Extraer funciones puras de configuración/preview si hace falta, sin reinterpretar el motor. Las decisiones sin confirmar mantienen protección al salir y no existe un permiso de continuar con pendientes tratados como resueltos.

## D2. Una intención y un botón de descarga

**Decisión:** identificar la intención por `{workspaceId, versionId, kind, runId?}` y ligar a ella resumen, aceptación, trabajo, manifiesto y archivo. Un único botón pasa por preparar, progreso, descargar y reintentar. Bloquear selectores solo mientras la aceptación es incierta; al conocer el trabajo se pueden cambiar, sin que su finalización descargue automáticamente otra intención. Un reintento incierto conserva clave, cuerpo y ETag originales.

**Motivo:** resuelve la coexistencia de selección histórica, atajos de versión aplicada y archivo previo. Corregir el enlace del selector a opciones dinámicas mediante las formas públicas de Angular y probar su valor DOM evita asumir que el estado interno equivale a la elección visible.

**Alternativas descartadas:** forzar siempre la última versión, conservar botones secundarios de descarga o vaciar la elección ante cualquier error. Se mantienen históricos y cancelación. Validar solo navega a Descargar con ejecución; comparación no depende del servicio de exportación.

## D3. Accesibilidad y controles útiles

**Decisión:** halo como hermano del botón dentro de un envoltorio propio, sin clases privadas de Material; duración 4,5 s, alternativa estática para movimiento reducido y colores forzados. Estilos de título/cabecera desplegable acotados por foco visible, sin quitar foco programático, de formularios o errores. Conservar los 17 tipos de selectores y 11 desplegables únicamente cuando aporten alternativas o contenido, según [ui.md](contracts/ui.md).

**Motivo:** el diagnóstico de [evidence.md](evidence.md) distingue foco de título y halo interior. Las pruebas deben comprobar geometría y modalidad de entrada, no solo duración. Los detalles vacíos y acciones duplicadas no tienen valor; exclusiones, dependencias, precisión y origen sí pueden tenerlo.

**Alternativas descartadas:** desactivar todo contorno, ocultar información útil bajo ayuda genérica o sustituir controles accesibles por elementos sin semántica.

## D4. Alojamiento separado con baseline gratuito explícito

**Decisión:** Vercel Hobby con Fluid Compute, Node 24.x y 2 GB/1 CPU; frontend Angular estático y backend Node en proyectos separados. Neon Free PostgreSQL será la autoridad transaccional; QStash Free entregará trabajos y mantenimiento; Vercel Blob privado guardará objetos inmutables, accesibles solo desde backend. El adaptador local de memoria/archivos continúa existiendo.

**Motivo:** una sesión global en memoria, workers arrancados después de responder y archivos temporales no ofrecen continuidad pública entre instancias. PostgreSQL conserva metadatos y transacciones; los archivos y bloques grandes quedan fuera de sus filas. No se presume que gratuidad equivale a capacidad ilimitada o aptitud para informes reales.

**Alternativas:** Pro/Neon Launch ofrecen más capacidad, pero no son el baseline elegido por el usuario; solo se reconsideran con decisión explícita. Redis/KV como autoridad, una fila JSON con toda la sesión o disco temporal como persistencia complican publicación atómica, límites o continuidad. No se adoptan.

Fuentes: [Hobby](https://vercel.com/docs/plans/hobby), [límites Functions](https://vercel.com/docs/functions/limitations), [Fastify](https://vercel.com/docs/frameworks/backend/fastify), [runtimes](https://vercel.com/docs/functions/runtimes). Cuotas y admisión concretas: [deployment.md](contracts/deployment.md).

## D5. Sesión anónima y autorización por petición

**Decisión:** Angular genera 256 bits con WebCrypto y un nonce de creación y los persiste en `sessionStorage` antes de pedir la sesión; el secreto va en `X-CE-Session`, nunca en URL. El servidor valida formato/32 bytes, controla IDs/cuotas y guarda solo hashes de secreto y nonce vinculados; no afirma medir su entropía. Misma pareja recupera sesión; reutilizar uno con otro produce conflicto; repetir una pareja cerrada/caducada no resucita ni crea otra sesión. Crear otra requiere una acción explícita con ambos nuevos. La respuesta contiene solo metadatos.

El almacenamiento se separa por origen frontend, base API y perfil de despliegue; no guarda Excel ni datos del negocio. Recargar la misma pestaña conserva sesión; contextos de navegador independientes crean sesiones distintas. El modo local conserva bootstrap compatible. Se redactan secreto y nonce en logs; los pocos IDs de un intento incierto se conservan para recuperar su recibo, no para reconstruir datos del negocio.

**Motivo:** quitar cuentas no significa quitar autorización. Cada consulta, fragmento, histórico, explicación y descarga verifica propietario dentro de la consulta. El contexto alojado se resuelve por petición, nunca mediante un token o almacén mutable global. Una referencia ajena produce respuesta genérica sin revelar su existencia.

**Alternativas descartadas:** token común en bootstrap público, identificadores como permisos, cookies compartidas entre proyectos o aceptar desde cualquier `*.vercel.app`. CORS usa orígenes exactos; no sustituye autenticación. `OPTIONS` no exige secreto, pero la petición real sí. [CORS](https://vercel.com/kb/guide/how-to-enable-cors), [protección de previews](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/options-allowlist).

## D6. PostgreSQL pequeño y bloques inmutables

**Decisión:** persistir sesiones, versiones, bases, trabajos, idempotencia, referencias, índices paginados, reservas, leases y outbox en PostgreSQL. Estado canónico pesado en bloques privados identificados por contenido, con deduplicación exclusivamente dentro de la sesión y referencias compartidas entre versiones. Rehidratar solo la entrada del trabajo en el worker; las rutas no reconstruyen toda la sesión.

**Motivo:** se conservan exactitud, numeradores/denominadores como cadenas y semántica del motor sin duplicar veinte snapshots ni enviar documentos gigantes a la base de datos. Cuotas separadas: estado retenido 512 MiB y archivos 512 MiB; máximo 20 snapshots. SQL es autoridad para referencias publicadas y permisos, incluso si el objeto existe antes de publicar.

**Alternativas descartadas:** serializar toda la sesión en una fila, hidratarla en cada consulta, deduplicar entre visitantes o conservar objetos sin propietarios/cuota. Los índices paginados son proyecciones reconstruibles, no otra autoridad de cálculo.

**Hallazgo de transporte:** los resultados actuales pueden incluir `run.resultIds`, `factReads` y otras listas grandes aunque se fragmenten los Excel. El modo alojado tendrá JSON compacto de hasta 1 MiB UTF-8 real, páginas de hasta 50 filas además del presupuesto de bytes y explicación/lecturas paginadas. Un valor original individual mayor que ese presupuesto se recupera por fragmentos con hash y tamaño, sin truncarlo ni declararlo no soportado. La API local compatible se conserva explícitamente; la interfaz usa el contrato compacto. No se cargan listas completas en la ruta para paginarlas después.

## D7. Fragmentos autenticados de extremo a extremo

**Decisión:** transferir fragmentos binarios de hasta 3 MiB mediante rutas propias autenticadas; solo backend usa Blob privado. IDs y rutas son del servidor; antes de aceptar cada fragmento se reservan cuotas, se verifica propietario y se registra tamaño/hash. Una repetición idéntica es idempotente y otra con hash distinto entra en conflicto. Sellar comprueba bytes completos, hash, estructura ZIP y límites antes de usar el archivo.

**Motivo:** Functions limita petición/respuesta a 4,5 MB, inferior a los 10 MiB por archivo admitidos. No se envían SDK, tokens ni URLs de Blob a Angular. Tras cierre no se aceptan nuevas partes o publicaciones; una segunda autorización antes de registrar una parte impide publicar una recepción que coincidió con la revocación. Los bytes ya en tránsito no pueden retirarse.

**Exportación:** ZIP de hasta 100 MiB reales, incluido overhead, con hasta 34 partes; manifiesto visible solo después de persistir todas sus partes y hashes. El navegador verifica tamaño/hash y ensambla el ZIP. Se reserva el pico de `/tmp` y se evita acumular simultáneamente exportaciones completas, entradas y staging sin presupuesto.

**Alternativas descartadas:** multipart grande hacia Function o una URL privada que siga funcionando tras cerrar la sesión. El [streaming tiene una excepción documentada al límite de respuesta](https://vercel.com/kb/guide/how-to-bypass-vercel-body-size-limit-serverless-functions), pero exigiría comprobar el adaptador real y las descargas abiertas al revocar; no es la vía elegida. Las opciones oficiales de [carga directa](https://vercel.com/docs/vercel-blob/client-upload) y [URLs firmadas](https://vercel.com/docs/vercel-blob/vercel-signed-urls) se evaluaron, pero este diseño elige la mediación autenticada por fragmentos.

## D8. Trabajos durables, una publicación y ejecución limitada

**Decisión:** aceptar en transacción la sesión/base/cuotas, el trabajo y su outbox; esperar la publicación de la referencia en QStash antes de confirmar aceptación normal. Si el envío es incierto, responder ` 503 JOB_DISPATCH_UNCERTAIN` con referencia recuperable, no un 202 que aparente ejecución. Repetir la misma clave recupera y, cuando corresponda, republica el mismo trabajo. Callback con firma, URL y cuerpo sin transformar verificados; reclamar lease con fencing y permiso global CPU= 1, por instancia= 1 y por conjunto= 1. Esperar al worker y a la publicación transaccional antes de responder 2xx. Mensajes solo contienen referencias, no archivos o snapshots.

**Motivo:** `waitUntil` o un worker abandonado tras responder no sustituyen ejecución durable. Cola válida diez minutos desde aceptación; nunca iniciar después. El plazo de 60 s desde el primer inicio incluye hidratación, cálculo, escritura y publicación. Callback con techo 120 s y timeout de entrega congruente; un intento iniciado no vuelve a empezar desde cero tras perder su worker. Se conserva resultado terminal o se registra timeout/fallo; duplicados consultan estado.

**Publicación:** comparar sesión viva, lease/fence, cancelación, deadline y CAS; publicar punteros, versión, recibo y terminal del trabajo juntos. Cancelación persistida, consulta del worker cada 750–1000 ms y señal/terminación; la salida tardía se rechaza. Un permiso de un proceso huérfano se mantiene hasta el techo conservador de su invocación, evitando dos workers vivos por expiración anticipada.

**Alternativas descartadas:** respuesta 202 antes de persistir, reejecución sin límite desde cada callback o CAS solo en memoria. Fuente: [trabajo después de responder](https://vercel.com/kb/guide/troubleshooting-inconsistent-logs-in-vercel-functions). El outbox y la limpieza se recuperan periódicamente, sin depender de que exista una pestaña abierta.

QStash verifica [firma y contenido](https://upstash.com/docs/qstash/howto/signature), tiene [reintentos configurables](https://upstash.com/docs/qstash/features/retry) y [deduplicación limitada a diez minutos](https://upstash.com/docs/qstash/features/deduplication). La idempotencia de sesión permanece en SQL; [flow control](https://upstash.com/docs/qstash/features/flowcontrol) es defensa adicional, no sustituto del permiso global transaccional.

## D9. Caducidad, residuos y presupuestos gratuitos

**Decisión:** 60 min de inactividad significativa y 24 h absolutas; polling, recarga, foco, fragmentos automáticos y descargas por partes no extienden actividad. Comprobar vigencia al autorizar y publicar; cierre/caducidad revocan de inmediato y limpian en un máximo de 24 h. Un mantenimiento QStash horario revisa outbox, leases y objetos registrados pendientes, sin enumerar todo Blob en cada tick. Polling de trabajo activo cada cinco segundos, con retroceso a diez; sin heartbeat en reposo.

**Motivo:** se reservan 24 disparos de mantenimiento al día. Estimación de despertares Neon: 5 min de inactividad × 24 × 0,25 CU × 30 días ≈ 15 CUh/mes; cada 15 min serían ≈ 60 CUh. Es una estimación que debe medirse, no garantía de coste. La lectura de estado muestra plazos vencidos sin esperar al mantenimiento; la liberación de permisos respeta 120 s desde claim de una invocación posiblemente viva. Reservar presupuesto también para reintentos, revocación y GC impide que admisión de trabajo consuma lo necesario para limpiarlo.

**Alternativas descartadas:** limpieza al cerrar navegador, confiar en un cron diario que no satisface el plazo, o asumir que cuotas del proveedor impiden por sí solas sobrecostes/interrupciones. El agotamiento suspende nuevas admisiones con diagnóstico; no cambia el máximo de archivo. Baseline: cuatro sesiones activas, diez creaciones/día UTC, ocho trabajos en cola, treinta trabajos/día y ciento veinte en treinta días móviles. Límites adicionales de almacenamiento, transferencias y operaciones, incluido mantenimiento, quedan fijados en [deployment.md](contracts/deployment.md).

Fuentes consultadas: [Neon Free y suspensión por cuota](https://neon.com/pricing), [QStash Free](https://upstash.com/pricing/qstash), [Blob: uso y precios](https://vercel.com/docs/vercel-blob/usage-and-pricing), [Cron de Vercel Hobby](https://vercel.com/docs/schedules/cron-jobs/usage-and-pricing). Un proyecto compartido, uso fuera de la aplicación, ataques o cambios del proveedor impiden prometer coste cero o disponibilidad continua.

## D10. Dependencias y build reproducible

**Decisión:** mantener Node local 24.22.2, npm 11.19.1, Angular/Material 22.2.4, CLI 22.2.5, TypeScript 6.0.3, Fastify 5.12.7 y ANTLR herramienta/runtime 4.13.2. Nuevas dependencias backend exactas: `pg` 8.23.1, `@types/pg` 8.23.1 para desarrollo, `@vercel/blob` 2.8.2 y `@upstash/qstash` 2.12.1; el driver PostgreSQL usa URL TLS agrupada, pool máximo 2 por instancia y transacciones cortas, liberadas antes de ejecutar un worker.

**Motivo:** se necesita PostgreSQL real también en integración local. Se evaluó `@neondatabase/serverless` 1.2.0, pero no se adopta para evitar un segundo transporte de base de datos. Pins comprobados en registros oficiales sin instalar: [pg](https://registry.npmjs.org/pg/latest), [Blob](https://registry.npmjs.org/@vercel%2Fblob/latest), [QStash](https://registry.npmjs.org/@upstash%2Fqstash/latest).

Cada transacción usa el mismo cliente desde BEGIN hasta COMMIT/ROLLBACK y `release` garantizado; no una sucesión de consultas del pool. Normalizar URL y opciones TLS sin que parámetros contradictorios sobrescriban la verificación del certificado; nunca `rejectUnauthorized:false`. [Transacciones pg](https://node-postgres.com/features/transactions), [TLS pg](https://node-postgres.com/features/ssl).

En Vercel se fija Node **24.x**, porque el proveedor actualiza minor/patch; registrar versión efectiva y comprobar compatibilidad, sin afirmar que allí se ejecuta exactamente 24.22.2. La imagen de build Amazon Linux 2023 incluye Java 11 compatible con el generador; registrar Java y comparar los ocho archivos generados, manteniendo JAR/gramáticas con hash fijado. [Versiones Node](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions), [imagen de build](https://vercel.com/docs/builds/build-image).

**Alternativas descartadas:** actualizar el toolchain local para coincidir ciegamente con el proveedor, generar ANTLR en la petición o descargar un JDK nuevo innecesariamente. Los dos proyectos requieren acceso a paquetes compartidos fuera de su raíz y trazado explícito de workers, parser y assets: [monorepos](https://vercel.com/docs/monorepos/monorepo-faq).

## D11. Evidencia y documentación al final

**Decisión:** pruebas locales obligatorias con dos orígenes y dos instancias, PostgreSQL real y adaptadores controlados de cola/objetos; pruebas Linux de packaging, límites máximos, memoria y archivos; después prueba real solo con recursos y autorización disponibles. Si 2 GB no bastan, optimizar y exponer la incompatibilidad, sin bajar límites ni activar Pro automáticamente.

**Motivo:** ni un proveedor elegido ni dos configuraciones acreditan capacidad o aislamiento. El motor permanece sin reinterpretación; regresiones COREP, FINREP F 01.01 y texto/fechas mantienen resultados guiados. README se escribe al final con cuatro capturas reales, dos diagramas y la declaración SDD con Spec Kit; la aceptación humana pendiente de 004 no se transforma en aceptación de 005.

**Alternativas descartadas:** sustituir una prueba alojada por simulación local sin indicarlo, fijar contadores de pruebas no ejecutadas o documentar pantallas futuras como si ya existieran.
