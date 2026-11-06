# Verificación de la iteración 002

Este registro separa preparación, implementación, pruebas y aceptación humana de
`specs/002-ui-eba-demo/`. No reemplaza la evidencia histórica de la iteración 001.
La automatización final pasa 1.430 pruebas y la medición nueva SC-007 cumple el
criterio en las diez ejecuciones. La aceptación humana SC-008 sigue pendiente.

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

## US3 — pruebas previas a la semántica y demos

Base: `c8729e1`, importación COREP confirmada en Git.

- T047–T049: tres suites, **82 fallos y 6 casos correctos** antes de implementar.
  Los fallos identifican nodos text/date/if no soportados, lecturas tipadas y
  clasificación indeterminada. También reproducen un intento interno que altera
  `variantIds`/código de una propuesta y conserva una dirección numérica legítima;
  deberá rechazarse al aplicar, aunque el hash de selección sea coherente.
- T051: **dos fallos conductuales**. Un libro tipado construido independientemente
  se rechaza en reconocimiento COREP; DEMO_IF_THEN tiene sintaxis válida pero
  soporte semántico ausente. No se usaron imports inexistentes como prueba roja.
- T061 UI: **siete fallos y siete regresiones correctas**, compilados. Faltan
  selector/descargas, versión de cobertura y contexto tipado; los selectores
  deshabilitados para políticas excluidas aún existen y deben retirarse.
- T052 E2E: recorrido completo escrito en `tests/e2e/visual-demos.spec.ts` para
  COREP/tipos a 320/390/1440 px. Baseline focal COREP 1440 falla en 5,4 s tras crear
  el conjunto por ausencia de «Demostraciones guiadas». Comando:
  `run-with-toolchain.ps1 -NpmArguments @('run','test:e2e','--',
  'tests/e2e/visual-demos.spec.ts','--grep','COREP demo 1440')`.
  Log local `.cache/us3-demo-red.log`. El oráculo congelado se consulta solo desde
  pruebas; no debe convertirse en el evaluador ni en una dependencia runtime.
- T050: **11/11 fallos conductuales** ante construcciones no soportadas/tipado,
  5,60 s, tras corregir la sintaxis de los fixtures antes de tomar la línea base.
  T060: **cuatro fallos 404 y un caso correcto** de rutas no expuestas, antes del
  nuevo cargador de descargas. No se han anunciado capacidades tipadas por estos
  fallos ni se considera una respuesta simulada como una validación real.

### Semántica, guardias y primera integración US3

- Motor: **617/617**, catorce archivos, 1,21 s de ejecución final y build correcto.
  Incluye los 88 casos iniciales nuevos y seis pruebas añadidas del motivo
  `NOT_EQUALITY` en v2; v1 mantiene su diagnóstico anterior. La expectativa antigua
  «condicional pendiente» se sustituyó por una construcción que continúa fuera del
  perfil (`abs`) para conservar la prueba de rechazo cerrado.
- T050: **13/13**. Aplicación/jobs/atomicidad y guardias anteriores **63/63**;
  descargas/presentación **20/20**. Se verifican validaciones y workers reales;
  las inyecciones privadas de fallo para carreras/manipulación se distinguen de
  esos recorridos. La aplicación ahora comprueba también identidad/política de las
  propuestas seleccionadas; el Job conserva los diagnósticos públicos finitos.
- Contratos HTTP **148/148**, dieciséis archivos, 90,23 s, ejecutados con
  `--maxWorkers=1 --no-file-parallelism`. Una ejecución concurrente previa produjo
  un timeout de 5 s en `validations.spec.ts`; desapareció al aislarla, sin ampliar
  plazos ni cambiar el test. No se omite ese intento previo.
- Angular final **112/112**, catorce archivos, 6,91 s; typecheck web correcto.
  Build web **659,36 kB iniciales**, 150,01 kB estimados transferidos, sin avisos.
  Guías y descargas no alteran archivos/contexto ni configuran destinos. La versión
  ya publicada se distingue de la revisión candidata, y los diez casos excluidos
  no presentan selectores de recálculo.
