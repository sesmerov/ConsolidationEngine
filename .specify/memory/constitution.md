# ConsolidationEngine Constitution

## Core Principles

### I. Semántica explícita y cobertura honesta

Toda regla DEBE conservar su expresión original, procedencia, contexto regulatorio y versión.
Reconocer una expresión mediante la gramática NO demuestra que su significado esté implementado.
Cada operación admitida DEBE tener semántica documentada y casos de aceptación con resultado conocido.
Una construcción, versión o contexto no soportado DEBE producir un diagnóstico visible; nunca un
resultado aprobado. No se permite ejecutar expresiones como código mediante `eval`, `Function`
o mecanismos equivalentes. Las fuentes EBA originales DEBEN conservarse sin modificaciones.

### II. Resultados reproducibles

Una ejecución DEBE identificar las versiones de reglas, informes, perfil semántico y configuración.
Con las mismas entradas DEBE producir los mismos valores, estados y orden observable, excluyendo
identificadores y marcas de tiempo. El motor DEBE distinguir ausencia, cero, valor inválido y dato
no aplicable. El tratamiento decimal, unidades, redondeo e intervalos DEBE estar documentado y
probado; ninguna tolerancia se puede presentar como criterio EBA sin una fuente que la sustente.
Los resultados DEBEN permitir reconstruir los datos y decisiones que los originaron.

### III. Recálculos controlados

La validación DEBE leer una versión de los datos sin modificarla. Una propuesta de recálculo DEBE
tener destino inequívoco, entradas identificadas y explicación de cómo se obtuvo el nuevo valor.
Una igualdad de validación no autoriza por sí sola a elegir qué operando modificar. Antes de aplicar
cambios, el usuario DEBE poder verlos y aceptarlos explícitamente. La aplicación DEBE conservar el
original, ser atómica para el conjunto aceptado, verificar que la propuesta sigue vigente y provocar
una nueva validación. Cancelar o fallar DEBE dejar intacta la versión de trabajo anterior.

### IV. Dependencias verificables

Las dependencias de recálculo DEBEN derivarse de las entradas y salidas concretas de cada operación,
incluidos entidad, periodo y coordenadas. Se DEBE utilizar el algoritmo de Kahn para obtener un orden
topológico estable. Dos operaciones que solo leen la misma celda no forman por ello una dependencia.
Los conflictos de productores, ciclos y operaciones bloqueadas por ellos DEBEN distinguirse y
explicarse. El residuo de Kahn no se puede etiquetar íntegramente como ciclo: también puede contener
consumidores posteriores. No se permite resolver ciclos mediante iteraciones silenciosas. Las ramas
independientes válidas DEBEN poder continuar.

### V. Evidencia y entrega incremental

Cada funcionalidad DEBE vincular requisitos y escenarios verificables con su implementación.
Las comprobaciones DEBEN cubrir comportamiento de negocio, errores y límites relevantes; no basta
con que el proyecto compile. Fixtures sintéticos, resultados esperados, pruebas ejecutadas y
compatibilidad real DEBEN identificarse por separado. Cada funcionalidad terminada DEBE registrarse
en un commit acotado con la validación realizada y sus límites. No se deben registrar informes
privados, credenciales ni salidas locales de ejecución en Git.

## Restricciones del proyecto

- Frontend Angular y backend Node.js, según la elección del usuario.
- Generación de lexer y parser JavaScript con ANTLR a partir de `grammar/`. La generación DEBE ser
  reproducible con versiones exactas y compatibles de herramienta y runtime. El plan definirá esas
  versiones y la adaptación del nombre de los archivos sin alterar las fuentes originales.
- La gramática analiza la sintaxis; un componente semántico separado DEBE resolver referencias,
  operaciones, precondiciones y resultados. El frontend no será la autoridad del cálculo.
- La primera versión importará un catálogo reducido de reglas desde Excel y los informes desde una
  plantilla Excel propia. Un catálogo de ejemplo no define por sí mismo el alcance soportado.
- Los ficheros importados se tratarán como datos: no ejecutar macros, fórmulas Excel ni enlaces
  externos. Se DEBEN aplicar límites de tamaño y trabajo antes y durante el procesamiento.
- Los datos de los informes permanecerán en el entorno de ejecución del usuario. Cualquier futura
  integración que los envíe a terceros requiere una decisión explícita de producto.

## Flujo de desarrollo

El proyecto sigue Spec Kit: constitución, especificación, aclaraciones cuando aporten valor,
planificación, tareas e implementación. Cada fase DEBE describir su estado real. Esta primera fase
establece requisitos; no acredita un parser generado, un motor operativo ni rendimiento medido.

Antes de implementar, el plan DEBE concretar la plantilla, el perfil de lenguaje, las políticas
numéricas, los contratos y los casos de prueba. Antes de cerrar una funcionalidad se DEBEN ejecutar
las comprobaciones pertinentes y registrar los resultados. Una ampliación de alcance DEBE
actualizar primero los requisitos afectados. Los commits serán progresivos; publicar un remoto no
forma parte del alta local de este repositorio.

El desarrollo con recibos permanece `disabled/unmanaged`, conforme a la preferencia por defecto
del proyecto. Esta constitución no habilita revisiones automáticas ni cambia ese interruptor.

## Governance

Esta es la adopción inicial, versión 1.0.0, basada en la solicitud del usuario del 2026-10-31.
Las instrucciones explícitas del usuario prevalecen. Los supuestos de alcance de la especificación
son revisables y no constituyen decisiones regulatorias oficiales.

Toda enmienda DEBE documentar el motivo y los requisitos afectados. Se usará versionado semántico:
MAJOR para retirar o redefinir principios de forma incompatible, MINOR para añadir o ampliar
obligaciones y PATCH para aclaraciones sin cambio de significado. Al modificar la constitución,
las siguientes fases DEBEN comprobar su coherencia con ella. Cualquier excepción DEBE quedar
justificada en el artefacto afectado, sin inventar aprobaciones ni evidencias de cumplimiento.

**Version**: 1.0.0 | **Ratified**: 2026-10-31 | **Last Amended**: 2026-10-31
