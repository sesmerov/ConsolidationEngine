# Verificación — iteración 004

## Estado

Implementación en curso desde `d4d98f8`, rama `codex/004-flujo-claro-finrep`. Las tareas solo se marcan al completar su comprobación. La observación humana SC-010 permanece pendiente y separada de la automatización.

## Preparación — 2026-11-07

- Árbol limpio al iniciar; checklist documental 16/16, sin hooks de extensión.
- Toolchain local comprobada: Node 24.22.2, npm 11.19.1, TypeScript 6.0.3, Angular/Material 22.2.4, CLI 22.2.5, ANTLR 4.13.2, Vitest 5.0.5 y Playwright 1.64.1. Dependencias presentes; no se instalaron ni actualizaron versiones.
- `.gitignore` cubre dependencias, builds, cachés, archivos de ejecución, secretos y temporales. Proyecto privado sin publicación npm; no se detectaron configuraciones Docker, ESLint, Prettier, Terraform ni Helm que requieran nuevos ignore files.
- Se contrastaron SHA-256 de los dos originales de `tests/fixtures/eba/source-manifest.json` y los cuatro archivos de `assets/demos/manifest.json`: todos coinciden. La fuente FINREP es el original oficial `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7`.
- Puertos 3318 (E2E), 3317 (benchmark) y 3340 (prueba manual) libres al inicio. El proceso del usuario en 3330 se conserva.
- CodeGraph sin índice y `gentle-ai` no disponible; se emplean lecturas directas. Recibos de revisión: disabled/unmanaged.
- Base FINREP: la compatibilidad visual, exportación conservando original y recorrido positivo todavía no están implementados ni acreditados. El probe de coordenadas anterior no demuestra ese soporte.

## Resultados de implementación

T003: escenarios sintéticos 2/3/51 productores, 51 destinos y contextos compatibles preparados. `vitest run --project integration tests/integration/iteration004-fixtures.spec.ts`: 5/5 pasan. Se identifica expresamente el sembrado frente al recorrido visual completo.

## Aceptación humana

SC-010 pendiente de observación con la versión de esta iteración. Una valoración global no sustituye el detalle de las acciones observadas.

## Primer incremento de interfaz

US1/2: acciones principales verdes, realce de etapa durante tres ciclos de 1,5 s, movimiento reducido/foco, retirada de controles técnicos e identificadores visibles y progreso exitoso solo oculto tras presentar su resultado. Se conservan errores, temporalidad, exclusiones, valores exactos y origen legible.

Pruebas Angular focales: 47 casos en cuatro suites. Build web: 690,75 kB iniciales, por debajo del aviso de 700 kB. Playwright: 4 casos iniciales (información útil y anchos 320/390/1440) pasan; el caso de movimiento reducido pasa tras ajustar su matcher de respuesta. Contraste de texto renderizado ≥4,5:1, foco conservado y pulso limitado a 4,5 s. Las capturas se regenerarán en la verificación integrada porque Playwright limpia salidas al reejecutarse.

El recorrido de los tres hitos, los detalles de comparación y todos los negativos se cerrarán después de integrar conflictos/selección. T010/T019 y los SC completos no se marcan todavía.
