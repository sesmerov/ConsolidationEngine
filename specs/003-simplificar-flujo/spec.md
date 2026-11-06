# Feature Specification: Simplificar el recorrido de validación

**Feature Branch**: `codex/003-simplificar-flujo`

**Created**: 2026-11-06

**Status**: Alcance revisado el 2026-11-06 y listo para la planificación. La comprobación FINREP sobre el producto actual se documenta en [la evidencia de esta iteración](evidencia.md).

**Input**: Simplificar Cargar y Validar, señalar la siguiente etapa, preparar los destinos inequívocos, actualizar la identidad de la aplicación y comprobar FINREP con un catálogo propio. Diego confirmó que quiere quitar de la interfaz tanto la carga anterior `ce-report-1` como su ejemplo.

En la revisión, Diego incorporó dos decisiones al alcance. En Recalcular, la confirmación de aplicación aparece a partir de la primera propuesta seleccionada. En la cabecera del conjunto, el contexto único se presenta como dato de lectura y el selector aparece cuando hay varios contextos disponibles.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cargar el informe y encontrar una regla (Priority: P1)

Como analista, quiero ver los archivos que debo aportar, revisar la cobertura que estoy aceptando y encontrar una regla por su código mientras escribo.

**Why this priority**: El primer paso concentra explicaciones técnicas y dos generaciones de ejemplos que compiten con la tarea de cargar.

**Independent Test**: Recorrer Cargar con las dos demos actuales y buscar un código que se encuentre después de la primera página de un catálogo.

**Acceptance Scenarios**:

1. Al abrir Cargar, el analista encuentra las demos visuales COREP y Texto y fechas. Se retiran de toda la interfaz el selector del formato anterior, su plantilla descargable, el catálogo e informe de su ejemplo y la guía de ocho pasos. «Otros formatos» tampoco da acceso al flujo retirado.
2. Al inspeccionar un libro con hojas excluidas, se ven las hojas incluidas, la magnitud de la exclusión y la aceptación que exige confirmar. Los identificadores de inspección, huellas, especificaciones de precisión y tamaños máximos se consultan bajo demanda. Si la inspección caduca o un límite impide cargar, el motivo y la acción para continuar se muestran en el lugar de la carga.
3. Al escribir o pegar parte de un código, se muestran las coincidencias del catálogo completo al dejar de teclear. Al borrar se recupera la primera página del catálogo con los demás filtros vigentes. Se puede seguir escribiendo mientras se actualizan las filas, incluso al pasar por una búsqueda con cero coincidencias.
4. Antes de cargar datos, la cabecera presenta el conjunto con cero selectores de contexto. Tras publicar un único contexto, la entidad, la fecha de referencia y el módulo se leen una sola vez en la cabecera. Con dos o más contextos, el selector identifica el contexto activo y permite cambiarlo con teclado. Al volver de otra etapa o actualizar la lista se conserva la elección si sigue siendo válida.

### User Story 2 - Guardar los destinos que tienen sentido (Priority: P1)

Como analista, quiero dedicar mi atención a las reglas que presentan una decisión real y saber qué destinos se guardarán para la simulación.

**Why this priority**: Un selector «Izquierda/Derecha» por cada regla exige trabajo incluso cuando solo existe una respuesta válida. Elegir un productor equivocado puede cambiar las propuestas posteriores.

**Independent Test**: Validar un conjunto con una igualdad por cada caso de la tabla y revisar qué se guarda. Se distinguen la regla y la celda concreta a la que se refiere en esta ejecución.

| Lados elegibles en la instancia | Qué ve el analista antes de guardar | Decisión |
|---|---|---|
| Solo izquierda o solo derecha | Celda destino reconocible y marca «Automático» | Se propone ese lado. El analista puede omitir la regla. |
| Ambos | Ambas celdas identificadas | Si falta una elección guardada válida, el analista elige izquierda, derecha u omitir. |
| Ninguno o regla solo de validación | Grupo con recuento y motivo consultable | La instancia queda fuera de los destinos. |

**Acceptance Scenarios**:

