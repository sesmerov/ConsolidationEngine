# Toolchain y comandos reproducibles

La verificación registrada corresponde a Windows x64. Desde la raíz del repositorio, en PowerShell,
con Java 11 o superior accesible mediante `java`:

```powershell
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'build')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

Después de iniciar, abrir `http://127.0.0.1:3000`. Ctrl+C detiene el proceso. Para desarrollo,
detener antes el servidor anterior y usar:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'dev')
```

Dev compila API/paquetes y arranca Node en `127.0.0.1:3000` y Angular en `127.0.0.1:4200`, con
proxy `/api`. Angular recarga el frontend; los cambios del backend requieren reiniciar el comando.
Start ejecuta la API compilada, que sirve también el build de Angular.

El bootstrap descarga Node 24.22.2/npm 11.19.1 en `.tools/`, verifica SHA-256 antes de extraer y no
modifica instalaciones globales. El launcher comprueba ambas versiones, prepara PATH solo durante
el comando y utiliza `.cache/npm`; restaura después el entorno. El pin/checksum están en
[node-toolchain.json](node-toolchain.json), con fuente oficial
[SHASUMS256.txt](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt).

Usar siempre `-NpmArguments @(...)` en estos ejemplos de PowerShell; cada argumento de npm ocupa
un elemento. Por ejemplo, un comando dirigido a un workspace es:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'build', '--workspace', '@ce/web')
```

En otros sistemas se necesitan las mismas versiones de Node/npm y se pueden invocar los scripts
con `npm run ...`; el bootstrap de este repositorio es específico de Windows x64. No se declara
verificación del producto en otros sistemas.

## Generación ANTLR

Build incluye generate:parser. Para ejecutarlo por separado:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'generate:parser')
```

ANTLR utiliza Java 11+; la generación registrada usó Java 17.0.8. El script descarga el
[JAR oficial 4.13.2](https://www.antlr.org/download/antlr-4.13.2-complete.jar) si falta, comprueba
el SHA-256 de [antlr-toolchain.json](antlr-toolchain.json) y los hashes de las gramáticas originales.
Copia sus bytes a `.cache/antlr-input/` con nombres compatibles y genera lexer antes que parser,
con `-visitor`, `-no-listener` y `-lib`. El runtime npm también es 4.13.2.

Los archivos y el manifiesto de generación se guardan en `packages/engine/src/generated/`, ignorado
por Git. No se editan los originales. La integración comprueba reproducibilidad de generación y
sintaxis real, incluidos errores de lexer/parser. La descarga inicial requiere red.

## Fixtures, navegador y pruebas

El ejemplo guiado de la UI se genera en la aplicación y no necesita fixtures de tests. Para las
suites, generar el subconjunto EBA y los informes sintéticos y preparar Chromium:

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

El generador de fixtures comprueba el hash del Excel EBA original antes de extraer filas; no lo
modifica. Los datos de informes son sintéticos. Las suites no aceptan un directorio vacío como éxito.

| Script | Alcance |
| --- | --- |
| build | Generación ANTLR, contratos/motor, API y Angular. |
| build:api | Contratos, motor y API; no construye Angular ni regenera por sí solo ANTLR. |
| typecheck | Compila paquetes y comprueba tipos API/Angular. |
| test:unit | Motor y componentes Angular; sin modo watch. |
| test:integration | Adaptadores, workers, almacenamiento y demás integraciones. |
| test:contract | Contratos HTTP. |
| test:e2e | Chromium contra API/Angular de producción compilados. |
| test | Unit + integration + contract; E2E y benchmark se ejecutan aparte. |

E2E arranca su servidor y no reutiliza uno existente: detener antes start/dev y liberar el puerto
3000. Playwright y el benchmark buscan Chromium en `.cache/playwright`; instalarlo en otra caché
no prepara esa ruta. Los scripts no publican un despliegue ni convierten E2E en un ensayo humano.

## Benchmark

Con build y Chromium preparados, usar una referencia nueva y ejecutar las etapas por separado:

```powershell
$benchmarkDirectory = Join-Path '.cache/benchmark' ('manual-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'prepare', $benchmarkDirectory)
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'pilot', $benchmarkDirectory)
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'cohort', $benchmarkDirectory)
```

Prepare congela equipo/protocolo/hashes y rechaza sobrescribir una referencia. Pilot no cuenta
como ejecución formal. Cohort realiza diez mediciones seriales con procesos propios; no ejecutar
otros builds o pruebas del proyecto a la vez. La evidencia y el alcance del cronómetro están en
[verificación 004](../docs/verification-004.md); el recorrido actual está en
[quickstart 004](../specs/004-flujo-claro-finrep/quickstart.md). Las mediciones anteriores permanecen en
[performance.md](../docs/performance.md) y en los registros de cada iteración; no se sobrescriben.

## Dependencias fijadas

El lockfile fija transitivas y allowScripts autoriza las cuatro versiones concretas de herramientas
binarias empleadas por Angular. No usar `npm audit fix --force`, que puede sustituir versiones
compatibles del plan sin evaluar el cambio.

Se conserva el override acotado de @fastify/static con glob 14.0.2 y minimatch 11.0.1 por
[GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4) y
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249). El plugin declara glob 13,
por lo que cruza una versión mayor. static-dependencies.spec.ts comprueba el uso real de glob y
el servicio wildcard; revisar el override al actualizar @fastify/static. La evidencia de pruebas,
versiones y limitaciones se mantiene en [verification.md](../docs/verification.md).
