# Verificación de la iteración 005

## Punto de partida — 2026-11-08

Rama `codex/005-simplificar-flujo-vercel`, commit inicial `33bc0b8` (tareas). Árbol limpio al iniciar implementación. Esta evidencia pertenece a 005; no importa resultados ni aceptación humana de 004. Receipt-driven development: `disabled/unmanaged`.

Spec Kit reconoce los documentos y tareas de 005; checklist de requisitos: 16/16, sin pendientes y sin modificar sus marcadores. No existe `.specify/extensions.yml`. CodeGraph no tiene índice y `gentle-ai codegraph init` no está disponible; se usan lecturas dirigidas después de ese intento.

Toolchain observada: Node **24.22.2** y npm **11.19.1** en `.tools/node/node-v24.22.2-win-x64`; Java **17.0.8**. ANTLR herramienta/runtime fijados **4.13.2**. Dependencias existentes presentes; no se afirma reinstalación ni nuevas pruebas pasadas. `.gitignore` cubre dependencias, generados, datos, credenciales y resultados locales. Se añade `.dockerignore` para futuros contextos aislados; paquetes privados, sin publicación npm, ESLint/Prettier/Terraform/Helm no configurados.

### SHA-256 iniciales (fuentes inmutables)

| Archivo | SHA-256 |
| --- | --- |
| `grammar/dpm_xlLexer-v0.9.g4` | `dda7b8de2c8e1430448cad7a342c712d52ba1b5bd533730b4eafede02bb5805a` |
| `grammar/dpm_xlParser-v0.9.g4` | `30fd37bddfdd356294801e53c7cf4864547a71d0ed13d1b884a3d9c6b6d884b4` |
| `(from 4.0) EBA_Validation_rules_2025-12-12.xlsx` | `36636afe42b2ef2247822a31ad710afe1128b5b65a250b657e1f20d5a75bba79` |
| `tests/fixtures/eba/official-annexes-4.0.xlsx` | `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` |
| `tests/fixtures/eba/annotated-corep-of-4.0.xlsx` | `610d72d283dd74a6d572c49e1959fba43a662548df4e5399dca2f4b3523c7e5f` |

### Entorno y comandos

Existen `build`, `typecheck`, `test`, `test:e2e` y suites específicas en package.json. Los comandos `test:hosted`, `test:e2e:hosted`, `package:vercel:web`, `package:vercel:api`, `test:package:linux` y `test:capacity:hosted` de quickstart siguen siendo contratos por implementar al iniciar.

`docker.exe` existe, pero `docker info` falla porque el daemon Linux de Docker Desktop no está arrancado (pipe `dockerDesktopLinuxEngine` ausente). Existe cliente PostgreSQL18; todavía no se ha verificado PostgreSQL17 de pruebas. No se han leído credenciales ni tocado la sesión del usuario en3340. Esto es disponibilidad inicial del entorno, no resultado de capacidad ni bloqueo de las historias locales.

Preparación posterior del entorno: Docker Desktop se arrancó en segundo plano con ventana oculta. La comprobación fuera del sandbox confirma estado `running`, servidor Docker29.5.3 y WSL2; el sandbox no tiene acceso a su pipe/registros. PostgreSQL17 aislado y el paquete Linux siguen pendientes de sus tareas. No se han detenido ni modificado contenedores ajenos.

## Matriz de evidencia

