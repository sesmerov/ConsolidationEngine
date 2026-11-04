# Implementation Plan: Interfaz Material, COREP visual y validación tipada

**Branch**: codex/002-ui-eba-demo | **Date**: 2026-11-04 | **Spec**: [spec.md](spec.md)

**Input**: especificación 002 y aclaración del usuario: condicionales, texto y fechas exclusivamente de validación.

**Estado**: fases 0 y 1 y funcionalidades US1–US4 implementadas según [tasks.md](tasks.md). Material/CDK, inspección COREP, semántica tipada, demos y exportadores tienen comprobaciones por incrementos. El cierre automatizado global pasa 1.430 pruebas, incluidos 33 E2E; la medición nueva SC-007 pasa 10/10 ensayos auditados ≤30 s (máximo 15,778 s) y la aceptación humana SC-008 sigue pendiente. La evidencia ejecutada está en [verificación 002](../../docs/verification-002.md); los resultados de 001 se conservan como evidencia histórica independiente.

## Summary

El producto incorpora Angular Material, cuatro etapas —Cargar, Validar, Recalcular y Descargar—, tablas compactas y trazabilidad secundaria; un adaptador versionado para COREP 4.0 C_01.00/CA1; y 24 reglas demo con expectativas independientes. El contexto se declara en pantalla o se confirma desde el libro, sin exigir listas de coordenadas. CA1 tiene 110 posiciones; el libro completo reconocido muestra 190 hojas excluidas y exige aceptar esa cobertura parcial. El corpus separa 16 reglas COREP y ocho tipadas: cinco procedentes del catálogo EBA y diecinueve sintéticas, con datos totalmente sintéticos.

El nuevo perfil evalúa condicionales, texto y fechas, pero una política común impide cualquier recálculo de esas reglas en consulta, configuración, simulación y aplicación. Clasifica expresión y precondición completas, incluidas ramas inactivas. Solo reglas numéricas elegibles del perfil nuevo forman productores Kahn. Se mantienen selección explícita, aplicación atómica, originales y revalidación completa.

La entrada visual se inspecciona sin publicar datos y después se confirma con hash/base. La exportación usa una plantilla saneada del producto y el perfil/binding de la versión elegida. El resumen histórico se acota por archivo, sin enviar todas sus declaraciones de contexto. Descargar desde un recibo usa su `newVersionId` y conserva la selección histórica del panel. Los formatos/perfil anteriores siguen disponibles en modo avanzado, con sus comportamientos ya admitidos.

## Technical Context

**Language/Version**: TypeScript 6.0.3; Node.js 24.22.2/npm 11.19.1; ANTLR JavaScript ESM 4.13.2 generado con Java 17.0.8 a partir de la gramática EBA 0.9 intacta.

**Primary Dependencies**: Angular 22.2.4 (CLI/build 22.2.5), RxJS 7.8.2, Fastify 5.12.7, multipart 10.1.6, static 10.1.8, read-excel-file 9.3.14, write-excel-file 4.1.1, yauzl 3.4.0 y sax 1.6.1. Material/CDK **22.2.4** instalados y fijados exactamente; peers comprobados. Se reutilizan parser, racionales, escritor ZIP/XML y codec OOXML existentes; no se añade otro motor de hojas de cálculo ni se ejecutan fórmulas Excel.

**Storage**: estado efímero en memoria, snapshots inmutables, archivos temporales propios y recursos de inspección contabilizados. Sin DB, localStorage, cuentas ni persistencia nueva.

**Testing**: Vitest 5.0.5, Angular con harnesses Material/CDK de la misma versión, Playwright 1.64.1 y Chromium local; suites existentes ampliadas con casos nuevos.

**Target Platform**: Windows x64 de desarrollo y navegador Chromium; producción local 127.0.0.1:3000 y desarrollo Angular 127.0.0.1:4200 con proxy. Sin servicios externos.

**Project Type**: monorepo npm con frontend Angular, API Node.js y motor puro.

**Performance Goals**: repetir 10 ejecuciones de 500 reglas/100 000 datos: al menos nueve ≤30 s y ninguna >60 s, con hardware/condiciones registrados. Carga medida aparte; CA1 tiene medición separada de sus 110 posiciones y libro completo. Páginas de 50 filas, sin todos los resultados en DOM. Mantener bundle 700 kB aviso/1 MB error y medir.

