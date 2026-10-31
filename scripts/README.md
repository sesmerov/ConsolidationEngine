# Toolchain reproducible

En Windows x64, desde la raíz del repositorio:

```powershell
./scripts/bootstrap-toolchain.ps1
./scripts/run-with-toolchain.ps1 ci --offline=false
./scripts/run-with-toolchain.ps1 run generate:parser
./scripts/run-with-toolchain.ps1 run typecheck
./scripts/run-with-toolchain.ps1 run build
./scripts/run-with-toolchain.ps1 run test:integration
./scripts/run-with-toolchain.ps1 run dev
```

El bootstrap descarga Node 24.22.2 con npm 11.19.1 en `.tools/`, verifica
SHA-256 antes de extraerlo y no modifica instalaciones globales. El launcher
comprueba ambas versiones, prepara el PATH sólo durante el comando y usa
`.cache/npm`. El pin y el checksum oficial están en `node-toolchain.json`;
su fuente es [SHASUMS256.txt de Node](https://nodejs.org/dist/v24.22.2/SHASUMS256.txt).
En otros sistemas se necesitan esas mismas versiones de Node/npm; los comandos
`npm run ...` del proyecto son portables.

ANTLR requiere Java 11 o superior accesible mediante `java`. La generación
descarga el [JAR oficial 4.13.2](https://www.antlr.org/download/antlr-4.13.2-complete.jar)
si falta, comprueba su SHA-256 fijado en `antlr-toolchain.json` y verifica
los hashes de las dos gramáticas originales antes de copiar sus bytes a
`.cache/antlr-input/` con nombres compatibles. Genera primero el lexer y después
el parser con `-visitor`, `-no-listener` y `-lib`, usando la salida del lexer.
El runtime npm también debe ser 4.13.2. Los archivos generados y el manifiesto
de versiones/hashes se guardan en `packages/engine/src/generated/` y se ignoran
en Git. La prueba de integración compara dos generaciones y analiza sintaxis
real, incluyendo errores del lexer y del parser.

`npm run dev` compila API/librerías y arranca API en `127.0.0.1:3000` y Angular
en `127.0.0.1:4200`, con proxy `/api`. Angular actualiza el navegador al editar;
para cambios del backend se reinicia el comando. `npm start` ejecuta la API
compilada. Los scripts de pruebas separan engine/Angular, integración,
contratos y Playwright; cada conjunto necesita sus pruebas y no acepta un
directorio vacío como éxito.

La política `allowScripts` autoriza sólo cuatro versiones concretas de las
herramientas de binarios utilizadas por Angular, revisadas durante el setup.
El lockfile fija también las dependencias transitivas. No ejecutar `npm audit fix
--force`: puede sustituir versiones directas del plan por versiones incompatibles.

Se fija un override acotado a `@fastify/static` con glob 14.0.2 y minimatch
11.0.1 por los avisos [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)
y [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).
El plugin declara glob 13, por lo que el override cruza una versión mayor;
la prueba `static-dependencies.spec.ts` comprueba su uso real tanto al enumerar
archivos con glob como al servirlos mediante wildcard. Debe revisarse al
actualizar `@fastify/static`.