| Criterio | Requisitos | Comprobación prevista | Estado inicial |
| --- | --- | --- | --- |
| SC-001 | FR-001–004 | Foco, geometría, tres hitos y accesibilidad | Pendiente |
| SC-002 | FR-005–009 | Base, decisiones, simulación atómica, diez reentradas | Pendiente |
| SC-003 | FR-010–011 | Una descarga y ausencia de atajos | Pendiente |
| SC-004 | FR-012–013 | Intención/resumen/payload/archivo coherentes | Pendiente |
| SC-005 | FR-014–017 | Inventario íntegro y controles útiles | Pendiente |
| SC-006 | FR-019–022 | Dos visitantes/instancias, continuidad y publicación | Pendiente |
| SC-007 | FR-023–024 | Revocación, limpieza, límites, transporte/capacidad | Pendiente |
| SC-008 | FR-018, FR-025–026 | Dos orígenes, packaging y operación | Pendiente local; alojamiento real pendiente |
| SC-009 | FR-030 | COREP/FINREP/tipos, hashes y roundtrip | Pendiente |
| SC-010 | FR-027–029 | README último, SDD, diagramas/capturas/arranque | Pendiente |

## Registro incremental

- T001: punto de partida, toolchain, hashes y requisitos de evidencia registrados. Ninguna prueba de producto de005 ejecutada todavía.
- Baseline: `pwsh -NoProfile -File scripts/run-with-toolchain.ps1 run build` termina correctamente (ANTLR, contratos, motor, API y Angular). El primer intento restringido falló al lanzar Java con EPERM; la misma compilación con permiso de ejecución completa pasó. El bundle inicial existente es707,00 kB frente al aviso de700 kB, registrado antes de cambios funcionales; no es fallo de compilación ni resultado de mejora de005.
- T002/T003: inventario inicial de17 selectores,11 detalles y18 controles adicionales documentado en `controls-005.md`, con comprobación final pendiente. Helpers sintéticos comprobados con tipos estrictos y aserciones del motor para ambos lados, único destino,51 productores,51 decisiones, cero candidatos, base de datos cambiados y seis versiones. El valor UTF-8 mayor de1 MiB es solo fixture de transporte; no afirma que el perfil acepte una celda Excel/texto gigante. Helpers E2E todavía no ejecutados en navegador. Fuentes originales sin cambios.
- Ejecución de fundamentos: T009 se marca paralelizable tras comprobar que crea contratos nuevos independientes de las mutaciones de T004–T008; la integración de `index.ts` espera a que sus escritores lo liberen. No cambia requisitos ni arquitectura, y evita editar archivos compartidos simultáneamente. Total105 tareas,21 marcadas[P].
- Aclaración de representación en T009: la primera carga parte de un conjunto vacío. `UploadBatchCreate.baseVersionId` es campo requerido `UUID|null`; null representa ausencia de versión y mantiene If-Match obligatorio. Contrato API/modelo precisados, sin inventar una versión inicial ni debilitar concurrencia.

Comprobación de tipos de helpers: `node node_modules/typescript/bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck --esModuleInterop --allowJs --checkJs false tests/helpers/iteration005-fixtures.ts tests/e2e/iteration005-helpers.ts`, usando el ejecutable Node fijado: exit0. Aserciones por stdin a Node/esbuild con `prepareDirectionProjection`, `readDirectionRows` y `validate005`: pendientes1, incluido1, conflictos51, pendiente51 en segunda página, excluido1, fail→pass entre datos cambiados, seis UUID distintos y valor UTF-8 de1 MiB+65 bytes. Inventario17/11/18, guardas de tamaños y `git diff --check`: exit0.

### T004–T006: identidad de base de validación

Prueba roja inicial: `node node_modules/vitest/vitest.mjs run --project integration tests/integration/validation-basis.spec.ts` con toolchain fijada,7 fallos por conducta ausente y3 controles aprobados. Tras implementación y caso adicional de selección autorizada de ejecución:11/11. Las publicaciones nuevas asignan UUID; configurar solo conserva la base si los demás datos no cambian. La aplicación reserva la base antes del worker y publica la misma en revalidación/snapshot. Legacy sin base solo reutiliza la versión exacta; exportación nunca relaja la coincidencia de versión.