**Constraints**: una entidad/fecha y un workspace por proceso; un Job no terminal; 60 s por Job, recepción 120 s, worker 256 MiB old generation, 20 snapshots, 512 MiB de estado canónico y otros 512 MiB de archivos propios. Inspección única, TTL 15 min. Límites ZIP/XML por perfil; nunca ejecutar archivos, fórmulas ni expresiones como código.

**Scale/Scope**: límites existentes de 500 filas de catálogo, 100 000 coordenadas/hechos, 1 000 000 instancias y cuotas de grafo. Cobertura oficial nueva: únicamente COREP 4.0 C_01.00; libro ITS completo reconocido o extracto CA1. Complemento tipado propio separado. Sin FINREP operativo, tablas abiertas, taxonomías generales, solver ni migración DB.

## Constitution Check

Comprobación inicial al cargar especificación/constitución, antes del diseño, y posterior contra los contratos de fase 1. «Pasa» significa coherencia de diseño, no pruebas del producto ni aceptación humana.

| Principio | Inicial | Después del diseño |
|---|---|---|
| I. Semántica explícita | Pasa: alcance acotado y fuentes preservadas. | Pasa: perfil v2, exclusión absoluta de recálculo, unsupported explícito, corpus con origen. |
| II. Reproducibilidad | Pasa: exactitud y versiones separadas. | Pasa: mapping con huellas, contexto/escala, DTO tipados, expectativas y roundtrip. |
| III. Recálculos controlados | Pasa: no ampliar autorizaciones de escritura. | Pasa: guardias compartidas y repetidas, selección cerrada, publicación atómica y revalidación. |
| IV. Dependencias verificables | Pasa: conservar Kahn y ciclos/descendientes. | Pasa: solo productores elegibles y demo real con dos ramas y tres niveles. |
| V. Evidencia e incrementos | Pasa: separar plan e implementación. | Pasa: FR/SC trazables; fuentes, fixtures, pruebas y aceptación diferenciados; commits progresivos. |
| Restricciones y privacidad | Pasa: Angular/Node/ANTLR, ejecución local. | Pasa: Material fijado, sin red runtime, preflight acotado sin relajar v1 globalmente. |

La constitución describe la plantilla propia de la **primera versión**. La solicitud nueva autoriza otro formato y mantiene compatibilidad; no requiere retirar principios ni modificar la evidencia de 001. Los recálculos booleanos de v1 se conservan, sin habilitar tipos nuevos ni condicionales allí. Recibos de desarrollo: disabled/unmanaged.

## Project Structure

### Documentation (this feature)

~~~text
specs/002-ui-eba-demo/
├── spec.md
├── inspection.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
├── checklists/requirements.md
└── contracts/
    ├── http-api.md
    ├── ui.md
    ├── workbook-profiles.md
    ├── corep-ca1-mapping.json
    ├── language-profile.md
    ├── demo-corpus.md
    └── demo-corpus.json
~~~

tasks.md se generó con speckit-tasks después de esta planificación: 76 tareas agrupadas por historia, con dependencias, pruebas y criterios de cierre. Su checklist registra el progreso de implementación posterior.

### Source Code (repository root)

~~~text
apps/web/src/
  styles.scss                         # nuevo tema, sustituye styles.css
  app/                                # shell, etapas y stores
    import/ validation/ recalculation/
apps/api/src/
  import/                             # perfiles, preflight e inspección privada
  routes/                             # inspecciones, proyecciones y detalles
  session/ jobs/ workers/              # leases, cuotas y publicación atómica
  export/                             # escritores por perfil y plantillas
packages/contracts/src/                # tipos, schemas, perfiles y errores
packages/engine/src/                   # AST, tipado, evaluación y política
assets/templates/                     # nuevo: plantillas saneadas y manifiestos
assets/demos/                         # cuatro libros, fuente ejecutiva y manifiesto
scripts/                              # preparación reproducible de fuentes/demos
tests/
  fixtures/eba/                       # nuevas fuentes públicas intactas
  fixtures/generated/                 # demos derivadas identificadas
  integration/ contract/ e2e/ performance/
packages/engine/test/                  # semántica, guardias y regresiones
~~~

**Structure Decision**: ampliar las fronteras existentes entre contratos, motor puro, adaptadores, servidor y UI. El motor no conoce HTTP, XML ni Material. No crear otro servicio, repositorio o persistencia. Se comprobó CodeGraph: sin índice y con gentle-ai no disponible; se usó inspección directa.

## Phase 0 — decisiones cerradas

[research.md](research.md) recoge diez decisiones, motivos y alternativas: dependencias, límites reales, staging, tipos, exclusiones y demos. No quedan aclaraciones de alcance pendientes.

