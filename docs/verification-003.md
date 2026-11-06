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

## Carga, búsqueda, portada y navegación

El primer corte funcional es `4db01e5`. En Cargar, el focal inicial reprodujo cinco regresiones y la versión integrada pasó 35/35 pruebas. La carga por teclado recorrió inspección, confirmación, aplicación y exportación en Chromium. La primera ejecución conjunta detectó dos diferencias: el nombre publicado de la plantilla es `COREP-CA1.xlsx` y una alerta duplicada retiraba el foco del diagnóstico con fichero y celda. Corregidos ambos, pasaron las seis pruebas focales de búsqueda e importación. El servidor siguió sirviendo el fallback de la SPA y protegiendo rutas internas.

SC-002. Catálogo sintético de 500 códigos, SHA-256 `6fd3ba45a853c9d588ca066b0df11b7efd6a89eed7bc72b142156fb39c4a0849`, Chromium 156.0.8078.4 en el equipo de referencia. Desde el último evento de entrada hasta las filas y el total correctos más dos frames se midieron 294,4 ms al escribir 10 coincidencias, 314,2 ms al pegar un código fuera de la primera página, 303,6 ms al obtener cero y 300,1 ms al borrar y recuperar las primeras 50 de 500. Se conservaron el foco y los filtros combinados. La prueba separada de carrera retuvo una respuesta real y verificó que su fila nunca reapareció. Logs `.cache/003-us1-browser.log` y `.cache/003-import-browser-fixed.log`.

SC-007. La portada anónima y el icono responden antes de ejecutar JavaScript. Se comprobó el mismo HTML antes y después de publicar datos marcados y se inspeccionó el símbolo de tabla y visto bueno a 16 y 32 px sobre dos fondos. Capturas en `.cache/verification-003/discovery/`. Las pruebas de señalización y descarga por versión pasaron junto con las de aplicación (28/28). El build de este corte pesó 667,27 kB iniciales.

## Compatibilidad FINREP

SC-006. El ensayo original fue producido por `6bd2476`. Se repitió con la API recompilada de 003 en `.cache/003-finrep-probe/run-pNtvqV/result.json`. El extracto visual F_01.01 recibió 202 y terminó en `INVALID_WORKBOOK / UNRECOGNIZED_COREP_SHEETS`, con cero versiones. Los cuatro importes equivalentes, cargados con el mismo catálogo en formato de coordenadas, dieron «pasa» para 100 = 40 + 35 + 25 y «falla» para 40 > 100. Se comprobó la huella del anexo de origen. La entrada visual FINREP necesita un adaptador.

## Motor y API de revisión

Las tres pruebas HTTP iniciales reprodujeron la ausencia de las rutas. Con la implementación pasan 624 comprobaciones de motor y 11 de contrato y ciclo de vida de revisión. Los escenarios incluyen las dos direcciones, un lado inconcluso, un grupo de 270 productores que cruza páginas, dos contextos con coordenadas iguales, omisión global, guardado parcial o vacío, replay, dos pestañas, vencimiento fijo, cancelación y límites de memoria y snapshots. La publicación crea una sola versión con sus decisiones y recibo y conserva los importes. Las consultas de resultados siguen admitiendo clientes anteriores.

En este corte pasaron las suites completas de integración (497, en 31 archivos, 160,22 s) y contrato (161, en 18 archivos, 116,72 s) en serie. El ensayo focal de presentación/previews pasó 34/34 y el de trabajos y atomicidad, 39/39. Los logs completos son `.cache/003-integration.log`, `.cache/003-contract.log` y `.cache/003-review-first.log`.