1. En `A = B + C`, si solo A es un destino elegible, el borrador propone A. En `B + C = A` propone A a la derecha. Si el analista omite una de estas reglas, puede reconsiderarla sin volver a elegir su lado. Los importes siguen siendo los de la versión cargada hasta que se aplican las propuestas confirmadas.
2. En `A = B`, con ambas celdas declaradas y elegibles, se pide una decisión para esa instancia. El resumen distingue las elecciones pendientes, las omisiones y los destinos que se van a guardar. Guardar un subconjunto exige revisar ese alcance y las instancias pendientes quedan fuera de él.
3. Dos reglas con único lado elegible pueden competir por la misma celda. En la demo COREP ocurre con `DEMO_RANGE` y `v0174_m` para la fila 0070. Se identifican la celda y sus productores. Antes de guardar ese destino, el analista conserva uno de los productores u omite el grupo. Los casos independientes siguen disponibles. Puede excluir también `DEMO_INTERVAL` y reproducir los cinco cambios de la guía con las cinco reglas oficiales.
4. Al volver de otra etapa o paginar, las elecciones del mismo borrador siguen disponibles. Una elección previamente guardada y aún válida tiene prioridad sobre la sugerencia. Si cambia el conjunto o la versión sobre la que se calculó la elegibilidad, se informa del cambio y se vuelve a comprobar el alcance antes de guardar.
5. Al guardar y simular, se pueden consultar propuestas, dependencias y bloqueos. El analista sigue eligiendo y confirmando de forma expresa las propuestas que desea aplicar. En la demo de Texto y fechas ve sus resultados de validación y puede descargarlos.
6. Al abrir una simulación con cero propuestas seleccionadas, el panel «Confirmar la aplicación» está oculto. Aparece al seleccionar la primera y sigue visible si el analista pasa a otra página o aplica un filtro que oculta las seleccionadas. El panel muestra el recuento global y los impedimentos para aplicar. Al quitar la última propuesta, el panel desaparece. Al abrirlo con una selección nueva se exige otra vez la confirmación expresa.

### User Story 3 - Reconocer la siguiente etapa (Priority: P1)

Como analista, quiero que el listado de etapas me indique dónde continuar después de una operación que ha terminado correctamente.

**Why this priority**: Tras pulsar un botón, el resultado pertenece a la etapa actual y la siguiente acción puede estar en otro lugar de la pantalla.

**Independent Test**: Completar una operación de cada fila y comprobar el listado de navegación antes de activarlo, con teclado, ratón y pantalla táctil.

| Resultado confirmado | Destino señalado con «Siguiente paso» |
|---|---|
| Carga publicada | Validar |
| Configuración guardada con destinos utilizables | Recalcular |
| Aplicación terminada con una versión resultante | Descargar |

**Acceptance Scenarios**:

1. Al terminar cada operación de la tabla se distingue tanto la etapa actual como una única recomendación en el listado. El usuario conserva el foco y decide cuándo navegar. Puede seguir consultando el resultado en pantalla.
2. Mientras se inspecciona, se guarda o se aplica, se muestra el estado real del trabajo. Un fallo, una cancelación o una respuesta antigua no adelantan la recomendación. Al entrar en la etapa recomendada se consume la indicación. Una operación posterior confirmada determina la nueva recomendación.
3. Tras aplicar, seguir la indicación permite identificar y descargar la versión recién aplicada. Si había una versión histórica elegida para exportar, el analista conserva esa elección y dispone de la descarga explícita de la versión aplicada.
4. Si una validación completa solo tiene reglas de validación o el analista ha excluido todos los destinos, puede descargar los resultados de esa ejecución. Recalcular se recomienda exclusivamente tras guardar destinos utilizables.

### User Story 4 - Conocer el alcance real para FINREP (Priority: P1)

Como responsable de informes, quiero saber si hoy puedo cargar una plantilla visual FINREP y evaluar un catálogo propio antes de decidir si necesito otra ampliación.

**Why this priority**: La lectura del Excel y la evaluación de sus reglas son dos capacidades distintas. Cada resultado influye en lo que puede ofrecerse al analista.

**Independent Test**: Ejecutar dos ensayos aislados sobre la versión existente con los mismos importes, contexto FINREP y catálogo pequeño. Se utilizan importes sintéticos y valores esperados calculados de antemano. En la prueba ejecutada, el extracto visual de FINREP F_01.01 fue rechazado durante la inspección. Con las mismas cuatro cifras expresadas en el formato anterior, la suma pasó y la desigualdad falló como se esperaba. Las operaciones, datos y diagnósticos están en [la evidencia](evidencia.md).

**Acceptance Scenarios**:

