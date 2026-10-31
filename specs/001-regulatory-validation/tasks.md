---
description: "Tareas de implementación del motor local de validación y recálculo"
---

# Tasks: Validación y recálculo de informes regulatorios

**Input**: `specs/001-regulatory-validation/`: spec, plan, research, data-model, contracts y quickstart.
**Prerequisites**: [plan.md](plan.md), [spec.md](spec.md) y constitución 1.0.0.
**Estado**: implementación en curso. Setup, foundation y US1–US4 T001–T070 completados y verificados; quedan las comprobaciones finales T071–T075, con evidencia en cada checkpoint.

**Tests**: Se incluyen pruebas porque spec.md exige escenarios verificables y criterios SC-001–007,
y la constitución exige evidencia de comportamiento. Las tareas de pruebas preparan casos de negocio
antes de implementar su comportamiento; completar esa preparación no significa que ya pasen.
Cada checkpoint exige ejecutar las pruebas relevantes y corregir fallos antes de cerrar la historia.

**Organization**: siete fases. Las historias se integran en orden US1 → US2 → US3 → US4;
su prueba independiente usa el incremento anterior y no necesita implementar una historia posterior.
US1 es el primer incremento de carga; **US1+US2 es el MVP validador**. La primera versión completa
solicitada incluye también US3 y US4.

## Format: `[ID] [P?] [Story] Description`

- Todos los checks permanecen vacíos hasta realizar y comprobar el trabajo.
- `[P]` permite trabajar en la misma onda solo cuando sus dependencias explícitas estén completadas
  y no se editen los mismos archivos. No autoriza ejecutar historias dependientes a la vez.
- `[US1]`…`[US4]` identifica la historia; setup, foundation y polish no tienen etiqueta de historia.
- Cada tarea declara sus dependencias por ID. Una dependencia de una tarea de pruebas significa
  que los casos están escritos; la verificación de que pasan ocurre en el checkpoint correspondiente.

## Path Conventions

Rutas relativas a la raíz del repositorio: `apps/web`, `apps/api`, `packages/engine`,
`packages/contracts`, `scripts` y `tests`. Los paths describen archivos futuros exactos.
`grammar/` y las fuentes EBA existentes se conservan sin cambios. No se añade base de datos,
motor de fórmulas Excel, servicio externo ni persistencia de sesión.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Crear el esqueleto reproducible, sin implementar todavía importación ni cálculo.

- [X] T001 Crear `package.json`, `.npmrc`, `.node-version` y `package-lock.json` con npm workspaces y pins exactos de research R1 (Node 24.22.2/npm 11.19.1, sin rangos de dependencias directas); registrar motores y scripts previstos sin sustituir versiones por latest (sin dependencias).
- [X] T002 Crear `packages/engine/package.json`, `packages/contracts/package.json`, `tsconfig.base.json`, `packages/engine/tsconfig.json` y `packages/contracts/tsconfig.json` con TypeScript 6.0.3 estricto/ESM, exports y compilación del JS ANTLR mediante frontera tipada; engine no importa HTTP/FS/Angular y contracts no guarda estado (depende de T001).
- [X] T003 Crear `apps/api/package.json`, `apps/api/tsconfig.json` y `apps/api/src/server.ts` con Fastify 5.12.7/plugins fijados, build ESM y arranque local; dejar las rutas de negocio para sus historias (depende de T002).
- [X] T004 Crear `apps/web/package.json`, `apps/web/angular.json`, `apps/web/src/main.ts` y `apps/web/src/app/app.config.ts` con Angular 22.2.4/CLI-build 22.2.5, standalone, Signals/HttpClient y modo zoneless sin zone.js; configurar proxy local en `apps/web/proxy.conf.json` (depende de T003).
- [X] T005 Configurar `vitest.config.ts`, `playwright.config.ts` y scripts de `package.json` para typecheck, test:unit, test:integration, test:contract, test:e2e, build y dev; Vitest 5.0.5/jsdom 30.1.3/Playwright 1.64.1 Chromium; actualizar `package-lock.json` con todos los manifiestos de los workspaces y comprobar instalación mediante npm ci, sin tests triviales del scaffold (depende de T004).
- [X] T006 Implementar `scripts/generate-parser.mjs`, `scripts/antlr-toolchain.json` y `tests/integration/antlr-generation.spec.ts`: fijar origen/checksum del jar 4.13.2 antes de ejecutarlo, comprobar hashes originales, copiar nombres dpm_xlLexer.g4/dpm_xlParser.g4, generar lexer y parser JS ESM con visitor y -lib, verificar que la entrada start exige EOF y registrar Java exacto; actualizar `.gitignore` para salida derivada y comprobar generación repetible sin editar fuentes (depende de T005).

**Checkpoint**: instalación bloqueada por lockfile, workspaces construibles y generación reproducible.
Esto aún no demuestra que se ejecute ninguna regla.

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Contratos comunes, sesión y ejecución aislada que necesitan todas las historias.
No se implementan aquí el importador, el lenguaje completo ni el grafo.

