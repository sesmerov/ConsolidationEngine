# Verificación de implementación

Fecha: 2026-10-31. Este registro distingue comprobaciones realizadas de funcionalidades pendientes.

## Setup T001–T006

Comprobado en Windows con Node 24.22.2/npm 11.19.1 aislados en `.tools/` y Java 17.0.8.
Las instalaciones globales de Node/npm no se han modificado.

Los comandos siguientes se ejecutaron mediante `scripts/run-with-toolchain.ps1`:

- `ci --offline=false --no-fund`: correcto con el lockfile final.
- `run build`: paquetes, API y Angular compilados correctamente.
- `run typecheck`: correcto.
- `run test:integration`: 3 pruebas correctas en 2 archivos.
- `audit --json --offline=false`: 0 vulnerabilidades conocidas en ese momento.

La integración comprueba dos generaciones ANTLR idénticas, hashes de las gramáticas originales,
EOF, una regla real, `default:null` y rechazo de errores léxicos/sintácticos. No prueba aún
la semántica de evaluación. La API inicial arrancó en loopback y respondió 200 en health.

Las otras dos pruebas comprueban el consumidor real `@fastify/static` en los modos wildcard y
enumeración, incluido el rechazo explícito de archivos ocultos. Se añadió un override acotado
de glob/minimatch para resolver tres avisos moderados; su motivo y límites están documentados
en [scripts/README.md](../scripts/README.md). Un audit sin hallazgos no garantiza ausencia de fallos.

Se precisó el contrato de lenguaje: el parser EBA admite `default:null`, pero no un literal
`null` independiente. No se alteraron las gramáticas para ampliar esa sintaxis.



## Foundation T007–T015

Comprobado con el mismo toolchain aislado:

- `run test:foundation`: 20 pruebas correctas en 2 suites; incluye build de contratos, motor y API.
- `run test --workspace @ce/web -- --watch=false`: 3 pruebas Angular correctas.
- `run typecheck`: correcto.
- `run build --workspace @ce/web`: compilación de producción correcta.
- `git diff --check`: sin errores de whitespace.

La API se ejercitó mediante Fastify inject. Las carreras usan workers controlados; una prueba
adicional ejecuta un worker_thread real y verifica que trabaja fuera del hilo principal.
No son pruebas de evaluación regulatoria ni una medición de rendimiento.

Los casos cubren snapshots inmutables, cuota sin alterar la versión vigente, un único trabajo,
cancelación antes/después de publicación, timeout, versión obsoleta, límite de tiempo comprobado
tras preparar el candidato, cierre con trabajo activo y cancelación concurrente con cierre.
También comprueban Host/Origin/token, esquemas cerrados, If-Match y replay idempotente con ETag antiguo.
La limpieza verifica el marcador de propiedad; marcador ausente/alterado impide borrar, y un archivo
original exterior permanece intacto. Los errores inesperados no exponen su ruta ni su mensaje interno.

Bootstrap incorpora `activeWorkspaceId` opcional: la interfaz puede recuperar el conjunto después
de refrescar sin guardar token ni datos en almacenamiento del navegador. Las pruebas Angular
comprueban esa restauración, cancelación y que respuestas tardías no repueblen una sesión cerrada.

Pendientes: importación, evaluación, recálculos, contratos de negocio, E2E y rendimiento.
No se han declarado suites vacías como superadas.
## US1 T016–T030

Checkpoint: 218 pruebas correctas (85 engine, 5 Angular, 106 integración, 19 contrato y 3 E2E).
Los comandos se ejecutaron mediante `scripts/run-with-toolchain.ps1`: `run typecheck`,
`run build:api`, `run build --workspace @ce/web`, `run test` y `run test:e2e`.
Typecheck/build y `git diff --check` correctos. No se añadieron dependencias ni se repitió audit
sin cambios del árbol de dependencias.