Las fuentes públicas XLSX se incorporaron intactas con URL/SHA-256 a fixtures EBA. `prepare:templates` reproduce los extractos saneados desde ellas y debe ejecutarse antes de `fixtures`, que también genera las demos. El build empaqueta plantillas, demos y mappings; runtime no depende de `.cache`, libros originales ni descargas de red. Los JSON de diseño fijan correspondencias y expectativas independientes; la [guía de demos](../../docs/visual-demos.md) describe su uso sin duplicar esos oráculos en la UI.

## Phase 1 — diseño y contratos

- [Modelo](data-model.md): tipos, perfiles, bindings, inspección y transiciones.
- [HTTP](contracts/http-api.md): revisión de carga, idempotencia/CAS, rechazo de recálculos, proyecciones, detalle de dependencias, filtro global de comparación y resumen acotado de exportación por versión.
- [Libros](contracts/workbook-profiles.md) y [mapping](contracts/corep-ca1-mapping.json): 110 celdas, anclas, contexto/escala, exclusiones, lectura dispersa y salida saneada.
- [Lenguaje](contracts/language-profile.md): tipos/ramas, controles en todas las entradas, compatibilidad y límites.
- [UI](contracts/ui.md): Material, etapas, stores por workspace, páginas/selección, comparación, descarga y accesibilidad.
- [Demo](contracts/demo-corpus.md) y [oráculo](contracts/demo-corpus.json): 24 reglas, cinco cambios y casos negativos.
- [Quickstart](quickstart.md): preparación reproducible, recorrido implementado y verificaciones pendientes de aceptación.

## Secuencia de implementación y cierre

1. Incorporar fuentes/fixtures reproducibles, contratos y perfiles; fijar compatibilidad v1, tipos y política, con pruebas que evidencien la carencia actual.
2. Ampliar AST/tipado/evaluación v2 y enforcement antes de habilitar rutas nuevas de recálculo. Mantener regresiones numéricas/booleanas v1.
3. Implementar preflight disperso, mapping/contexto y candidato privado; inspección, confirmación y cleanup con cuotas/carreras probadas.
4. Implementar exportación por perfil y demos; verificar datos, formato, procedencia y roundtrip contra oráculos independientes.
5. Integrar Material/shell con stores de workspace; conectar tablas, política, inspección y descarga por versión. Tema/shell puede avanzar en paralelo con adaptadores una vez fijados contratos.
6. Ejecutar integración, revisión visual/accesibilidad, benchmark separado y recorrido humano; corregir antes de declarar entrega.

Las tareas generadas concretan esta secuencia y registran sus cierres por historia. US1–US4 y los controles automatizados finales están completos; la aceptación humana permanece pendiente y separada de ellos. Commits acotados con validación y límites. Sin push ni despliegue remoto. Pruebas con procesos/datos aislados; no cerrar ni reutilizar el conjunto activo del usuario.

## Trazabilidad de verificación

| Requisitos | Comprobaciones definidas en las tareas |
|---|---|
| FR-001–012, SC-001/002 | Stores/harnesses, páginas, selección oculta, estados, teclado y 320/390/1440 px. |
| FR-013–019, SC-003 | 110 celdas, completo/extracto, XFD, anomalías, contenido externo y staging sin publicación. |
| FR-020–023, SC-005 | Exportación/reimportación exacta, plantilla saneada, histórico y versión aplicada. |
| FR-024–029, SC-006 | Tipos/ramas/nulos; rechazo UI/API/worker/apply aun con resultado numérico o rama inactiva; cero propuestas excluidas. |
| FR-030–035, SC-004 | 24 expectativas y cinco recálculos; negativos separados; unsupported no cuenta como éxito. |
| FR-036–038, SC-006/007/008 | Regresión, cuotas/atomicidad/cancelación, medición nueva y aceptación humana. |

Evidencia histórica de planificación: 30 análisis sintácticos ANTLR y cinco sumas independientes; 110 correspondencias y huellas verificadas. No sustituye pruebas del producto. Al cerrar aquella planificación no se había instalado Material ni modificado el producto; la ejecución posterior, el cierre automatizado y la aceptación humana pendiente se distinguen en [verificación 002](../../docs/verification-002.md).

## Complexity Tracking

Sin incumplimientos de la constitución que justificar. La inspección permite revisión previa; perfiles de archivo/lenguaje evitan reinterpretar v1. No se añaden servicios ni almacenamiento innecesarios.
