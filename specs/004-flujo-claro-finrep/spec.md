# Feature Specification: Acciones claras, selección de recálculos y FINREP F 01.01

**Feature Branch**: `codex/004-flujo-claro-finrep`

**Created**: 2026-11-07

**Status**: Planificación completada el 2026-11-07; lista para desglosar tareas. Comportamiento propuesto, pendiente de implementación y pruebas. Véase [plan.md](plan.md).

**Input**: Nueva iteración solicitada por Diego: destacar la siguiente etapa sin el rótulo «Siguiente paso», dar un color distintivo a las acciones principales, eliminar información técnica innecesaria, mejorar la resolución de conflictos, seleccionar varios recálculos con preselección de los que tienen destino único y confirmar el funcionamiento de FINREP F 01.01.

**Clarificación del 2026-11-07**: Diego confirma que el selector múltiple corresponde a las propuestas de Recalcular, con casillas, «Seleccionar todas», preselección inicial y confirmación antes de aplicar.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Identificar la acción principal y la etapa a la que continuar (Priority: P1)

Como analista, quiero reconocer la acción que permite avanzar y localizar la etapa siguiente después de que termine correctamente.

**Why this priority**: La indicación actual se parece a una etiqueta secundaria. Los botones para continuar compiten visualmente con acciones de consulta.

**Independent Test**: Recorrer una carga, un guardado de destinos y una aplicación, incluyendo un fallo y un reintento, con ratón y teclado.

**Acceptance Scenarios**:

1. Al confirmar una carga y publicarse sus datos, el elemento completo «2. Validar» recibe un realce visible. Al guardar destinos utilizables se realza «3. Recalcular»; al aplicar y publicarse la nueva versión, «4. Descargar». No aparece texto visible «Siguiente paso» debajo, al lado ni dentro de las etapas.
2. La etapa recomendada presenta borde, fondo y un indicador direccional que la distinguen de la etapa abierta. Realiza tres pulsos suaves en 4,5 segundos, una vez por operación confirmada, y después mantiene su realce estático hasta visitarla o quedar sustituida por un hito vigente. Con movimiento reducido, el realce es estático desde el principio.
3. La indicación no cambia de pantalla ni mueve el foco por sí sola. Un lector de pantalla recibe una única descripción de la etapa recomendada. Consultar resultados, repintar la pantalla o recuperar una respuesta repetida no reinicia el pulso.
4. En cada estado existe como máximo una acción principal habilitada de color verde sólido. Su texto expresa lo que hará. Las acciones de consulta, cancelar, descartar u omitir son secundarias; cerrar y descartar datos nunca adopta el verde de avance.
5. Un trabajo pendiente, fallido, cancelado, incompleto o perteneciente a otra versión no recomienda avanzar como si hubiera terminado. Descargar desde el resultado aplicado identifica la versión recién publicada aunque hubiera otra histórica elegida.

### User Story 2 - Trabajar con información que ayuda a decidir (Priority: P1)

Como analista, quiero ver archivos, reglas, resultados, cambios y problemas que puedo resolver, sin bloques de identificadores o explicaciones internas del motor.

**Why this priority**: Ocultar los datos técnicos detrás de un botón mantuvo un apartado que el usuario ha pedido eliminar.

**Independent Test**: Abrir las cuatro etapas y un detalle de cálculo; repetir con un archivo no compatible, una exclusión, un redondeo y una operación caducada.

**Acceptance Scenarios**:

1. Cargar deja de ofrecer el botón y el panel «Información técnica». La interfaz tampoco muestra huellas, identificadores internos, nombres internos de perfiles, volcados de datos ni fechas técnicas de caducidad. Esta retirada alcanza los detalles de sesión, ejecución, previsualización y cálculo identificados en el alcance.
2. Se siguen viendo la entidad, fecha, módulo, versión legible, archivos, hojas incluidas/excluidas, cobertura efectiva, reglas incumplidas y errores que requieren actuación. Un fallo indica qué ocurrió, dónde procede y qué puede hacer el usuario.
3. El detalle de una regla explica el cálculo, sus valores, la celda afectada y su origen legible. Si un redondeo o intervalo influye en el resultado, se puede consultar su efecto en lenguaje de negocio. La retirada de «Detalle técnico» no elimina la explicación de un cambio.
4. Tras mostrarse el resultado de un trabajo terminado correctamente, desaparece su bloque redundante de progreso. El progreso activo, una cancelación, una ejecución incompleta y los errores conservan un mensaje hasta que el usuario pueda comprender el estado.
5. La condición temporal de la sesión se comunica brevemente al crear el conjunto y al confirmar su cierre. El usuario conoce cuándo podría perder datos y qué debe descargar.