- `scripts/run-with-toolchain.ps1 run build:api`: PASS.
- Vitest integration/contract: session-jobs, retained-size, direction-review-lifecycle, apply-worker, application-atomicity, revalidation-comparison, proposal-selection-application, validations, results-export:9 archivos/105 pruebas PASS.
- Vitest engine/integration: validation-basis, apply-candidate, validation-run:3 archivos/76 pruebas PASS (incluyen las11 nuevas; no contarlas de nuevo).
- `git diff --check`: PASS. Ejecución Vitest fuera de sandbox tras EPERM de spawn. Sin nuevas pruebas de navegador ni cobertura alojada atribuida a este incremento.

Preparación local adicional: descargada imagen oficial `postgres:17`, digest `sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f`. Aún no se ha creado base de pruebas ni probado SQL; ningún recurso comercial provisionado.

### T007–T009: adaptadores, recibos y contratos de transporte

Los puertos async de repositorio, objetos y despacho tienen adaptadores locales, sin dependencia de PostgreSQL. La hidratación es explícita. Recibos con fingerprint de método/ruta/cuerpo/base se recuperan por clave u operación dentro de la sesión; la escritura de índices es atómica. Un fallo de respuesta tras aceptar conserva el recibo y no ejecuta otro worker. Repetir el If-Match original recupera la operación aunque ahora sea antiguo; sustituirlo por otro arbitrario produce conflicto.

- Prueba roja de adaptadores/recibos: seis fallos esperados por capacidades ausentes. Tras implementar: 58/58 en seis suites (adaptadores, recibos, sesión local, jobs, recursos y atomicidad).
- Regresión de ocho suites de rutas: 79/81 inicialmente. Los dos fallos eran expectativas anteriores que permitían cambiar arbitrariamente If-Match. Tras ajustar a la identidad exacta de petición: operaciones, exportación visual y sesión local, 22/22 PASS. No atribuir 81/81 a una repetición que no se realizó.
- Contratos de intención, sesión, página compacta y partes: 13/13 PASS; esquema cerrado, límites UTF-8, UUID|null para primera carga y manifiestos sin URLs privadas. El primer intento rojo fue módulo ausente (cero pruebas ejecutadas), no trece fallos de comportamiento.
- Typecheck API, build:packages, tipos estrictos de contratos y git diff --check: PASS. No acreditan todavía autenticación alojada, almacenamiento o navegador.

Precisión de UI acordada al integrar: todas las reglas omitidas explícitamente es un estado listo, distinto de no existir candidatos. Se permite una simulación deliberada vacía para conservar esas decisiones; nunca aplicación vacía. Antes de preparar los contadores son desconocidos, no ceros. Una revisión mantiene su ejecución compatible aunque aparezca otra de la misma base.

Docker aislado confirma PostgreSQL17.11 con postgres:17 y límites de128MiB/1CPU, ejecutando solamente --version; aún no hay evidencia SQL funcional ni de capacidad del motor.

### Preparación parcial T053: dependencias alojadas

Instalados los pins pg8.23.1, @types/pg8.23.1, @vercel/blob2.8.2 y @upstash/qstash2.12.1 mediante npm11.19.1, sin scripts de instalación. No cambia ninguna versión del lockfile preexistente; verificado comparando todos sus paquetes anteriores. Imports de los cuatro SDK/tipos y parser de configuración: PASS. La configuración y las pruebas hosted de T053 siguen pendientes.

La instalación reveló GHSA-mrhx-c7xc-m3w5 en Zod4.1.11, transitivo de @vercel/cli-config0.3.1 incluido por OIDC. La corrección puntual fija @vercel/cli-config0.3.6 y Zod4.6.6 con override; el bundle del paquete también necesita la corrección, por eso no basta con sustituir solo Zod. npm update dirigido al paquete y npm ls confirman resolución; npm audit posterior:0 vulnerabilidades conocidas. Esto no es garantía de ausencia de vulnerabilidades. Se mantiene el SDK Blob decidido en el plan y el resto del toolchain.

