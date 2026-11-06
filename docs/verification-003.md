# Verificación de la iteración 003

Rama `codex/003-simplificar-flujo`, base `b74bba9`. Se distinguen las comprobaciones ejecutadas en esta iteración de la [verificación histórica de 002](verification-002.md) y del [ensayo FINREP de la especificación](../specs/003-simplificar-flujo/resultado-finrep.json).

| Alcance | Criterios de 003 | Comprobación prevista |
| --- | --- | --- |
| Carga, ayuda, catálogo y contexto (FR-001–004,017) | SC-001,002,009 | Demos visuales, búsqueda global y cabecera con 0/1/varios contextos |
| Revisión, simulación y consentimiento (FR-005–009,016) | SC-003,004,008 | Decisiones globales, selección fuera de página, conflictos, publicación y recuperación |
| Siguiente etapa (FR-010–012) | SC-005 | Operación confirmada, versión, foco y descarga por recibo |
| Caracterización FINREP (FR-013) | SC-006 | Contraste del extracto visual con los cuatro hechos en coordenadas |
| Identidad y portada (FR-014–015) | SC-007 | HTML inicial, recurso local y privacidad |

Checklist de especificación: 16/16. Las huellas de los dos libros oficiales se contrastaron con `tests/fixtures/eba/source-manifest.json`. La toolchain y Chromium están instalados localmente. Se reserva el proceso propio de E2E en 3318 y el de volumen en 3317.

T001–T002. Con Node 24.22.2/npm 11.19.1, `npm ls --depth=0`, `prepare:templates`, `fixtures` y `build` terminaron con código 0. Angular Material 22.2.4. Build inicial 662,29 kB. Se comprobó la igualdad de todas las entradas de los tres XLSX anteriores regenerados antes de conservar sus bytes versionados. Los logs se encuentran en `.cache/003-setup-*.log`.
