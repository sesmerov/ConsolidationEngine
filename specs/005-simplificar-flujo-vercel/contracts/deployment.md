# Contrato de preparación y operación — 005

Baseline gratuito elegido por Diego, **pendiente de pruebas de capacidad y de alojamiento real**. No se crean cuentas, instalan servicios, publican proyectos ni contratan upgrades durante el plan. El adaptador local permanece disponible; informes reales quedan fuera de la demo pública.

## Dos proyectos y artefactos

| Proyecto | Configuración decidida |
| --- | --- |
| Frontend | Root Directory `apps/web`; acceso a archivos compartidos fuera de raíz habilitado. Build desde raíz del repo con npm fijado: contratos y Angular, sin compilar API o generar ANTLR. Copiar `dist/web/browser` a `apps/web/.vercel-dist/browser`, Output Directory dentro de la raíz. Estático; fallback de rutas de app a index preserva assets/404 reales. |
| Backend | Root Directory `apps/api`; acceso externo a raíz habilitado; framework preset nulo. Node Function `apps/api/api/index.ts` delega a `dist/hosted-entry.js`, inicializa Fastify y espera ready antes de emitir request/response; no `listen(127.0.0.1)`, bootstrap global de sesión ni `serveWeb`. |
| Enrutado API | Rewrites de `/api/v1/*` y `/internal/*` a función `api/index`, preservando URL original para routing y firma. No detección automática ambiguamente basada en `app.ts`/`server.ts`. |
| Runtime | Vercel Node 24.x, Fluid, 2 GB/1 CPU, maxDuration 120 s; worker con deadline de producto 60 s y heap viejo 256 MiB vigente. Node/npm locales 24.22.2/11.19.1 permanecen fijados. Registrar versión efectiva del proveedor. |
| Assets | Trazado explícito de `apps/api/dist/**`, workers, perfiles/assets empaquetados, `packages/contracts/dist/**`, `packages/engine/dist/**` y JavaScript ANTLR generado. Incluir archivos fuera de raíz requeridos por los workspaces. PruebaLinux debe demostrar resolución en el paquete aislado sin checkout vecino. |

Install Command previsto para ambos proyectos: `cd ../.. && npx --yes npm@11.19.1 ci`. Build Command: `cd ../.. && npx --yes npm@11.19.1 run package:vercel:web` o `package:vercel:api`, respectivamente. El script web compila contratos+Angular y copia el artefacto interior; el script API genera ANTLR y compila contratos+motor+API. Así los subprocesses heredan npm 11.19.1, sin asumir la versión global de la imagen.

Java 11 Corretto está disponible en la imagen oficial para el build API, sin descargar otro JDK. Registrar Java/toolchain, verificar SHA de JAR/gramáticas/originales y comparar ocho generados con una generación aislada. No ejecutar Java ni generar parser durante peticiones. Los scripts/configuraciones se crearán en implementación; estos comandos describen el diseño, no ejecuciones de esta fase.

Angular recibe únicamente baseURL pública y perfil del entorno mediante configuración pública de build. Backend conserva credenciales. Una preview requiere pareja exacta frontend/backend autorizada; backend públicamente alcanzable con autenticación de sesión o protección compatible comprobada. Permitir solo OPTIONS no basta para las peticiones reales; nunca exponer secreto de bypass en cliente.

## Servicios y dependencias

- Neon Free PostgreSQL como autoridad; conexión TLS agrupada, `pg` 8.23.1 y `@types/pg` 8.23.1, pool ≤ 2 por instancia, cliente único por transacción y release antes de worker. PostgreSQL 17 real aislado en integración local; no necesita una cuenta Neon para esa prueba.
- Vercel Blob privado, `@vercel/blob` 2.8.2 solo backend; nombres generados y autorizados por dueño, deduplicación solo intrasesión. No URLs ni SDK/token Blob en Angular.
- QStash Free, `@upstash/qstash` 2.12.1, destino interno exacto, firma actual/siguiente, timeout 120 s y máximo 3 reintentos por entrega con espera acotada por TTL. Flow control global 1 adicional al permiso SQL. Un schedule horario para mantenimiento; sin cron diario como única limpieza.
- Mantener pins actuales Angular/Material 22.2.4, CLI 22.2.5, TypeScript 6.0.3, Fastify 5.12.7 y ANTLR4.13.2. Nuevas versiones son exactas, sin caret, registradas sin instalar durante el plan.

## Variables y secretos

