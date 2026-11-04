# Verificación de la iteración 002

Este registro separa preparación, implementación, pruebas y aceptación humana de
`specs/002-ui-eba-demo/`. No reemplaza la evidencia histórica de la iteración 001.
La aceptación humana SC-008 y las comprobaciones finales de esta iteración siguen pendientes.

## Setup — T001, T002 y T003

Fecha: 2026-11-04. Base Git: `33fa590`, rama `codex/002-ui-eba-demo`.
Entorno: Windows x64, Node **24.22.2** y npm **11.19.1**, comprobados por
`scripts/run-with-toolchain.ps1` antes de cada comando npm.
Recibos de desarrollo: `disabled/unmanaged`.

### Dependencias e instalación reproducible

Material y CDK **22.2.4** quedan fijados exactamente en `apps/web/package.json` y
`package-lock.json`. El resto de versiones fijadas se conserva. El diff del lockfile
añade esos dos paquetes y convierte las dependencias ya existentes `parse5`/`entities`
en dependencias de producción por CDK, sin cambiar sus versiones. No se añade un motor
XLSX ni se modifican los presupuestos Angular de 700 kB de aviso y 1 MB de error.

Comandos ejecutados desde la raíz:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('install','--workspace','@ce/web','--save-exact','@angular/material@22.2.4','@angular/cdk@22.2.4','--no-audit','--no-fund')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('--prefix','.cache/setup-002-ci','ci','--no-audit','--no-fund','--offline')
```

La primera instalación terminó correctamente, añadiendo dos paquetes. Para comprobar
`npm ci`, se copiaron los manifests de los cuatro workspaces, el manifest raíz,
`.npmrc` y el lockfile a `.cache/setup-002-ci`. La instalación limpia de esa copia
terminó correctamente **sin red**, con 382 paquetes. No se borró el `node_modules`
activo ni se detuvo el proceso del usuario.

Los primeros intentos dentro del sandbox encontraron `ECONNREFUSED` al acceder al
registro npm y `spawn EPERM` en los scripts de instalación. Se repitieron los mismos
comandos con la escalación autorizada: ambos terminaron con código 0. Estos errores
de entorno no se contabilizan como pruebas funcionales fallidas del producto.

### Fuentes públicas preservadas

Los originales se incorporaron desde la caché de investigación a `tests/fixtures/eba/`;
la caché solo intervino en esta adquisición. URL, nombre de entrada original, finalidad,
fecha y huellas quedan en `tests/fixtures/eba/source-manifest.json`.

| Archivo | Bytes | SHA-256 verificado antes y después de copiar |
|---|---:|---|
| `official-annexes-4.0.xlsx` | 1 335 372 | `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` |
| `annotated-corep-of-4.0.xlsx` | 3 059 614 | `610d72d283dd74a6d572c49e1959fba43a662548df4e5399dca2f4b3523c7e5f` |

Son fuentes públicas originales intactas, sin datos de informes del usuario. La fuente
anotada aporta metadatos de correspondencia, no importes reportados. El adaptador y la
preparación de plantillas saneadas se implementan en tareas posteriores.

### Aislamiento y baseline v1

`playwright.config.ts` usa ahora **127.0.0.1:3318** y `reuseExistingServer:false`.
El puerto del analista **3000** no se usa para E2E. El benchmark conserva **3317**,
con un proceso hijo propio por ensayo; ahora exige recibir la confirmación de escucha
de ese hijo antes de consultar HTTP. Si otro proceso ocupa el puerto y el hijo falla,
no se intenta usar el proceso ajeno. La configuración de rendimiento y el workload
no cambiaron; no se ejecutó todavía una medición SC-007.

| Comprobación ejecutada | Resultado |
|---|---|
| `run-with-toolchain.ps1 -NpmArguments @('run','typecheck')` | Correcta: contratos, motor, API y Angular. |
| `run-with-toolchain.ps1 -NpmArguments @('exec','--','vitest','run','--project','engine','packages/engine/test/parser.spec.ts','packages/engine/test/numeric.spec.ts','packages/engine/test/simulation.spec.ts','packages/engine/test/apply-candidate.spec.ts')` | **286 pruebas aprobadas en 4 archivos**, 1,71 s informados por Vitest; regresión representativa v1. |
| `run-with-toolchain.ps1 -NpmArguments @('run','test:e2e','--','--list')` | Configuración cargada; 16 pruebas descubiertas, **no ejecutadas**. |
| `BENCH_OUTPUT=.cache/benchmark/setup-002-config-check`, `BENCH_PILOT=1`; `run-with-toolchain.ps1 -NpmArguments @('exec','--','playwright','test','-c','tests/performance/playwright.config.ts','--list')` | Configuración cargada; un ensayo descubierto, **no ejecutado**. |
| `git diff --check` | Sin errores de espacios; avisos de conversión LF/CRLF de Git, sin cambios de contenido por ello. |

La verificación de ignore confirmó las reglas de dependencias, builds, cachés,
artefactos locales, credenciales y archivos del sistema. No se detectaron configuraciones
Docker, ESLint, Prettier, Terraform o Helm que requieran otro ignore. El monorepo es
privado y no se prepara publicación npm. No fue necesario modificar `.gitignore`.

Este baseline no acredita todavía la UI Material, importación COREP, semántica v2,
exportadores nuevos, rendimiento ni aceptación humana. Solo completa la preparación
T001–T003 y demuestra que la regresión v1 seleccionada sigue pasando tras instalar las
dependencias.