Fuente de la corrección: https://github.com/advisories/GHSA-mrhx-c7xc-m3w5, consultada2026-11-08; versión corregida4.6.6. Smoke de parseGlobalConfig con objeto sintético válido e inválido, sin leer configuración de usuario ni hacer peticiones a proveedores: PASS. Ninguna cuenta ni despliegue creados.

### US1 en integración: foco, halo y guía

T010 rojo:5 fallos conductuales/5 controles aprobados. Tras implementar el hito de validación por base,19/19 pruebas focales PASS (viewstore10, ResultsStore4, StageFocus5). Configurar ya no anuncia avance; validar completo conserva versión y recomienda Recalcular. Halo hermano del botón dentro de envoltorio propio, sin clases privadas Material.

T011 reprodujo dos fallos reales de baseline en navegador: a390px el halo difería28,83px del ancho del botón; el título tenía focus-visible=false y outline2px solid. En summary no se reprodujo contorno pintado con ratón (outline-style:none aunque el ancho computado fuera3px); con teclado sí3px solid. Se preservó ese comportamiento y se corrigió solo el título con estilo acotado. La geometría final, tres anchuras y modalidades siguen PENDIENTES de T016 después del build integrado; los19 tests unitarios no sustituyen esa evidencia.

Imagen Linux preparada para gates posteriores: node:24.22.2-bookworm-slim, digest sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9; probes aislados sin red con2GiB/1CPU confirman Node24.22.2/npm11.19.1. Son pruebas del runtime, no del paquete ni de capacidad.

### US2 backend y US3 identidad de descarga

T017/T018:13 fallos iniciales por endpoints inexistentes; implementación final incluye17 casos nuevos (7 contrato/10 lifecycle). Build:api PASS; ocho suites/64 pruebas PASS, y tres suites/24 pruebas PASS después de ajustar filtrado de grupos antes de hidratación y rearme de TTL al cancelar. Las repeticiones no se suman como casos distintos.

Comprobados:51 decisiones/productores, diez reentradas sin versiones, configuración equivalente sin versión nueva ni validación adicional, omisiones explícitas completas, GET de revisión caducada sin mutar estado, presupuesto agotado, selección alterada, dependencias fuera de página, CAS y aplicación con nueva base. Un solo worker compila configuración, simula y prepara selección bajo el mismo presupuesto; publicación local atómica, sin prefijos tras fallo/cancelación. La durabilidad entre procesos sigue pendiente de US5.

T034/T037: nuevo contrato inicialmente rechaza con400 la query de intención ausente. Tras implementar, download-intent y results-export:12/12 PASS. Resumen, recibo reservado y artefacto incluyen intención/huella canónica; resultados requieren versión exacta, no solo base. Compatibilidad explícita: Accept application/json devuelve resumen del artefacto; descargaZIP completa continúa como ruta legacy local. Hosted deberá ofrecer resumen/partes privadas y no heredar la descarga completa.

Primer build web integrado PASS (bundle inicial723,34kB frente al aviso700kB; baseline707kB). Primer E2E de guía: geometría corregida comprobada a320/390/1440; cuatro fallos de aserción confundían outlineWidth computado3px con outline-style:none que no pinta contorno. El trace confirma headingPointer y summaryPointer sin estilo visible, teclado3px solid. Se corrige esa aserción y se amplía estática/movimiento reducido/colores forzados a las tres anchuras. Repetición pendiente; no registrar aún T016comoPASS.

### Cierre local US1 — T010–T016

Los cinco casos de workflow-guidance pasan con el build integrado: dos pruebas de foco/movimiento reducido/colores forzados PASS y, después de corregir el locator específico de metadatos y comparar innerText con innerText, los tres recorridos320/390/1440 PASS (33,4s). Las repeticiones previas solo descubrieron aserciones de test mal acotadas; las expectativas de producto se conservaron.