### User Story 3 - Elegir una regla cuando varias escriben en la misma celda (Priority: P1)

Como analista, quiero comparar las reglas en conflicto, elegir una u omitir ese destino y poder revisar mi elección antes de guardar.

**Why this priority**: Una hilera de botones «Conservar…» repite acciones y oculta qué decisión se está tomando.

**Independent Test**: Resolver los grupos COREP de dos y tres productores; después probar un grupo cuyos miembros ocupen más de una página.

**Acceptance Scenarios**:

1. Cada grupo presenta una celda destino como encabezado, con concepto si está disponible, coordenada y contexto legibles. Una lista de selección única muestra código y descripción de cada regla, además de «No recalcular esta celda». Se puede consultar su expresión para decidir. Si falta descripción, el código y la expresión permiten identificarla.
2. Inicialmente no se elige ningún ganador ni la omisión por defecto. Elegir una opción deja visible un resumen «Regla elegida: …» u «Omitida» y permite cambiar la decisión antes de guardar. Resolver el grupo prepara la configuración; no modifica valores del informe.
3. No se inventa un valor propuesto durante la configuración si todavía no hay una simulación. Los importes anterior → propuesto se consultan en Recalcular.
4. Un grupo de más de una página muestra su número total y permite llegar a todos sus candidatos. Elegir un candidato excluye los demás del grupo completo, incluidos los que no se ven. El usuario puede elegir el candidato 51 sin que el primero gane por defecto.
5. La lista funciona con teclado y lector de pantalla, muestra la opción seleccionada sin depender solo del color y no pierde el foco al actualizarse. A 320 píxeles, las opciones se disponen verticalmente sin botones pegados ni texto cortado.

### User Story 4 - Revisar varias propuestas y aplicar la selección (Priority: P1)

Como analista, quiero partir de una selección útil, ajustar varias propuestas a la vez y conocer exactamente qué cambios estoy confirmando.

**Why this priority**: Marcar individualmente una lista larga de propuestas inequívocas añade trabajo sin aportar una decisión nueva.

**Independent Test**: Simular las cinco propuestas de la demo COREP y un conjunto de más de 50 propuestas con dependencias; seleccionar, desmarcar, filtrar, cambiar de página y aplicar.

**Acceptance Scenarios**:

1. Al terminar una nueva simulación vigente, se preseleccionan una sola vez todas las propuestas disponibles con destino único resuelto en la configuración guardada, incluidas las situadas fuera de la primera página. Esto comprende una elección manual ya guardada. Las propuestas bloqueadas, ambiguas, obsoletas, descartadas o aplicadas quedan fuera.
2. La tabla tiene casillas individuales y «Seleccionar todas las disponibles de este filtro», con total y estado parcial. La acción alcanza todas las páginas del filtro vigente. «Limpiar selección» desmarca toda la simulación, incluidas las propuestas fuera del filtro.
3. La selección inicial es global de la nueva simulación. Cambiar filtro, contexto de consulta o página no la recalcula ni recupera propuestas que el usuario desmarcó. El resumen distingue total seleccionado, seleccionadas fuera del filtro y seleccionadas fuera de la página; ambos últimos recuentos pueden solaparse y no se suman.
4. Al desmarcar un antecedente de otra propuesta seleccionada, queda visible qué dependencias faltan y no se permite aplicar. El sistema respeta la deselección y no la revierte silenciosamente. El usuario puede revisar y seleccionar los antecedentes identificados.
5. La preselección muestra el resumen de cambios y el panel de confirmación, con su casilla de aceptación inicialmente desmarcada. Aplicar requiere una acción explícita y una selección vigente con todas sus dependencias. Cambiar la selección invalida una aceptación anterior, aunque se vuelva después a las mismas propuestas.
6. Al vaciar la selección se oculta la confirmación. Una selección en otro filtro o página sigue contando. Durante aplicación o respuesta incierta no se altera el conjunto que se está aplicando.
7. Volver a consultar la misma simulación en la sesión conserva las elecciones. Abrir un histórico, recuperar una vista o recargar la página no vuelve a preseleccionar. Una nueva simulación tiene su propia selección inicial; los cambios de versión invalidan la anterior.
8. Si falla la obtención o comprobación de la selección completa, se muestra una acción para reintentar y no se presenta una selección parcial como «todas». Hasta obtener una selección comprobable no se permite aplicar.