- Sumas independientes ejecutadas en PowerShell con BigInteger, sin motor/parser:
  **6000, 18500, 5000, 10000 y 28500 céntimos** para v0174_m, v0173_m, v0176_m,
  v0175_m y v0172_m. Evidencia local `.cache/us3-independent-arithmetic.json`.
- Primer E2E de ambas demos a 1440 px: **2/2**, 29,5 s. Descargas reales, inspección,
  24 resultados individuales, cinco direcciones elegidas por UI y sus cinco cambios,
  rechazo HTTP directo de recálculos prohibidos, COREP 7/8/1 → 14/1/1 y tipos 6/2
  sin propuestas. Capturas bajo `.cache/verification-002/demo-*-1440.png`.

La inspección visual detectó nombres internos de familias en Description de las
19 reglas sintéticas; se reemplazaron por frases en español y se regeneraron las
descargas. Las quince columnas de cada una de las cinco reglas oficiales no cambian.
El corpus también detectó `INVALID_DIRECTION` demasiado genérico para desigualdades;
se añadió el motivo previsto `NOT_EQUALITY`, sin cambiar el envelope HTTP ni v1.

Se corrigió una diferencia de reproducibilidad: el mapping COREP del árbol de trabajo
tenía CRLF mientras Git y `.gitattributes` fijaban LF. Se normalizó el archivo de
producto a LF y se regeneró su huella en el manifiesto. Su JSON/estructura y el SHA
de la plantilla COREP no cambian; la huella anterior de mapping documenta los bytes
usados en US2, no la huella del checkout limpio. Los nuevos mappings/manifiestos
se comprueban con sus bytes LF versionados. Gramática y oráculo permanecen intactos.

T051 final: **95/95** (51 importación tipada, siete corpus y 37 COREP), 31,07 s,
después de normalizar la huella. Regresión previa de importación v1/COREP/tipos:
**228/228**, nueve archivos, 28,81 s. Se contrastan las 30 expresiones/precondiciones
con ANTLR, los 24 resultados antes/después, lecturas efectivas, elegibilidad, cinco
importes, cuatro aristas y procedencia de las cinco filas oficiales.

La regresión E2E obtuvo **27/28**, 3,9 minutos: pasaron las seis demos a 320/390/1440
px y todos los recorridos salvo uno que aún buscaba el encabezado/texto anteriores
«Carga y cobertura». Se actualizaron ambas aserciones al texto de datos publicados
y su versión, conservando comprobaciones de cifras, nulos, fuentes y recarga. El
recorrido focal final pasa **1/1**, 6,3 s total. No se cambió producto para ese ajuste.
Se conservan los logs de la ejecución completa y de ambos intentos focales.

Capturas finales de propuestas/comparación COREP y resultados tipados guardadas en
`.cache/verification-002/demo-*.png`; inspeccionados escritorio y móvil. No desborda
la página; las tablas anchas se desplazan dentro de su región. Se anotó para T073
añadir una pista visible de desplazamiento móvil, porque los importes quedan a la
derecha de la primera vista. Resultados y severidad permanecen separados.

Huella COREP de mapping LF:
`c8dd23660c7a2e31d0e9871dd2198d88cc6fb7dd40bb3be79321a62a0c7cd790`.
Mapping tipado: `c84d1950e9849443cd58ee86908a56147d8de88317808749a9c38f334e4ac5fe`.
Los cuatro activos coinciden con su manifest; los tres XLSX originales y grammar
siguen intactos. El exportador visual y la aceptación humana siguen pendientes.

Antes del commit se detectó que la ruta de descarga COREP compilada aún buscaba
assets en la raíz del checkout. Un backend compilado reubicado en una carpeta
aislada devolvió 500; tras seleccionar los assets empaquetados desde `.js`, la
misma prueba pasa **1/1**, 3,46 s, respuesta 200 y bytes idénticos a su plantilla.
Build API final correcto. La copia temporal se limpia; no se movieron originales.
**Checkpoint T047–T062 completo**, con los 28 escenarios E2E verificados entre la
ejecución conjunta y la repetición focal del selector corregido.