- [X] T007 Definir `packages/contracts/src/common.ts`, `packages/contracts/src/errors.ts` y `packages/contracts/src/common.schemas.ts` con DTO JSON/esquemas cerrados, UUID, fechas civiles, locadores y racionales como cadenas; preservar «No se serializa `BigInt` como JSON number» y «displayName nunca es ruta»; campos opcionales permanecen opcionales y los errores no revelan rutas/stack/token (depende de T006).
- [X] T008 [P] Preparar `tests/integration/session-jobs.spec.ts` con invariantes de snapshot, cuota, un solo Job, cancelación, timeout y cierre seguro; usar dobles de workers controlados, sin confundirlos con evaluación real del motor (depende de T007).
- [X] T009 [P] Preparar `tests/contract/local-session.spec.ts` con Host/Origin/token, 403/409/412/428, esquemas cerrados, replay idempotente antes de If-Match y rechazo de clave reutilizada con otro cuerpo (depende de T007).
- [X] T010 Implementar `apps/api/src/app.ts`, `apps/api/src/plugins/local-session.ts` y `apps/api/src/routes/bootstrap.ts`: loopback 127.0.0.1:3000, allowlist Host/Origin por modo, bootstrap/token aleatorio 256 bits en memoria y X-CE-Session en el resto; CORS sin comodín/origen null y logs sin secretos (depende de T008, T009).
- [X] T011 Implementar `apps/api/src/session/workspace-store.ts` y `apps/api/src/session/canonical-state.ts` con «Un workspace por proceso; el hilo principal es el único propietario mutable del puntero vigente», snapshots «Inmutable. Versiona cualquier cambio de reglas, datos, contexto o direcciones» y estados `empty → ready → closed`; imponer «hasta 20 snapshots por workspace y hasta 512 MiB de estado contabilizado de sesión», bytes UTF-8 canónicos/objetos compartidos una vez, incluyendo resultados/propuestas/diagnósticos/cache y rechazo sin borrar original (depende de T010).
- [X] T012 Implementar `apps/api/src/storage/session-files.ts` y `apps/api/src/routes/workspaces.ts`: nombres UUID/sha256, GET/POST/DELETE workspace, directorio propio con marcador y borrado limitado a su ruta absoluta verificada; respetar «No se borran originales elegidos para carga ni descargas ya guardadas» y cierre que cancela primero los trabajos (depende de T011).
- [X] T013 Implementar `apps/api/src/jobs/job-manager.ts`, `apps/api/src/workers/protocol.ts` y `apps/api/src/routes/jobs.ts` con «kind=import/validate/preview/apply/export», transición `queued → running → succeeded | failed | cancelled | timed_out` y «Se admite como máximo un trabajo no terminal total»; worker_threads, deadline CPU 60 s, cancelación cooperativa/terminate, progreso incompleto y limpieza, sin asumir que resourceLimits limita Buffers (depende de T012).
- [X] T014 Implementar `apps/api/src/plugins/version-guard.ts` y `apps/api/src/session/idempotency-store.ts`: ETag fuerte/If-Match, caché por sesión/workspace/operación/clave/hash consultada tras autenticación y antes de rechazar versión antigua; replay devuelve Job original, no reaplica; definir entrada del hash multipart por archivos/metadatos, nunca boundary, y excepciones GET/selection/cancelación por jobId (depende de T013).
- [X] T015 Crear `apps/web/src/app/core/session.store.ts`, `apps/web/src/app/core/api-client.ts` y `apps/web/src/app/app.component.ts` con bootstrap/token solo en memoria, selección de workspace/contexto/versión, progreso/cancelación y aviso de sesión efímera; ejecutar T008/T009 con API real y workers controlados antes de pasar a US1 (depende de T014).

**Checkpoint**: `npm run typecheck`, pruebas foundation y contratos locales correctos. La base
no persiste datos entre reinicios ni expone servidor fuera de loopback.

## Phase 3: User Story 1 - Cargar y comprobar reglas e informes (Priority: P1)

**Goal**: Descargar plantilla, importar catálogo/reportes y explicar entradas/cobertura sin validar.
**Independent Test**: V01/V04/V13 y parte de V14: datos válidos generan una versión, errores
estructurales conservan la anterior; una regla errónea permanece visible sin ocultar reglas válidas.

### Tests for User Story 1

- [X] T016 [US1] Crear `scripts/create-fixtures.mjs`, `tests/fixtures/source-manifest.json` y `tests/fixtures/import-cases.json` con extractos reales G113/G169/G170 y datos sintéticos ce-report-1; conservar celda/hash/fechas y precondiciones originales, declarar filingIndicators sintéticos y etiquetar entidad SYNTHETIC, cubrir contexto 4.2/2026-06-30 y 4.0/2025-12-31, sin sobrescribir el Excel EBA completo (depende de T015).
- [X] T017 [P] [US1] Preparar `tests/integration/xlsx-import.spec.ts` para null/ausencia/cero, tipos textuales, >15 dígitos, duplicados, fechas 1900/1904/serial60, raw XML, XML inválido, fórmulas/macros, ZIP traversal/bomb, cuotas y carga fallida que conserva snapshot (depende de T016).
- [X] T018 [P] [US1] Preparar `tests/contract/imports.spec.ts` para plantilla, multipart, 120 s de recepción, cabeceras, error por regla, 202 Job, 413/415/422, idempotencia con distinto boundary y reglas paginadas/versionadas (depende de T016).

### Implementation for User Story 1

