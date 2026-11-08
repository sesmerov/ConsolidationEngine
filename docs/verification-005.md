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