Los E2E usan Chromium 156.0.8078.4 (build1248), instalado únicamente en `.cache/playwright`,
contra el servidor Node de producción y Angular compilado. No sustituyen importador, parser
ni workers por mocks. Comprueban descarga y carga, cero/null/ausencia, refresco de sesión,
reglas inválidas/duplicadas, carga fallida que conserva versión, archivos estáticos y protección API.
La captura `.cache/import-ui.png` fue inspeccionada; contiene sólo el conjunto SYNTHETIC.

La suite de importación completa ejecuta 75 casos, incluido un worker real. Comprueba raw XML,
fechas 1900/1904/serial60, precisión textual, ZIP/XML adversos, fórmulas/componentes activos,
cuotas y atomicidad. Otros casos comprueban catálogo/variantes y composición de informes.
Los 11 contratos de imports incluyen recepción lenta/simultánea, cierre de workspace/servidor
durante subida, cancelación y limpieza, replay con boundary distinto y ETag antiguo, y conflicto.
La plantilla tiene formato Texto real en su XML y pasa roundtrip por el importador.

Se corrigieron dos discrepancias descubiertas durante la integración: NULL de fecha sólo es
válido como texto, y los esquemas aceptan los mismos códigos que el lexer/importador. Los errores
del parser conservan la columna real incluso con cabeceras reordenadas; los fallos de importación
indican archivo saneado, hoja y celda sin exponer rutas internas.

Las precondiciones reales usan filing indicators. Se precisó el contrato con declaraciones
explícitas en Contexts, apoyadas en las fuentes de research R8, sin inferirlas de los hechos ni
alterar las precondiciones. T025 incluye AST filing_indicator; su evaluación aún corresponde a US2.
El parser rechaza errores léxicos/sintácticos aunque ANTLR recupere un árbol, scripts, asignaciones,
construcciones fuera del perfil y entradas que exceden límites. Nunca se envía AST por HTTP.

Hashes originales comprobados antes y después del E2E:

- Excel EBA: `36636afe42b2ef2247822a31ad710afe1128b5b65a250b657e1f20d5a75bba79`.
- Lexer: `dda7b8de2c8e1430448cad7a342c712d52ba1b5bd533730b4eafede02bb5805a`.
- Parser: `30fd37bddfdd356294801e53c7cf4864547a71d0ed13d1b884a3d9c6b6d884b4`.

Esto acredita carga/análisis y su recorrido de usuario. Evaluación, recálculos, aplicación,
exportación de resultados y medición de rendimiento siguen pendientes.

## US2 — comprobaciones del núcleo T031–T039

Antes de integrar la API, el motor superó 353 pruebas: parser, racionales/intervalos,
primitivas de valores y unidades, resolución, evaluación y ejecuciones de validación.
Build y typecheck de contratos y motor correctos. Las pruebas de contrato/UI T033 se
prepararon antes de implementar sus rutas/componentes; no se contaron como pruebas superadas.

Los casos numéricos conservan racionales exactos, distinguen límites de recursos de división
por cero y comprueban intervalos con extremos negativos, contacto y denominadores que contienen
cero. No se usa Number para importes ni una tolerancia global. La resolución comprueba ámbitos
entre tablas, rangos sobre coordenadas existentes, hojas finitas, ambigüedad e identidades estables.

Las ejecuciones comprueban G113/G169 con hechos sintéticos, vigencias, precondiciones e indicadores,
variantes equivalentes/conflictivas y conciliación de registros frente a instancias reales.
Una ejecución técnicamente completa puede contener reglas fallidas o con errores aritméticos;
una interrupción o límite global la deja incompleta. Los resultados serializados no contienen
AST ni BigInt. Se concretaron en el perfil la unidad de nvl con literales y el contexto de lectura
de indicadores para crossModule; no se afirma compatibilidad con todo el lenguaje EBA.

