# Verificación del despliegue real en Vercel

## 2026-11-16 — Lectura privada de Blob sin Content-Length

Con `8e0d005`, la demo pública permitió crear una sesión y un conjunto. La carga falló con HTTP 500 después de escribir el objeto privado. El diagnóstico desplegado en `79e2bd2` registró `provider_failed`, `providerOperation=blob-read`, `providerReason=missing-length` y `request_failed` con `failureKind=range-error` (20:31:47.58, hora mostrada por Vercel).

El SDK representa con tamaño cero las respuestas privadas sin `Content-Length`. El adaptador confundía ese dato ausente con un objeto vacío. La corrección cuenta los bytes del flujo cuando falta esa cabecera, conserva el máximo de 3 MiB por fragmento y rechaza flujos vacíos, estados no válidos, tamaños declarados incoherentes y cancelaciones. El registro SQL sigue comprobando la longitud y SHA-256 antes de aceptar o devolver el objeto.

La comprobación local pasó 22 pruebas en tres archivos (`blob-object-store`, `operational-log` y `hosted-transfers`): respuestas controladas del SDK e integridad de longitud y SHA-256 sobre PostgreSQL 18.6 real. La compilación de la API también pasó. La corrección aún debe desplegarse y repetirse la carga y el flujo completo en los proveedores reales; este documento no declara aceptación del recorrido ni de la capacidad máxima alojada.