## US4 — exportación visual y versión elegida

Base: `a550442`. Se precisó el contrato HTTP con un resumen de exportación de la
versión exacta: hasta 20 informes y listas acotadas de hojas, sin hechos ni todos los
contextos. Es necesario para describir un histórico cuyo perfil difiere del vigente.
La UI no deduce ese perfil del contexto actual. Se documentó además que la elección
número/texto del serializador no amplía el dominio de importación del perfil.

Pruebas previas a implementar:

- T063/T064: **tres fallos conductuales**, 1,0 s. La exportación con contexto manual
  falla por ausencia de localizador; COREP y tipos se escriben con el formato anterior
  y no se reconocen al reimportarlos como perfiles visuales.
- T070: **cinco fallos compilados**. Falta el resumen histórico y el aviso de ejecución
  incompleta; repetir resultados permite un artefacto de informe/otra versión/otra
  ejecución. Se conservarán las guardias de solicitud/idempotencia existentes.
- T065 E2E: recorrido COREP real escrito, con exportación aplicada/histórica y
  reimportación de 110 posiciones; baseline falla en 14,8 s al buscar el resumen de
  la versión elegida, después de importar, validar, simular y aplicar cinco cambios.
  El recorrido tipado exige las seis entradas, ocho resultados, XLSX/JSON tipado y
  que no se repita el paquete ajeno. Log `.cache/us4-roundtrip-red.log`.

La comparación de negocio excluye IDs/localizadores nuevos, pero conserva valores,
tipos, presencia, precisión, unidades e intervalos; la prueba exige fuentes nuevas
y ausencia de historial restaurado tras reimportar.

Implementación y verificación de US4:

- Dispatch por perfil/binding de la versión solicitada, con plantillas del producto
  comprobadas por tamaño/SHA/CRC. No se copia el paquete original. COREP conserva
  110 posiciones, 335 anclas, merge y disposición; la salida tipada distingue texto
  vacío informado de nulo y conserva fechas civiles y espacios literalmente.
- El serializador decimal evita Number y redondeos adicionales. Los casos fuera del
  dominio reimportable se rechazan completos. Los límites matemáticos del serializador
  se prueban aparte: no amplían los 128 dígitos/lugares decimales de entrada.
- T063/T064 y regresiones de informes/resultados/lifecycle: **82/82**, cinco archivos,
  15,94 s. Serialización decimal adicional: **25/25**. Incluyen escalas 0/3/6,
  precisión/INF, manual/libro, cifras largas, estilos, 190 exclusiones, cuotas,
  cancelación y compatibilidad v1; la regresión de recursos usa 100 000 hechos.
- T065 HTTP: **9/9** con trabajos reales, selección histórica, token/ETag, cancelación
  y resultados incompletos producidos por una validación interrumpida. Regresiones
  contractuales de aplicaciones/exportaciones y resultados: **21/21**.
- Angular: **125/125**, quince archivos, typecheck correcto. Build inicial
  **660,72 kB**, transferencia estimada 149,66 kB, sin elevar presupuestos.
  El resumen y la repetición de descarga están ligados a versión/contenido/ejecución.
- T065 navegador: **2/2**, 36,4 s, log `.cache/us4-roundtrip-first.log`.
  COREP descarga la versión aplicada y la histórica sin cambiar el selector, cambia
  después el perfil vigente y sigue describiendo el histórico correcto. Se reimportan
  las 110 posiciones y se comparan los 16 resultados. La demo tipada comprueba seis
  entradas, ocho resultados, JSON/XLSX tipado y que un informe no se repita como
  resultados. Ambos casos crean fuentes nuevas sin restaurar historial.
- Los cuatro activos de demo mantienen sus hashes antes/después. Copias exactas de
  los XLSX descargados y capturas quedan en `.cache/verification-002/us4/` para
  inspección visual, fuera de Git y sin datos privados.

