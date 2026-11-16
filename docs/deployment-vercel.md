# Preparación de la demo pública en Vercel

La configuración separa Angular y la API en dos proyectos. La demo admite exclusivamente uso con datos sintéticos y sesiones anónimas independientes. Esta guía prepara un despliegue posterior: no acredita recursos contratados ni un despliegue real. Los resultados de cada comprobación están en [verification-005.md](verification-005.md).

**Capacidad pendiente:** la prueba de 500 reglas y 100.000 hechos con 2 GB/1 CPU alcanza el plazo de 60 s durante la evaluación. Memoria y temporales cumplen sus límites, pero ese caso máximo aún no está habilitado como capacidad demostrada del alojamiento gratuito. No abrir la demo anunciando ese volumen como garantizado; consultar las medidas y el estado de gates antes de publicar.

## Proyectos y comandos

Crear posteriormente dos proyectos del mismo repositorio, habilitando en ambos el acceso a archivos fuera de su Root Directory. Los archivos `vercel.json` ya contienen los comandos y las reglas de enrutado.

| Configuración | Frontend | Backend |
| --- | --- | --- |
| Root Directory | `apps/web` | `apps/api` |
| Framework preset | Other | Other |
| Install Command | `cd ../.. && npx --yes npm@11.19.1 ci --engine-strict=false` | Igual |
| Build Command | `cd ../.. && npx --yes npm@11.19.1 run package:vercel:web` | `cd ../.. && npx --yes npm@11.19.1 run package:vercel:api` |
| Output Directory | `.vercel-dist/browser` | `public`; solo `robots.txt`. API en la función `api/index.ts` |
| Node | 24.x | 24.x, Fluid Compute |
| Recursos | Archivos estáticos | Hobby: 2 GB / 1 vCPU; `maxDuration: 120` |

La instalación permite el patch de Node gestionado por Vercel; los scripts comprueban Node 24 y npm 11.19.1. Localmente se mantienen Node 24.22.2 y `engine-strict`. Registrar la versión efectiva del proveedor, sin asumir que coincidirá exactamente. La generación ANTLR necesita Java ≥11 durante el build y verifica el JAR y las gramáticas; no genera el parser durante peticiones. El paquete incluye los workers, migraciones SQL, perfiles, demos y paquetes compartidos.