Al integrar FR-009 se añadieron las lecturas individuales originales (`factReads`) con presencia,
precisión y procedencia. Un null sustituido por default conserva su ausencia original en la traza.
También se conserva la identidad estructural de una instancia soportada cuando su precondición
sea false/null/unknown, sin ejecutar el cuerpo. Esto permite reevaluar la condición durante una
futura simulación. Cuatro fallos se reprodujeron antes de corregir estos casos; la suite del run
pasó después sus 33 pruebas. No se asignan instancias ficticias a cuerpos no soportados.

## US2 — checkpoint T031–T045

527 pruebas correctas: 358 engine, 9 Angular, 119 integración, 34 contrato y 7 E2E.
Typecheck global, build API y build Angular de producción correctos. Los comandos se ejecutaron
con el toolchain aislado mediante los scripts existentes y Vitest/Playwright fijados. La suite
engine se ejecutó por separado; tras el último arreglo de coordinación de API se repitieron
build/typecheck API e integración/contratos, sin repetir las suites no afectadas.

La API publica un run desde la aceptación y lo conserva como incomplete si el trabajo falla,
se cancela o excede límites. La aceptación rechazada por cuota no deja un run huérfano. Las páginas
y filtros históricos permanecen ligados a la versión evaluada; la severidad no se confunde con
el estado. Se comprobó también el reintento simultáneo de una misma clave idempotente durante
la aceptación asíncrona, además del replay con ETag antiguo.

La descarga results es un ZIP con results.json exacto y results.xlsx literal. Diez pruebas de
integración independientes verifican lectura con yauzl, CRC/tamaños/hash, JSON con 1/3 y más de
15 dígitos, nulls, texto XLSX mediante lector y SAX, límites UTF-8/preconteo, cancelación y cuotas
de archivos con reservas. Las reservas no se cuentan dos veces; tras una descarga real el
retenido coincide con el tamaño del ZIP y no quedan reservas. El guard de carga XML previo al
writer está publicado por separado del límite de tamaño serializado. No se publica salida parcial.

Se reprodujo y corrigió una carrera de cierre durante la preparación asíncrona del export,
antes de registrar el Job. Dos pruebas controladas comprueban cierre de workspace y servidor:
se espera a transferir o limpiar la preparación antes de borrar la carpeta propia, sin archivos
huérfanos. La respuesta rechazada conserva la clasificación WORKSPACE_BUSY.

Los siete E2E usan Chromium y el servidor de producción reales, sin sustituir parser/importador
ni workers. Los cuatro nuevos recorren V02/V03/V04/V05/V12/V15: G169 en contacto de intervalos y
fuera del borde, G113 con dos hojas y sumandos explicados, null explícito/implícito/cero, falta de
soporte, sintaxis y división por cero, 1/3 exacto, descarga e históricos y permutación de filas.
El primer recorrido detectó un error de fixture (`not isnull(...)`); se corrigió a la forma
admitida por la gramática original (`not(isnull(...))`), sin cambiar el lenguaje del producto.

La captura `.cache/validation-ui.png` fue inspeccionada: conteos coherentes, detalle legible,
advertencia separada de fallo, valores originales/precisión/fuentes e indicadores visibles.
Los originales Excel/lexer/parser mantienen los hashes registrados en US1. No se añadieron
dependencias. `git diff --check` correcto.

US1+US2 acreditan carga, validación, explicación y exportación de resultados. Propuestas,
aplicación de recálculos y medición de rendimiento todavía corresponden a fases posteriores.

## US3 — preparación T046–T049

Las pruebas se prepararon antes de sus módulos: T046 define 23 casos de grafo, pero inicialmente
falló al importar read-set (0 aserciones ejecutadas); T047 descubre 47 casos, con 2 prerrequisitos
de fixtures correctos y 45 sin ejecutar por los hooks de módulos todavía ausentes. T048 ejecutó
13 contratos HTTP que fallaron por 404 de rutas inexistentes, usando importación/validación reales.
Estas ejecuciones no acreditan aún recálculos. T049 compiló los DTO y superó 2 pruebas reales AJV
de sus esquemas, incluidos racionales, booleanos y rechazo de campos ajenos.