Comprobado: caja/radio/posición del halo igual al botón dentro de1px, sin captura de eventos ni desplazamiento,4500ms y retirada antes5s; ratón sin contorno pintado y teclado con3px solid; estado estático distinguible con movimiento reducido/colores forzados a las tres anchuras; carga→Validar, validación completa→Recalcular conservando versión, fallo de inspección sin avance. Capturas de390y1440 abiertas e inspeccionadas; el intento temprano de abrir1440 mientras se generaba no encontró archivo, la lectura posterior sí. Capturas de test no se confunden con las cuatro imágenes finales pendientes de README.

Rerun tras el último ajuste de presentación/recuperación de US3: export.store, exports.component y workspace-shell,26/26 Angular PASS. Prueba conjunta de19E2E interrumpida por el coordinador antes de completar casos: detectado helper antiguo que esperaba /recalculate en vez de /recalculation-operations; corregido también el ETag tomado antes de la nueva versión compuesta. No se cuenta esa ejecución interrumpida como resultado. Los14 recorridos no visuales están en ejecución separada.

### T053/T060 y arnés base T054: PostgreSQL real

Commit204cd82 contiene configuración de modos/orígenes/secretos/cuotas, migración versionada001 y cliente transaccional PG, transportes controlados y script test:hosted. Primeros rojos por módulos/helper ausentes; primer SQL real16/18 por serialización incorrecta de arrayJSON en fixture, corregida sin cambiar restricciones. Gate final repetido tras canonical_block_edges:22/22 PASS en tres suites (hosted-config, database, harness), tsc API PASS.

Pruebas acreditan migración concurrente/checksum, rollback y release, dos pools independientes, poolMaximum1 para composición futura API1+worker1, unicidad hashes, ownership FK, CAS, límite20 snapshots en carrera, reloj/barreras, ACK perdido y fallos de objetos. Script solo crea y elimina su contenedor PostgreSQL17 por UUID+etiqueta propia; imagen fijada por digest, sin tocar recursos ajenos. Cada suite crea esquema ce_* aislado. Ninguna contraseña o configuración de usuario guardada en repositorio.

T054 tiene infraestructura funcional con factoría createApis; sigue pendiente conectar dos API reales a la composición hosted. Dos pools PostgreSQL no se presentan como dos API ni acreditan aún el recorrido completo, proveedores reales o capacidad. El paquete API posterior debe incluir dist/hosted/migrations/001-demo.sql y sucesoras. Cambios de esquema posteriores a204cd82 se versionan como002+.

### Integración UI2/UI3 y rojo US4

Tras adaptar endpoint exacto y ETag efectivo,14 recorridos de decisiones/descarga:13 PASS,1 fallo al cierre por un intento que permanecía en sessionStorage. El caso fallido sí completó aplicación, comparación, ZIP, resultados, histórico y reimportación exacta; no se cuenta como aprobado. Corrección SessionStore: limpiar solo el namespace propio tras cierre confirmado/sesión inválida, preservarlo ante cierre rechazado/origen no permitido. Rojo focal4fallos/7controles, verde Session11+Attempt4=15PASS; E2E de cierre pendiente de repetición.

Los13PASS incluyen selección global51/dependencias, conflictos con candidato51, cambio de elección, diez entradas sin versión nueva, decisión51 y omisión persistida, cero candidatos, versión1 frente a6/respuesta tardía conZIP real, recuperación de aceptación perdida, reintento sin regenerarZIP, COREP110valores y texto/fechas sin artefactos ajenos.

T045 rojo en build anterior:3/3 fallos esperados por instrucciones manuales obsoletas, selector único de ejecución y detalle numérico vacío de texto/fecha. T046 rojo:3 fallos/14 controles; tras cambios de producto,48 pruebas Angular en cinco archivos PASS. Aún pendiente comprobar las pantallas nuevas y completar inventario; no declarar todos los controles verificados a partir de tests escritos.

### Integración local US2–US4 y regresión general