1. Se intenta cargar por el recorrido ordinario de inspección una muestra de una tabla visual FINREP identificada y su catálogo. Si llega a validación, se compara cada resultado previsto y observado. Si la carga se rechaza, se registra la etapa y el diagnóstico que recibe el analista.
2. Por separado se representa el mismo ejemplo mediante `ce-report-1` y se prueba la evaluación con el mismo catálogo. Se registra qué reglas alcanzan la evaluación y qué resultado obtiene cada una. El informe de evidencia distingue la carga visual del ensayo en el formato anterior. Un rechazo documentado constituye un resultado válido de esta prueba exploratoria.
3. Los ensayos se realizan sin adaptar el producto para que pasen. Se identifican la procedencia de la plantilla, la tabla y sus celdas, el carácter sintético de catálogo e importes y las limitaciones para extrapolar el resultado a otras tablas o frameworks.

### User Story 5 - Reconocer la aplicación en la pestaña y en su portada (Priority: P2)

Como usuario, quiero reconocer ConsolidationEngine por su símbolo y por una descripción breve que explique para qué sirve.

**Why this priority**: La identidad debe distinguirse incluso en una pestaña estrecha. Los lectores automáticos necesitan una presentación comprensible del producto.

**Independent Test**: Abrir la portada sin un conjunto creado, comprobar la pestaña y leer el documento inicial sin ejecutar la interfaz interactiva.

**Acceptance Scenarios**:

1. El símbolo nuevo aparece en el encabezado y como favicon. Se distingue a 16 y 32 píxeles, sobre los fondos en los que se presenta. El nombre de la aplicación sigue siendo accesible cuando el símbolo se muestra solo.
2. La portada entrega inicialmente el nombre, un título y una descripción en castellano que identifican la validación y el recálculo de informes regulatorios. Un lector automático que alcance la portada puede leerlos y localizar el icono antes de que se abra un conjunto.
3. Al repetir la lectura con una sesión de trabajo abierta, el contenido descriptivo del producto sigue siendo genérico. Los nombres de archivos, entidades, reglas cargadas, importes, versiones de trabajo y credenciales quedan reservados al espacio de trabajo.

### Edge Cases

