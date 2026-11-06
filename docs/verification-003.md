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

## Cabecera y selección global

Antes del cambio de producto, el focal de cabecera presentó dos fallos y doce pruebas correctas: había un selector con un único contexto y dos opciones distintas tenían la misma etiqueta. En aplicación, las cuatro regresiones nuevas fallaron ante la ocultación del panel, la revocación del consentimiento al recuperar los mismos IDs, la consulta obsoleta y la recuperación de un intento incierto. Pasaron las otras 21 comprobaciones de ese focal.

Tras el cambio pasan las 14 pruebas de cabecera/sesión y las 25 de selección/aplicación. Build web correcto, 663,06 kB iniciales. El helper de compatibilidad importa el catálogo y los informes mediante multipart en el servidor 3318 y comprueba el trabajo terminal, la publicación de una sola versión y la rehidratación de la página.

SC-008/009. En Chromium pasaron los cuatro casos de `material-workflow.spec.ts` en 1,2 min. El cambio 0 → 1 → 2 → 1 → 0 contextos tardó 7,1 s. Los recorridos a 320, 390 y 1440 px tardaron 22,7, 21,1 y 19,0 s. Comprueban selección entre páginas, bloqueo por dependencias pendientes y descarga del ZIP correspondiente al recibo de 51 cambios. Se conservaron seis capturas sintéticas y el log en `.cache/verification-003/base/`.
