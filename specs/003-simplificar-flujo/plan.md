# Implementation Plan: Simplificar el recorrido de validación

**Rama** `codex/003-simplificar-flujo` · **Fecha** 2026-11-06 · **Alcance aprobado** 17 requisitos y 9 criterios de éxito. [Especificación](spec.md)

## Summary

La iteración reduce las decisiones visibles durante la carga, la validación y el recálculo. Al analista se le propone el único lado elegible de cada igualdad y se le pide intervenir cuando hay dos alternativas o varios productores para una celda. Guardar esa configuración, simular y autorizar la escritura son tres operaciones diferenciadas.

Las dos mejoras incorporadas tras la revisión se pueden entregar como un primer incremento de interfaz. La cabecera muestra entidad, fecha y módulo como lectura si existe un contexto y permite elegir cuando hay varios. La confirmación aparece con la primera propuesta seleccionada en toda la simulación y desaparece al quitar la última. Una selección incompleta puede verse y revisarse, pero aplicar exige que la selección concreta cumpla las condiciones de seguridad.

## Technical Context

| Aspecto | Decisión de planificación |
| --- | --- |
| Proyecto | Monorepo npm con aplicación Angular Material, API local Fastify y motor puro. Se amplían las fronteras existentes entre interfaz, contratos compartidos, trabajos y snapshots. |
| Herramientas fijadas | Node 24.22.2, npm 11.19.1, TypeScript 6.0.3, Angular/Material/CDK 22.2.4, CLI/build 22.2.5, RxJS 7.8.2, Fastify 5.12.7, estáticos 10.1.8 y ANTLR 4.13.2. Se aprovechan las dependencias actuales. |
| Estado | Una sesión efímera local y un conjunto activo por proceso. Borrador de revisión acotado por conjunto y ejecución. Configuración guardada en una nueva versión inmutable. Estado de navegación y selección en stores de sesión/conjunto. |
| Volumen y recursos | Hasta 500 filas de catálogo, 100.000 coordenadas/hechos y 1.000.000 de instancias. Un trabajo no terminal, 60 s por trabajo, old generation de worker de 256 MiB, veinte snapshots y cuotas separadas de 512 MiB de estado y archivos. El límite ordinario de petición JSON es de 1 MiB. |
| Rendimiento observable | Filtro correcto en ≤1 s desde la última entrada para un catálogo de hasta 500 filas en el equipo de referencia 002. Páginas de 50 por defecto y consultas acotadas. Mantener presupuesto de bundle de 700 kB de aviso / 1 MB de error. Las lecturas de páginas ordinarias de resultados deben seguir siendo independientes de preparar una revisión global. |
| Plataforma y pruebas | Windows x64, Chromium, Vitest 5.0.5 y Playwright 1.64.1. Comprobar teclado, toque y anchos de 320/390/1440 px. E2E en 3318, benchmark en 3317 y pruebas de API aisladas. La guía concreta las órdenes y distingue comprobaciones futuras de la evidencia ya ejecutada. [Guía de validación](quickstart.md) |

## Constitution Check

| Principio | Evaluación inicial | Comprobación del diseño |
| --- | --- | --- |
| I. Semántica explícita | La sugerencia usa la política y la elegibilidad que resuelve el motor. | Cada instancia distingue cero, uno o dos lados y comprobación indeterminada. Se respetan precondiciones, perfiles y exclusiones de solo validación. |
| II. Reproducibilidad | Una decisión se refiere a una ejecución completa y a su versión. | La revisión identifica base, ejecución y revisión de edición. Se preservan las elecciones guardadas y se trata de forma explícita la ausencia de procedencia en datos anteriores. |
| III. Recálculos controlados | La autorización del usuario para guardar destinos es independiente de aplicar importes. | El commit valida la base y publica una configuración completa. La aplicación exige simulación vigente, selección cerrada, aceptación y revalidación. El panel se oculta con cero propuestas sin perder la recuperación de un intento incierto. |
| IV. Dependencias verificables | Dos productores pueden tener el mismo destino aunque ambos lados sean inequívocos por separado. | Se compara la identidad completa de la celda y se resuelve el productor antes de guardar. Kahn, los ciclos, las ramas independientes y la selección explícita de antecedentes conservan su función en el motor. |
| V. Evidencia e incrementos | Distinguir propuestas de diseño, pruebas futuras y evidencia de compatibilidad ya ejecutada. | Hay criterios trazables por incremento y un ensayo FINREP reproducible. Los protocolos 002 de uso de la interfaz antigua se conservan identificados como históricos. |
| Privacidad y ejecución local | La identidad pública del producto solo requiere datos genéricos. | Portada y favicon se sirven localmente como recursos estáticos. Los datos, identificadores operativos y credenciales de la sesión quedan fuera de la información de descubrimiento. |

La revisión inicial y la posterior al diseño cumplen la constitución. Los límites del perfil reglamentario están descritos en la evidencia del ensayo FINREP. [Constitución](../../.specify/memory/constitution.md) · [Evidencia](evidencia.md)

## Project Structure

