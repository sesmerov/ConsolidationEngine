# Implementation Plan: Acciones claras, selección de recálculos y FINREP F 01.01

**Branch**: `codex/004-flujo-claro-finrep` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: `specs/004-flujo-claro-finrep/spec.md`, 23 requisitos y 10 criterios de éxito. Diseño terminado; implementación y aceptación pendientes.

## Summary

La iteración dará una jerarquía clara a las acciones, sustituirá la etiqueta de siguiente paso por un realce breve de la etapa y retirará la información interna de la interfaz. Los conflictos se podrán resolver y volver a editar mediante opciones excluyentes. La selección de propuestas se mantendrá en el servidor para permitir preselección y acciones sobre todas las páginas, con una confirmación independiente antes de escribir.

Se incorporará un perfil acotado de FINREP F_01.01 para la cuadrícula de 38 importes del anexo 4.0 fijado. La exportación conservará las hojas excluidas seguras y permitirá cargar de nuevo el archivo sin la sesión original. La demo propia verificará cinco reglas y dos cambios encadenados: 90 → 100 y 105 → 120.

La investigación detectó tres límites que el diseño resuelve: los grupos desaparecen al resolverlos; la selección y los recibos actuales transportan arrays que no caben en el límite de petición; la exportación COREP reconstruye una plantilla y no cumple la conservación de hojas requerida para FINREP. [Decisiones y alternativas](research.md).

## Technical Context

| Aspecto | Diseño fijado |
| --- | --- |
| Language/Version | TypeScript 6.0.3; Node 24.22.2 y npm 11.19.1; lexer/parser JavaScript ANTLR 4.13.2. |
| Primary Dependencies | Angular/Material/CDK 22.2.4, CLI/build 22.2.5, RxJS 7.8.2; Fastify 5.12.7, multipart 10.1.6, static 10.1.8; read-excel-file 9.3.14, write-excel-file 4.1.1, sax 1.6.1 y yauzl 3.4.0. Reutilizar compresión nativa y escritor ZIP incremental. No se añade dependencia de producto. |
| Storage | Estado efímero local en snapshots y registros JSON acotados; originales retenidos por SessionFiles. Una selección por simulación, candidata y revisión publicada; fuentes y exportaciones sometidas a las cuotas vigentes. Sin nueva base de datos. |
| Testing | Vitest 5.0.5, pruebas Angular y Playwright 1.64.1. Contratos, integración de workers/archivos, regresiones de motor, recorridos Chromium y revisión humana separada. |
| Target Platform | Aplicación local en Windows x64 y navegador Chromium; anchos de 320, 390 y 1440 px, teclado, tacto, lector de pantalla y movimiento reducido. |
| Project Type | Monorepo npm: Angular, API Fastify y motor de cálculo puro. Los perfiles de informe son adaptadores de entrada/salida, no nuevas semánticas de evaluación. |
| Performance Goals | Mantener búsqueda de catálogo de hasta 500 filas en ≤1 s y protocolo existente de validación de 500 reglas/100.000 lecturas: 9/10 ensayos ≤30 s y 10/10 ≤60 s en el equipo de referencia. No hacer recorridos globales síncronos en el hilo HTTP. Selección y cierre grandes usan worker con límite de 60 s; páginas 50, máximo 200. |
| Constraints | Petición JSON 1 MiB; worker 256 MiB de old generation; una operación no terminal; 20 snapshots; cuotas de 512 MiB para estado y archivos según sus contadores existentes. Hasta 1.000.000 instancias/aristas y 10.000.000 lecturas. Mantener límites de carga 10 MiB/archivo, 50 MiB/lote comprimido y 100 MiB expandido. |
| Scale/Scope | 500 filas de catálogo y 100.000 coordenadas/hechos; selección significativa de volumen de hasta 100.000 destinos disponibles distintos. Un millón de posiciones es límite de representación/instancias, no promesa de un millón de escrituras aplicables. F_01.01 tiene 38 coordenadas. |
| Budget web | Conservar aviso de bundle inicial a 700 kB y error a 1 MB. Cargar detalle de candidatos y propuestas por páginas o bajo demanda. |

## Constitution Check

*Evaluación antes de investigación y revisión posterior al diseño.*