## US3 — núcleo y direcciones T050–T054/T056

El motor completo pasa 470 pruebas en 8 archivos tras integrar simulación: 25 de grafo y 87 de
cuantización/candidatos/simulación, además de las 358 anteriores, sin omisiones. Build/typecheck
de contratos y motor correctos. Kahn usa cola estable y Tarjan iterativo identifica SCC, autociclos
y descendientes; los casos incluyen 20.000 nodos. Los conflictos preceden al ordenamiento.

Las simulaciones comprueban A12/D24, consumo de 0.33 para obtener 0.99, precondiciones que cambian,
cuotas compartidas, cancelación tras un candidato sin resultado parcial y ramas independientes
sin fallback al valor anterior. UUIDv5 usa el procedimiento estándar y supera el vector RFC 9562;
la fecha de creación de preview no participa en la identidad de las propuestas.

T050 verifica direcciones con publicación atómica, rechazo por cuota sin mutación, autorreferencia
del RHS y tratamiento separado de la precondición. GET results aporta elegibilidad estructural y
la configuración completa del snapshot. La interfaz T056 supera 7 pruebas nuevas (16 Angular
totales): conserva elecciones fuera de filtros/páginas y tras recrearse, envía reemplazo completo,
mantiene el histórico y bloquea guardado ante 412 incluso si falla refrescar la sesión.

## US3 — checkpoint T046–T058

701 pruebas correctas sin omisiones: 474 engine, 119 integración, 70 contrato, 26 Angular y
12 E2E. Build API/Angular, typecheck completo y `git diff --check` correctos. No cambiaron
dependencias. Se usó el mismo toolchain aislado y Chromium de los incrementos anteriores.

El worker de preview publica únicamente un bundle completo. La selección calcula una clausura
iterativa (probada con 20.000 nodos) y no acepta antecesores por el usuario. Cuotas/cancelación
no publican una preview ready parcial. El descarte es atómico, exige CAS y ausencia de trabajo
activo, y conserva los estados históricos; un rechazo por cuota conserva registros y bytes.
Los casos applied/obsolete del contrato de descarte se preparan como fixtures de estado: no
constituyen evidencia de aplicación real, que pertenece a US4.

Se completó la recuperación de historial: GET runs/previews devuelve resúmenes paginados
explícitos, sin AST, datos completos ni rutas. El cursor HMAC queda ligado a recurso, filtros,
sesión y revisión de la colección. La interfaz recupera referencias tras refrescar, sin
localStorage. Las 13 pruebas nuevas de historial/descarte fallaron inicialmente por 404 y
pasaron después con las rutas reales. Los fallos de restauración de UI se reprodujeron antes
de incorporar las consultas, y se conserva la selección a través de filtros/páginas.

Durante la integración se reprodujeron cuatro problemas de orden: los IDs dependientes del run
o preview alteraban el orden visible, y el listado de propuestas podía colocar al consumidor
antes que a su productor. La corrección usa una clave semántica compartida con la API, conserva
los IDs y enumera las propuestas según Kahn, seguidas de bloqueadas estáticas. Antecesores y
causas se ordenan por dirección antes de convertirlos a UUID. Los 124 casos afectados pasaron
tras la corrección; después se ejecutó la suite completa del motor (474).

Los cinco E2E nuevos verifican V06 con 11/5/7/22 → 12/24, V07 con 0.33/0.99 y rechazo puntual,
V08 con ciclo/autociclo/descendiente/rama independiente, V09 con conflicto de valores iguales
y precondición false→true, además de cancelación real, descarte y recarga del navegador.
La primera prueba visual de V07 necesitó acotar un selector a su encabezado porque el nombre
también aparecía como predecesor; los valores/bloqueos API ya eran correctos. La suite completa
de 12 E2E pasó después en 58,4 segundos; esto no es el benchmark de SC-006.