### User Story 5 - Completar el recorrido con una plantilla visual FINREP F 01.01 (Priority: P1)

Como analista de FINREP, quiero cargar la tabla F 01.01 en su disposición EBA, evaluar un catálogo propio y descargar los cambios revisados conservando esa disposición.

**Why this priority**: La evidencia anterior mostró una carencia de la carga visual. Esta iteración debe terminar con un recorrido positivo que pueda reproducirse.

**Independent Test**: Usar un extracto de la hoja oficial «1.1 Assets» del paquete 4.0 fijado en el proyecto, con sus 38 posiciones monetarias, datos sintéticos y catálogo propio; completar carga, validación, configuración, simulación, aplicación, descarga y nueva carga.

**Acceptance Scenarios**:

1. Cargar reconoce las 38 posiciones de F8:F45, columna regulatoria 0010, y sus códigos de fila reales, incluidos los no consecutivos. Se distinguen las celdas vacías, cero e importes inválidos. La información del contexto identifica FINREP y permite aportar entidad, fecha, divisa y escala sin pedir una tabla COREP.
2. Con un extracto que conserva la cuadrícula oficial, el usuario puede completar el recorrido ordinario. Un libro con otras hojas muestra qué se procesará y exige aceptar las exclusiones antes de confirmar. Las hojas conservadas para descarga se mantienen sin atribuirles validación.
3. El catálogo sintético de aceptación produce los estados y cambios de la tabla siguiente. Las dos igualdades ofrecen un destino inequívoco; el segundo recálculo usa el primero ya recalculado. Las desigualdades y el condicional solo validan.
4. Tras aplicar, se publican exactamente los cambios aceptados y se vuelve a validar. Descargar conserva la cuadrícula, conceptos, estilos y contexto del informe. Al cargar de nuevo el archivo descargado, se obtienen los mismos valores y resultados finales.
5. Una estructura alterada o incompatible informa del problema antes de publicar datos. La incorporación de FINREP permite seguir completando las demos COREP y Texto y fechas.

Datos sintéticos en EUR, precisión declarada de dos decimales: r0010=90, r0020=40, r0030=35, r0040=25, r0050=20, r0380=105; el resto de las 38 posiciones, cero. Todas las referencias de esta tabla pertenecen a F_01.01/c0010. Se trata de reglas de prueba propias, no de reglas regulatorias oficiales ni de una certificación de cuentas.

| Regla propia | Comprobación de negocio | Antes | Después | Recálculo esperado |
| --- | --- | --- | --- | --- |
| FIN_TOTAL_CASH | r0010 = r0020 + r0030 + r0040 | Falla | Pasa | r0010: 90 → 100 |
| FIN_TOTAL_ASSETS_DEMO | r0380 = r0010 + r0050 | Falla | Pasa | r0380: 105 → 120; depende del cálculo anterior |
| FIN_GREATER_PASS | r0020 > r0030 | Pasa | Pasa | Solo validación |
| FIN_GREATER_FAIL | r0040 > r0020 | Falla | Falla | Solo validación |
| FIN_CONDITIONAL | Si r0020 > 0, r0030 ≥ 0; en otro caso, r0040 = 0 | Pasa | Pasa | Solo validación |

### Edge Cases