| Principio | Puerta inicial | Resultado después del diseño |
| --- | --- | --- |
| I. Semántica explícita y cobertura honesta | No ampliar el lenguaje por cambiar la interfaz ni confundir el probe antiguo con soporte visual. | Cumple: perfil FINREP cerrado, fuentes identificadas, alias local separado de taxonomía oficial; condicionales/texto/fechas/desigualdades solo validan. |
| II. Resultados reproducibles | Conservar base, reglas, contexto, precisión y decisiones. | Cumple: selección identificada por revisión, grupo por destino/contexto, fuentes con hash y exportación reimportable. Quitar identificadores de pantalla no borra registros. |
| III. Recálculos controlados | Guardar destinos y preseleccionar no autorizan escritura. | Cumple: confirmación explícita de selección/revisión, bloqueo durante incertidumbre, revalidación de cierre en worker, publicación atómica y originales conservados. |
| IV. Dependencias verificables | No resolver productores o ciclos mediante prioridad silenciosa. | Cumple: grupos editables sin trasladar candidatos desde otro destino; selección reconoce antecedentes; Kahn y diagnósticos existentes permanecen. |
| V. Evidencia e incrementos | Separar diseño, automatización futura y observación humana. | Cumple: matriz de cobertura, protocolos de negativos/volumen y SC-010; commits por incremento, sin datos privados. |
| Restricciones del proyecto | Mantener toolchain, procesamiento local y archivos como datos. | Cumple: ANTLR sin cambios de gramática, sin eval ni ejecución de fórmulas/macros; preflight global y fuentes verificadas antes de exportar. |
| Gobierno | Planificar antes de crear tareas/implementar. | Cumple: el diseño de Phase 0/1 precede al desglose en tasks.md; no se modifican fuentes de producto. Recibos de revisión: disabled/unmanaged. |

No se necesita excepción a la constitución. El cambio de 6 a 4,5 segundos se documenta en investigación y en la especificación; preserva el comportamiento pedido y reduce movimiento innecesario.

## Project Structure

### Documentation (this feature)

```text
specs/004-flujo-claro-finrep/
├── spec.md
├── evidencia.md
├── checklists/requirements.md
├── plan.md
├── research.md
├── data-model.md
├── quickstart.md
├── tasks.md
└── contracts/
    ├── ui.md
    ├── proposal-selection.md
    └── finrep-f0101.md
```

El desglose de implementación se encuentra en [tasks.md](tasks.md): 83 tareas de las cinco historias y sus comprobaciones. `docs/verification-004.md` será evidencia de implementación, no un artefacto de pruebas ejecutadas en este plan.

### Source Code (repository root)

| Frontera existente | Trabajo previsto |
| --- | --- |
| `apps/web/src/app/workspace/`, `core/` | Realce deduplicado por operación, acción principal por estado y progreso visible solo cuando aporte información. |
| `apps/web/src/styles.scss`, `shared/` | Estilo de acción principal y foco; explicación de negocio sin volcados ni identificadores. Mantener renderizado exacto de importes. |
| `apps/web/src/app/import/` | Formulario y elección de perfil por informe, cobertura/exclusiones y demo FINREP; retirada de ayuda técnica. |
| `apps/web/src/app/validation/`, `recalculation/` | Grupos de conflicto estables y editables, selección compacta con páginas de cambios/antecedentes, confirmación ligada a revisión y recibo compacto. |
| `packages/contracts/src/` | Grupos/candidatos, selección, alternativa de petición y recibo de aplicación; perfil FINREP y elección de perfil en inspección. Validación estricta y compatibilidad explícita. |
| `packages/engine/src/recalculation/` | Índice estable de candidatos, proyección de selección ordinal y cálculo presupuestado del cierre; reutilizar política y Kahn. |
| `apps/api/src/routes/`, `recalculation/`, `jobs/`, `workers/`, `session/` | Rutas paginadas, trabajos de selección, reservas/revisiones/idempotencia, invalidación y proyecciones compactas. |
| `apps/api/src/import/profiles/`, `import/xlsx-preflight.ts` | Perfil y mapping FINREP, despacho de candidatos reconocidos, contexto compartido con guards por perfil. |
| `apps/api/src/export/`, `routes/exports.ts`, `workers/` | Exportador FINREP sobre original retenido y verificado; conservación de partes, contexto reimportable y serialización exacta. |
| `scripts/prepare-visual-templates.mjs`, `scripts/create-visual-demos.mjs`, `assets/demos/` | Derivar plantilla y demo FINREP reproducibles, fijar hashes y empaquetar; actualizar guías de demos por nuevos controles/preselección. |
| `packages/engine/test/`, pruebas Angular, `tests/contract/`, `tests/integration/`, `tests/e2e/`, `tests/performance/` | Casos de contratos, carreras, conservación del libro, exactitud, UX y volumen. |

**Structure Decision**: conservar los paquetes y fronteras actuales. Los nuevos recursos son temporales del workspace; los perfiles se registran por capacidades verificadas. Los contratos de diseño nombran las ampliaciones precisas y distinguen archivos nuevos de los existentes.

## Phase 0 — Investigación concluida

Las decisiones D1–D8 de [research.md](research.md) fijan las fuentes y alternativas. No quedan marcadores de aclaración. Las bibliotecas se contrastaron con los manifiestos/archivos instalados y la documentación primaria. El contexto FINREP usa un alias local respaldado por la cuadrícula de presentación; no se atribuye a un módulo oficial no verificado.

## Phase 1 — Diseño

### Interfaz, navegación y conflictos

El estado de navegación sigue relacionado con una publicación confirmada. La duración visual se mide desde la aceptación del nuevo hito y no se reinicia por nuevas lecturas o renderizados. Estado activo y recomendado tienen señales distintas; las acciones de consulta y descarte no heredan el verde principal.

