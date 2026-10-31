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