- [X] T019 [US1] Definir `packages/contracts/src/catalog.ts`, `packages/contracts/src/report.ts` y sus esquemas cerrados: SourceFile/RawRuleRecord/RuleVariant/ReportContext/Coordinate/ReportedFact; conservar «Una entrada por fila importada; ninguna desaparece por ser inválida o duplicada», campos precondition/submissionDate opcionales, filingIndicators explícitos por contexto sin inferirlos de hechos/coordenadas, «Una entidad/fecha por workspace» y enums dataType=`number|boolean`, presence=`value|null` (depende de T017, T018).
- [X] T020 [US1] Implementar `apps/api/src/import/multipart-staging.ts`: streams a UUID internos y SHA-256, 1 catálogo+1–20 informes, 10 MiB/archivo, 50 MiB/lote, recepción máxima 120 s, extensión/contenido XLSX y hash idempotente de bytes+metadatos; fallo/cancelación elimina solo staging propio (depende de T019).
- [X] T021 [US1] Implementar `apps/api/src/import/xlsx-preflight.ts` con yauzl lazy/strict/validateEntrySizes y sax estricto/namespaces: rechazar rutas/entradas duplicadas/cifrado/symlinks/DOCTYPE/SGML/fórmulas/VBA/OLE/ActiveX/relaciones externas de datos; conservar tipo/lexema/estilo/date1904, validar sharedStrings/relaciones internas/sparse dimensions y contar límites reales 100 MiB/lote, 64 MiB/entrada, 2048 entradas, 64 hojas, 500000 sharedStrings, 32767 caracteres/celda, profundidad64, 200001 filas/64 columnas (depende de T020).
- [X] T022 [US1] Implementar `apps/api/src/import/xlsx-reader.ts` con read-excel-file9.3.14, parseNumber que conserva texto y trim:false, consumiendo metadatos del preflight sin reconstruir fechas desde Date transformado; no acceder a enlaces ni usar valores de fórmulas cacheados (depende de T021).
- [X] T023 [P] [US1] Implementar `apps/api/src/import/eba-catalog.ts` y `apps/api/src/import/excel-dates.ts`: 15 cabeceras exactas incluida Precondtion, Expression/precondición separadas de Description, comas en Modules/Tables, fechas inclusivas/NULL/date1904/serial60, severidad original+normalizada y variantes con «variantId no incluye fila/archivo»; preservar todas las procedencias de duplicados equivalentes y diagnosticar incompatibles sin escoger por orden (depende de T022).
- [X] T024 [P] [US1] Implementar `apps/api/src/import/ce-report.ts` y codec de entrada en `packages/engine/src/numeric/rational.ts`: Contexts/Coordinates/Facts, contextId «Texto único en el lote, 1–64 caracteres alfanuméricos, guion o guion bajo», fecha/entidad común, filingIndicators JSON booleanos con códigos exactos y ausencia distinta de false, «No admite claves repetidas», presence=value/null, null explícito versus fila Facts ausente y coordenada inexistente; validar códigos textuales, unit canónica, decimals -18…18/INF y valor texto≤128 dígitos/128 decimales sin Number (depende de T022).
- [X] T025 [US1] Implementar `packages/engine/src/parser/parse-rule.ts`, `packages/engine/src/ast/ast.ts`, `packages/engine/src/parser/ast-visitor.ts` y `packages/engine/test/parser.spec.ts`: start+EOF, errores de lexer y parser aun con recuperación, una expresión booleana/null, AST whitelist incluido PRECONDITION_ELEMENT como filing_indicator (sin variables genéricas) y diagnóstico de scripts/asignaciones/no soportados; «Solo hay AST ejecutable con cero errores y construcciones soportadas. El árbol ANTLR no sale por HTTP»; límites 32768 caracteres, 8192 tokens/nodos y profundidad128, sin eval (depende de T019, T006).
- [X] T026 [US1] Implementar `apps/api/src/import/import-workspace.ts` y `apps/api/src/workers/import.worker.ts`: integrar preflight/adaptadores/análisis estático, 500 registros/100000 hechos/100000 coordenadas, compatibilidad Contexts explícita, selección por vigencia y conteos conciliados; publicar un snapshot solo tras carga estructural válida, conservar registros de reglas inválidos y la versión previa ante error técnico/cancelación (depende de T023, T024, T025).
- [X] T027 [US1] Implementar `apps/api/src/export/report-template.ts` con write-excel-file4.1.1 y fixture G169: cuatro hojas Instructions/Contexts/Coordinates/Facts, instrucciones en español, tipos textuales que conservan ceros/importes, ejemplo sintético y precisión/null bien explicados; generar ce-report-1 y comprobar que el importador lo acepta (depende de T024).
- [X] T028 [US1] Implementar `apps/api/src/routes/imports.ts`, `apps/api/src/routes/rules.ts` y `apps/api/src/routes/capabilities.ts` con GET plantilla, POST imports, GET rules paginado/versionado y capacidades del perfil; integrar T014 sin pérdida de la versión anterior, exponer cobertura/diferencia de intervalos sin atribuir conformidad completa EBA (depende de T026, T027, T014).
- [X] T029 [US1] Crear `apps/web/src/app/import/import-page.component.ts`, su template y `apps/web/src/app/import/import.store.ts`: descargar plantilla, mostrar módulos/entidad/periodo declarados, cargar archivos, seguir/cancelar Job, inspeccionar filas/diagnósticos/cobertura y conservar vista válida anterior ante rechazo (depende de T028, T015).
- [X] T030 [US1] Implementar y ejecutar `tests/e2e/import.spec.ts` para V01/V04/V13 y cero/null/texto de V14; ejecutar T017/T018, comprobar originales por hash y recorrido sin validación ni recálculo, corrigiendo errores de este incremento antes de cerrarlo (depende de T029).

**Checkpoint**: US1 entrega un cargador verificable. Las reglas no soportadas/erróneas son visibles;
no hay todavía resultados de validación ni propuestas de cambio.

## Phase 4: User Story 2 - Entender resultados de validación (Priority: P1)

**Goal**: Evaluar y explicar reglas aplicables, filtrar resultados y exportarlos sin recálculos.
**Independent Test**: V02–V05/V12/V15 con expected documentados; toda instancia tiene estado,
el resumen coincide con el detalle y los resultados exportados incluyen fuentes/versiones.

