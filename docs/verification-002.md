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

## Foundation — evidencia inicial de pruebas

Base de ejecución: `f1e1c2c`. Antes de implementar la ampliación de contratos y
guardias se ejecutaron las pruebas nuevas con Vitest sobre el código existente:

- T004, `tests/contract/typed-profile-schemas.spec.ts`: 11 casos, 9 fallidos y 2
  aprobados. Los fallos de comportamiento incluyen texto/fecha rechazados y valor
  numérico indebidamente aceptado con presencia nula; también faltan exports nuevos.
  Las comprobaciones genéricas de hash/cuota existentes ya pasan.
- T005, `packages/engine/test/profile-policy.spec.ts` y
  `tests/integration/profile-guards.spec.ts`: 12 casos, 10 fallidos y 2 aprobados.
  V2 numérico queda incompleto, v2 booleano ofrece destino, v1 acepta un texto no leído,
  una configuración mixta publica y una preview acepta trabajo en lugar de rechazar.
  Las comprobaciones de v1 y asociación de perfiles ya cubiertas siguen pasando.

Estos resultados demuestran las carencias iniciales, no una funcionalidad terminada.
Los comandos usan `run-with-toolchain.ps1 -NpmArguments @('exec','--','vitest','run',...)`
con los proyectos contract, engine e integration correspondientes y los tres archivos
indicados. El intento inicial de Vitest en sandbox produjo `spawn EPERM`; el mismo
comando con escalación local ejecutó las pruebas. La verificación verde conjunta de
Foundation se registrará tras T006–T011.

T006–T007: build de contratos y los 11 casos de T004 pasan tras ampliar las uniones,
fechas civiles, presencia y bindings. No fue necesario cambiar los algoritmos genéricos
de hash ni contabilidad. Los consumidores existentes de Angular y exportación distinguen
ahora racionales de los objetos de texto/fecha sin coerción. Tras los ajustes mínimos
de Angular, `typecheck --workspace @ce/web` pasa y
`run-with-toolchain.ps1 -NpmArguments @('run','test','--workspace','@ce/web','--','--watch=false')`
aprueba **46 pruebas en ocho archivos** (19,26 s). Esto verifica compatibilidad de las
vistas existentes; el rediseño Material sigue pendiente de US1.

### Foundation — cierre T008–T012

- Contratos: **109/109 pruebas en 13 archivos**, incluida la ampliación T004 a
  15 casos con HTTP, proyección cerrada y agotamiento de presupuesto.
- Motor/API: regresión ampliada de **606 pruebas en 18 archivos** correcta;
  después, focal de política **10/10** con los casos adicionales de fecha y
  precondición formal. T005 contiene ahora diez casos de motor y seis de API.
- `run-with-toolchain.ps1 -NpmArguments @('run','build:api')`: correcto.
- `run-with-toolchain.ps1 -NpmArguments @('run','typecheck')`: correcto en todos
  los workspaces. Angular conserva las 46 pruebas aprobadas registradas arriba.
- `git diff --check`: sin errores de espacios.

El perfil y dominio de valores se comprueban antes del grafo y se vuelven a
comprobar en worker y publicación. Una configuración mixta prohibida no produce
una preview parcial. V1 conserva recálculos booleanos, exactitud y comportamiento
ante cuotas; v2 admite por ahora el subconjunto numérico protegido. Texto, fecha e
if todavía no tienen semántica nueva: permanecen cerrados hasta US3. La prueba de
publicación final introduce un fallo interno controlado; no implica snapshots
mutables en producción. Los cambios genéricos de hash/cuota no fueron necesarios:
las pruebas verifican que ya incluyen los nuevos valores y bindings.

Se precisó el contrato de US1 para conservar en la propuesta la expresión y las
lecturas reales del overlay de simulación, incluyendo el productor precedente.
El listado omitirá esta evidencia; el detalle por ID la devolverá. Reconstruirla
con el snapshot original habría mostrado importes incorrectos en cadenas Kahn.
También se fijaron alias estables `corep` y `demo_types` para contextos generados;
la identidad de negocio sigue basándose en entidad, periodo, framework y módulo.
Estos ajustes están documentados, pero su implementación pertenece a US1/US2.

## US1 — pruebas antes del rediseño

Base `eb5420e`. La compilación web previa al rediseño pasa con **343,22 kB**
iniciales (86,91 kB estimados transferidos). Este tamaño no incluye Material en uso.