- Una respuesta antigua o duplicada llega tras cambiar de conjunto, versión o simulación; no recupera un pulso, selección ni aceptación anteriores.
- Solo hay reglas de validación o se omiten todos los destinos. Se ofrece descargar resultados, sin obligar a simular una lista vacía.
- Dos reglas con un solo destino individual apuntan a la misma celda. Tener un solo lado elegible no resuelve el conflicto de productores.
- Dos celdas con las mismas coordenadas pertenecen a entidades o periodos distintos. La identidad incluye su contexto; no se mezclan decisiones ni selecciones.
- El filtro muestra cero propuestas, pero hay selección fuera de él. «Seleccionar todas» está inactivo y «Limpiar selección» permite vaciar la selección global.
- La simulación contiene 51 propuestas disponibles, otras bloqueadas y un antecedente en la segunda página. Los totales y la selección abarcan la simulación completa.
- Se desmarca una propuesta preseleccionada y se vuelve a la etapa o al filtro anterior; permanece desmarcada.
- Condicionales, texto o fechas aparecen en una rama no ejecutada o una precondición. Se mantiene la restricción de solo validación.
- El usuario permite movimiento reducido, navega con teclado o amplía texto. El cambio de etapa y las acciones siguen identificándose.
- Una caducidad, exclusión o límite impide continuar después de retirar el panel técnico. El problema y su solución permanecen visibles junto a la acción.
- FINREP contiene códigos no consecutivos, ceros, ausencias, decimales, etiquetas largas, una celda desplazada o una hoja desconocida. Se reconoce la plantilla admitida o se explica la incompatibilidad; nunca se asignan valores por una suposición silenciosa.
- Se vuelve a cargar el informe FINREP exportado, con su contexto y valores recalculados, sin depender de la sesión original.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** — Señalar una única etapa recomendada mediante el realce del propio elemento de navegación y sin el rótulo visible «Siguiente paso». Distinguirla de la etapa abierta; conservar el control de navegación y foco en manos del usuario.
- **FR-002** — Aplicar tres pulsos suaves de 1,5 segundos al nuevo hito confirmado y después conservar un realce estático. No producir destellos ni alternancias bruscas. Respetar movimiento reducido y anunciar de forma accesible una sola recomendación por operación.
- **FR-003** — Activar las recomendaciones tras carga publicada, destinos utilizables guardados y aplicación publicada; ignorar trabajos pendientes, fallidos, cancelados, incompletos, duplicados o ajenos a la versión vigente. Cuando solo proceda validar, permitir descargar resultados.
- **FR-004** — Usar verde sólido para la acción principal de avance según el estado de la etapa y jerarquía de la tabla inferior. Diferenciar controles secundarios y destructivos. Mantener texto, foco y contraste legibles en reposo, interacción y deshabilitado.
- **FR-005** — Eliminar los apartados y datos técnicos enumerados en el alcance de simplificación. Conservar internamente la trazabilidad necesaria para reproducir decisiones y resultados; la retirada visual no altera los cálculos ni sus registros.
- **FR-006** — Mostrar contexto de negocio, cobertura, exclusiones, consecuencias de pérdida de datos y problemas accionables en el lugar donde se decide. Expresar un fallo mediante causa comprensible y acción disponible. Conservar valores exactos, unidades y explicación pertinente de redondeo o intervalo sin volcados internos.
- **FR-007** — Retirar el progreso de un trabajo exitoso cuando su resultado ya esté visible. Conservar mensajes de actividad, error, cancelación e incompletitud mientras aporten información necesaria para continuar.
- **FR-008** — Presentar cada conflicto de productores como una lista de elección única por destino/contexto, con código, descripción, consulta de expresión y una opción de omisión. No elegir ganador automáticamente ni repetir botones «Conservar».
- **FR-009** — Aplicar la decisión al grupo completo, mantener un resumen editable de la elección antes de guardar y conservar el foco. Permitir acceder a todos sus participantes aunque haya paginación. No mostrar importes calculados que todavía no se hayan obtenido.
- **FR-010** — Añadir selección múltiple individual y masiva en Recalcular. «Seleccionar todas las disponibles de este filtro» comprende todas sus páginas; «Limpiar selección» comprende toda la simulación. Mostrar estado parcial y el alcance de cada acción.
- **FR-011** — Preseleccionar una vez al terminar una nueva simulación vigente las propuestas disponibles cuyo destino y productor estén resueltos. Respetar las elecciones guardadas de destino y omisión. Excluir conflictos pendientes y propuestas bloqueadas, obsoletas, descartadas o aplicadas.
- **FR-012** — Mantener las selecciones y deselecciones durante consultas, paginación y cambios de filtro de la misma simulación en la sesión. No reactivar la preselección al consultar históricos o recuperar pantallas. Aislar la selección por conjunto, versión y simulación.
- **FR-013** — Mostrar un recuento global y los recuentos fuera del filtro y de la página. Durante la obtención completa mostrar el estado pendiente; un fallo no debe confundirse con selección completa ni habilitar aplicación.
- **FR-014** — Comprobar dependencias de la selección, identificar las que falten y permitir consultarlas. Una selección masiva o inicial puede incluir antecedentes elegibles; desmarcar uno no lo vuelve a añadir automáticamente. Ciclos, conflictos y dependencias pendientes impiden aplicar las propuestas afectadas.
- **FR-015** — Mostrar la confirmación solo si hay alguna propuesta seleccionada en una simulación pendiente. Exigir aceptación explícita del conjunto vigente, invalidarla tras cambios y bloquear ediciones mientras la aplicación esté en curso o su resultado sea incierto. Conservar aplicación atómica, originales y revalidación.
- **FR-016** — Admitir la plantilla visual FINREP F_01.01 de la edición 4.0 fijada en el proyecto y sus 38 coordenadas monetarias. Reconocer su estructura y códigos reales; la evidencia de cuatro celdas o del formato antiguo no constituye aceptación de este requisito.
- **FR-017** — Identificar el contexto de FINREP, con entidad, periodo, módulo, divisa y escala declarados, de forma diferenciada de COREP. Resolver ausencias o incompatibilidades antes de publicar. Mantener separación entre informes y contextos.
- **FR-018** — Ofrecer una demostración FINREP descargable con la cuadrícula oficial, importes sintéticos, cinco reglas propias y resultados esperados indicados en US5. Identificar la procedencia y edición de la plantilla; conservar las fuentes oficiales originales.
- **FR-019** — Procesar el extracto F_01.01 directamente y permitir libros con hojas adicionales mediante el mecanismo de exclusión explícita. Informar qué hojas se evaluarán, preservar las no procesadas al descargar y rechazar una cuadrícula incompatible sin publicación parcial.
- **FR-020** — Completar con FINREP el flujo de carga, validación, destinos, simulación, selección, aplicación, revalidación y descarga; al volver a cargar el archivo exportado, conservar valores, contexto y resultados. Comprobar celdas no modificadas y presentación de la plantilla.
- **FR-021** — Mantener condicionales, texto, fechas y desigualdades como solo validación. La simplificación visual y la preselección no amplían las reglas que permiten escribir. Mantener el orden de recálculos por sus dependencias y la distinción entre ciclos y operaciones bloqueadas por ellos.
- **FR-022** — Hacer operables navegación, conflictos y selección con teclado, lector de pantalla y tacto a 320, 390 y 1440 píxeles. Mantener texto con contraste mínimo 4,5:1 y límites/indicadores necesarios con 3:1; no depender solo del color.
- **FR-023** — Conservar las demostraciones COREP y Texto y fechas, la búsqueda automática, la cabecera con contexto único de lectura y el selector cuando haya varios. Descargar la versión aplicada debe seguir siendo inequívoco. Comprobar las regresiones de estos recorridos.

