# Guía de uso y verificación

Actualizada el 2026-11-01. El producto implementa carga, validación, propuestas, aplicación
confirmada, comparación y exportación. Esta guía usa los scripts y recorridos existentes;
la evidencia por incremento está en [verificación](../../docs/verification.md).
**SC-007 se cierra el 2026-11-01** con la confirmación global del usuario «todo lo veo ok»
al recorrido solicitado de ocho pasos. Los E2E se mantienen como evidencia técnica separada.

## Preparar el proyecto

Ejecutar desde la raíz del repositorio en PowerShell de Windows x64. Se necesita Java 11 o
superior accesible mediante `java`; la generación registrada usó Java 17.0.8.

```powershell
java -version
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'build')
```

El bootstrap instala Node 24.22.2/npm 11.19.1 en `.tools/` y verifica su checksum. El launcher
prepara PATH y `.cache/npm` solo para el comando; no cambia las instalaciones globales. Usar
`-NpmArguments @(...)` conserva correctamente los argumentos y opciones al pasarlos a npm.
En otros sistemas se requieren esas mismas versiones; pueden usarse los scripts npm directamente,
aunque la evidencia registrada corresponde a Windows. Detalles: [toolchain](../../scripts/README.md).

Build incluye `generate:parser`: comprueba los originales y el JAR ANTLR 4.13.2, genera lexer/parser
JavaScript ESM desde copias y compila paquetes, API y Angular. Para regenerar solo el parser:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'generate:parser')
```

La preparación inicial necesita red para dependencias, JAR y navegador de pruebas. El uso normal
es local; los informes no se envían a un servicio externo. Los originales de grammar y del Excel
EBA permanecen intactos. Los artefactos generados se guardan en rutas ignoradas por Git.

## Iniciar la aplicación

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

Después de iniciar, abrir `http://127.0.0.1:3000`. Node sirve Angular y la API. Ctrl+C detiene el
proceso y termina la sesión. Para desarrollo, detener antes ese servidor y ejecutar:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'dev')
```

Abrir `http://127.0.0.1:4200`; la API utiliza el puerto 3000 y el proxy `/api`. Angular recarga
cambios del frontend. Reiniciar dev tras modificar el backend. Estos comandos son instrucciones
de arranque, no una afirmación de que haya un servidor iniciado.

## Ejemplo guiado en ocho pasos

El ejemplo no requiere editar Excel: sus reglas e importes son **100 % sintéticos**, separados de
los fixtures con reglas EBA reales. Los archivos contienen las mismas instrucciones en su hoja
Instructions. Abrir la guía y descargar archivos no importa ni aplica cambios.

1. Introducir **Nombre del conjunto** y pulsar **Crear conjunto**. En Cargar, desplegar
   **Empezar con el ejemplo guiado**; pulsar **Descargar catálogo del ejemplo** y **Descargar informe
   del ejemplo**. Cargar manualmente `ejemplo-catalogo.xlsx` como catálogo y `ejemplo-informe.xlsx`
   como informe, sin editarlos. Una carga válida sustituye los archivos del conjunto si ya existían.
2. Pulsar **Validar informes**. Inicialmente `SYNTHETIC_A` falla y `SYNTHETIC_D` pasa:
   A=11, B=5, C=7, D=22; las igualdades son A=B+C y D=A×2.
3. En **Configurar destinos de recálculo**, elegir **Izquierda** en ambas reglas y pulsar
   **Guardar configuración**. Esto todavía no modifica los hechos.
4. Pulsar **Simular recálculos**. Revisar A=12.00 y D=24.00; D usa el valor propuesto para A.
5. Seleccionar primero `SYNTHETIC_D`: aparece que falta su predecesor `SYNTHETIC_A`. Seleccionar
   A también expresamente. La clausura completa permite continuar; el sistema no añade antecesores automáticamente.
6. Revisar ambas propuestas, marcar **He revisado cada propuesta…** y pulsar **Aplicar cambios
   seleccionados**. Se revalida antes de publicar una nueva versión.
7. Comprobar antes/después: **1 pasa / 1 falla → 2 pasan / 0 fallan**. A cambia de 11 a 12.00 y
   D de 22 a 24.00; B=5 y C=7 se conservan. La versión original permanece en el historial.
8. En **Guardar informes y resultados**, elegir la versión marcada **vigente**, seleccionar
   **Informes y registro de cambios** y pulsar **Preparar y descargar ZIP**. El panel mantiene
   su selección histórica hasta cambiarla: seleccionar vigente es parte de este paso.