Repetición tras corregir limpieza de cierre: siete E2E de analyst-controls, apply-export y visual-roundtrip PASS (1min30s). Acreditan recorrido completo, cierre sin intento residual, COREP110 valores/typed6 exactos, filtros, historiales cero/uno/varios y retorno de foco de antecedentes. La ampliación posterior de controles tiene73/73 Angular PASS en siete suites y14 E2E compilados estrictamente; candidato tardío y cierre de detalle tuvieron rojo de foco real antes de corregirse. Cancelar editor de conflicto también devolvía el foco al elemento retirado: rojo1/9controles, verde10/10 tras retorno al resumen, sin PATCH.

Ejecución local general (engine+contract+integration, un worker):1428 PASS/2FAIL sobre1430,87 archivos,454,18s. Ambos fallos se corrigieron conservando guardas: profile-guards construía una ejecución con versionId nuevo y validationBasisId antiguo (fixture corregido,6/6PASS); visual-exports exigía lista anterior sin intent/intentFingerprint (ahora verifica identidad y SHA exactos,9/9PASS). No se atribuye una segunda ejecución general que no ocurrió. La prueba local de volumen informa100000posiciones, query145ms/worker945ms/total10450ms, respuesta33018bytes, RSS final1074049024bytes; no sustituye el gate de capacidad hosted.

Global Angular:205PASS/1FAIL en22suites/206casos. El fallo legacy de preparar selección vacía omitía en su mock el estado de destinos requerido por la operación nueva; corregido solo fixture,14/14focalPASS. Todos los otros21archivos pasaron. Exports-visual11/11PASS, incluyendo cero exclusiones sin desplegable vacío. Build web posterior PASS724,94kB inicial (aviso700kB, error1MB sin modificar). Los23 recorridos E2E ampliados se ejecutan por separado; aún no se acredita su cierre aquí.

### Sesiones, transporte y autoridad SQL incremental

T055/T065/T067 base:40/40 en siete suites SQL/HTTP reales. Dos Fastify independientes comparten PostgreSQL y prueban token/nonce, recuperación sin resurrección, owner404, caducidad/revocación, CORS exacto/preflight/errores y medidas de bytes reales. Las variantes nuevas se llaman routes/hosted-sessions.ts, routes/hosted-bootstrap.ts y plugins/hosted-cors.ts; la composición pública completa sigue pendiente. Se conserva autenticación antes del parser; reserva específica antes de partes se integra con T077.

T063 detectó y corrigió subcuenta de SQL: una reserva futura se sumaba al ledger pero podía quedar oculta tras max(ledger,tamañoSQL). Ahora compara también tamaño medido+reservas pendientes no materializadas. Caso rojo con pg_total_relation_size real y dos pools admitía dos reservas incompatibles; verde11/11 junto a aceptación. No hay mock de tamaño. Migrador incremental verifica cada checksum y protege concurrencia;001 permanece inmutable.

Repositorio4/4 SQL: ownership, metadatos sin hidratar, base compatible y revocación revalidada tras I/O. Coordinación4/4: duplicados, permisoCPU global, plazo desde primerclaim y fence antiguo sin liberar permiso nuevo. Aceptación/outbox5/5: ACK perdido recupera mismojob antes del CAS obsoleto, rollback de hook, red fuera de transacción y sesión vigente. Son incrementos de infraestructura, no recorrido alojado completo.

Codec/objetos17/17 (8 SQL,5 codec,4 fronteraSDK controlada): hashes reales, cadenas exactas, orden, bloques256KiB, partes≤3MiB, deduplicación solo intrasesión, reservas antes de red, revocación antes/después de I/O y reconciliación sin liberar objetos inciertos. Migración002 añade claims;003 añade autoridades de inspección/aplicación. No se contactó Blob real ni se acredita todavía cleanup completo.

Consolidación de infraestructura estable: `test:hosted` con database/quota-ledger/session-service/repository/canonical-codec/blob-object-store/operational-log/hosted-session/hosted-cors/hosted-transfers,10 suites/52 pruebas PASS (16,47s), PostgreSQL real y contenedor propio retirado al finalizar. Incluye división transaccional de reservas de bytes con total constante, sin readmitir ni duplicar presupuesto. Los transportes SDK permanecen controlados. Registro operacional por lista cerrada descarta cuerpo, token, nonce, rutas privadas y errores del proveedor;2 pruebas PASS incluidas.