### Tests for User Story 2

- [X] T031 [P] [US2] Preparar `packages/engine/test/numeric.spec.ts` y `tests/fixtures/numeric-cases.json` con racionales exactos, límites4096bits antes/después de operar, 0.1+0.2, (1/3)*3, intervalos negativos/cuatro esquinas, división que incluye0, comparación no transitiva y precisión INF; expected derivados del perfil local, no de una supuesta errata oficial (depende de T030).
- [X] T032 [P] [US2] Preparar `packages/engine/test/resolver.spec.ts` y `packages/engine/test/nulls-units.spec.ts`: herencia with entre tablas, rangos ordinales con huecos, s* finito, referencias ambiguas, null explícito/implícito/ausencia inválida, Kleene/default/nvl/sum vacío, filingIndicators true/false/ausente/true sin Facts sin sustitución por default y promoción de literales sin permitir EUR+USD (depende de T030).
- [X] T033 [P] [US2] Preparar `tests/contract/validations.spec.ts` y `apps/web/src/app/validation/validation-page.component.spec.ts` con estados/severidad, cobertura sin falsos pasa, errores y precondiciones, cancelación/incompleto, páginas/filtros anclados a versión y explicación de operandos/fuentes (depende de T030).

### Implementation for User Story 2

- [X] T034 [US2] Ampliar `packages/engine/src/numeric/rational.ts` con suma/resta/producto/división/comparación exactos, gcd/signo/cero normalizados y control de crecimiento antes de multiplicar; mantener «Dinero y otros números: racionales `{numerator: string, denominator: string}`» al serializar y no redondear valores intermedios (depende de T031, T024).
- [X] T035 [P] [US2] Implementar `packages/engine/src/numeric/interval.ts` con nominal separado de lo/hi, radio10^-p/2 o cero para INF, operaciones de extremos/min/max y comparación del contrato; p no obliga a cuantizar importación y división por intervalo con0 es error, nunca intervalo inválido (depende de T034).
- [X] T036 [P] [US2] Implementar `packages/engine/src/evaluator/nulls.ts` y `packages/engine/src/numeric/units.ts`: lógica ternaria, isnull/nvl/default tipados (nvl admite literal contextual según contrato), sum omite null y vacío/all-null devuelve null+EMPTY_AGGREGATION; unidades por mapa/exponentes y literal contextual, con errores que no se convierten en null (depende de T034, T032).
- [X] T037 [US2] Implementar `packages/engine/src/resolver/coordinates.ts`, `packages/engine/src/resolver/scope.ts` y `packages/engine/src/resolver/instances.ts`: FactKey/contexto canónicos, catálogo cerrado, rangos y s*, herencia same-table/override y distinta tabla sin heredar coordenadas; «Clave estable por contenido de regla efectivo y binding completo, sin ordinal de importación», sin primer match ni joins implícitos; resolver filing_indicator por contexto como metadato sin herencia de ejes/default/interval (depende de T035, T036, T025).
- [X] T038 [US2] Implementar `packages/engine/src/evaluator/evaluate.ts` para AST admitido, aritmética/comparaciones/precondiciones/null/funciones y trazas de referencias y filingIndicators (MISSING_FILING_INDICATOR si impide decidir); respetar el default interval:false, cuotas1000000 instancias/aristas y10000000 lecturas más deadline/cancelación; una construcción reconocida pero no admitida permanece no evaluable (depende de T037, T035, T036).
- [X] T039 [US2] Definir `packages/contracts/src/validation.ts` y `packages/engine/src/validation/run.ts`: ValidationRun `running → completed | incomplete`, RuleResult «`pass`, `fail`, `not_applicable`, `not_evaluable`, `error`; `blocked` solo en la simulación dependiente de recálculo», reglas de aplicabilidad antes de resultado y conteos filas/variantes/instancias conciliados; «Los resultados pertenecen a un snapshot. Cambiar el vigente los hace históricos, no los reasigna» (depende de T038, T023).
- [X] T040 [US2] Implementar `apps/api/src/workers/validate.worker.ts` y `apps/api/src/validation/validation-service.ts` con almacenamiento del run/resultados sujeto a cuota y perfil/versión, snapshot inmutable y Job succeeded aunque haya reglas fail/error; cancelación/cuota da ejecución incompleta, no resumen aprobado (depende de T039, T013, T011).
- [X] T041 [US2] Implementar `apps/api/src/routes/validations.ts` y `apps/api/src/routes/results.ts`: POST validations y resultados históricos paginados, limit1–200/default50, cursor por recurso/filtro/versión, racionales como cadenas y operandos/locadores/expresión/precondición; no exponer AST/rutas ni aceptar esquema subido (depende de T040, T033, T014).
- [X] T042 [US2] Implementar `apps/api/src/export/results-export.ts`, `apps/api/src/workers/export.worker.ts` y `apps/api/src/routes/exports.ts` para POST exports kind=results y descarga segura: ZIP con results.json exacto y results.xlsx literal, versiones/fuentes/diagnósticos, límites64MiB/contenido y100MiB/paquete más512MiB de archivos propios acumulados, selección de run/version históricos con If-Match; reutilizar el coordinador de trabajos y escritor XLSX sin requerir recálculos (depende de T041, T027).
- [X] T043 [US2] Crear `apps/web/src/app/validation/validation-page.component.ts`, su template y `apps/web/src/app/validation/results.store.ts` con ejecutar/cancelar, filtros por estado/código/tabla, páginas, severidad separada, detalle de valores/ausencias y explicaciones del perfil; invalidar vista vigente cuando cambie snapshot sin borrar resultados históricos (depende de T041, T033, T015).
- [X] T044 [US2] Añadir `apps/web/src/app/validation/results-export.component.ts` y `tests/contract/results-export.spec.ts` para exportación de validación de solo lectura, descarga de run elegido, conciliación de filas/variantes/instancias y ausencia de fórmulas activas o pérdida decimal; probar errores de cuota y versión (depende de T043, T042).
- [X] T045 [US2] Implementar y ejecutar `tests/e2e/validation.spec.ts` con V02/V03/V04/V05/V12/V15 y exportación de resultados; ejecutar T031–T033/T044 y comprobar estados/valores exactos, fuentes y repetibilidad al permutar filas antes de cerrar el MVP validador (depende de T044).