El frontend tiene una ruta de documento `/`; las cuatro etapas pertenecen a la misma aplicación. La regla de fallback no transforma un asset inexistente en HTML. La API conserva la URL original al redirigir `/api/v1/*` y `/internal/*` a su función. Espera a `Fastify.ready()` y al final de la respuesta, sin abrir otro listener. [Configuración de funciones](https://vercel.com/docs/project-configuration/vercel-json), [límites y memoria](https://vercel.com/docs/functions/limitations).

El backend declara `public` como salida estática y conserva allí únicamente `robots.txt`. Vercel necesita una carpeta de salida no vacía al ejecutar este build personalizado; la función continúa en `api/index.ts`. No usar `.` ni `dist` como salida pública: expondrían fuentes o recursos internos. El manifiesto de empaquetado permanece fuera de `public`. [Directorio de salida](https://vercel.com/docs/builds/configure-a-build#output-directory).

El builder de funciones Node puede instalar dependencias de nuevo después del comando de instalación del proyecto. Configurar `NPM_CONFIG_ENGINE_STRICT=false` en el entorno **Production del backend en Vercel** para que esa instalación admita el patch 24.x gestionado por el proveedor; `--engine-strict=false` en el primer comando no se hereda automáticamente. Mantener Node 24.x en el proyecto y los requisitos estrictos locales sin cambios. Este ajuste no se copia a `.env` local.

## Configuración privada y pública

Usar [apps/api/.env.example](../apps/api/.env.example) y [apps/web/.env.example](../apps/web/.env.example) como inventario; el programa no carga automáticamente esos ejemplos. En local, las variables deben estar en el entorno del proceso. En Vercel se configuran por proyecto y entorno.

| Variable | Uso |
| --- | --- |
| `API_BASE_URL` | Pública, origen HTTPS de la API sin `/api/v1`, paths, query ni fragmento. Vacía en local con mismo origen. |
| `DEPLOYMENT_PROFILE` | Público, identifica el entorno y separa la persistencia de sesión. |
| `CE_MODE` | `hosted` en el backend público; `local` por defecto. `hosted-test` se limita a pruebas controladas. |
| `DATABASE_URL_UNPOOLED` | Conexión directa de PostgreSQL 17 o 18 creada por la integración Neon/Vercel. Tiene prioridad cuando está definida; TLS con certificado verificado. |
| `DATABASE_URL` | Alternativa si no existe `DATABASE_URL_UNPOOLED`: configurar una conexión directa con «Connection pooling» desactivado (host sin `-pooler`). |
| `BLOB_READ_WRITE_TOKEN` | Acceso backend a un almacén Blob **privado**. |
| `QSTASH_TOKEN` | Publicar referencias de trabajos. |
| `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` | Verificar la firma del cuerpo original y la URL exacta del callback. |
| `CE_CURSOR_SIGNING_KEY` | 32 bytes aleatorios, base64url sin relleno, iguales en todas las instancias del entorno. Rotarla invalida cursores. |
| `PUBLIC_API_URL` | Origen HTTPS real del backend; se utiliza para las firmas y destinos internos. |
| `ALLOWED_ORIGINS` | Lista separada por comas de orígenes frontend exactos. Sin `*` ni patrones `*.vercel.app`. |

Generar la clave de cursores en una terminal privada con `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` y guardarla como secreto del backend. No copiarla al frontend, al repositorio ni a una captura. El build web solo inserta los dos valores públicos; las claves de proveedores nunca se distribuyen al navegador.

## Autoridad, sesiones y migraciones

Neon conserva sesiones, versiones, recibos, índices paginados, trabajos y cuotas. Los datos voluminosos se escriben en bloques privados inmutables; se comparten referencias entre versiones de la misma sesión. La API usa un pool de una conexión y cada worker otra conexión: como máximo dos por instancia de ejecución. No se mantiene un usuario global ni se reconstruye toda la sesión en cada lectura.

La integración gestionada añade `DATABASE_URL` (agrupada) y `DATABASE_URL_UNPOOLED` (directa). La API y sus workers utilizan la directa automáticamente cuando está definida; no sobrescribir las variables gestionadas. Si su valor está vacío o es inválido, el arranque falla indicando el nombre de la variable, sin revelar credenciales ni volver a la conexión agrupada. Sin integración, basta configurar la URL directa en `DATABASE_URL` y dejar `DATABASE_URL_UNPOOLED` sin definir. [Variables de la integración Neon/Vercel](https://neon.com/docs/guides/vercel-managed-integration).

En **Connect** de Neon, desactivar **Connection pooling** y copiar la URL completa. Esta versión envía `search_path`, `statement_timeout` e `idle_in_transaction_session_timeout` como parámetros de inicio; las consultas dependen de ellos. Neon documenta que su conexión agrupada puede rechazar parámetros de inicio no admitidos y propone la conexión directa como alternativa. No eliminar esos parámetros del código para hacer pasar la conexión. Conservar los parámetros TLS de la URL: la aplicación normaliza `sslmode` y configura explícitamente la verificación del certificado. [Parámetros de inicio y conexión directa](https://neon.com/docs/connect/connection-errors#unsupported-startup-parameter).

Al iniciar, las migraciones `apps/api/src/hosted/migrations/*.sql` se ejecutan en una transacción con bloqueo asesor y checksums; se rechaza una migración ya aplicada cuyo contenido cambie. Se admiten exclusivamente PostgreSQL 17 y 18. Usar una base dedicada o un rol con permiso sobre el esquema `ce_demo`; verificar primero sobre una copia de prueba. Las futuras modificaciones requieren una migración nueva, no editar una aplicada.

La [comprobación de compatibilidad 17/18](verification-postgres-18.md) recoge las pruebas SQL reales en contenedores y distingue esa evidencia de los servicios alojados.

El navegador genera un secreto y un nonce antes de crear la sesión. Guarda únicamente credenciales anónimas e identificadores mínimos de recuperación en `sessionStorage`, separados por orígenes y perfil; no conserva Excel, reglas, respuestas de negocio ni blobs. Recargar la misma pestaña recupera la sesión. Cerrar o caducar borra esas credenciales y exige una acción explícita para iniciar otra.

La sesión caduca tras 60 minutos sin actividad significativa o 24 horas absolutas. Leer, cambiar foco, preparar un borrador automáticamente, descargar partes o consultar el progreso no prolonga la sesión. La revocación se comprueba en cada acceso y antes de publicar. No se pueden retirar bytes ya autorizados que están en tránsito.

## CORS y previews

Autorizar la pareja exacta de orígenes frontend/backend de cada entorno. Una preview requiere sus propios valores públicos y su origen exacto en `ALLOWED_ORIGINS`; no reutilizar a ciegas el perfil de producción. `OPTIONS` no lleva credenciales, pero valida el origen, método y cabeceras. La petición real exige `X-CE-Session`; las mutaciones añaden `If-Match` y, cuando corresponde, `Idempotency-Key`.

Se exponen `ETag`, `Content-Disposition`, hashes de partes y `Retry-After`. Se utiliza `Vary: Origin` y `Cache-Control: private, no-store`; no cookies ni `Access-Control-Allow-Credentials`. CORS no sustituye la comprobación del propietario. Los recursos ajenos y los inexistentes devuelven el mismo 404.

Si está activada Deployment Protection, comprobar tanto el preflight como la petición real y los callbacks de QStash. Permitir solo OPTIONS no basta. No poner un secreto de bypass en Angular. [Documentación CORS](https://vercel.com/kb/guide/how-to-enable-cors), [protección de previews](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/options-allowlist).

## Cola y mantenimiento sin navegador

La aceptación registra trabajo, recibo y outbox antes de publicar en QStash. Si se pierde su acuse, devuelve un error recuperable con el mismo trabajo; repetir la clave no duplica la operación. El callback espera al worker y a la transacción final. El permiso SQL, el identificador de intento y su contador de vigencia impiden publicar un resultado de una ejecución anterior.

Configurar posteriormente un schedule QStash con estos valores, usando credenciales privadas del operador:

| Campo | Valor |
| --- | --- |
| Destino | `PUBLIC_API_URL` + `/internal/maintenance` |
| Cron, UTC | `0 * * * *` |
| Método y contenido | POST, `application/json` |
| Cuerpo exacto | `{"kind":"maintenance","version":1}` |
| Timeout | 120 segundos |
| Reintentos máximos | 3 |

Los trabajos se entregan a `/internal/jobs` con firma, referencias mínimas, deduplicación y concurrencia de cola 1. El mantenimiento utiliza un permiso propio y presupuesto reservado; reconcilia envíos inciertos, sesiones vencidas, objetos provisionales y permisos huérfanos. Un trabajo que esperó más de diez minutos no empieza a calcular. Los trabajos tienen 60 segundos desde su primer inicio, incluyendo lecturas, escritura y publicación; el permiso de una invocación posiblemente viva se conserva hasta 120 segundos. [Schedules](https://upstash.com/docs/qstash/features/schedules), [reintentos](https://upstash.com/docs/qstash/features/retry).

Alerta operativa: el log redactado `cleanup_delayed` indica trabajo pendiente cerca de las 18 horas o fallo de borrado. Configurar su notificación fuera de la aplicación. Antes de 24 horas, comprobar el schedule, firmas, conectividad y presupuestos del proveedor; restaurar el acceso y solicitar otra entrega firmada de mantenimiento. Confirmar que baja la cola pendiente y aparece `cleanup_completed`. No borrar referencias SQL manualmente ni liberar reservas cuyo borrado no esté confirmado. Una caída externa prolongada puede impedir el objetivo de limpieza; registrarla como incidente, sin afirmar que se cumplió.

## Límites y planes gratuitos

Cuotas públicas de aplicación: 4 sesiones activas, 10 creaciones/día, 8 trabajos en cola, 30 trabajos/día y 120 en 30 días móviles. Un catálogo y 1–20 informes; 10 MiB por archivo, 50 MiB por lote y 100 MiB expandidos. Se retienen hasta 20 snapshots y presupuestos separados de 512 MiB de estado y 512 MiB de archivos por sesión, sujetos al presupuesto global disponible.

| Presupuesto global de la aplicación | Reserva o límite |
| --- | --- |
| Blob almacenado, reservado y provisional | 768 MiB |
| SQL | 512 MiB, con reservas y comprobación del tamaño real |
| Blob por 30 días | 1600 operaciones avanzadas, 8000 simples y 8 GiB transferidos |
| Parte reservada para mantenimiento | 200 avanzadas, 1000 simples y 1 GiB |
| QStash por día | 700 entregas públicas + 100 de mantenimiento, incluidos reintentos |
| Transporte | JSON 1 MiB, páginas de hasta 50 elementos, partes binarias de hasta 3 MiB |
| ZIP de salida | 100 MiB incluido overhead, hasta 34 partes |
| Capacidad que debe medirse | RSS conjunto ≤1,6 GiB y temporales ≤400 MiB con 2 GB/1 CPU |

Referencias consultadas el 16-11-2026: Hobby incluye 4 horas de CPU y 360 GB·h de memoria; Blob incluye 1 GB, 10 GB transferidos y 2000/10000 operaciones avanzadas/simples. [Hobby](https://vercel.com/docs/plans/hobby), [Blob](https://vercel.com/docs/vercel-blob/usage-and-pricing). Neon Free anuncia 1 GB, 100 CU·h y 5 GB de transferencia por proyecto; QStash Free, 1000 mensajes/día. [Neon](https://neon.com/pricing), [QStash](https://upstash.com/pricing/qstash).

Estas cifras no garantizan coste cero ni disponibilidad. Las unidades no son intercambiables: 8 GiB son aproximadamente 8,59 GB. Otros proyectos, consultas manuales y el dashboard también pueden consumir recursos. El mantenimiento horario se estimó en unos 15 CU·h/mes de despertares Neon a 0,25 CU; debe medirse. Un presupuesto agotado rechaza nuevas admisiones conservando la limpieza. No hay upgrade ni pago por uso automático.

## Comprobaciones antes de publicar

1. Ejecutar `npm run test:hosted`: PostgreSQL real con esquemas aislados; cola y objetos controlados. El contenedor predeterminado sigue siendo 17; `TEST_POSTGRES_MAJOR=18` selecciona la imagen 18 fijada por huella. `TEST_DATABASE_URL` permite usar una base de pruebas propia 17/18. No equivale a probar los proveedores reales.
2. Ejecutar `npm run test:e2e:hosted`: dos visitantes, frontend 3350, API pública 3351 y dos procesos 3352/3353; control protegido 3354. Verifica propiedad antes de ocupar puertos y no usa el servidor del usuario en 3340.
3. Ejecutar `npm run test:package:linux` y `npm run test:capacity:hosted`; consultar las medidas y fallos en `outputs/` y el resumen de verificación. No convertir un fallo de capacidad en una reducción silenciosa de los límites.
4. Con autorización posterior, configurar los dos proyectos y servicios. Verificar versión efectiva de Node/Java, paquete desplegado, orígenes reales, callbacks firmados, descarga reconstruida, aislamiento, caducidad y limpieza sin navegador.
5. Comparar el consumo real de cada dashboard con el ledger antes de abrir la demo. Mantener pendiente la viabilidad alojada si la capacidad o las cuotas no se han demostrado.

Los registros de prueba, las simulaciones de proveedor y la aceptación humana se presentan por separado. La existencia de estos archivos no significa que Vercel, Neon, Blob o QStash estén ya configurados.