#### Jerarquía de acciones por estado

| Etapa y estado | Acción principal verde | Acciones secundarias |
| --- | --- | --- |
| Cargar, archivos elegidos sin inspección utilizable | Inspeccionar archivos | Demos, descargas de ejemplos |
| Cargar, inspección lista | Confirmar carga | Descartar o actualizar inspección |
| Validar, sin resultado completo vigente | Validar informes | Consulta de histórico |
| Validar, resultado vigente sin revisión | Preparar revisión de destinos | Repetir validación, detalles |
| Validar, revisión abierta | Guardar configuración, cuando sea válida | Elegir/omitir destinos, actualizar, descartar |
| Recalcular, sin simulación utilizable | Simular recálculos | Históricos |
| Recalcular, simulación vigente | Aplicar cambios, solo tras cumplir selección y confirmación | Selección masiva, filtros, detalle, descartar |
| Descargar, con una aplicación recién publicada | Descargar informes de esa versión aplicada | Otras versiones y resultados |
| Descargar, sin aplicación recién publicada | Descargar la versión elegida o sus resultados, según la salida seleccionada | Consulta y cambio de versión |

El verde indica la acción principal disponible, no que las reglas se cumplan. Un estado «pasa» o «falla» conserva su etiqueta propia. Las acciones de descarga no crean nuevas versiones.