- T013–T014: cinco fallos conductuales en tres archivos Angular: etapas simultáneas,
  navegación sin estado activo, presentación de 1/8 y acumulación de 51 filas al
  avanzar la página. La compilación de estas pruebas sí completó.
- T015 API: siete casos iniciales, seis fallidos y uno aprobado: etiquetas ausentes,
  evidencia/AST indebidamente retenidos en lista, detalle inexistente y rechazo de
  `changedOnly`. El fallback sin etiqueta ya funciona.
- T015 motor: ocho casos iniciales, seis fallidos y dos aprobados. Falta evidencia
  de cálculo; el caso encadenado exige que el consumidor lea 0,33 del overlay,
  no el cero original ni el nominal 1/3. Bloqueo de grafo y aborto por cuota ya pasan.
- T016: `run-with-toolchain.ps1 -NpmArguments @('run','test:e2e','--',
  'tests/e2e/material-workflow.spec.ts','--grep','1440px')`: una prueba ejecutada y
  fallida tras crear el conjunto, por ausencia del botón de etapa «2. Validar».
  El servidor propio de Playwright usó 3318. No se ejecutó todavía el resto del
  recorrido de 51 reglas ni los anchos móviles sobre el código nuevo.

Comando de regresión Foundation de 606 pruebas:
`run-with-toolchain.ps1 -NpmArguments @('exec','--','vitest','run','--project',
'engine','--project','integration','--project','contract','packages/engine/test',
 'tests/integration/profile-guards.spec.ts',
 'tests/integration/application-atomicity.spec.ts',
 'tests/integration/apply-worker.spec.ts',
 'tests/integration/static-dependencies.spec.ts',
 'tests/integration/revalidation-comparison.spec.ts',
 'tests/contract/previews.spec.ts','tests/contract/applications-exports.spec.ts',
 'tests/contract/typed-profile-schemas.spec.ts')`.

T015 motor/T021 captura: ocho casos nuevos aprobados tras la implementación;
`run-with-toolchain.ps1 -NpmArguments @('exec','--','vitest','run','--project',
'engine','--reporter=dot')` aprueba **523 pruebas en once archivos**. El build del
motor también pasa. La evidencia incluye fuente y precondición efectivas sobre el
overlay, defaults con presencia nula intacta, bloqueo sin lecturas inventadas y
aborto completo por presupuesto. La UI y la consulta HTTP se verifican por separado.

T015 API/T021–T022: **121/121 pruebas de contratos en catorce archivos**, incluidas
12 nuevas de presentación, detalle y comparación. Build de contratos y typecheck
API correctos; `run-with-toolchain.ps1 -NpmArguments @('run','build:api')` también
pasa al integrar contratos, motor y API. `changedOnly` se aplica globalmente antes
del cursor, incluye diferencias reales Pasa→Pasa y excluye cosmética/IDs/tiempos;
las interrupciones no publican una página parcial. Las pruebas de retención verifican
bytes adicionales de calculation, inmutabilidad y rechazo por cuota conservando
registro/snapshot/bytes previos. Los casos HTTP usan bundles controlados; la captura
real está comprobada por separado en las ocho pruebas de motor anteriores.
`conceptLabel` sigue siendo opcional hasta disponer del mapping confiable de US2.

Hallazgo durante la integración T026: `importCatalog` guarda `originalFields.Description`
como celda `{value, xmlType, lexeme, column}`. El fixture HTTP inicial usaba un string;
por ello las 121 pruebas anteriores no demostraban todavía la descripción del Excel
real. Se reabre T021 para corregir esa lectura, conservar compatibilidad con strings
y añadir un caso con la forma real antes de considerar completa la proyección.

Corrección de T021: la lectura admite la celda real `Description.value` y el string
heredado. El fixture incorpora esa forma, texto con apariencia HTML y descripciones
alternativas ordenadas por fuente. `presentation-queries` vuelve a pasar **12/12**.
El E2E de Material también comprobará la descripción de un Excel subido y su
representación literal, sin crear nodos HTML.

### Primera integración visual US1

`run-with-toolchain.ps1 -NpmArguments @('run','build','--workspace','@ce/web')`
compila Material: **783,29 kB iniciales**, 165,47 kB estimados transferidos. Se
mantienen los límites; aparece aviso de 700 kB, sin alcanzar el error de 1 MB.
Se prepara carga diferida de etapas inactivas para reducir el inicial.