- Un aviso exige acción inmediata mientras la ayuda técnica está cerrada. La acción para subsanarlo debe seguir visible.
- El usuario pega varias letras, borra el campo o cambia de catálogo antes de recibir una búsqueda anterior. La última consulta del contexto actual gobierna la tabla y su paginación.
- Una igualdad menciona una celda dentro de una suma, rango o expresión. Para que un lado sea destino, el lado **completo** debe identificar una sola celda declarada y el perfil debe permitir modificarla.
- Una condición o un valor textual/de fecha aparece solo en la precondición o en una rama que no se ejecuta. Se conserva la restricción de solo validación. En una desigualdad tampoco procede elegir destino.
- Reglas distintas pueden producir un conflicto aunque cada una tenga un único lado elegible. Una selección filtrada o paginada puede ocultar participantes del conflicto o antecedentes necesarios.
- Un guardado o una aplicación se reintenta después de perder la respuesta. El mensaje de éxito y su indicación de siguiente paso requieren confirmación de la operación y de la versión correspondiente.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001** — Retirar de la interfaz los controles para cargar en el formato anterior y todas las acciones de su ejemplo de ocho pasos. Conservar las dos demostraciones visuales actuales y el acceso a sus respectivos catálogos e informes.
- **FR-002** — Presentar contexto, cobertura, exclusiones pendientes y errores accionables junto a la carga. Reunir los datos técnicos de inspección y alcance bajo ayuda identificable, cerrada inicialmente, accesible mediante teclado y tacto y que pueda cerrarse devolviendo el foco al control de apertura. El analista puede seleccionar y copiar identificadores y huellas al consultar el detalle. La información esencial se puede consultar sin pasar el puntero sobre un icono.
- **FR-003** — Filtrar por coincidencia parcial de código sin distinguir mayúsculas, automáticamente al escribir, pegar o borrar, sin botón «Filtrar reglas». Aplicar la búsqueda a todo el catálogo de la versión seleccionada y combinarla con el estado y la tabla elegidos.
- **FR-004** — Iniciar cada búsqueda modificada en la primera página, informar de resultados vacíos y mantener el foco en el campo. Solo la última búsqueda de la versión y los filtros vigentes puede actualizar los resultados o su recuento.
- **FR-005** — Clasificar las instancias por los lados que realmente admite el producto para sus datos y su perfil. La preselección requiere una igualdad elegible, un lado constituido por una referencia directa a una única celda declarada y resuelta, y la inelegibilidad confirmada del otro lado. Si un límite o plazo impide decidir, se muestra el motivo y se deja la instancia pendiente de comprobación. La procedencia de la decisión debe distinguir sugerencia automática, elección del analista y configuración ya guardada.
- **FR-006** — Para un único lado elegible, proponer su celda por defecto, mostrarla y permitir omitir o recuperar esa regla. Para dos lados elegibles, ofrecer las dos celdas y la omisión. Para cero lados, ofrecer consulta del motivo y agrupar esas instancias sin controles de dirección.
- **FR-007** — Respetar las elecciones previas válidas y las omisiones explícitas al volver a consultar la misma configuración. Guardar sustituye la configuración completa de la versión. Presentar antes de guardar un resumen global de lo incluido, omitido y pendiente, incluyendo filas fuera de la página o filtro actual. Cambiar de filtro por sí solo nunca elimina una elección del borrador.
- **FR-008** — Ante varios productores del mismo destino, mostrar la celda y sus reglas. Para guardar un nuevo productor de ese grupo hace falta una elección explícita. También se puede omitir el grupo completo y continuar con los destinos independientes. El código, el orden de filas y el hecho de que una regla sea oficial o sintética no otorgan preferencia automática.
- **FR-009** — Mantener las salvaguardas vigentes para reglas de solo validación, versiones obsoletas, dependencias, conflictos y ciclos. Guardar confirma destinos para simular. Aplicar requiere una simulación vigente, selección y confirmación explícitas, publicación conjunta y revalidación.
- **FR-010** — Identificar en el listado una única etapa siguiente para cada éxito confirmado según la tabla de la historia 3. Distinguir la etapa activa y la recomendación mediante texto y señal visual estática, a todos los anchos admitidos y con las preferencias de movimiento reducido.
- **FR-011** — La recomendación pertenece al conjunto, la versión y la operación que la originaron. Descartarla cuando se visita el destino o cambia la base correspondiente. La indicación se comunica sin parpadeo recurrente, traslado de foco ni navegación automática.
- **FR-012** — Mantener disponible la descarga de resultados cuando la validación termina sin destinos que simular. Después de aplicar, ofrecer la descarga de la versión resultante y conservar la elección histórica realizada por el usuario.
- **FR-013** — Comprobar y documentar por separado la entrada visual FINREP y la evaluación del equivalente en formato anterior, con el mismo catálogo propio, un caso previsto que pase y otro que falle como mínimo. Si una etapa impide continuar, registrar su diagnóstico y qué comprobaciones quedaron sin ejecutar.
- **FR-014** — Incorporar un símbolo de producto y favicon coherentes y reconocibles en los tamaños de uso. La identidad sigue siendo legible mediante texto accesible y se sirve con los recursos locales del producto.
- **FR-015** — Identificar en el documento inicial de la portada el idioma, nombre, título, descripción y favicon del producto para usuarios y lectores automáticos. Limitar la información de descubrimiento a contenidos generales. La publicación en Internet y la indexación efectiva por buscadores externos quedan fuera de esta iteración.
- **FR-016** — En una simulación pendiente de aplicación, mostrar el panel de confirmación exclusivamente cuando la selección global contenga al menos una propuesta. Ocultarlo de nuevo al vaciar la selección. Las propuestas seleccionadas fuera de la página o el filtro cuentan para el total. La acción de aplicar requiere selección vigente, dependencias satisfechas, ausencia de bloqueos y confirmación explícita de esa selección. Una aplicación ya publicada se consulta mediante su comparación y su recibo.
- **FR-017** — Con cero contextos disponibles, omitir el selector de la cabecera y los datos de cualquier contexto anterior. Con uno, presentar su entidad, fecha de referencia y módulo como información de lectura. Con varios, mostrar un selector accesible que identifique la opción activa y permita cambiarla. Al navegar entre etapas o refrescar el conjunto, conservar la elección mientras siga disponible. Si deja de estarlo, mostrar el contexto disponible que corresponda al estado vigente del conjunto.

### Key Entities

- **Instancia de regla**. Aplicación concreta de una regla a la versión, contexto y celdas de un informe. Distintas instancias del mismo código pueden tener destinos diferentes.
- **Borrador de destinos**. Conjunto de sugerencias, elecciones, omisiones y decisiones pendientes que se revisa antes de guardar.
- **Indicación de siguiente paso**. Recomendación de una etapa asociada a la operación confirmada y a la versión pertinente.
- **Caso de compatibilidad**. Un par informe/catálogo con contexto, resultado previsto por regla, formato probado y etapa alcanzada.

## Success Criteria *(mandatory)*

### Measurable Outcomes