**Checkpoint**: US1+US2 permite carga, validación, explicación y exportación de resultados.
No se promete recalcular ni aplicar cambios hasta completar las historias siguientes.

## Phase 5: User Story 3 - Previsualizar recálculos y dependencias (Priority: P2)

**Goal**: Elegir destinos de igualdades, obtener propuestas explicadas y conocer sus bloqueos.
**Independent Test**: V06 solo preview, V07/V08/V09: A12/D24, consumidores de valores cuantizados,
ciclos versus descendientes, conflictos y precondiciones reevaluadas; snapshot original intacto.

### Tests for User Story 3

- [X] T046 [P] [US3] Preparar `packages/engine/test/dependency-graph.spec.ts` con productores únicos, lecturas RHS/ámbito/precondiciones, Kahn estable, SCC residual, autociclo, descendientes y rama independiente; permutar nodos/filas sin alterar orden semántico ni resultados (depende de T045).
- [X] T047 [P] [US3] Preparar `packages/engine/test/simulation.spec.ts` y `tests/fixtures/recalculation-cases.json` con elegibilidad, destino explícito, half-even/negativos, A=1/3 p2→0.33/D0.99 con interval:true, rechazo puntual, INF periódico, OUTPUT_VALUE_LIMIT y productores fallidos sin fallback (depende de T045).
- [X] T048 [P] [US3] Preparar `tests/contract/previews.spec.ts` con directions/preview/proposals/selection, If-Match, ausencia de destino, rechazo de código subido, clausura incompleta y prueba de que consultar/seleccionar preview no modifica hechos (depende de T045).

### Implementation for User Story 3

- [X] T049 [US3] Definir `packages/contracts/src/recalculation.ts` y esquemas cerrados para Direction/Preview/Proposal: dirección «Configurada expresamente para una igualdad; destino único e identidad canónica», preview «Solo puede aplicarse contra la base que la produjo» y proposal «after es el valor ya cuantizado y la precisión que leerán sus consumidores y se exportará»; conservar before/exactNominal/derivedInterval/readKeys/predecessorIds/diagnósticos (depende de T046, T047, T048).
- [X] T050 [US3] Implementar `apps/api/src/recalculation/directions-service.ts` y `apps/api/src/routes/directions.ts`: PUT completo usando instancias de validación del snapshot vigente, targetSide left/right de celda única, nuevo configVersion/ETag y previews ready anteriores obsoletas; no aceptar expresiones ni inferir dirección del signo= (depende de T049, T041, T014).
- [X] T051 [P] [US3] Implementar `packages/engine/src/dependencies/read-set.ts` y `packages/engine/src/dependencies/producers.ts` con expansión estática finita de RHS/precondición/ámbito, claves contextuales completas y detección de múltiples productores antes de ordenar, incluso si los valores coinciden (depende de T050, T037).
- [X] T052 [P] [US3] Implementar `packages/engine/src/dependencies/kahn.ts` y `packages/engine/src/dependencies/scc.ts`: cola por clave canónica, aristas productor→consumidor, SCC>1/self-edge en residuo, propagación de bloqueos y ramas independientes; no etiquetar todo el residuo como ciclo ni crear dependencia por lectura compartida (depende de T051, T046).
- [X] T053 [P] [US3] Implementar `packages/engine/src/recalculation/quantize.ts` y `packages/engine/src/recalculation/candidate.ts`: half-even a precisión destino, INF solo decimal finito, salida≤128 significativos/128 posiciones o OUTPUT_VALUE_LIMIT, unidad compatible y revalidación originaria; si el candidato no satisface la igualdad devolver CANDIDATE_DOES_NOT_SATISFY_RULE (depende de T049, T047, T038, T051).
- [X] T054 [US3] Implementar `packages/engine/src/recalculation/simulate.ts`: recorrer orden Kahn sobre copia, consumir valores ya cuantizados, reevaluar precondiciones y bloquear dependientes si productor no resulta disponible; registrar nominal/intervalo/política/base/lecturas con cuotas y cancelación, sin fallback al valor antiguo ni escritura del snapshot (depende de T052, T053, T038).
- [X] T055 [US3] Implementar `apps/api/src/workers/preview.worker.ts`, `apps/api/src/recalculation/preview-store.ts` y `apps/api/src/routes/previews.ts` con POST preview, GET detalle/propuestas, POST selection, DELETE para descarte persistente y listados paginados de resúmenes de runs/previews que permitan recuperar historial sin almacenamiento del navegador; calcular requiredIds/closureHash sin aceptar ancestros por el usuario, páginas versionadas, previews ready/obsolete y propuestas available/blocked, manteniendo separados ambos estados según contrato (depende de T054, T049, T048).
- [X] T056 [P] [US3] Crear `apps/web/src/app/recalculation/directions.component.ts` y su template para elegir solo lados elegibles desde resultados, mostrar motivo de inelegibilidad y actualizar versión/configuración sin tratar igualdades como correcciones automáticas (depende de T050, T043).
- [X] T057 [US3] Crear `apps/web/src/app/recalculation/preview-page.component.ts`, su template y `apps/web/src/app/recalculation/preview.store.ts`: antes/después/precisión, dependencias/ciclos/conflictos/causas, selección con ancestros faltantes y obsolescencia; recuperar historial desde el servidor tras refrescar, sin localStorage; seleccionar o descartar preview no aplica cambios (depende de T055, T056).
- [X] T058 [US3] Implementar y ejecutar `tests/e2e/preview.spec.ts` para V06-preview/V07/V08/V09 y snapshot intacto tras cancelar; ejecutar T046–T048, incluidos orden independiente de filas y consumidor que lee precisión cuantizada, antes de cerrar US3 (depende de T057).

