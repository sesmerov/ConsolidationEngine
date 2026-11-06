# Verificación de la iteración 003

Rama `codex/003-simplificar-flujo`, base `b74bba9`. Se distinguen las comprobaciones ejecutadas en esta iteración de la [verificación histórica de 002](verification-002.md) y del [ensayo FINREP de la especificación](../specs/003-simplificar-flujo/resultado-finrep.json).

| Alcance | Criterios de 003 | Comprobación ejecutada |
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

## Revisión y recorrido COREP

El motor y las siete operaciones quedaron en `f9e2606`. La sonda FINREP sobre este commit reprodujo el diagnóstico y los dos resultados en `.cache/003-finrep-probe/run-m7g2KG/result.json`. El foco de revisión en Angular pasó de seis pruebas en rojo a 24/24 comprobaciones en cuatro archivos. Se probó elegir el productor 51 utilizando el cursor del grupo y recuperar un PATCH sin duplicarlo tras perder la respuesta.

SC-003/004/005. Un primer recorrido móvil permitió ver dos grupos con la misma etiqueta de tabla y columna. La etiqueta ahora usa la celda de destino completa, incluida su fila. El recorrido integrado posterior pasó 4/4 a 320 px, incluida la prueba de rechazo y cancelación. Conservar `v0174_m` en r0070 y omitir el grupo r0200 dio 5 destinos incluidos, 4 omitidos y 7 excluidos. Los cambios antes → después en EUR fueron 5 → 60, 100 → 185, 10 → 50, 20 → 100 y 1.000 → 285. La revalidación dio 14 aprobadas, 1 fallida y 1 no aplicable. La demo tipada validó ocho reglas y produjo cero escrituras. La descarga ligada al recibo conservó la selección histórica y el informe exportado volvió a importarse con sus 110 celdas. Log `.cache/003-corep-final-focal.log`.

En las dos copias del informe COREP se actualizó la hoja de instrucciones con las decisiones r0070/r0200. Se compararon las nueve entradas descomprimidas con Git. Solo cambió `xl/worksheets/sheet3.xml`. La huella del nuevo informe es `64840d2e6443956f41e0acb3944701cfff12fbb6bde20cc22aba22e1aeaf29f3`.

## Aceptación automática

Código entregado en `f74ea0a`, con el motor de `f9e2606`. Se ejecutó `npm ci --offline` con los manifiestos y el lock del workspace en `.cache/003-locked-install` (382 paquetes). El wrapper `scripts/run-with-toolchain.ps1` verificó Node y npm contra los pins locales. Se prepararon plantillas y fixtures y se ejecutaron `build`, `typecheck`, `test:unit`, `test:integration`, `test:contract` y `test:e2e`. Integración y contrato se repitieron en serie sobre el árbol entregado. ANTLR 4.13.2 regeneró lexer, parser y visitor con las huellas originales; se contrastaron también los dos libros del manifiesto y el catálogo EBA fuente. El bundle inicial de producción pesa 676,02 kB (advertencia 700 kB, error 1 MB).

| Suite | Resultado | Log en `.cache/` |
| --- | ---: | --- |
| Motor | 624/624 | `003-unit.log` |
| Angular | 140/140 | `003-unit.log` |
| Integración | 497/497 | `003-integration-final.log` |
| Contrato | 161/161 | `003-contract-final.log` |
| Chromium E2E | 38/38 en 5,4 min | `003-e2e.log` |

SC-001–009 cubiertos por los recorridos y pruebas anteriores. En la suite completa, SC-002 registró 304,2 ms al escribir, 299,7 ms al pegar, 297,9 ms para cero coincidencias y 299,8 ms al borrar. SC-005 pasó en los tres anchos, con teclado, toque en 390 px y movimiento reducido. Se verificaron la persistencia del foco durante cada publicación y el consumo de la indicación solo al visitar la etapa. El rechazo por ETag fue real. La prueba de notificación de cancelación en el navegador fue controlada y las cancelaciones del servidor se verificaron por separado.

Se conservaron 15 capturas de datos sintéticos en `.cache/verification-003/workflow/`. Incluyen `revision-corep-{320,390,1440}.png` y `siguiente-etapa-{320,390,1440}.png`. Se inspeccionaron la distinción visual entre etapa actual y recomendada, las dos celdas en conflicto y las acciones por productor. La portada y el icono de la instancia local de demostración respondieron HTTP 200, con `image/svg+xml` para el icono. La aceptación de esta iteración se basa en las pruebas automáticas y en la inspección visual descrita. No se registraron observaciones de una prueba humana de 003. La entrega usa commits locales y revisión externa `disabled/unmanaged`.

## Regresión de volumen

Protocolo `003-api-seeded-validation`, referencia nueva en `.cache/benchmark/003-reference/`. El catálogo de carga tiene SHA-256 `d76eaad8a4e2a06659163df996bb2c3fbe69e25f1c3fb941ca20ba50bf7c73bd` y el informe `e893027a81ec189be87b3f98022be69c5e9ca06ac8982f6153dbe18ce9c31f00`. Se registraron equipo y commit limpio antes del piloto. Windows 11 Pro x64, Ryzen 5 3600X, 12 procesadores lógicos, 34.277.588.992 bytes de RAM, Node 24.22.2 y Chromium 156.0.8078.4 headless mediante Playwright 1.64.1.

El piloto obtuvo 14,207 s. En la cohorte `cohort-2026-11-06T21-54-59-281Z`, cada ejecución inició un servidor propio y un contexto de navegador nuevo. El intervalo medido empezó al observar por HTTP la carga publicada, antes de rehidratar la página, y terminó con el resumen completo y 50 filas correctas visibles más dos frames. La auditoría posterior cotejó las 500 reglas, 250 aprobadas, 250 fallidas y 100.000 lecturas distintas en cada ejecución. La cohorte duró 9,2 minutos y conservó los diez ensayos.

| Ensayo | Carga aparte (s) | Hasta resultados visibles (s) |
| ---: | ---: | ---: |
| 1 | 29,256 | 15,388 |
| 2 | 29,952 | 14,510 |
| 3 | 29,412 | 14,450 |
| 4 | 28,951 | 16,928 |
| 5 | 29,416 | 14,929 |
| 6 | 29,617 | 15,458 |
| 7 | 29,692 | 16,486 |
| 8 | 29,477 | 15,984 |
| 9 | 28,679 | 14,716 |
| 10 | 29,274 | 15,324 |

10/10 auditorías correctas, todas por debajo de 30 s, mediana 15,356 s. Los tiempos de búsqueda SC-002 y la medición de 002 utilizan protocolos diferentes.