| Frontera | Archivos y responsabilidad previstos |
| --- | --- |
| Cargar y navegación | `apps/web/src/app/import/`, `workspace/` y `core/session.store.ts`. Simplificar la carga, aislar controles de búsqueda, presentar contextos y asociar el siguiente paso a publicaciones confirmadas. |
| Validar y recalcular | `apps/web/src/app/validation/` y `recalculation/`. Adaptar DirectionsStore al resumen y páginas de revisión. PreviewStore aporta la selección completa. ApplyStore conserva el intento, la aceptación y la respuesta incierta. ExportStore puede descargar la versión del recibo. |
| Motor y API | `packages/engine/src/recalculation/`, `packages/contracts/src/`, `apps/api/src/recalculation/`, `routes/`, `jobs/`, `workers/` y `session/`. Reutilizar resolución por instancia y WorkBudget. Añadir contratos y trabajos para preparar y confirmar la revisión de destinos. Integrar sus recursos con la invalidación de versiones y el cierre de sesión. |
| Identidad | `apps/web/src/index.html`, `apps/web/src/app/app.component.ts`, estilos y entrada de assets en `apps/web/angular.json`. Empaquetar un símbolo local para cabecera y pestaña. Fastify sirve el directorio de build. |
| Verificación | Suites del motor, Angular, `tests/contract/`, `tests/integration/`, `tests/e2e/`, `tests/performance/` y `scripts/benchmark.mjs`. Los datos sintéticos antiguos se pueden preparar por la API en el proceso de pruebas. |
| Entregables de diseño | [Investigación](research.md), [modelo de datos](data-model.md), [contrato de interfaz](contracts/ui.md), [contrato de revisión de destinos](contracts/direction-review.md) y [guía de validación](quickstart.md). |

## Fase 0. Decisiones cerradas

El principal cambio de arquitectura es revisar **todo el conjunto de destinos de una ejecución**, incluidas las filas que el analista aún no ha visto. El guardado existente sustituye una configuración entera y el servidor impone límites de tiempo, memoria y transporte. Una revisión temporal permite calcular el resumen y los conflictos en el servidor, consultar filas por páginas y enviar solo las decisiones que cambian. El contrato conserva la vía de sustitución explícita que utilizan los clientes actuales. [Decisiones y alternativas](research.md)

El ensayo FINREP ya estableció el límite de entrada actual. El extracto visual F_01.01 se rechazó durante el reconocimiento y dejó cero versiones publicadas. El mismo catálogo sobre cuatro coordenadas equivalentes en `ce-report-1` produjo la suma y la desigualdad esperadas. La entrega 003 retira ese recorrido antiguo de la interfaz y conserva la comprobación independiente de la capa de cálculo. [Resultado observado](resultado-finrep.json)

## Fase 1. Diseño e incrementos previstos

| Orden | Incremento | Evidencia que deberá aportar la implementación |
| --- | --- | --- |
| 1 | Cabecera según contextos y confirmación según selección global. | FR-016–017, SC-008–009. Transiciones 0/1/varios, selección fuera de página, desmarcar y volver a marcar, respuestas tardías, histórico aplicado y foco. |
| 2 | Retirada de la experiencia de carga anterior, ayuda compacta y filtro automático. Migrar en el mismo incremento las pruebas que dependían del control retirado. | FR-001–004, SC-001–002. Dos demos visuales accesibles, exclusiones/error visibles, búsqueda parcial en todo el catálogo dentro del umbral y protección contra cursores o respuestas anteriores. |
| 3 | Revisión global de destinos y configuración versionada. Primero contrato, clasificación y publicación, después consumo por la interfaz y actualización de la guía COREP. | FR-005–009, SC-003–004. Único destino en cualquiera de los lados, ambigüedad, omisión, cuotas, colisión en r0070, cinco cambios COREP y cero propuestas tipadas. Comprobar sustitución completa, replay y concurrencia. |
| 4 | Recomendación de siguiente etapa a partir de la carga publicada, del guardado confirmado o de la aplicación publicada. | FR-010–012, SC-005. Tres hitos, un solo distintivo, sin robo de foco. Descarga vinculada al recibo aun con historial distinto. |
| 5 | Símbolo común y metadatos estáticos de portada. | FR-014–015, SC-007. Lectura inicial con y sin sesión y sin ejecutar JavaScript, favicon efectivo a 16/32 px, recurso local y ausencia de datos del conjunto. |
| 6 | Cierre transversal y caracterización FINREP. | FR-013, SC-006 y regresiones de los otros incrementos. Reproducir el ensayo de comparación si cambia su entorno o el importador. Registrar por separado evidencia funcional, medidas y prueba de uso. |

La planificación deja listos los contratos para desglosar las tareas. La publicación pública, una ampliación del importador FINREP y las otras dos sugerencias de UX recogidas en la evidencia quedan fuera del alcance aprobado.

## Complexity Tracking

El coste adicional es un recurso temporal de revisión en la API. Reutiliza los trabajos, presupuestos, claves de idempotencia y publicación de snapshots del producto. Su justificación es poder detectar colisiones y confirmar el alcance completo sin transferir un millón de instancias al navegador ni fiar el guardado a las páginas visitadas. La sesión y el proceso de despliegue siguen el modelo existente.