Revisión visual de ocho renders de los XLSX descargados: CA1 aplicado A1:F25 y
A97:F114, histórico A1:F25, Contexto/Instrucciones COREP y las tres hojas tipadas.
Los rangos revisados son legibles, mantienen jerarquía, bordes, anchos y filas
multilínea, sin solapes ni cortes observados. Los cinco cambios se distinguen del
histórico, y cero, blancos, fechas y estado Informado conservan su representación.
Los tres XLSX mantienen su SHA tras renderizar. Evidencia:
`.cache/verification-002/us4/renders/`. Se usó artifact-tool sobre descargas reales;
esto no acredita apertura nativa en Excel ni aceptación humana.
**Checkpoint T063–T071 completo**. La revisión conjunta posterior detectó una carrera
de foco al recargar/navegar con teclado; su corrección y regresión pertenecen a T073.

## Cierre conjunto — T072–T076

Base funcional: `b469275`. La primera regresión conjunta de navegador obtuvo
**29/30**, 4,5 min (`.cache/final-002-e2e.log`). El caso Material de 320 px detectó
que un encabezado de etapa diferida podía robar el foco del botón de navegación
tras recargar. Los casos de 390/1440 px y ambos roundtrips pasaron. El fallo se
conserva como evidencia y no se sustituye por un aumento del timeout.