La captura `.cache/preview-ui.png` fue inspeccionada: productor 12 antes de consumidor 24,
predecesores con código/coordenada, valores y precisión visibles y selección explícita sin
modificar hechos. Los originales Excel/lexer/parser mantienen los tres hashes registrados.
Aplicación, comparación, exportación de informes y rendimiento siguen pendientes de US4/polish.

## US4 — preparación y candidato T059–T063

Las pruebas de atomicidad se prepararon antes de la ruta: 1 prerrequisito real correcto y
18 fallos por 404; se añadió después el caso de identidad compartida en un no-op, también
reproducido contra la ruta ausente. La comparación preparó 1 prerrequisito correcto y 3 fallos
por 404. Los 10 casos Angular quedaron sin ejecutar por ausencia de los componentes.
Los 12 contratos de aplicación/exportación dieron 11 fallos por funcionalidades pendientes y
1 rechazo de esquema correcto, que por sí solo no acreditaba exportación de informes.

T062 compiló contratos, motor y API y superó 7 pruebas de esquemas. T063 superó 511 pruebas
del motor y transporte real del worker, incluidas 31 directas de aplicación y 6 de worker.
Build/typechecks correctos. El candidato devuelve parches y validaciones antes/después con
presupuesto compartido, sin publicar registros. Un límite alcanzado durante la validación
posterior impide devolver el candidato completo.

Los destinos sin cambio semántico conservan referencia, texto original y procedencia previa;
los modificados incorporan derivation, visible también en lecturas y previews posteriores.
La capa HTTP de publicación y los exportadores se verifican en los siguientes checkpoints.

## US4 — publicación, historial e interfaz T064–T065/T068

La integración de publicación e historial supera 156 pruebas en 13 archivos. Los contratos y
esquemas existentes pasan 75 casos, más los 4 de aplicación de applications-exports; los 8 casos
de exportación de esa suite siguen pendientes de T066/T067 y no se cuentan como verificados.
Build y typecheck de API correctos. Las 44 pruebas focalizadas de atomicidad, comparación y jobs
incluyen cuota, limpieza del intento retenido y comprobación final de versión/preview/cancelación.

La publicación reconstruye copy-on-write en el hilo principal después del transporte real del
worker: comparte los hechos sin cambios y publica conjuntamente snapshot, ambas validaciones,
recibo, cambios y estados históricos. Un no-op conserva texto y derivación anteriores, queda
auditado como changed:false y no incrementa el número de hechos modificados. El intento privado
de operación se contabiliza en la cuota y se elimina en todas las transiciones terminales.

T068 supera las 41 pruebas Angular, typecheck y build de producción. La confirmación muestra el
conjunto completo, incluidos seleccionados fuera de página/filtro; una respuesta incierta conserva
cuerpo, clave idempotente y ETag originales. El historial recupera recibo y comparación paginada
mediante appliedReceiptId, distingue propuestas aceptadas de valores modificados y muestra la
procedencia calculada. Cancelar después del commit conserva el estado aplicado y su nueva versión.
Estas pruebas de componentes todavía no sustituyen el recorrido Chromium completo de T070.

La preparación de exportación/reimportación detectó que import enviaba innecesariamente el
snapshot anterior al worker. Tres pruebas fallaron primero por esa retención; después de excluir
el snapshot del transporte pasan 14 casos (3 de transporte/reemplazo/CAS y 11 contratos de carga).
La versión base sigue en el Job y el control de publicación permanece en el hilo principal:
fallo o versión competidora conservan el original. Esto reduce una copia, pero todavía no acredita
la carga de 100.000 hechos ni el objetivo de rendimiento SC-006.

