# Verificación — iteración 004

## Estado

Implementación en curso desde `d4d98f8`, rama `codex/004-flujo-claro-finrep`. Las tareas solo se marcan al completar su comprobación. La observación humana SC-010 permanece pendiente y separada de la automatización.

## Preparación — 2026-11-07

- Árbol limpio al iniciar; checklist documental 16/16, sin hooks de extensión.
- Toolchain local comprobada: Node 24.22.2, npm 11.19.1, TypeScript 6.0.3, Angular/Material 22.2.4, CLI 22.2.5, ANTLR 4.13.2, Vitest 5.0.5 y Playwright 1.64.1. Dependencias presentes; no se instalaron ni actualizaron versiones.
- `.gitignore` cubre dependencias, builds, cachés, archivos de ejecución, secretos y temporales. Proyecto privado sin publicación npm; no se detectaron configuraciones Docker, ESLint, Prettier, Terraform ni Helm que requieran nuevos ignore files.
- Se contrastaron SHA-256 de los dos originales de `tests/fixtures/eba/source-manifest.json` y los cuatro archivos de `assets/demos/manifest.json`: todos coinciden. La fuente FINREP es el original oficial `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7`.
- Puertos 3318 (E2E), 3317 (benchmark) y 3340 (prueba manual) libres al inicio. El proceso del usuario en 3330 se conserva.
- CodeGraph sin índice y `gentle-ai` no disponible; se emplean lecturas directas. Recibos de revisión: disabled/unmanaged.
- Base FINREP: la compatibilidad visual, exportación conservando original y recorrido positivo todavía no están implementados ni acreditados. El probe de coordenadas anterior no demuestra ese soporte.

## Resultados de implementación

T003: escenarios sintéticos 2/3/51 productores, 51 destinos y contextos compatibles preparados. `vitest run --project integration tests/integration/iteration004-fixtures.spec.ts`: 5/5 pasan. Se identifica expresamente el sembrado frente al recorrido visual completo.

## Aceptación humana

SC-010 pendiente de observación con la versión de esta iteración. Una valoración global no sustituye el detalle de las acciones observadas.

## Primer incremento de interfaz

US1/2: acciones principales verdes, realce de etapa durante tres ciclos de 1,5 s, movimiento reducido/foco, retirada de controles técnicos e identificadores visibles y progreso exitoso solo oculto tras presentar su resultado. Se conservan errores, temporalidad, exclusiones, valores exactos y origen legible.

Pruebas Angular focales: 47 casos en cuatro suites. Build web: 690,75 kB iniciales, por debajo del aviso de 700 kB. Playwright: 4 casos iniciales (información útil y anchos 320/390/1440) pasan; el caso de movimiento reducido pasa tras ajustar su matcher de respuesta. Contraste de texto renderizado ≥4,5:1, foco conservado y pulso limitado a 4,5 s. Las capturas se regenerarán en la verificación integrada porque Playwright limpia salidas al reejecutarse.

El recorrido de los tres hitos, los detalles de comparación y todos los negativos se cerrarán después de integrar conflictos/selección. T010/T019 y los SC completos no se marcan todavía.

## Selección y explicación compactas

La selección se publica junto con la simulación, conserva una revisión propia y se edita con control de base/idempotencia. La aplicación nueva envía una referencia a esa revisión. Se mantienen las APIs compatibles por arrays. El resumen de simulación también tiene proyección compacta: el navegador no descarga proposalIds ni los arrays completos del grafo al entrar en Recalcular.

Las pruebas focales de aplicación y explicación pasan (5/5): equivalencia entre arrays y referencia, unión mixta rechazada, revisión antigua, repetición de una aplicación publicada, cadena A→B→C con lecturas registradas de importes recalculados y 51 antecedentes paginados. Las pruebas de límites y lifecycle amplían estos casos; sus resultados finales se consolidarán tras el barrido completo.

Medición aislada de volumen (`.cache/verification-004/selection-volume-1794081230373.json`): bundle sintético sembrado de 100.000 propuestas, no recorrido de importación/simulación. Consulta 143 ms; edición en worker 965 ms; respuesta 33.018 bytes; petición 105 bytes; estado retenido 105.411.319 bytes; 72 ticks del event loop durante la operación. La cancelación conserva la revisión anterior sin publicar un prefijo. Se comprueba además la representación mínima de un millón de posiciones y rechazo del exceso. RSS final del proceso de pruebas: 1.152.897.024 bytes, incluyendo fixtures/copias y workers; no es medida del pico del worker ni de la cuota de estado de producto.

## FINREP visual y preservación