#### Alcance de la simplificación informativa

| Elemento actual | Resultado requerido |
| --- | --- |
| Botón y panel «Información técnica» de Cargar | Retirados, incluidos huella, identificador, perfil interno, caducidad en bruto y explicación interna de aritmética/cuotas. |
| Identificador de versión dentro de «Información de la sesión» | Retirado; versión con número legible y aviso breve de temporalidad en creación/cierre. |
| «Cobertura y trazabilidad de la ejecución» | Retirar identificadores y jerga de variantes/instancias; integrar solo recuentos de negocio necesarios en el resumen de validación. |
| «Identificadores y política de cálculo» de Recalcular | Retirado; la versión base y los avisos que afectan a los cambios se presentan con nombres legibles. |
| «Detalle técnico» y su volcado de datos | Retirados. Expresión, valores, origen legible y efecto relevante de precisión/intervalo se consultan como explicación del cálculo. |
| Recuentos internos «Direcciones» y «Dependencias» del grafo | Sustituir por propuestas disponibles/bloqueadas; mostrar dependencias concretas donde afecten a la selección. |
| Progreso terminado duplicado con un resultado exitoso | Retirado al aparecer ese resultado; un único mensaje confirma la operación. |
| Restricciones de archivos, exclusiones, caducidad y errores | Expresar junto a la carga las restricciones que permiten preparar archivos y, cuando impidan continuar, el problema y cómo resolverlo. Sin panel técnico genérico. |

### Key Entities *(include if feature involves data)*

- **Recomendación de etapa**: destino de navegación asociado a una operación y versión confirmadas; tiene realce transitorio y estado estático hasta visitarlo.
- **Acción principal**: acción destacada según la etapa y su estado; puede estar pendiente de requisitos visibles de habilitación.
- **Decisión de conflicto**: celda y contexto completos, reglas candidatas y elección exclusiva de una regla u omisión, revisable antes de guardar.
- **Selección de propuestas**: conjunto de propuestas de una simulación y versión, con origen inicial o manual, alcance global y dependencias; separado de la aceptación para aplicar.
- **Informe visual FINREP F_01.01**: plantilla de edición identificada, 38 coordenadas, valores y contexto; conserva su presentación y procedencia.
- **Demostración FINREP**: copia de plantilla oficial con datos y catálogo propios identificados como sintéticos y resultados conocidos.

## Success Criteria *(mandatory)*

### Measurable Outcomes