El recorrido `material-workflow.spec.ts --grep 1440px` pasa completo: **1/1**,
17,8 s de prueba y 20,9 s total. Usa 51 reglas numéricas sintéticas en cadena,
carga real de XLSX, descripciones literales con etiquetas HTML, validación,
configuración por API como preparación, simulación/selección/aplicación/descarga
por UI. Verifica dependencia fuera de página sin autoaceptación, selección de 51,
lectura del antecesor simulado, desaparición de confirmación, 51 cambios exactos y
descarga del recibo sin modificar la selección histórica. Un intento previo del
mismo build falló por una aserción que esperaba «no visibles» en vez del texto real
«fuera de esta página»; se ajustó la aserción, no el comportamiento.

Capturas inspeccionadas: `.cache/verification-002/material-proposals-1440.png` y
`material-comparison-1440.png`. Las tablas muestran códigos, importes y estados;
no imprimen claves JSON en las filas. Hallazgos para corregir antes del cierre:
alinear flecha con importes, concordancias de singular y priorizar comparación/
descarga tras aplicar para no obligar a atravesar las filas históricas. Aún faltan
build final diferido, móvil y regresión E2E completa. Esta es evidencia automática,
no aceptación humana.

### Cierre US1 — T013–T030

- **79/79 Angular, doce archivos**, con Material/harnesses, exactitud, cursores,
  navegación, estado de workspace, intentos idempotentes, etiquetas de dependencias
  (máximo cuatro solicitudes simultáneas), respuestas tardías y foco. Comando:
  `run-with-toolchain.ps1 -NpmArguments @('run','test','--workspace','@ce/web','--',
  '--watch=false')`. Vitest informa 6,93 s de ejecución, aparte de compilación.
- **19/19 E2E, 2,4 minutos**: `run-with-toolchain.ps1 -NpmArguments
  @('run','test:e2e')`. Incluye los dieciséis recorridos anteriores adaptados y los
  tres Material a 320/390/1440 px; sin skips. Servidor propio en 3318.
- Build web final correcto, **657,51 kB iniciales** y 149,98 kB estimados transferidos;
  etapas Validar/Recalcular/Descargar diferidas. No hay aviso de presupuesto y no se
  modificaron los límites de 700 kB/1 MB. API/contratos/motor compilan también.
- Capturas finales guardadas e inspeccionadas bajo `.cache/verification-002/`:
  `material-proposals-{320,390,1440}.png` y
  `material-comparison-{320,390,1440}.png`. Son fixtures sintéticos, no informes reales.
  El móvil mantiene desplazamiento dentro de la tabla, comprobado también mediante
  flechas del teclado; la página no desborda. Importes completos, flecha alineada,
  unidad común y foco visible. El recorrido anterior comprueba contraste de texto.

La primera regresión final fue 18/19: detectó que `viewChild` de botones Material
no obtenía ElementRef para enfocar el cierre. Se corrigió con `read:ElementRef`,
se añadió prueba de foco Cerrar/Volver y se repitió la suite, ahora 19/19. Se conservan
severidad y procedencia en detalle; no se eliminaron sus aserciones. Tras aplicar,
comparación y descarga aparecen primero y las propuestas históricas quedan bajo
una acción secundaria sin controles de selección. El listado no muestra calculation,
AST ni claves serializadas; su detalle conserva entradas reales y origen.

Este checkpoint acredita US1 sobre `ce-report-1`, incluida compatibilidad v1 de
importación, validación, recálculo y exportación. **No acredita todavía COREP visual,
las demos tipadas, exportación visual, benchmark nuevo ni aceptación humana SC-008.**

## US2 — pruebas previas y reconocimiento del original

Base: `074f174`, incremento US1 confirmado en Git.

- T031: el preflight existente rechaza el libro oficial con `INVALID_WORKBOOK` por
  externalLink. Es un fallo conductual real antes de los adaptadores nuevos.
- T032: **28 casos de lifecycle fallidos por HTTP 404**, 12,32 s; archivo
  `tests/integration/import-inspection-lifecycle.spec.ts` y helper propio. Pruebas
  de reloj/fallos controlados separadas del caso con worker real.
- T033: tres fallos conductuales HTTP iniciales por ausencia del recurso.
- T034 Angular: tres fallos compilados por ausencia de acción de inspección,
  selector de contexto/compatibilidad y recuperación active.