Perfil `eba-finrep-4.0-f0101-v1`: 38 posiciones, 144 anclajes, layout cerrado y cero merges. Se verifican contexto, escala/precisión, ausencia frente a cero, estructura, fuentes y exclusiones. El original permanece intacto; hash del mapping `446123bd6de88b82a837b5ed2497d3f805c7a6808a4e2bf1c2f2b240c4cb85d5`; plantilla `e1552769c2fb7d0a9f6a00cba7d62eee64a1d7f5d01420a2514e7edf9b75d358`.

La integración de demo verifica cinco reglas: 2 pasa/3 falla → 4 pasa/1 falla, con 90→100 y 105→120 en orden Kahn. El Excel exportado retorna las 38 posiciones y sus valores. Las pruebas de preservación/exportación/lifecycle pasan 18/18, incluidos libro completo, escalas 0/3/6, origen ausente/alterado/ajeno, cuotas, cancelación, salida truncada, CRC incorrecto y modificación indebida de una parte excluida. Los errores no publican artefactos parciales.

Importación Angular: 35/35 casos en `finrep-import.component.spec.ts`, `import-inspection.spec.ts` y `visual-demos.component.spec.ts`. Descarga Angular: 14/14 en `exports-visual.spec.ts`, con mensaje específico de hojas FINREP preservadas sin presentarlas como validadas. `npm run typecheck` pasa para API y Angular.

Se contrastaron nuevamente los dos originales, seis demos y tres plantillas contra sus manifiestos: 11 hashes coinciden. Catálogo FINREP `65286b1bedb55d421d834e4b4bb8154aad25520a633c5a574ddaba10b6d81309`; informe FINREP `4d400b7579d15cd2b1f2e7dd584b511cbe96fd1b923497d103600cbba497e6de`.

## Barridos de regresión

- Backend: 78 archivos, 1.370 pruebas pasan en 197,08 s con `vitest run --project engine --project integration --project contract --maxWorkers=2 --exclude tests/integration/proposal-selection-volume.spec.ts`. Volumen se ejecuta separado (2/2), total 1.372 casos cubiertos. La primera ejecución concurrente encontró tres timeouts de 5 s por contención y una regresión real del callback síncrono de la vía antigua de aplicación. Se corrigió esa vía; no se ampliaron timeouts ni límites del producto.
- Angular: 19 archivos, 166/166 pasan. El único ajuste del barrido fue una expectativa antigua que exigía un UUID visible: ahora comprueba la etiqueta pública de versión y la ausencia del identificador.
- La inspección visual de `guidance-320.png` detectó el anuncio accesible visible por falta de CSS global de CDK. Se añade estilo local de ocultación visual y comprobación de dimensiones/recorte reales en navegador, manteniendo `aria-live`.
- El recorrido FINREP por navegador detectó que el commit de inspección liberaba el original necesario para exportar. Se añadió una prueba roja de retención desde el commit real y se corrigió para conservar exclusivamente los originales FINREP publicados, contabilizados en la cuota hasta cerrar el conjunto. Las pruebas aisladas anteriores proporcionaban la fuente directamente y no acreditaban este enlace; se repiten los lifecycle afectados y el recorrido integral.

Commits incrementales ya registrados: `2cf74d5` (preparación), `bbca1f6` (jerarquía/guía visual), `4b9bfe5` (contratos/motor), `e96db6b` (API de decisiones y selección) y `19f100d` (FINREP, preservación y demos). La verificación integrada y el benchmark permanecen en curso.

FINREP después de corregir la retención: 42/42 pruebas focales (`finrep-source-retention`, `import-inspection-lifecycle`, `finrep-export-lifecycle`, `finrep-demo-roundtrip`). El recorrido Playwright `finrep-journey.spec.ts` pasa 3/3 en 320, 390 y 1440 px: descarga de ambos archivos de demo, 38 posiciones cargadas, dos propuestas preseleccionadas, lectura 100+20=120, aceptación explícita, aplicación por referencia, descarga de la versión aplicada aun con selector histórico y reimportación con resultado 4 pasa/1 falla. Evidencias en `.cache/verification-004/finrep/run-02/`. Se inspeccionaron las capturas de 320 y 1440; la suite integrada regenerará las definitivas tras los últimos ajustes visuales.

## Build y recorridos finales

`npm run build`, `npm run typecheck` y Angular completo pasan con las fuentes integradas: **169/169 pruebas en 19 archivos**. Dos generaciones ANTLR aisladas y la salida del build coinciden en los ocho archivos; gramáticas y fuentes originales mantienen sus hashes. Logs: `.cache/verification-004/build-final.log`, `typecheck-final.log`, `angular-final.log` y `antlr-final-comparison.json`.

Bundle inicial: **706,97 kB**, transferencia estimada **158,55 kB**. Hay un aviso de **6,97 kB sobre el umbral orientativo de 700 kB**; el límite de error permanece en 1 MB y el build pasa. No se elevaron budgets para ocultar el aviso.