El ZIP actual contiene los valores 12.00 y 24.00, además del registro de cambios. Para guardar
la validación, elegir **Resultados de validación** y la ejecución correspondiente. Los dos archivos
del ejemplo se descargan por rutas autenticadas que gestiona la aplicación:
`GET /api/v1/templates/guided-catalog` y `GET /api/v1/templates/guided-report` para los dos ejemplos.

Para reimportar `report.zip`, extraer los XLSX de reports y cargarlos con el catálogo original
por separado. El log no se carga como informe ni restaura recibos en el nuevo conjunto. Cerrar
el conjunto elimina sus temporales del servidor; los ZIP guardados por el usuario permanecen.

## Pruebas reproducibles

Detener el servidor manual antes de E2E o benchmark: sus pruebas arrancan procesos propios y
necesitan el puerto 3000 libre. Preparar los fixtures y Chromium en la ruta que utiliza el proyecto:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'fixtures')
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache/playwright'
.\scripts\run-with-toolchain.ps1 -NpmArguments @('exec', '--', 'playwright', 'install', 'chromium')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'typecheck')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'build')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'test:unit')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'test:integration')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'test:contract')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'test:e2e')
```

`test:unit` incluye motor y Angular; integración comprueba adaptadores/workers y contratos comprueba
HTTP. Playwright utiliza Chromium y el servidor de producción compilado, sin reutilizar uno
existente. `npm test` agrupa unit/integration/contract, pero no E2E ni benchmark.

`fixtures` comprueba el hash del Excel EBA original y genera `tests/fixtures/generated/eba-subset.xlsx`,
`report-42.xlsx` y `report-40.xlsx`, además de los manifiestos. Los informes son sintéticos; las
expresiones y precondiciones de G113/G169/G170 conservan su procedencia real. Se carga un informe
cada vez con el subconjunto, según módulo/fecha. El catálogo EBA completo supera 500 filas y no
es el archivo de carga de estos recorridos.

## Escenarios V01–V16 comprobados

Esta tabla resume pruebas automatizadas registradas, no ensayos humanos. Los checkpoints y sus
métodos están en [verificación](../../docs/verification.md): las secciones son históricas y muestran
qué estaba pendiente en cada incremento. No se suman sus conteos como si fueran pruebas distintas.

| ID | Comprobación y resultado registrado | Evidencia |
| --- | --- | --- |
| V01 | Carga válida; un hecho duplicado rechaza la nueva carga y conserva la versión anterior. | US1 T016–T030. |
| V02 | G169/COREP_OF_4.2 con indicadores explícitos: contacto de intervalos pasa y fuera del borde falla. | US2 T031–T045. |
| V03 | G113/COREP_OF_4.0: expansión por dos hojas, sumandos explicados y fallo aislado de una hoja. | US2 T031–T045. |
| V04 | Variantes G169/G170, vigencias, módulos, duplicados y permutación de filas sin elección por orden. | US1 y US2. |
| V05 | Cero, null explícito/implícito, isnull/nvl/default y agregados vacíos conservan su semántica y diagnóstico. | Núcleo US2 y E2E US2. |
| V06 | Cadena 11/5/7/22 → propuestas 12/24, selección explícita de antecesores y aplicación con versión original conservada. | US3 y US4; ejemplo guiado. |
| V07 | 1/3 a precisión 2 produce 0.33 y su consumidor 0.99 con intervalos; igualdad puntual rechaza ese candidato. | US3 T046–T058 y núcleo. |
| V08 | Ciclo, autociclo y consumidores bloqueados se distinguen; la rama independiente continúa. | US3 T046–T058. |
| V09 | Productores en conflicto aunque coincidan valores, bloqueo sin fallback y precondición false→true tras productor. | Núcleo y E2E US3. |
| V10 | Base obsoleta rechazada; replay idempotente con ETag anterior no publica una segunda versión. | Contratos US2/US4 y E2E US4. |
| V11 | Cancelación/timeout antes de publicar conservan el snapshot; cancelar después no deshace lo publicado. | US3/US4 y T071, con workers reales y plazos de prueba dirigidos. |
| V12 | Sintaxis inválida, construcciones no admitidas y división por cero no aparecen como pasa. | Núcleo y E2E US2. |
| V13 | Fórmulas, contenido activo y ZIP/XML adversos se rechazan sin sustituir el conjunto vigente. | Importación US1 y recursos T071. |
| V14 | Exportación/reimportación conserva valor exacto, precisión, null/cero, códigos y contextos; Facts numérico Excel se rechaza. | US1, exportadores T066–T067 y checkpoint US4. |
| V15 | Racionales exactos, intervalos negativos/bordes, división puntual y half-even conservan resultados del perfil local. | Núcleo US2/US3 y E2E. |
| V16 | ZIP de resultados/informes/histórico, trazabilidad acumulada, reimportación y cierre conservan originales y descargas guardadas. | T066–T070; recorrido guiado técnico. |

Los casos de cuotas usan tamaños y plazos dirigidos para provocar rechazo; no representan un
benchmark. Las comprobaciones técnicas de teclado, foco, contraste y recorrido guiado se registran
en T073. La aceptación global del usuario se registra por separado al final de esta guía;
no se atribuye a esas comprobaciones automáticas.

## Repetir el benchmark SC-006

Usar una carpeta nueva para cada referencia; prepare se niega a sobrescribir una referencia ya
congelada. Tener build y Chromium preparados como arriba. No ejecutar otras pruebas/builds del
proyecto durante la cohorte:

```powershell
$benchmarkDirectory = Join-Path '.cache/benchmark' ('manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'prepare', $benchmarkDirectory)
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'pilot', $benchmarkDirectory)
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'cohort', $benchmarkDirectory)
```

Prepare fija equipo, versiones, protocolo y hashes; pilot se conserva aparte; cohort ejecuta diez
mediciones seriales sin reintentos. Cada ejecución usa API/contexto Chromium nuevos y audita todos
los resultados después del cronómetro. Detalles y evidencia: [performance.md](../../docs/performance.md).

La cohorte registrada usa 500 reglas sintéticas distintas/admitidas y 100.000 hechos, en Ryzen 5
3600X/32 GiB, Windows 11, Node 24.22.2 y Chromium 156.0.8078.4. **10/10 ≤30 segundos**, entre
13,511 y 16,320 segundos, desde fin de carga hasta ejecución completa y primera página visible;
la carga está excluida. Los 250 pasa/250 falla son intencionados. Este resultado se limita al equipo
y carga medidos; no se extrapola a cualquier expresión ni sustituye SC-007.

## Perfil, límites y conservación

El perfil `ce-dpmxl-0.9-closed-v1` usa racionales exactos, precisión declarada, nulos e indicadores
explícitos. Reconocer sintaxis ANTLR no implica admitir toda la semántica EBA. El perfil documenta
la diferencia de multiplicación/división de intervalos frente a fórmulas inconsistentes observadas
en el PDF v0.9; no declara conformidad literal completa. Véase [lenguaje](contracts/language-profile.md).

| Recurso | Límite de producto |
| --- | --- |
| Catálogo / informes / hechos / coordenadas | 500 filas / 20 archivos / 100.000 / 100.000. |
| Carga XLSX | 10 MiB por archivo; 50 MiB por lote; 100 MiB descomprimidos, 64 MiB por entrada ZIP. |
| Trabajo / recepción | Una tarea activa; 60 s de trabajo; 120 s para recepción de archivos. |
| Sesión | 20 snapshots; 512 MiB de estado canónico y 512 MiB de archivos propios, por separado. |
| Paquete de exportación | Suma de contenidos y ZIP final ≤100 MiB; informes ≤10 MiB cada uno. |
| Resultados/logs | Cada JSON/XLSX ≤64 MiB; guard XML estimado de 64 MiB sólo para results.xlsx/changes.xlsx. |

Un report ZIP reimportable respeta también 50 MiB comprimidos y 100 MiB expandidos junto con el
catálogo original. Los informes se escriben incrementalmente; el heap configurado del worker
(256 MiB de generación antigua), el RSS del proceso y la cuota de estado son métricas distintas.
Las cuotas adicionales y errores se detallan en [Excel](contracts/workbook.md), [HTTP](contracts/http-api.md)
y [modelo](data-model.md); la API las comunica en capabilities.

Las lecturas muestran archivo/hoja/celda, valor original, precisión e indicadores. Los hechos
calculados señalan su derivación; un no-op conserva texto y procedencia y se audita changed=false.
La sesión se recupera al refrescar, pero no tras cerrar el conjunto o reiniciar el servidor.
Guardar los paquetes conserva los resultados fuera de esa sesión; no hay persistencia multiusuario.

## SC-007: aceptación global del usuario

El 2026-11-01, ante la solicitud de aceptación del recorrido de ocho pasos con los archivos
descargados, el usuario respondió «todo lo veo ok». Esta confirmación global, sin incidencias
comunicadas, cierra SC-007 y T073. No consta observación directa, confirmación individual de
cada paso, tiempo de ejecución ni información sobre la ayuda recibida.

Los E2E y las comprobaciones de accesibilidad siguen siendo evidencia técnica separada.
El [registro de verificación](../../docs/verification.md) conserva los checkpoints anteriores
y este cierre final; las tareas quedan completadas (75/75).