**Checkpoint**: hay propuestas y explicaciones, pero ninguna edición automática del informe.
El analista puede comprobar la clausura necesaria antes de la futura aplicación.

## Phase 6: User Story 4 - Aplicar cambios y comparar resultados (Priority: P2)

**Goal**: Confirmar conjuntos coherentes, revalidar una nueva versión y exportar sus datos/cambios.
**Independent Test**: aceptar A/D crea versión nueva con A12/D24; stale/cancel/timeout dejan la
anterior intacta; reintentos no repiten cambios; exportación/reimportación conserva datos exactos.

### Tests for User Story 4

- [X] T059 [P] [US4] Preparar `tests/integration/application-atomicity.spec.ts` con clausura incompleta, cambio de base, timeout/cancelación antes y después de publicar, worker caído, cuota512MiB/20snapshots y revalidación técnica incompleta; comprobar byte/valor/versión previa sin mutaciones parciales (depende de T058).
- [X] T060 [P] [US4] Preparar `tests/contract/applications-exports.spec.ts` para aplicación confirmada, replay tras If-Match antiguo, misma clave/cuerpo distinto, export histórico/Content-Disposition y roundtrip de >15 dígitos/null/códigos; expected V10/V14/V16 (depende de T058).
- [X] T061 [P] [US4] Preparar `apps/web/src/app/recalculation/apply.component.spec.ts` y `tests/integration/revalidation-comparison.spec.ts`: aceptación explícita de todos los selectedIds, resultados antes/después con reglas que siguen fallando, obsolescencia y respuesta perdida sin segundo cambio (depende de T058).

### Implementation for User Story 4

- [X] T062 [US4] Definir `packages/contracts/src/application.ts` con ApplyReceipt/selección/resultado y estados del modelo: «Solo existe tras publicar la versión completa», Preview `ready → applied | discarded | obsolete`, Proposal `available → accepted → applied` y ramas descartada/obsoleta; accepted vive solo en candidato mientras se revalida, no como cambio publicado prematuramente (depende de T059, T060, T061).
- [X] T063 [US4] Implementar `packages/engine/src/recalculation/apply-candidate.ts` y `apps/api/src/workers/apply.worker.ts`: validar conjunto no vacío/cerrado/sin conflictos, copiar únicamente hechos cambiados y revalidar todas las reglas aplicables con versiones/evidencia; fallos de reglas se conservan como resultados, pero fallo técnico/cuota/timeout impide completar candidato (depende de T062, T054, T040).
- [X] T064 [US4] Implementar `apps/api/src/recalculation/application-service.ts` y `apps/api/src/routes/applications.ts`: comprobar base/preview/closureHash, iniciar Job y publicar en una única sección del hilo principal tras nueva comprobación de versión/cancelación/plazo/cuota; conservar original ante fallo y recuperar resultado por idempotencia sin reaplicar (depende de T063, T014, T013, T059).
- [X] T065 [US4] Ampliar `apps/api/src/recalculation/preview-store.ts` y `apps/api/src/session/workspace-store.ts` con historial de aplicación: «solo una preview ready de otra base pasa a obsolete; applied/discarded mantienen su estado histórico»; al aplicar subconjunto marcar elegidas applied y no elegidas obsolete, registrar cambio/versiones/momento y respetar límites sin expulsar original (depende de T064).
- [X] T066 [P] [US4] Implementar `apps/api/src/export/recalculated-report.ts` y `apps/api/src/export/change-log.ts`: ce-report-1 exacto particionado por SourceFile, con contextos/filingIndicators/coordenadas y valores cuantizados como texto, precisión/presencia intactas, JSON de cambios acumulados de la rama y vista Excel literal; conservar expandedBytes durante importación y comprobar límites de reimportación con el catálogo original; no sobrescribir originales ni presentar salida como remisión oficial (depende de T065, T042, T060).
- [X] T067 [US4] Ampliar `apps/api/src/routes/exports.ts` y `apps/api/src/workers/export.worker.ts` para kind=report/resultados posteriores, snapshot histórico explícito, temporales propios y descarga por exportId con nombre seguro, token/If-Match/quotas y limpieza; no admitir rutas del usuario (depende de T066, T064).
- [X] T068 [P] [US4] Crear `apps/web/src/app/recalculation/apply.component.ts`, su template y `apps/web/src/app/recalculation/comparison.component.ts`: mostrar conjunto completo y confirmar expresamente, comunicar stale/timeout/fallo versus aplicado, comparar estados/severidad/valores antes-después y no prometer rollback si cancelación llega después de publicar (depende de T065, T057, T061).
- [X] T069 [US4] Añadir `apps/web/src/app/recalculation/exports.component.ts` y ampliar `apps/web/src/app/core/session.store.ts` para elegir exportación de versión/run, guardar informes/cambios y cerrar workspace con cancelación/limpieza explícitas, manteniendo descargas del usuario y aviso de que reinicio pierde sesión (depende de T068, T067).
- [X] T070 [US4] Implementar y ejecutar `tests/e2e/apply-export.spec.ts` con V06-completo/V10/V11/V14/V16, reimportación exacta del resultado, cierre y hashes originales; ejecutar T059–T061 antes de cerrar la primera versión con recálculos (depende de T069).