| Ámbito | Configuración |
| --- | --- |
| Pública frontend | API_BASE_URL es el origen backend sin `/api/v1` ni path (vacío en modo local del mismo origen); DEPLOYMENT_PROFILE. ApiClient añade sus paths `/api/v1/...` una sola vez. Namespace sessionStorage incorpora origen frontend y valores normalizados, sin secretos de proveedor. |
| Backend obligatoria | CE_MODE=hosted, DATABASE_URL TLS agrupada, BLOB_READ_WRITE_TOKEN, QSTASH_TOKEN, QSTASH_CURRENT_SIGNING_KEY, QSTASH_NEXT_SIGNING_KEY, CE_CURSOR_SIGNING_KEY de 32 bytes, PUBLIC_API_URL, ALLOWED_ORIGINS exactos, límites siguientes. |
| Local | CE_MODE=local conserva memoria/archivos y bootstrap local; modo hosted-test usa PostgreSQL 17 aislado y adaptadores de cola/objetos controlados. No sustituir repositorio SQL por mock para acreditar transacciones. |
| Logs | Redactar tokens, nonce, cabeceras y cuerpos privados; solo IDsoperativos no reutilizables como permisos, códigos, duraciones, cuotas y fases. Nunca Excel/reglas/valores del visitante. |

El diseño usa SHA-256 del secreto aleatorio de 256 bits, sin pepper adicional ni cifrado recuperable del token porque el cliente lo genera antes de POST. CE_CURSOR_SIGNING_KEY es exclusivamente backend, compartida por todas las instancias y por ambas instancias de prueba; cambiarla invalida cursores, no sesiones. Clientes de proveedor y pools pueden reutilizarse por proceso, pero autorización de sesión se consulta en DB cada petición y publicación, sin caché de vigencia que retrase la revocación.

PUBLIC_API_URL es el origen HTTPS backend sin path, base de la URL exacta firmada `/internal/...`; ALLOWED_ORIGINS contiene orígenes frontend sin paths. Validar al iniciar: URL absolutaHTTPS en producción, HTTP solo loopback local, sin userinfo/query/fragment ni destinos elegidos libremente por el visitante. Normalizar slash final para evitar rutas duplicadas y namespaces de sesión distintos por la misma dirección.

## Cuotas públicas iniciales

Son límites de admisión, **no medidas de capacidad ni garantía de coste cero**. Valores configurables explícitamente y verificables; no aumentar de forma automática al agotarse un proveedor. UTC para cuotas diarias, ventana móvil de 30 días donde se indica.

| Recurso | Límite aplicación | Regla |
| --- | ---: | --- |
| Sesiones | 4 activas; 10 creaciones/día | Creación idempotente no vuelve a contar; caducadas se revocan sin resucitar. |
| Trabajos | 30/día y 120/30 días | Reservar antes de aceptar; incluir preparaciones con CPU. GET, detalle y recuperación no son jobs, pero consumen presupuesto de operaciones. |
| CPU/cola | 1 global, 1 por instancia, 1 por conjunto; 8 en cola | Permiso SQL con fence; TTL cola 10 min desde aceptación. |
| Tiempo | 60 s desde primer claim; callback 120 s | Incluye hidratación, cálculo, escritura y publicación. Permiso huérfano retenido hasta 120 s desde claim salvo terminación acreditada. |
| Sesión | 60 min sin acción significativa; 24 h absolutas | GET, foco, recarga, polling y transferencias automáticas no prolongan. Revocación inmediata; limpieza ≤ 24 h. |
| Estado/archivos de sesión | 512 MiB de estado + 512 MiB de archivos; 20 snapshots | Presupuestos distintos; referencias compartidas no se duplican por snapshot. |
| Blob global | 768 MiB | Suma almacenado+reservado+provisional/huérfano pendiente; contabilizar antes de aceptar partes/trabajos. |
| PostgreSQL aplicación | 512 MiB | Metadatos+índices medidos periódicamente, con reservas pesimistas y margen frente a 1 GB Neon. |
| Blob/30 días | 1600 avanzadas; 8000 simples; 8 GiB de transferencia | Incluir lecturas backend, escrituras/egress donde se facture, reintentos, verificación y GC. Reservar parte para mantenimiento. |
| QStash/día | 700 entregas públicas + 100 de mantenimiento | Incluye reintentos; margen frente a 1000 Free. Un horario consume 24 disparos base/día; máximo 3 reintentos puede consumir 96. |
| Capacidad a demostrar | RSS agregado ≤ 1,6 GiB; `/tmp` ≤ 400 MiB | Peor caso admitido+consultas concurrentes+cancelación; deja margen frente a 2 GB y 500 MB documentados. No afirmar PASS sin medición. |

Límites de negocio conservados: entradas ≤ 10 MiB por archivo/50 MiB por lote/100 MiB expandido, un catálogo+ 1–20 informes; ZIP final ≤ 100 MiB incluido overhead, fragmentos ≤ 3 MiB, JSON ≤ 1 MiB real y páginas ≤ 50. Mantener guardas existentes adicionales por exportador. La reserva temporal actual de exportación 200 MiB no autoriza sumarla a otras reservas sin revisar pico; gestionar el conjunto de temporales, no únicamente un archivo.

Los presupuestos mensuales se reservan en transacciones antes de acceder a servicios; salidas desconocidas usan límite superior o bloques de reserva acotados antes de producir más bytes. Contabilizar cada intento proveedor aunque la petición falle. Reservas pendientes solo se liberan al confirmar que no existen objetos/operaciones facturables; conciliación de errores inciertos. No hacer un listado completo de Blob por cada tick: GC consulta su ledger y borra lotes conocidos, con reconciliación acotada de huérfanos.