## US4 — exportadores T066

104 pruebas focalizadas correctas: 18 de report-export y 86 de results-export, file-budget e
xlsx-import. Builds de contratos/API y typecheck API correctos. El roundtrip pequeño usa lectores
reales y conserva múltiples archivos, contextos vacíos, booleanos, null/ausencia/cero, códigos y
valores de más de 15 dígitos. Se comprueban partición por fuente, manifiesto, historial ancestral,
no-ops, guardas y cuotas; esto todavía no sustituye las rutas T067 ni el navegador T070.

El escritor incremental se comparte entre report, changes y results; sólo results/changes conservan
el guard conservador de carga XML estimada de 64 MiB. La escritura de informes mide los bytes
reales comprimidos/expandidos y conserva los límites existentes. Dos fallos se reprodujeron antes
de corregir ST_Xstring: escapes literales solapados y results.xlsx que convertía `_x0041_` en `A`.
La decodificación de entrada se realiza una sola vez; se preservan CR, espacios y Unicode.

Prueba de capacidad de exportación (no SC-006): worker real con heap configurado de 256 MiB,
100.000 coordenadas y 100.000 hechos. XLSX 4.881.114 bytes, expansión 77.528.057 bytes más catálogo
6.923, ZIP final 4.888.418 bytes; 2.896 ms y máximo de heap muestreado 166.355.968 bytes. La muestra
de heap no mide un pico absoluto ni limita RSS. Evidencia local en `.cache/report-capacity-NrjYkz/`.

La reimportación del mismo archivo falló realmente con ERR_WORKER_OUT_OF_MEMORY a los 11.674 ms
en el worker de 256 MiB. Sólo completó el catálogo; RSS máximo del proceso muestreado 531.243.008
bytes, distinto del heap. Evidencia en `.cache/import-volume-probe/import-measurement.json`.
La retención del lector queda en corrección: no se acredita todavía capacidad de carga completa
ni el benchmark y no se cerrará US4 con ese fallo sin resolver.

## US4 — integración de exportación T067

21 contratos de applications/results, 6 pruebas de comparación y 6 de ciclo de vida de exportación
correctas, con API construida. Se comprueba exportar resultados posteriores a aplicar, incluidos
fallos/errores restantes y derivation, así como informes originales/históricos y su log acumulado.
El payload del worker de informe excluye snapshot completo, AST y runs. La aceptación reserva
200 MiB para los N+3 temporales; tras completar sólo se conserva el ZIP. Replay con CAS antiguo,
cancelación, rechazo de cuota y razones públicas saneadas conservan el estado y limpian reservas.

Se corrigieron dos expectativas defectuosas de test sin cambiar los datos: la coordenada de gran
precisión es r0240, y `kind:catalog` en metadatos SourceFile no constituye un catálogo AST filtrado.
La comparación profunda del roundtrip ya era correcta. La prueba de volumen del lector sigue
separada de estos casos y pendiente de su corrección.

T069 supera las 46 pruebas Angular, build y typecheck de frontend. El panel permite elegir una
versión actual/histórica y su informe o una ejecución concreta para resultados, conserva los
reintentos y descarta respuestas recibidas después del cierre. La selección sólo vive en memoria;
el cierre comunica qué temporales se eliminan y que las descargas guardadas permanecen.

## US4 — corrección de memoria del lector

El preflight aislado reprodujo el OOM antes de leer el informe. La corrección procesa XML por
chunks, conserva sólo metadatos en informes y entrega filas al mismo normalizador de ce-report.
El catálogo mantiene el lector raw/read-excel-file; el informe evita retener todas las celdas y
materializar una segunda matriz. Los 41 casos ST_Xstring pasan en ambas rutas, incluidos 13 que
comparan tipo, lexema y texto completos y comprueban que el modo metadata no retiene A2.