Instalación final reproducible **sin red** en `.cache/final-002-ci`, creada con los
manifests de los cuatro workspaces, raíz, `.npmrc` y lockfile:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('--prefix','.cache/final-002-ci','ci','--offline','--no-audit','--no-fund')
```

Código 0, **382 paquetes**, aproximadamente un minuto. Lock de raíz y copia antes
y después: `757243bd642c152d2ec25f73d00ae51a50fdacb7a3a2d7b7b43c76afcd95fa94`.
La instalación activa y el servidor del usuario no se reemplazaron. Las suites se
ejecutan con el toolchain fijado del checkout; la copia limpia acredita instalación,
no una segunda ejecución de toda la batería dentro de esa copia.

`prepare:templates` y `fixtures` pasan. Motor completo: **617/617**, catorce archivos,
1,45 s. El test de paquete compilado se amplió para dos plantillas, cuatro descargas
de demo y cuatro exportaciones reales (informes/resultados de COREP y tipos), con
cuatro workers y reimportación de negocio. El proceso hijo y sus workers bloquean
red y accesos a fuentes externas al paquete. Los únicos bloqueos registrados son
las dos autocomprobaciones deliberadas de la guardia. Resultado focal: **1/1**, 4,79 s;
seis casos excluidos por el filtro `-t`, pendientes de la suite completa. Dos fallos
iniciales del harness se corrigieron: URL file:// para --import en Windows y cierre
del primer workspace antes de crear el segundo. No fueron defectos del producto.

La carrera de foco se reprodujo con una prueba Angular determinista. La etapa
diferida ya no interpreta su montaje como una orden de enfocar: un coordinador del
workspace cumple únicamente la navegación solicitada y cancela la petición si el
usuario mueve el foco. Se eliminó el temporizador duplicado del shell. Las cinco
pruebas nuevas y siete de shell pasan **12/12**; E2E sigue exigiendo activación con
teclado y foco en el título, sin suavizar sus aserciones.

La revisión móvil añadió una indicación visible del desplazamiento horizontal y
su asociación accesible a las tablas. Las capturas de exportación se centran ahora
en el resumen/contexto expandido; el recorrido tipado verifica desplazamiento de
esa región con teclado y ausencia de desbordamiento de página a 320 px.

Verificación final ejecutada con `scripts/run-with-toolchain.ps1`:

| Comando npm | Resultado |
|---|---|
| `run prepare:templates` y `run fixtures` | Correctos; plantillas y demos visuales sin diferencias versionadas. |
| `exec -- vitest run --project engine` | 617/617, 14 archivos, 1,45 s. |
| `run test:integration -- --maxWorkers=1 --no-file-parallelism` | 489/489, 30 archivos, 144,38 s; incluye dos generaciones ANTLR y comparación reproducible. |
| `run typecheck` | Correcto para contratos, motor, API y Angular. |
| `run build` | Correcto; ANTLR 4.13.2 y huellas originales comprobadas, API/activos/web empaquetados. |
| `run test --workspace @ce/web -- --watch=false` | 130/130, 16 archivos, 7,25 s. |
| `run test:contract -- --maxWorkers=1 --no-file-parallelism` | 158/158, 17 archivos, 98,91 s; incluye la prueba completa del paquete reubicado. |

Motor y Angular se ejecutaron por separado, cubriendo ambos componentes de
`test:unit`. Sin skips en estas suites completas. Bundle final **662,14 kB** iniciales
(149,75 kB estimados transferidos), por debajo de 700 kB de aviso y 1 MB de error.
Tres fixtures antiguos regenerados solo variaron en metadatos de contenedor ZIP:
se comprobó igualdad de todos sus nombres/bytes internos frente a Git antes de
conservar los archivos versionados, evitando un cambio binario ajeno al producto.

La segunda ejecución E2E obtuvo **27/30**, 4,2 min. La entrada inicial con teclado
ya funciona, pero los tres anchos detectan otra competencia de foco al regresar de
Descargar a Recalcular: el detalle retenido se recrea y enfoca su encabezado sin
una nueva apertura del usuario. Se conserva el estado del detalle y se corrige la
autoridad de foco, en vez de borrar la selección o cambiar la expectativa del test.
Log `.cache/final-002-e2e-fixed.log`, capturas/trazas en
`.cache/verification-002/final-second/`. Los otros 27 escenarios, incluidos los
resúmenes/contextos expandidos y el desplazamiento de exportación por teclado, pasan.

La segunda causa se reprodujo en Angular (10 pasan y una falla antes del arreglo).
Etapas y detalles comparten ahora solicitudes explícitas de foco. Los tres padres
solicitan el encabezado identificado al abrir el detalle; un detalle retenido no
genera otra solicitud, y mover el foco cancela una respuesta tardía. Los resultados
Antes/Después usan IDs que incluyen el runId. Focal: **52/52**; batería Angular
final: **133/133**, 16 archivos, 6,84 s. Typecheck web y nuevo build correctos,
**662,29 kB** iniciales, 150,05 kB estimados transferidos.

Se añadieron tres E2E de legibilidad con 31 dígitos enteros y nueve decimales exactos,
precisión INF y descripción larga literal. La primera comprobación independiente
pasó **3/3**, 19,8 s: validación, detalle, propuesta antes/después, teclado y
320/390/1440 px. Seis capturas en `.cache/verification-002/t073-long-values/`.
Los ajustes de la prueba conservaron el resultado booleano como tercer operando y
solo exigen desplazamiento en la tabla secundaria cuando realmente desborda.
La inspección visual detectó la etiqueta técnica `pure` y poca separación antes de
EUR: ahora se presenta «sin unidad» conservando el DTO original, y la unidad tiene
separación visual. El recorrido final comprueba texto y geometría de los caracteres.

E2E final conjunto: **33/33**, 4,3 minutos, sin skips, log
`.cache/final-002-e2e-complete.log`. Pasan los tres recorridos de foco corregidos,
las cifras largas, las seis demos por anchura y ambos roundtrips. Total de las
últimas suites completas: **1 430 pruebas** (617 motor + 133 Angular + 489 integración
+ 158 contratos + 33 E2E). Los intentos fallidos anteriores permanecen documentados;
no cuentan como aprobados por una repetición sin cambio.

Capturas finales en `.cache/verification-002/final-complete/`, sin datos privados.
El contraste de texto secundario muestreado se comprueba contra 4,5:1; se revisan
foco visible, estados acompañados de texto y tablas contenidas. Esto no pretende
ser una certificación integral de accesibilidad. Los tres XLSX originales y las dos
gramáticas vuelven a coincidir con sus SHA fijados, registrados en
`.cache/final-002-source-hashes.json`. **T073 y T074 completos**.

### Rendimiento nuevo — SC-007

Referencia `.cache/benchmark/002-reference/reference.json`, congelada antes del piloto
el 2026-11-04 a las 21:52:40 UTC. Código funcional `ff825cd`; los cambios pendientes
eran documentales y el protocolo conserva sus hashes/diff en `code.json`. Equipo:
AMD Ryzen 5 3600X, 12 procesadores lógicos, 34.277.588.992 bytes de RAM, Windows 11 Pro
x64 10.0.26200, plan Alto rendimiento. Node 24.22.2, V8 13.6.233.17-node.63,
Chromium 156.0.8078.4 headless y Playwright 1.64.1.

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','prepare','.cache/benchmark/002-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','pilot','.cache/benchmark/002-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','cohort','.cache/benchmark/002-reference')
```