| ID | Resultado verificable | Cobertura |
| --- | --- | --- |
| **SC-001** | Los tres hitos señalan la etapa correcta sin texto visible «Siguiente paso», sin navegación automática y con como máximo tres pulsos durante 4,5 segundos. Con movimiento reducido hay cero pulsos. Fallo, cancelación, duplicación y respuesta tardía no generan una nueva recomendación. | FR-001–003 |
| **SC-002** | En todos los estados de la tabla de acciones hay como máximo una acción principal verde habilitada. Se cumplen los contrastes 4,5:1 y 3:1 y el foco es visible a 320, 390 y 1440 píxeles; el recorrido completo se puede operar con teclado. | FR-004, FR-022 |
| **SC-003** | En las cuatro etapas y los detalles hay cero controles «Información técnica», «Detalle técnico» e «Identificadores y política de cálculo», y cero huellas, identificadores internos o volcados técnicos visibles. Los casos de exclusión, límite, caducidad, redondeo y cierre mantienen explicación y acción pertinentes. | FR-005–007 |
| **SC-004** | Se resuelven y se pueden cambiar grupos de 2, 3 y más de 50 productores con una única elección por celda/contexto, incluidos candidatos de la segunda página. Se observan cero botones «Conservar…» y cero escrituras de valores antes de aplicar. | FR-008–009 |
| **SC-005** | La demo COREP genera y preselecciona sus cinco propuestas tras resolver la configuración prevista. Un conjunto con 51 propuestas disponibles preselecciona las 51 y ninguna bloqueada. Filtrar y paginar conservan las deselecciones; selección masiva y limpieza coinciden con sus alcances y recuentos. | FR-010–013 |
| **SC-006** | Las secuencias preselección → deselección → selección masiva → limpieza y cambio de versión no producen aplicaciones sin aceptación vigente. Quitar un antecedente bloquea la aplicación hasta resolverlo. Recuperar un histórico o una pantalla no restaura selecciones desmarcadas. | FR-011–015 |
| **SC-007** | El ensayo FINREP visual reconoce las 38 posiciones; las cinco reglas producen antes 2 pasa/3 falla y después 4 pasa/1 falla. Se obtienen exactamente r0010 90 → 100 y r0380 105 → 120. El condicional y las dos desigualdades generan cero recálculos. | FR-016–021 |
| **SC-008** | El FINREP descargado se vuelve a cargar en un conjunto nuevo con las mismas 38 coordenadas, contexto y valores finales; sus cinco resultados coinciden. Se verifican celdas no modificadas, cuadrícula y hojas excluidas conservadas. Una plantilla alterada no publica datos. | FR-016–020 |
| **SC-009** | COREP conserva sus cinco cambios y resultados previstos; las ocho reglas de Texto y fechas generan cero recálculos. La búsqueda automática, los casos de 0/1/varios contextos y la descarga de versión aplicada conservan su comportamiento. | FR-021–023 |
| **SC-010** | En una revisión humana registrada, Diego identifica sin ayuda la etapa recomendada tras carga, guardado y aplicación; resuelve un conflicto, desmarca una propuesta preseleccionada y encuentra la versión descargable. Se anotan las acciones observadas, ayudas e incidencias. Una aprobación global no acredita por sí sola cada observación. | US1–US5 |

## Assumptions

- Esta entrega corresponde a especificación. Planificación, tareas, implementación y prueba positiva FINREP se realizarán en sus fases; el estado actual se recoge en [evidencia.md](evidencia.md).
- Se interpreta «confirmar que F 01.01 funciona» como lograr aceptación positiva de la carga visual y su recorrido completo. El rechazo documentado que era válido en 003 no satisface esta iteración.
- El alcance FINREP se limita a F_01.01 de la edición 4.0 fijada, sus 38 posiciones monetarias y las operaciones admitidas por el motor. No abarca todas las plantillas, ediciones ni conformidad regulatoria completa. El plan fijará la identificación de módulo y su correspondencia con la fuente oficial.
- El soporte incluye un extracto con cuadrícula oficial y el tratamiento existente de exclusiones para libros con más hojas. No se exige en esta iteración mezclar COREP y FINREP dentro de una misma carga; cada uno debe completar su recorrido.
- Las propuestas preseleccionadas ya tienen un destino y productor resueltos. La elección entre dos lados se sigue tomando en Validar, y un conflicto entre reglas se sigue resolviendo explícitamente.
- La selección masiva se aplica al filtro completo, nunca solo a las filas visibles; la etiqueta declara este alcance. «Limpiar selección» es global. Son decisiones de diseño adoptadas para evitar cambios ocultos.
- Se conserva el diseño visual existente como base. Esta iteración ajusta jerarquía, información y controles; no incluye una nueva marca ni publicación en Internet.
- Esta especificación sustituye para los aspectos afectados las decisiones de 003 sobre etiqueta estática de etapa, ayuda técnica y selección inicialmente vacía. Los artefactos anteriores conservan su valor histórico.