Reservar como mínimo 200 operaciones avanzadas, 1000 simples y 1 GiB de transferencia del presupuesto Blob para revocación, reconciliación y GC; el público admite hasta el resto y mantenimiento puede usar su reserva. Reducir admisión con anticipación si consumo observado del proveedor excede el ledger o hay otros proyectos. El trabajo que no pueda reservar todas sus cuotas recibe diagnóstico público de capacidad, no un resultado parcial ni un límite de archivo falsamente reducido.

## Costes y disponibilidad: hipótesis verificables

Valores oficiales consultados 2026-11-08: Hobby 4 h de CPU/360 GB·h de memoria; Blob 1 GB de almacenamiento, 10 GB de transferencia, 2000 avanzadas y 10000 simples/mes; Neon Free 1 GB, 100 CUh y 5 GB de transferencia; QStash 1000 mensajes/día y 10 schedules. [Hobby](https://vercel.com/docs/plans/hobby), [Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing), [Neon](https://neon.com/pricing), [QStash](https://upstash.com/pricing/qstash).

- 120 jobs × 60 s = 2 h máximas de ventana de producto para CPU, dejando margen nominal respecto a 4 h; no mide CPU de rutas, arranque, transferencia, limpieza o ataques. Debe medirse y cortar admisión antes de consumo real.
- Mantenimiento horario: 5 min de idle × 24 × 0,25 CU × 30 ≈ 15 CUh/mes de despertares, frente a ≈ 60 CUh cada 15 min. No es pronóstico garantizado: carga y polling pueden mantener Neon despierto. Polling activo 5 s, retroceso 10 s, ninguno en reposo.
- 1600/8000 operaciones dejan 20% respecto a 2000/10000. 8 GiB son ≈ 8,59 GB decimales: no afirmar margen 20% exacto frente a 10 GB. Las unidades de dashboard, regiones y factura se comprueban antes de publicar.
- Intermediación privada suma tramos de transferencia y fragmentación aumenta operaciones. Las cuotas de aplicación no controlan tráfico fuera de ella, uso manual/dashboard, otros proyectos o cambios de proveedor; no garantizan gratuidad ni disponibilidad contra ataques.

No habilitar pago por uso, Pro, Launch o failover de pago automáticamente. Ante incompatibilidad: optimizar, repetir la medición afectada y registrar el límite; si persiste, queda pendiente viabilidad alojada y se pide una decisión explícita posterior sin rebajar requisitos silenciosamente.

## Mantenimiento y revocación

Sweep horario firmado, lease propio y lotes limitados: sesiones vencidas, trabajos/cola expirada, permisos huérfanos tras techo seguro, outbox, reservas y objetos sin referencia. Un envío incierto responde 503 recuperable; reintento inmediato del mismo usuario puede republicar el mismo job. El barrido tardío nunca ejecuta un job cuya cola de 10 min venció; solo lo termina/reconcilia.

GET estado informa vencimiento sin esperar cron. Cerrar/caducar impide nuevas peticiones y commits; bytes ya autorizados en tránsito no se pueden retirar. Cleanup conserva budget aun con admisión pública cerrada. Detectar tareas sin progreso, alertar antes de 18 h y documentar procedimiento de recuperación para cumplir 24 h; la prueba de fallo proveedor distingue objetivo contratado de disponibilidad real, sin afirmar garantía absoluta durante caída externa.

## Gates de preparación y verificación real

**Obligatorios locales:** dos orígenes+dos instancias contra PostgreSQL real; doble visitante; aceptación/commit/respuesta perdidos; duplicados; cancelación y caducidad durante publicación; rechazo de propietario; continuidad y reconstrucción FINREP; lote50 MiB/expandido100 MiB y archivo>4,5 MB; ZIP 100 MiB y 34 partes; JSON grande/valor individual fragmentado; límites+ 1; referencias compartidas 20 snapshots; limpieza sin navegador.

**Packaging/capacidad:** paquete Linux aislado contiene workers/parser/assets, ejecuta cada tipo de job y demos sin acceso al checkout; ocho archivos ANTLR reproducibles y hashes originales; RSS/tmp medidos con 2 GB/1 CPU, peor caso y lecturas API concurrentes; deadline 60 s incluyendo I/O. Docker/Java/pwsh están disponibles como comandos, pero no se ha comprobado daemon Docker ni instalado PostgreSQL durante el plan.

**Solo con recursos autorizados:** provisionar posteriormente dos proyectos y servicios, verificar Node/Java efectivos, rutas directas del frontend, CORS real/previews, firmas, continuidad entre instancias, cargas/descargas grandes, cuotas del dashboard y barridos. Sin entorno se marca **preparado localmente; alojamiento real pendiente**, nunca despliegue PASS. No tocar la sesión del usuario en 3340; pruebas futuras usan 3350 frontend, 3351/3352 API, 3353 cola y 3354 objetos tras verificar propiedad.