- T034 E2E: `run-with-toolchain.ps1 -NpmArguments @('run','test:e2e','--',
  'tests/e2e/corep-import.spec.ts','--grep','full COREP')` ejecuta un caso y falla
  tras crear conjunto por ausencia de «Inspeccionar archivos» (5,5 s). El recorrido
  completo/extracto/rechazo de fórmula está escrito, todavía no validado.

La lectura del ZIP original verificó una PI inerte adicional:
`<?mso-contentType?>` en `customXml/item2.xml`. Se precisó el contrato de libro para
permitir exclusivamente esa PI vacía en esa parte del candidato COREP reconocido,
sin ejecución; otras PI/DTD siguen rechazadas y v1/catálogos/hojas propias conservan
la restricción. Se añadirán negativos de PI distinta y con contenido. El original
no se modifica; sus huellas se comprueban antes y después en E2E.

### Evidencia integrada US2

- T031: **37/37** casos focales, 27,80 s. La regresión anterior de ocho archivos
  de COREP/XLSX/importación/v1 pasó **175/175**, 46,28 s. El original tiene
  191 hojas, 335 anclas CA1, 110 posiciones, 166 645 celdas físicas y extremos XFD;
  72 fórmulas fuera de CA1 y 22 XML de vínculos externos se tratan como inertes.
  Se verifican límites, CRC, orden de ZIP/hojas, PI, contenido activo y ausencia
  de llamadas fetch/http/https. Completo y extracto preservan importes exactos.
- T032: **28/28**, 36,92 s, frente a los 28 fallos iniciales. Incluye worker real,
  TTL fijo, cuotas, CAS/replay, lease, cancelación/cierre y publicación atómica.
  Tras commit se liberan las copias privadas de la inspección; permanecen datos
  normalizados, bindings, huellas y localizadores, además de archivos anteriores
  ajenos a esa inspección. Se corrigió una prueba que suponía retención indefinida.
- T033: **19/19**, 12,37 s, con Host, token, If-Match, 20/21 informes, DTO cerrado,
  conflicto de inspección activa y rechazo del bypass por `/imports` con worker
  real. Regresión anterior: **137/137** contratos y **55/55** casos de importación,
  jobs y cuotas. Presentación **13/13**: etiqueta OWN FUNDS solo con binding/mapping
  confiables; una etiqueta no cambia identidad de celda ni datos.
- Angular: **96/96**, trece archivos, 6,57 s; después de diferir Cargar, sus tres
  suites afectadas pasan **26/26**, 3,52 s. Typecheck global y build API correctos.
  Build web final: **657,75 kB iniciales**, 148,99 kB estimados transferidos, sin
  aviso y sin elevar presupuestos. Logs locales `.cache/us2-*.log`.
- Plantilla saneada reproducible: 71 353 bytes, SHA-256
  `7767a6ab34990ff3f954f5acd3348180c7004ca901f8b92b6521940e52ee7e7f`;
  mapping `3a6ea97bce6bd48e6caa7eb722ef76e30704b51f56993f8718be267d4eefd916`.
  Verificadas nuevamente ambas huellas públicas de T002, sin cambios.

La primera ejecución de los tres E2E COREP pasó el libro oficial completo y falló
en los dos archivos alterados por el test. El helper `patchCell` consumía la celda
siguiente al reemplazar una celda autocerrada. Se corrigió el helper y se añadieron
comprobaciones de XML válido, unicidad y conservación exacta del resto del documento;
no se relajó el importador. La captura `.cache/verification-002/corep-full-review.png`
muestra contexto, 110 posiciones y aceptación explícita de las 190 exclusiones.
Regresión E2E final: **22/22**, 2,9 minutos, sin skips, mediante
`run-with-toolchain.ps1 -NpmArguments @('run','test:e2e')`, servidor propio 3318.
Incluye los tres casos COREP, dieciséis recorridos anteriores y tres anchos Material.
El extracto descargado, modificado por la prueba con 12,34 a escala 3/precisión 2,
se normaliza exactamente a 12 340, precisión base -1, y valida la igualdad esperada.
El error de fórmula señala CA1/E5 y mantiene versión/ETag previos. La inspección
recuperada conserva plazo y no descarta silenciosamente al editar el formulario;
confirmar publica una versión, y repetir la petición recupera el mismo Job.

**Checkpoint T031–T046 completo.** Las fuentes públicas siguen intactas. Esta
evidencia cubre importación visual y compatibilidad anterior; semántica nueva,
demos de 24 reglas y exportación visual se completan en US3/US4.