La revisión de destinos tendrá un catálogo de candidatos separado de las asignaciones activas. Permanecerán consultables los grupos que tuvieron conflicto, con resumen de su decisión y candidatos paginados. Un único editor local por pantalla evita convertir las flechas del grupo de radio en sucesivas mutaciones remotas. [Contrato de interfaz y grupos](contracts/ui.md).

### Selección, confirmación y aplicación

Una simulación nueva publica su registro de selección una sola vez. Los GET recuperan el registro existente y nunca preseleccionan. Un comando de edición prepara una revisión candidata en worker; solo una publicación completa sustituye la anterior. La UI conserva una página y resúmenes, no todos los ProposalDTO.

La aplicación acepta una referencia inmutable a una revisión. El recibo compacto y las páginas de comparación evitan devolver de nuevo la lista global. El contrato legado de arrays sigue disponible para clientes y regresiones existentes. [Contrato de selección](contracts/proposal-selection.md) · [Modelo de datos](data-model.md).

### FINREP y conservación del informe

Se mantiene una misma entidad y fecha por conjunto y el rechazo de coordenadas de negocio duplicadas; la cota de veinte informes no autoriza copias de F_01.01. El reconocedor valida la cuadrícula contra la fuente fijada y mapea las 38 posiciones por sus códigos reales. Un libro ambiguo requiere elegir entre perfiles realmente reconocidos. La hoja Contexto y el formulario deben coincidir si ambos aportan datos.

El exportador FINREP valida propiedad, fuente y mapping; parchea los importes de la versión elegida y escribe contexto reimportable. Las partes excluidas admitidas por el preflight conservan su contenido. La validación posterior compara datos, contexto, estructura y partes no modificadas, incluidos históricos y varias aplicaciones. [Contrato FINREP](contracts/finrep-f0101.md).

## Incrementos previstos y dependencias

| Orden | Incremento | Criterios y salida comprobable |
| --- | --- | --- |
| 1 | Jerarquía de acciones, realce accesible y retirada de información interna. Actualizar en el mismo incremento las pruebas basadas en controles retirados. | SC-001–003; nuevos controles y foco a tres anchos, reducción de movimiento, mensajes accionables y cero datos técnicos visibles. |
| 2 | Modelo y contratos de grupos estables; después API y editor de conflictos. | SC-004; elegir/cambiar/omitir con 2, 3 y más de 50 candidatos, sin escrituras de hechos, sin mover candidatos de otro destino. |
| 3 | Selección compacta, publicación y aplicación por referencia; después tabla/confirmación paginadas. | SC-005–006; cinco preseleccionadas, 51 y 100.000 seleccionables, carreras, recuperación, cuotas y compatibilidad de arrays. |
| 4 | Perfil FINREP, contexto, reconocimiento y elección de perfil; después exportación conservando fuente. | Primera parte de SC-007–008; 38 coordenadas, exactitud, exclusiones explícitas, fuentes/bindings verificados y partes conservadas. |
| 5 | Demo FINREP y recorridos integrados; adaptar guías COREP/tipadas. | SC-007–009 completos; antes 2 pasa/3 falla, después 4 pasa/1 falla; dos cambios encadenados y regreso por Excel. |
| 6 | Cierre de verificación y observación humana. | Suite pertinente, build/hash de parser, regresiones de búsqueda/volumen y SC-010 documentado separadamente. |

Los incrementos 1 y 4 pueden prepararse independientemente de selección. El recorrido FINREP completo depende de 2–5. Al generar tareas se concretarán contratos/pruebas antes de los productores y consumidores correspondientes; cada incremento tendrá commit acotado y resultado registrado.

## Estrategia de verificación

- **Motor/contratos**: clasificación de candidatos y cierres; revisiones/identidades; forma antigua y nueva de aplicación mutuamente excluyentes; respuesta compacta; validadores FINREP y filtros coherentes.
- **Integración**: cancelación, timeout, cuotas, fuente alterada, cambio de versión durante worker, operación repetida, original conservado y ausencia de publicaciones parciales.
- **Navegador**: progresión de etapas, foco/movimiento, contraste, eliminación de identificadores incluso en errores/comparación/exportación, radios paginados, selección fuera de filtro y aceptación invalidada.
- **Excel**: 38 posiciones, anclajes, vacíos/ceros/decimales, escala, contexto, hojas excluidas, fuente propia, múltiples aplicaciones e históricos, regreso por archivo descargado.
- **Volumen**: transporte compacto para 100.000 seleccionables; representación hasta un millón de posiciones; cuotas negativas sin pérdida del estado anterior; regresión del protocolo de validación anterior, con mediciones y entorno registrados.
- **Humana**: SC-010 se observa con una versión funcional y datos sintéticos. No se sustituye por tests ni se deduce de una aprobación global.

La [guía de validación](quickstart.md) contiene comandos y resultados previstos. No se han ejecutado estas pruebas nuevas durante la planificación.

## Complexity Tracking

No hay violaciones que justificar. El estado adicional de selección y de grupos resueltos evita listas masivas y pérdidas de decisiones; reutiliza el ciclo de vida de workspace y jobs. La exportación FINREP necesita conservar el original porque la reconstrucción actual no cumple FR-019. Se mantienen los límites existentes, el motor puro y el despliegue local.