| Criterio | Resultado observable | Requisitos |
|---|---|---|
| **SC-001** | En un conjunto nuevo hay cero entradas de usuario para el flujo anterior y se pueden abrir las dos demos visuales. En una inspección normal las huellas y los límites técnicos ocupan cero líneas de detalle abierto. Cobertura, acciones obligatorias y errores se distinguen con la ayuda cerrada. | FR-001–002 |
| **SC-002** | Con hasta 500 filas, escribir, pegar y borrar actualiza el resultado correcto sin pulsar otro control, en un segundo desde la última entrada en el equipo local de referencia de la iteración 002. Un código presente solo fuera de la primera página se encuentra. Una respuesta anterior retrasada no altera los resultados vigentes. | FR-003–004 |
| **SC-003** | En un catálogo con un caso solo izquierdo, otro solo derecho, uno ambiguo y otro excluido, los casos inequívocos requieren cero elecciones de lado, los ambiguos ofrecen ambas opciones y la omisión, y los excluidos presentan cero selectores. Las elecciones se conservan al paginar y el resumen coincide con los destinos guardados tras revisión. | FR-005–007 |
| **SC-004** | Con los productores de la demo COREP revisados y las cinco reglas oficiales configuradas según la guía, la simulación y aplicación reproducen los importes finales de 60, 185, 50, 100 y 285 EUR. Los conflictos y ciclos conservan su diagnóstico. En la demo tipada, las ocho reglas se validan y generan cero propuestas de escritura. | FR-008–009 |
| **SC-005** | Los tres hitos confirmados señalan la etapa esperada, una sola a la vez, a 320, 390 y 1440 píxeles y sin perder el foco. Un fallo, cancelación o respuesta obsoleta no produce una nueva recomendación. Descargar desde el resultado aplicado identifica su versión aun con otra histórica elegida. | FR-010–012 |
| **SC-006** | Cada uno de los dos ensayos FINREP tiene procedencia, catálogo, valores esperados, operación alcanzada y resultados observados o diagnóstico reproducible. La conclusión distingue formatos y acota las tablas y reglas efectivamente probadas. | FR-013 |
| **SC-007** | El icono nuevo se reconoce en encabezado y pestaña a los dos tamaños de prueba. La lectura inicial de la portada identifica la aplicación, su finalidad e icono sin ejecución interactiva, tanto con el conjunto vacío como con datos sintéticos cargados. Las dos lecturas contienen cero datos de ese conjunto en la información de descubrimiento. | FR-014–015 |
| **SC-008** | En la secuencia seleccionar 0 → 1 → 2 → 0 propuestas de una simulación, el panel pasa por oculto → visible → visible → oculto. Con las dos propuestas fuera de la página visible, indica dos seleccionadas. Una dependencia pendiente, una simulación obsoleta o la falta de confirmación impiden aplicar. Tras publicarse la aplicación, la consulta del histórico presenta cero paneles de confirmación. | FR-009, FR-016 |
| **SC-009** | Con 0, 1 y 2 contextos disponibles en la cabecera hay respectivamente 0, 0 y 1 selectores. Con uno, entidad, fecha y módulo son legibles una sola vez. Con dos, se puede elegir el segundo con teclado y sigue activo al cambiar de etapa. Si la lista se reduce a un único contexto, la cabecera muestra los datos de ese contexto como lectura. | FR-017 |

## Assumptions

- La primera entrega documentó la especificación y la prueba FINREP. Tras su revisión, Diego autorizó la planificación con FR-016 y FR-017 incorporados. La compatibilidad FINREP se caracteriza con el producto actual y datos sintéticos en un conjunto aislado. Implementar un perfil visual FINREP adicional requiere una decisión posterior.
- La retirada aprobada afecta al recorrido de usuario. El ensayo independiente de compatibilidad y las regresiones del motor pueden seguir utilizando el formato anterior. Las pruebas y mediciones históricas que usaban ese control se identificarán como tales al planificar sus sucesoras.
- Se adopta texto estático «Siguiente paso» junto al nombre de la etapa para que también pueda interpretarse con teclado, lector de pantalla y movimiento reducido. Como criterio de diseño, una omisión explícita prevalece sobre volver a proponer automáticamente la misma regla.
- La aplicación se utiliza en el entorno local del analista. La verificación de descubrimiento examina la portada allí donde es accesible. La evaluación de posiciones en buscadores, el alojamiento público y la exposición de espacios de trabajo quedan fuera del alcance.
- Las propuestas de adelantar los campos de archivo a las demos y de retirar el progreso terminado siguen pendientes de valoración. La revisión de las cuatro propuestas está en [evidencia.md](evidencia.md).