Regresión ampliada de navegador:23casos,17PASS/6FAIL,5,8min. COREP+texto/fecha en320/390/1440 pasan6/6, FINREP1440 también completa90→100/105→120 y exportación/reimportación. Fallos abiertos antes de corregir: dos FINREP estrechos por carrera al navegar antes del último polling UI; detalle de candidato sin foco tras respuesta; dos helpers de select nativo abrían el popup con Enter en lugar de cerrarlo; y aserción sobre selector que desaparece correctamente al resolver una pendiente. No se rebajan los oráculos; se corregirá producto o helper según causa y se repetirán los casos afectados.

Cierre de los seis E2E afectados:6/6PASS,1,2min, mismo API/motor y build web corregido727,61kB inicial (aviso700kB conservado). Directions13/13focalPASS. Correcciones reales: reintentar recuperación al finalizar validación estando Recalcular activo, ignorando también respuesta de estado anterior; esperar render del detalle antes de cumplir foco, conservando trigger durante GET; al resolver una fila pendiente enfocar encabezado en vez de nodo retirado. El helper select abre popup con Space antes de elegir/cerrar; no se elimina la comprobación Tab/Shift+Tab. Inventario local46 tipos conciliado en controls-005.md; T100 revalidará controles nuevos y cobertura final alojada.

T071: cinco pruebas controladas PASS con SDK QStash2.12.1 real para verificar HMAC actual/siguiente sobre raw body y URL pública exacta, sin depender de Host del visitante. Mensajes cerrados solo IDs, tamaño4KiB, inválidos rechazados antes de JSON, ocupado503 y callback sin2xx antes de terminal durable. Publish sin reintentos SDK ocultos; entrega120s, tres reintentos con backoff y paralelismo1 suplementario a SQL. Outbox reserva conservadoramente cuatro entregas por publicación, incluidas las de respuesta incierta. No se contactó QStash real. Fuentes SDK contrastadas en documentación oficial: https://upstash.com/docs/qstash/howto/signature , https://upstash.com/docs/qstash/features/flowcontrol , https://upstash.com/docs/qstash/features/retry .

T066/T087 avance de composición: dos suites/cuatro pruebas SQL/HTTP PASS y tscAPI --noEmit PASS. Dos instancias reales de createHostedApp recuperan creación y metadatos, separan propietarios, revocan entre instancias y mantienen CORS de errores; bootstrap no entrega token global. Entry Vercel no abre listener ni sirve Angular y espera finish/close de respuesta. Todavía faltan las rutas de dominio/consultas y el recorrido completo; no cerrar T066/T087 por este incremento.

### Ejecución durable, consultas y transferencias

Núcleo durable: cinco suites/28 pruebas PASS antes de ampliar admisión. Hook de reserva dentro de la transacción añade IDs y reserva devueltos por dominio, preserva revisión del servidor y se omite en replay; aceptación7/7PASS. Admisión de dominio3/3SQL PASS tras rojo3/3: diez entradas comparten preparación, GET no escribe, pendientes no simulan, reserva de versión/configuración no publica datos y replay se recupera antes de revisar base/revisión obsoletas.

QStash publicación ajustada tras inspeccionar SDK2.12.1: publishJSON no propaga AbortSignal. El emisor usa REST oficial con URL fija, sin redirecciones/reintento oculto, aborto real10s y mensaje solo IDs; Receiver SDK conserva verificación firma. Seis pruebas PASS incluidas llamada bloqueada y ACK incierto. Fuentes oficiales: https://upstash.com/docs/qstash/features/retry , https://upstash.com/docs/qstash/features/flowcontrol , https://upstash.com/docs/qstash/howto/redact-fields . Sin contacto con proveedor real.

