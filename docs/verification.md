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