**Checkpoint**: US1–US4 integradas. Las propuestas aceptadas producen una versión nueva y una
validación completa; la integridad original, efectos de cancelación y exportación son verificables.

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Comprobar los límites del conjunto y dejar una entrega reproducible y utilizable.

- [ ] T071 Extender y ejecutar `tests/integration/resource-lifecycle.spec.ts` y `tests/contract/local-surface.spec.ts` para cuotas acumuladas/caché, CPU cancelable, worker terminado, sesión cerrada/reiniciada, original intacto y errores/logs sin secretos ni rutas; verificar POST/GET/DELETE permitidos y limpieza solo de directorio propio, sin introducir revisión por recibos (depende de T070).
- [ ] T072 Crear `scripts/benchmark.mjs`, `tests/performance/validation-browser.spec.ts` y resumen en `docs/performance.md`: 500 reglas distintas/admitidas y100000 hechos, 10 ejecuciones desde fin de carga hasta resultados visibles en navegador, hardware/versiones/memoria/cuotas/instancias; medir 9/10≤30s y corte60s, no contar deduplicados o fixtures rechazados como éxito y corregir cuellos de botella concretos sin cambiar semántica (depende de T071).
- [ ] T073 Completar accesibilidad y recorrido en `apps/web/src/app/app.component.ts`, estilos de las cuatro páginas y `tests/e2e/analyst-journey.spec.ts`: teclado/foco/etiquetas, errores junto al campo, tablas legibles/paginadas y entidad/periodo/versión visibles; ejecutar SC-007 y registrar pasos/ayuda necesaria sin sustituirlo por una simulación del usuario (depende de T072).
- [ ] T074 Actualizar `README.md`, `specs/001-regulatory-validation/quickstart.md` y `docs/verification.md` con comandos realmente existentes, versiones utilizadas, fixtures sintéticos/fuentes reales, política de sesión, perfil/diferencia EBA y resultados/limitaciones observados; no marcar compatibilidad total ni benchmarks no medidos (depende de T073).
- [ ] T075 Ejecutar el recorrido completo y checks pertinentes de `specs/001-regulatory-validation/quickstart.md`: npm ci, generación reproducible, typecheck, suites de negocio/contrato/integración/E2E y build; contrastar hashes de originales y registrar resultados finales en `docs/verification.md`, corrigiendo fallos dentro de su funcionalidad antes del commit de cierre (depende de T074).

## Dependencies & Execution Order

### Phase Dependencies

```mermaid
flowchart LR
  S[Setup T001–T006] --> F[Foundation T007–T015]
  F --> U1[US1 T016–T030]
  U1 --> U2[US2 T031–T045]
  U2 --> U3[US3 T046–T058]
  U3 --> U4[US4 T059–T070]
  U4 --> P[Polish T071–T075]
```

La lista `(depende de …)` de cada tarea es normativa para su ejecución. Todas las referencias
apuntan a IDs anteriores. Las historias comparten el producto ya construido y se verifican sobre
fixtures controlados; no necesitan esperar a las historias posteriores.

### Within Each User Story

Preparar los casos → modelos/contratos → núcleo/adaptadores → servicios/rutas → UI → integración.
Si una prueba inicial no puede compilar porque falta su módulo, eso no acredita una prueba roja
de comportamiento: debe demostrarse el caso relevante cuando la frontera mínima exista y luego
comprobar el resultado final. Ninguna tarea está autorizada a afirmar un test ejecutado solo por escribirlo.

### Parallel Opportunities

| Onda | Prerrequisito | Tareas y archivos separados |
| --- | --- | --- |
| Foundation | T007 terminada | T008 session-jobs.spec.ts y T009 local-session.spec.ts. |
| US1 pruebas | T016 terminada | T017 xlsx-import.spec.ts y T018 imports.spec.ts. |
| US1 adaptadores | T022 terminada | T023 eba-catalog/excel-dates y T024 ce-report/codec racional. |
| US2 pruebas | T030 terminada | T031 numeric, T032 resolver/nulls-units y T033 validations/UI spec. |
| US2 primitivas | T034 y T032 terminadas | T035 interval.ts y T036 nulls.ts/units.ts. |
| US3 pruebas | T045 terminada | T046 dependency-graph, T047 simulation/fixture y T048 previews. |
| US3 implementación | T050 terminada | T051 y T056 en archivos separados; tras T051, T052 y T053, con contratos comunes T049 y API de resolución ya fijados. |
| US4 pruebas | T058 terminada | T059 application-atomicity, T060 applications-exports y T061 apply/UI comparison. |
| US4 implementación | T065 terminada | T066 exportadores y T068 aceptación/comparación Angular en archivos separados; T067 espera T066 y T069 espera T067/T068. |

## Parallel Example: User Story 1

Tras T016, preparar simultáneamente T017 y T018. Tras T022, implementar T023 y T024 en archivos
distintos. Esperar a ambos antes de integrar T026. No ejecutar dos scaffolds que alteren el lockfile.

## Parallel Example: User Story 2