Snapshot/canónico9 pruebas SQL PASS, compartiendo ramas solo intrasesión; query/aceptación11PASS. Páginas firmadas ≤50, tamañoUTF8≤1MiB, valor grande en partes128KiB, owner/revisión/filtro y reautorización tras I/O. Históricos y ejecuciones incompletas retenidas siguen consultables; la admisión de recálculo continúa exigiendo ejecución completa compatible.

Transferencias14/14SQL/HTTP PASS: lotes10, comandos FINREP2 y rutas2. FINREP F01.01 real sintético completa sellado→inspección→importación→exportaciónZIP con originales retenidos; comandos ejecutados en proceso de prueba, todavía pendiente integrar recorrido completo en workers/API/navegador. Crear lote es idempotente por clave antes de CAS;201 perdido se recupera desde otra instancia sin nueva reserva/actividad. SDK/transportes controlados, no Blob real.

Consultas locales: dos suites15/15PASS y tscAPI PASS.51 contextos paginados; workspace y resultados compactos no exponen arrays globales. Una expresión UTF8 de1.100.000bytes se recupera por partes con SHA completo y origen/diagnóstico paginados, sin truncamiento. El recorrido frontend final se ejecutará tras montar todos los endpoints alojados.

Integración HTTP nueva: hosted-http-workflow1/1PASS (17,57s) atraviesa dos APIs reales, PostgreSQL y workers compilados, con originales FINREP cargados porpartes y proveedorprivado filesystem compartido. Sellado→inspeccióncompacta→importación→validación2/3→resumenexacto→exportación ZIP/hash. GET job/resultados/inspección/manifiesto/parte ajenos404; no equivalencia ficticia basada en un mock de motor. Firma usa adaptador controlado en esta suite, con prueba independiente de Receiver real. Recálculo/aplicación y navegación browser todavía pendientes de integrar en este recorrido.

Mantenimiento T058/T076:15/15PASS (tres suites SQL/HTTP), tscPASS.1400 objetos tras cuota pública agotada se borran en14barridos/13horas,14DEL por lotes≤100 y ceroGET con ACKconfirmado; cuota incierta permanece hasta confirmar ausencia. Incluye lease/fence tardío, techoCPU120s, caducidad60min sin pestañas, alerta18h, grafo compartido, paginación metadatos2001filas y ZIPcaducado sin borrar versiones. Límites de trabajo100s, tombstones token/nonce conservados. Pruebas con reloj/proveedores controlados; sin servicio horario real desplegado.

### Reanudación e integración — 16-11-2026

Requisitos:16/16 aprobados; sin hooks de extensión. Se conservaron los cambios de la sesión previa. Docker estaba detenido: el primer intento no ejecutó pruebas SQL y no se contabiliza como PASS; el arranque oculto permitió repetirlas con PostgreSQL17 real. La revisión SQL usaba un reloj del8 de noviembre mientras el codec comprueba el plazo real; se alineó el instante inicial sin retirar ninguna guarda. CORS+revisiones:5/5PASS. Admisión de dominio/selección y HTTP hasta la simulación:6/6PASS.

El navegador separado encontró un defecto que no aparecía con rutas estáticas: hasRoute no resolvía el identificador concreto del conjunto durante el preflight. findRoute resuelve el método y URI real; se añadieron preflight parametrizado y rechazo de método incorrecto. El caso browser de orígenes pasó después:dos procesos, sesiones separadas, tercer origen403, errores legibles y assets404.

T092: deployment-vercel.md y ejemplos de entorno describen configuración realmente implementada, migraciones, orígenes exactos, callbacks firmados, schedule horario, límites/reservas y recuperación antes24h. Las cuotas se contrastaron con fuentes oficiales el16-11-2026. No se han creado cuentas ni desplegado servicios. Mantenimiento recibe el logger redactado también cuando no hay logger de prueba, de modo que cleanup_delayed no se pierde en producción.