El conjunto sintético ce-report-1 tiene 500 sumas diferentes, 200 lecturas por regla
y 100.000 hechos distintos. Cada ensayo usa API propia y contexto de navegador nuevo.
Desde la primera respuesta de carga terminada hasta los resultados visibles se
incluyen refresco de cobertura, navegación a Validar, ejecución, resumen y dos frames.
Se comprueban 250 pasan/250 fallan, 500 filas/variantes/instancias, cero duplicadas y
50 filas en DOM. Después se auditan las 500 respuestas y las 100.000 lecturas exactas;
el tiempo de esa auditoría está fuera del cronómetro de presentación.

El criterio nuevo exige diez ensayos auditados, al menos nueve ≤30 s y **todos ≤60 s**,
sin excepciones por diagnóstico, reintentos ni descartes. No se ejecutan otras suites,
builds ni pruebas humanas durante la cohorte. La carga queda registrada por separado.
Piloto independiente: pasa auditoría, **15,549 s** de validación/presentación y
**29,541 s** de carga; duración total del ensayo 54,6 s. El campo `passed:false` del
resumen del piloto significa que solo la cohorte puede acreditar el criterio, no
que hubiera fallado el piloto. Su carpeta es `pilot-2026-11-04T21-52-43-739Z`.

Cohorte `cohort-2026-11-04T21-53-59-624Z`: **10/10 auditadas y ≤30 s**, ninguna >60 s,
sin reintentos ni descartes. Duración conjunta 9,2 minutos. El resumen registra
`passed:true`; promedio de validación/presentación **14,868 s**, mínimo **14,450 s**
y máximo **15,778 s**. Carga media **30,204 s**, rango **29,299–31,576 s**.

| Ensayo | Validación y presentación (s) | Carga separada (s) | Auditoría |
|---|---:|---:|---|
| 1 | 14,865 | 29,524 | Pasa |
| 2 | 14,456 | 29,450 | Pasa |
| 3 | 15,778 | 29,299 | Pasa |
| 4 | 14,862 | 31,576 | Pasa |
| 5 | 14,453 | 30,254 | Pasa |
| 6 | 15,363 | 30,145 | Pasa |
| 7 | 14,450 | 30,159 | Pasa |
| 8 | 14,807 | 30,301 | Pasa |
| 9 | 14,815 | 30,611 | Pasa |
| 10 | 14,834 | 30,724 | Pasa |

Medición CA1 independiente, posterior a la cohorte y sin otra batería concurrente:

```powershell
.\.tools\node\node-v24.22.2-win-x64\node.exe scripts/benchmark-corep.mjs .cache/benchmark/002-corep-load
```

| Caso | Recepción hasta 202 (s) | Desde 202 hasta revisión lista (s) | Confirmación hasta publicación (s) | Total de carga/publicación (s) |
|---|---:|---:|---:|---:|
| Extracto, contexto del libro | 0,029 | 0,593 | 0,215 | 0,838 |
| Libro completo, contexto declarado | 0,019 | 2,149 | 0,298 | 2,468 |