Tras T030, T031/T032/T033 comparten fixtures ya terminados y escriben suites distintas.
Después de T034 y T032, T035/T036 pueden avanzar a la vez; T037 espera a ambos.

## Parallel Example: User Story 3

Tras T045, T046/T047/T048 preparan pruebas independientes de grafo, simulación y HTTP.
Tras fijar contratos y direcciones (T049/T050), T056 puede desarrollar los controles de dirección mientras T051 prepara las lecturas. T052 y T053 se ejecutan en paralelo después de T051, sin modificar sus archivos compartidos. Esta distribución se precisó al iniciar US3, una vez acordadas las interfaces; no cambia requisitos ni adelanta una tarea a sus dependencias.
No iniciar T054 hasta disponer tanto del grafo terminado T052 como del candidato cuantizado T053.

## Parallel Example: User Story 4

Tras T058, T059/T060/T061 preparan atomicidad, exportación y UI/comparación en archivos distintos.
T062 espera sus contratos/casos; no paralelizar T064/T065, pues comparten publicación y ciclo de vida. Tras T065 y con DTO/API estables, T066 y T068 pueden avanzar en paralelo; T069 espera a la integración de exportación T067 y a la aceptación UI T068. Esta distribución se precisó al fijar los contratos de US4 y no cambia sus dependencias funcionales.

## Implementation Strategy

### MVP First (User Stories 1 and 2)

1. Completar setup y foundation con verificaciones de sus límites.
2. Entregar US1 como primer incremento de carga e inspección, comprobado mediante T030.
3. Completar US2 y T045 para obtener el MVP validador, incluida exportación de resultados.
4. Continuar US3/US4 para cumplir también el recálculo solicitado; no presentar el MVP como la
   primera versión completa mientras falten esas historias.

### Incremental Delivery

Hacer commits progresivos por funcionalidad coherente y comprobada, con pruebas ejecutadas y
limitaciones en el mensaje. No crear un commit por checkbox si rompe una unidad de trabajo;
tampoco acumular todo el producto en un único commit. Los checkpoints son verificaciones ordinarias
del trabajo, no aprobaciones de un sistema de recibos.

Marcar una tarea solo después de implementarla y comprobar su resultado. `$speckit-implement`
está en ejecución; no se invoca automáticamente
`$speckit-analyze` ni se habilitan revisiones. Desarrollo con recibos: `disabled/unmanaged`.

## Traceability

Las tablas indican trabajo que debe producir la evidencia; no afirman que exista ya.

| Requisito | Tareas |
| --- | --- |
| FR-001 | T016–T019, T022–T023, T026, T028–T030 |
| FR-002 | T023, T026, T030, T037, T039, T045 |
| FR-003 | T019, T024, T027–T030 |
| FR-004 | T011, T017–T018, T020–T026, T030 |
| FR-005 | T025, T028–T030, T033, T038–T043, T045 |
| FR-006 | T025, T031–T039, T045 |
| FR-007 | T024, T031–T039, T045, T053 |
| FR-008 | T033, T039–T045, T049, T054–T058 |
| FR-009 | T028–T030, T039–T045, T066–T070 |
| FR-010 | T011, T014, T026, T030, T037, T040, T045, T054, T064–T065 |
| FR-011 | T047–T050, T053–T058 |
| FR-012 | T046, T051–T054, T058 |
| FR-013 | T046, T051–T052, T054–T058 |
| FR-014 | T048–T049, T055–T058, T061, T068 |
| FR-015 | T014, T059–T065, T068–T070 |
| FR-016 | T060–T070 |
| FR-017 | T011, T013, T017–T021, T025–T026, T034, T038, T054, T059, T071–T072 |
| FR-018 | T010–T012, T017–T022, T027, T042, T066–T067, T070–T071 |

| Criterio de éxito | Tareas que producen/comprueban evidencia |
| --- | --- |
| SC-001 | T016–T019, T023–T024, T026, T030, T039, T045 |
| SC-002 | T017–T018, T025, T030–T045, T046–T058, T059–T070, T075 |
| SC-003 | T046–T047, T051–T054, T058 |
| SC-004 | T008–T014, T059–T065, T068–T071 |
| SC-005 | T028, T039–T045, T060, T066–T070 |
| SC-006 | T013, T038, T040, T071–T072 |
| SC-007 | T029–T030, T043–T045, T056–T058, T068–T070, T073–T075 |

| Escenario quickstart | Tareas |
| --- | --- |
| V01 | T016–T018, T026, T029–T030 |
| V02 | T016, T031, T035, T039–T045 |
| V03 | T016, T032, T037–T045 |
| V04 | T016, T023, T026, T030, T039, T045 |
| V05 | T017, T024, T032, T036–T039, T045 |
| V06 | T047, T050–T058, T061–T065, T068–T070 |
| V07 | T047, T053–T054, T058 |
| V08 | T046, T051–T052, T054–T058 |
| V09 | T046–T047, T051–T055, T058 |
| V10 | T009, T014, T059–T065, T068, T070 |
| V11 | T008, T013, T040, T054–T055, T059, T063–T065, T070–T071 |
| V12 | T025, T028, T033, T038–T045 |
| V13 | T017–T022, T030, T071 |
| V14 | T017, T024, T030, T044, T060, T066–T067, T070 |
| V15 | T031, T034–T035, T045, T047, T053, T058 |
| V16 | T060, T066–T071 |

## Notes

No hay `.specify/extensions.yml`; no se ejecutan hooks before_tasks/after_tasks.
La generación inicial de tareas comprobó formato, dependencias y cobertura documental.
La evidencia posterior de implementación se registra en `docs/verification.md`.
