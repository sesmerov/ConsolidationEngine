# Compatibilidad PostgreSQL 17 y 18

Fecha: 16-11-2026. La integración gestionada de Neon observada durante el despliegue crea una base PostgreSQL 18. La API admite ahora exclusivamente las versiones mayores 17 y 18; otras versiones y respuestas de versión inválidas se rechazan antes de aplicar el esquema.

Las ocho migraciones conservan sus bytes y checksums. Continúan el bloqueo asesor, la transacción de migración, las restricciones de propietario, las conexiones directas, la comprobación TLS y los parámetros de inicio. No se actualizó ningún clúster existente ni se modificó su formato de almacenamiento.

## Evidencia local

| Comprobación | Resultado |
| --- | --- |
| Compilación `npm run build:api` | PASS |
| Frontera de versiones y empaquetado web | 30/30 pruebas PASS; incluye rechazo de PostgreSQL 16/19 y versiones inválidas |
| Suite alojada completa en PostgreSQL 18.6 | 36 archivos, 170 pruebas PASS, 146,60 s |
| Regresión en PostgreSQL 17.11 | 36 archivos, 170 pruebas PASS, 132,36 s |

La suite usa SQL real en contenedores locales temporales, con una base y esquemas propios. La cola y el almacenamiento de objetos son adaptadores controlados. Comprueba migraciones concurrentes e idempotentes, rollback, límites, claves foráneas entre propietarios, CAS, consultas, publicación, trabajos, sesiones, mantenimiento y recorridos HTTP. Ambos contenedores PostgreSQL se eliminaron al terminar.

Reproducción: `npm run test:hosted` conserva PostgreSQL 17 por defecto. Para 18, definir `TEST_POSTGRES_MAJOR=18` antes de ejecutarlo. Las imágenes fijadas son:

- 17: `postgres@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f`.
- 18: `postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336`.

Las [notas oficiales de PostgreSQL 18](https://www.postgresql.org/docs/18/release-18.html#RELEASE-18-MIGRATION) se revisaron para cambios de compatibilidad. El SQL del proyecto no usa claves foráneas `RESTRICT` explícitas, cambios de rol entre ejecución y commit, columnas generadas ni `COPY` CSV; los índices ordinales conservan su colación `C` explícita.

Esta evidencia no acredita todavía Neon 18, Vercel Blob ni QStash reales, tampoco capacidad máxima o rendimiento alojado. El arranque y el recorrido desplegados requieren comprobación separada. Las limitaciones de capacidad documentadas en [verification-005.md](verification-005.md) siguen vigentes.
