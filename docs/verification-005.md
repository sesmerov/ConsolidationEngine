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
