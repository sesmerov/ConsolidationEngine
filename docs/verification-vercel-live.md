# Verificación del despliegue real en Vercel

## 2026-11-16 — Lectura privada de Blob sin Content-Length

Con `8e0d005`, la demo pública permitió crear una sesión y un conjunto. La carga falló con HTTP 500 después de escribir el objeto privado. El diagnóstico desplegado en `79e2bd2` registró `provider_failed`, `providerOperation=blob-read`, `providerReason=missing-length` y `request_failed` con `failureKind=range-error` (20:31:47.58, hora mostrada por Vercel).

El SDK representa con tamaño cero las respuestas privadas sin `Content-Length`. El adaptador confundía ese dato ausente con un objeto vacío. La corrección cuenta los bytes del flujo cuando falta esa cabecera, conserva el máximo de 3 MiB por fragmento y rechaza flujos vacíos, estados no válidos, tamaños declarados incoherentes y cancelaciones. El registro SQL sigue comprobando la longitud y SHA-256 antes de aceptar o devolver el objeto.

La comprobación local pasó 22 pruebas en tres archivos (`blob-object-store`, `operational-log` y `hosted-transfers`): respuestas controladas del SDK e integridad de longitud y SHA-256 sobre PostgreSQL 18.6 real. La compilación de la API también pasó. Los resultados del siguiente despliegue se registran debajo; este documento no declara aceptación del recorrido ni de la capacidad máxima alojada.

## 2026-11-16 — Publicación QStash y ocultación de datos

Con `a2e0c82`, ambos archivos se cargaron correctamente en Blob; el sellado quedó pendiente por una respuesta incierta de QStash. El diagnóstico de `cdefb47`, ejecutado mediante mantenimiento firmado, confirmó HTTP 400 con `providerReason=redaction-invalid` a las 20:44:00.41 (hora mostrada por Vercel).

El valor `body,headers` de `Upstash-Redact-Fields` no fue aceptado por el proveedor real. Se cambia a `body,header`, que es el valor emitido por el SDK fijado de QStash para ocultar el cuerpo y todas las cabeceras. Se mantienen los reintentos, deduplicación, firma, control de concurrencia y contabilidad de entregas. Pasaron 18 pruebas enfocadas del publicador y del registro operativo, incluida la comprobación expresa de ambos campos ocultos, y la compilación de la API. Queda pendiente desplegar esta corrección y repetir el trabajo; todavía no se declara completo el recorrido alojado.