US4 en navegador: **13/13** pasan con ese mismo build, en 2,3 minutos (`bulk-selection`, `apply-export`, `material-workflow`, `preview`). Se verifican 51 propuestas, recarga y filtros, limpieza global, dependencia oculta, aceptación invalidada, reintento idéntico, aplicación por referencia, contextos, valores exactos, históricos y cancelación. Evidencias en `.cache/verification-004/us4/run-01/`. La interfaz y sus pruebas Angular se registraron en `1f0b339`.

Primera pasada integrada: **43 pasan y 9 fallan de 52** en 8,1 minutos, conservada en `.cache/verification-004/e2e-final/`. Las fallas identifican dos defectos de producto (reinspección bloqueada tras caducidad local y pérdida del localizador de una fórmula COREP) y ajustes del arnés: elegir perfil en el libro completo, declarar contexto de fixtures, separar etiqueta pública e ID de API, usar un libro reconocido para probar exclusiones y esperar la limpieza asíncrona antes de seleccionar. No se relajan los reconocedores ni las expectativas de diagnóstico. Se recompila y se repiten los cuatro archivos afectados más FINREP; no se presenta esta pasada inicial como 52 casos verdes.

Correcciones: caducidad local con 19/19 pruebas Angular de inspección; diagnóstico de perfil con tres regresiones nuevas rojas→verdes y **93/93** casos en cinco suites. Se conserva el localizador CA1/E5 o E7 del perfil solicitado; un FINREP válido sigue admitiendo una fórmula COREP en una hoja excluida. La primera pasada HTML permanece en `.cache/verification-004/e2e-first-report/index.html`.

La compilación corregida pasa build/typecheck, **169/169 Angular** y comparación ANTLR **8/8**. Sus logs terminan en `-corrected` bajo `.cache/verification-004/`. Bundle definitivo: **707,00 kB** iniciales, **158,59 kB** de transferencia estimada; aviso de 7,00 kB sobre 700 kB, con error a 1 MB intacto. Las dos correcciones se registran en `a2c129d`.

Revalidación: **20/20** pasan en 3,1 minutos (`corep-import`, `import`, `useful-information`, `visual-demos`, `finrep-journey`), en `.cache/verification-004/e2e-corrected/`. Los **52 escenarios** quedan cubiertos por los 43 verdes de la primera pasada y estos 20 verdes posteriores, con 11 repetidos; no se afirma una única ejecución 52/52. No hubo cambios de producto después de ese build.

## Correspondencia de aceptación técnica

| Criterios | Evidencia | Estado |
| --- | --- | --- |
| SC-001–002 / FR-001–004, FR-022 | Tres hitos reales; verde único; contraste renderizado ≥4,5:1; pulso de 4,5 s; foco, reduced-motion y forced-colors; anuncio oculto con dimensiones 1 px. | Verificado |
| SC-003 / FR-005–007 | Carga, validación, detalle, propuesta, comparación y descarga sin identificadores internos; se conservan errores localizados, caducidad y exclusiones. | Verificado |
| SC-004 / FR-008–009 | Grupos 2/3/51; elección, cambio y omisión; borrador local, teclado, página posterior y aislamiento. | Verificado |
| SC-005–006 / FR-010–015 | Preselección persistente, edición/filtro global, 51 propuestas, cierre de dependencias, revisión y consentimiento, incertidumbre y aplicación compacta. | Verificado |
| SC-007–008 / FR-016–020 | FINREP visual, 38 posiciones, cinco reglas, cambios 90→100 y 105→120, partes conservadas y descarga/reimportación. | Verificado |
| SC-009 / FR-021, FR-023 | COREP y ocho reglas tipadas, exactitud/Kahn, contextos, búsqueda y recorridos en 320/390/1440 px. | Verificado |
| SC-010 | Observación de Diego en esta versión. Las capturas y acciones Playwright no la sustituyen. | Pendiente |

Rendimiento de referencia pendiente de ejecutar tras congelar el código. Se usará `004-api-seeded-validation`: misma carga 500 reglas/100.000 lecturas y umbrales 30/60 s; al retirar el panel técnico, su cobertura se consulta por API antes de T1, con esa latencia incluida. El manifiesto explicita esta diferencia respecto a 003.

Búsqueda automática sobre 500 reglas, Chromium 156.0.8078.4: escritura con 10 coincidencias **313,0 ms**, pegado con una **313,1 ms**, cero coincidencias **303,6 ms** y borrado para recuperar 500 **310,7 ms**. Las cuatro cumplen ≤1.000 ms desde la última entrada e incluyen dos frames; el foco permanece. SHA-256 del catálogo sintético: `6fd3ba45a853c9d588ca066b0df11b7efd6a89eed7bc72b142156fb39c4a0849`. El prefijo `SC-002` de ese test pertenece a la regresión de 003, no al criterio de contraste de 004.
