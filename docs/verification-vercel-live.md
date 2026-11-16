# Verificación del despliegue real en Vercel

## 2026-11-16 — Lectura privada de Blob sin Content-Length

Con `8e0d005`, la demo pública permitió crear una sesión y un conjunto. La carga falló con HTTP 500 después de escribir el objeto privado. El diagnóstico desplegado en `79e2bd2` registró `provider_failed`, `providerOperation=blob-read`, `providerReason=missing-length` y `request_failed` con `failureKind=range-error` (20:31:47.58, hora mostrada por Vercel).

El SDK representa con tamaño cero las respuestas privadas sin `Content-Length`. El adaptador confundía ese dato ausente con un objeto vacío. La corrección cuenta los bytes del flujo cuando falta esa cabecera, conserva el máximo de 3 MiB por fragmento y rechaza flujos vacíos, estados no válidos, tamaños declarados incoherentes y cancelaciones. El registro SQL sigue comprobando la longitud y SHA-256 antes de aceptar o devolver el objeto.

La comprobación local pasó 22 pruebas en tres archivos (`blob-object-store`, `operational-log` y `hosted-transfers`): respuestas controladas del SDK e integridad de longitud y SHA-256 sobre PostgreSQL 18.6 real. La compilación de la API también pasó. Esa comprobación local no establecía todavía el resultado del recorrido alojado; los resultados de los siguientes despliegues se registran debajo.

## 2026-11-16 — Publicación QStash y ocultación de datos

Con `a2e0c82`, ambos archivos se cargaron correctamente en Blob; el sellado quedó pendiente por una respuesta incierta de QStash. El diagnóstico de `cdefb47`, ejecutado mediante mantenimiento firmado, confirmó HTTP 400 con `providerReason=redaction-invalid` a las 20:44:00.41 (hora mostrada por Vercel).

El valor `body,headers` de `Upstash-Redact-Fields` no fue aceptado por el proveedor real. Se cambia a `body,header`, que es el valor emitido por el SDK fijado de QStash para ocultar el cuerpo y todas las cabeceras. Se mantienen los reintentos, deduplicación, firma, control de concurrencia y contabilidad de entregas. Pasaron 18 pruebas enfocadas del publicador y del registro operativo, incluida la comprobación expresa de ambos campos ocultos, y la compilación de la API. La corrección se desplegó en `1df001d`; el trabajo anterior caducó conforme a su plazo y la repetición explícita permitió continuar el recorrido siguiente, sin ampliar límites.

## 2026-11-16 — Recorrido COREP con proveedores reales

Se recorrió la demo pública en Chrome sobre `1df001d`, con el frontend y la API en proyectos Vercel separados:

- Frontend: <https://consolidation-engine-web.vercel.app> (`apps/web`).
- API: <https://consolidation-engine-api.vercel.app> (`apps/api`), Node.js 24, Fluid Compute, región `fra1`, plan Hobby de 2 GB y 1 CPU.
- PostgreSQL 18 de Neon Free en Frankfurt, conexión directa con TLS; Vercel Blob privado en FRA1 y QStash Free en EU. Credenciales solo en backend Production y CORS limitado al origen exacto del frontend.

| Etapa | Resultado observado |
| --- | --- |
| Inspeccionar y confirmar | COREP CA1: 110 coordenadas y 15 valores; carga confirmada como versión 1. |
| Validar | A las 20:50:42 CET: 7 reglas cumplidas, 8 incumplidas, 1 no aplicable y 0 errores. |
| Elegir destinos | En el conflicto de `r0070` se eligió `v0174_m`; el grupo de `r0200` se omitió. Quedaron 5 destinos. |
| Simular | A las 20:52:37 CET: versión 2, cinco propuestas preseleccionadas y cadena de dependencias presentada. |
| Aplicar | A las 20:53:17 CET: versión 3 con los cinco cambios de la tabla siguiente. |
| Revalidar automáticamente | Versión 3: 14 reglas cumplidas, 1 incumplida intencionadamente (`DEMO_LT_FAIL`), 1 no aplicable, 0 no evaluables y 0 errores. |
| Descargar | Se generó `report.zip` de la versión 3, con informes y registro de cambios. El usuario confirmó expresamente que el archivo se descargó. |

Todos los destinos corresponden a `C_01.00`, columna `c0010`:

| Fila | Antes → después |
| --- | --- |
| `r0070` | 5 → 60 |
| `r0030` | 100 → 185 |
| `r0150` | 10 → 50 |
| `r0130` | 20 → 100 |
| `r0020` | 1000 → 285 |

Este resultado acredita el recorrido funcional indicado con PostgreSQL, Blob, QStash y Vercel reales. La confirmación humana recogida aquí se limita a la descarga del archivo; no sustituye una aceptación general de usabilidad.

## Mantenimiento e independencia de sesiones

Quedó una programación activa para `POST /internal/maintenance`, cron `0 * * * *`, timeout de 120 segundos y tres reintentos. Un duplicado creado durante la configuración quedó pausado. Las ejecuciones manuales firmadas devolvieron HTTP 200 con limpieza de un objeto a las 20:23:45 y 20:44 CET; la segunda permitió observar el rechazo de publicación pendiente antes de corregirlo.

Una segunda pestaña de navegador mostró la interfaz de un conjunto nuevo vacío. Es una observación de separación en la interfaz, no una prueba negativa de autorización cruzada.

## Aviso falso tras confirmar una elección

Durante el recorrido, cada elección se guardaba correctamente pero aparecía «La revisión cambió.». El frontend trataba el incremento de revisión causado por su propia confirmación como un cambio externo. La corrección `0509453` cierra el editor sin ese aviso cuando reconoce su propia elección y mantiene los errores de conflicto reales.

La regresión se reprodujo con dos pruebas fallidas antes del cambio. Después pasaron tres pruebas enfocadas (confirmación correcta, repetición de una confirmación incierta y rechazo real por revisión distinta) y la compilación del frontend. Vercel confirmó el frontend Production `0509453` en estado Ready (despliegue `5ar6497hpYae3SwSV8tUmBSNtFdS`).

La corrección también se verificó en la interfaz pública tras recargar: se recuperaron el conjunto en versión 3 y su `report.zip`; se abrió «Revisar decisiones», se usó `DEMO_RANGE` para reabrir el conflicto de `r0070` y, desde «Ver pendientes» y «Elegir regla», se volvió a elegir y confirmar `v0174_m`. La interfaz mostró «5 destinos preparados», «Decisión confirmada» y «Regla elegida: v0174_m», sin el aviso «La revisión cambió.». La versión siguió siendo la 3 y la elección original quedó restablecida.

## Alcance pendiente

- FINREP no se probó en este recorrido sobre proveedores reales; sus evidencias locales anteriores no se presentan como una prueba de este despliegue.
- La capacidad máxima alojada sigue pendiente. El éxito de esta demo pequeña no acredita los máximos de reglas, coordenadas o hechos; se conserva la evidencia previa del timeout cercano a 60 segundos en la prueba de capacidad de 2 GB y 1 CPU.
- No se ha ejecutado en esta sesión una prueba negativa de autorización entre sesiones ni una aceptación humana general de UX.