Ambos pasan: 16 reglas, **110 posiciones, 15 valores, 95 blancos**, una hoja incluida;
cero exclusiones en el extracto y 190 en el libro completo. HTTP real contra una
aplicación propia con puerto efímero por caso. La revisión entre etapas es automatizada
(~1 ms), no tiempo humano; la medida no incluye render del navegador. Los originales
permanecen intactos y no se atribuyen 100.000 celdas al perfil CA1. Protocolos, entradas,
tiempos y huellas están en `.cache/benchmark/002-corep-load/`. Son medidas de este equipo
y corpus, no una garantía para cualquier conjunto. **T072 / SC-007 completos**.

### Trazabilidad de cierre

| Criterio | Estado y evidencia de esta iteración |
|---|---|
| SC-001 / FR-001–006,012 | Tablas Material, antes/después exactos y detalle secundario; T030/T073, capturas y E2E a tres anchos. |
| SC-002 / FR-007–011 | Etapas, paginación, selección fuera de página, estados conservados y teclado; stores, harnesses y recorridos completos. |
| SC-003 / FR-013–019,037 | COREP 4.0 CA1: 110 posiciones/335 anclas, contexto explícito, completo/extracto e inspección atómica; T031–046. |
| SC-004 / FR-030–035 | 24 reglas, cinco recálculos y diez reglas solo validación; oráculo independiente, ANTLR, integración y seis recorridos demo. |
| SC-005 / FR-020–023 | Versiones/bindings y roundtrip del 100 % de ambos corpus; T063–071 y descargas reales de navegador. |
| SC-006 / FR-024–029,036,038 | Tipos, ramas, exclusión en todas las entradas, Kahn, conflictos, cuotas, cancelación, atomicidad y regresión v1; motor/integración/HTTP/E2E. |
| SC-007 / FR-037–038 | Cohorte nueva 10/10 ≤30 s, máximo 15,778 s, todas auditadas; carga y CA1 medidas aparte. T072 completo. |
| SC-008 / FR-038 | Valoración global favorable recibida el 2026-11-06. T075 sigue pendiente de los detalles del recorrido. |

La cobertura operativa es COREP CA1 y el perfil didáctico propio de texto/fechas.
No se declara soporte general FINREP/COREP, conformidad completa DPM-XL ni fichero
oficial de remisión. La evidencia de 001 y su aceptación global no se reinterpretan
como aceptación de esta iteración. Recibos de desarrollo: `disabled/unmanaged`.

### Aceptación humana pendiente — SC-008

Se inició una sesión propia de la versión verificada en `http://127.0.0.1:3320`
(HTTP 200), sin detener ni reutilizar el servidor/conjunto anterior del usuario.
Se solicitó completar la demo COREP, identificar dos cambios antes/después,
indicar la versión descargada y comunicar ayuda e incidencias.

El 2026-11-06, Diego respondió «Todo me cuadra» a la solicitud sobre la demo COREP
de esta iteración. Se registra su valoración global favorable. Para cerrar T075
queda por recoger hasta qué paso llegó, qué dos valores vio cambiar (antes → después),
qué versión descargó y si necesitó ayuda o encontró alguna incidencia.

### Entrega documental — T076

README, guía de demos, quickstart, plan y tareas describen las capacidades entregadas,
los límites de cobertura y la evidencia final. Estado: **75/76 tareas**, pendiente
únicamente T075. Los commits funcionales finales son `b469275` (exportación visual),
`989c328` (navegación y verificaciones de paquete/rendimiento) y `ff825cd` (apertura
explícita de detalles y legibilidad). Se conservan los incrementos anteriores de
US1–US3. No se publica remoto ni se modifica la evidencia histórica de 001.
La comprobación posterior de Spec Kit no encuentra `.specify/extensions.yml`, por
lo que no hay hooks registrados que despachar. El cierre documental conserva
explícitamente la aceptación humana pendiente.