El mismo archivo de 100.000 coordenadas/hechos completa ahora importación, transporte del snapshot
y publicación mediante operation-worker/import.worker y WorkspaceStore reales. Snapshot recibido
a los 23.205 ms; publicación completa a los 28.551 ms; proceso total 29.747 ms y estado canónico
80.692.106 bytes, por debajo de 512 MiB. No se modificaron canonicalHash, cuotas ni límites.
Evidencia local: `.cache/import-volume-probe/import-transport-measurement.json`.

La configuración limita old generation a 256 MiB, no el heap total ni el RSS: el heap total usado
observado alcanzó 292.495.616 bytes incluyendo young generation. RSS observado en la publicación
734.412.800 bytes; el muestreo periódico sólo captó 558.788.608 durante el bloqueo síncrono. Son
mediciones distintas de los bytes canónicos de sesión y se conservan separadas en la evidencia.
Este caso usa el catálogo reducido de fixtures, por lo que aún no acredita SC-006 de 500 reglas.

## US4 — checkpoint T059–T070

893 pruebas correctas sin omisiones: 505 engine, 241 integración (19 archivos), 87 contrato
(10 archivos), 46 Angular (8 archivos) y 14 Chromium (4 archivos). Las 505 del motor se conservan
del checkpoint T063, sin cambios posteriores del motor; sus 6 pruebas de worker ya están dentro
de integración y no se cuentan dos veces. Se ejecutaron completas integración, contratos y E2E
tras estabilizar el lector. Typecheck raíz, build API/Angular y `git diff --check` correctos.
Los esquemas declaran type:object en sus subschemas y ya no emiten los warnings AJV observados.

Los dos E2E nuevos usan servidor de producción y Chromium reales: aplican 4 propuestas
(12/24/0.33/boolean), conservan fail/error restantes, comprueban replay con ETag antiguo sin
segunda versión y cancelación antes/después de publicar, recuperan la comparación tras recargar,
exportan informe/resultados/histórico y reimportan exactamente precisión, null, cero y códigos.
El cierre elimina temporales y conserva la descarga guardada. Dos fallos iniciales pertenecían
al test: selector ambiguo y edición de direcciones sin validar antes la nueva base; se corrigieron
sin alterar las expectativas de negocio. Los tres originales mantienen los hashes registrados.

Se inspeccionó `.cache/apply-export-ui.png` (137.368 bytes): resumen pasa 4→7, falla 4→1 y error
1→1, detalle 11→12.00, precisión/procedencia visibles y valor calculado diferenciado del Excel
original. Quedan contrastes, disposición y recorrido de accesibilidad para T073, además de las
comprobaciones de recursos T071 y el benchmark real T072. US4 no acredita todavía SC-006/SC-007.

## T071 — recursos y superficie local

10 pruebas nuevas (4 resource-lifecycle, 6 local-surface) y 40 regresiones correctas: 50/50 en
7 archivos. Build/typecheck API correctos. Los casos de CPU/cancelación/timeout/cierre utilizan
workers Node reales con carga sintética y plazos de prueba, observados por una factory; el caso
de error/stdout/stderr usa la factory de producción. Los límites configurados no se aumentaron.
IdempotencyStore y WorkspaceStore son reales; las peticiones usan Fastify.inject y los errores
inyectados son sintéticos. No se presentan esos datos como integración con informes privados.

Se comprueban acumulación de caché, liberación tras cierre, token nuevo al reiniciar y ausencia
de secretos/rutas en errores y logs. Sesión vecina, original y descarga guardada conservan hashes.
Un JSON superior al bodyLimit de 1 MiB devuelve 413 UPLOAD_LIMIT público; no requirió corregir
el handler. El único cambio de producto corrige una descripción de capabilities, que afirmaba
erróneamente aplicar la estimación XML de 64 MiB a informes: ahora la distingue de sus bytes reales.
Esa incoherencia falló primero y pasó después del cambio; no cambiaron las cuotas.
