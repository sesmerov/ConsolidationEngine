# Feature Specification: Flujo sencillo y demo pública independiente

**Feature Branch**: `codex/005-simplificar-flujo-vercel`

**Created**: 2026-11-08

**Status**: Draft

**Input**: Corregir los rectángulos de foco y realce; trasladar y simplificar la elección de destinos; centralizar las descargas; revisar todos los controles; preparar frontend y backend como proyectos Vercel separados; terminar la implementación actualizando README con diagramas y capturas reales.

**Aclaración del usuario**: «Demo pública con datos sintéticos y sesiones independientes», sin cuentas, SSO ni informes reales.

**Ampliación explícita del usuario**: README debe indicar que la demo se ha desarrollado mediante Spec Driven Development (SDD), utilizando Spec Kit.

**Aclaración de planificación del usuario**: «Priorizar planes gratuitos, con cuotas públicas y comprobación de capacidad». La elección no autoriza compras, upgrades automáticos ni reducir silenciosamente los límites de producto.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Reconocer la etapa y continuar sin adornos incorrectos (Priority: P1)

Como analista, quiero identificar dónde estoy y adónde continuar con ratón o teclado, sin rectángulos innecesarios sobre títulos o cabeceras desplegables ni un halo interior que parezca un defecto.

**Why this priority**: La guía debe orientar sin confundir decoración y foco, y adaptarse al nuevo recorrido.

**Independent Test**: Recorrer las cuatro etapas con ratón, teclado, movimiento reducido y colores forzados, comprobando los tres hitos de avance.

**Acceptance Scenarios**:

1. **Given** navegación con ratón, **When** se abre una etapa o un apartado como «Ver informes y contexto», **Then** título y cabecera desplegable no muestran un contorno rectangular innecesario; el título conserva la orientación programática y el teclado mantiene una señal de foco perceptible. No se retiran indicadores útiles de formularios o errores.
2. **Given** un hito completado, **When** se destaca la etapa siguiente, **Then** el realce acompaña el contorno completo del botón, sin rodear solo el texto, desplazar elementos ni añadir «Siguiente paso» debajo.
3. **Given** carga confirmada, validación completa o aplicación confirmada de los datos vigentes, **When** cambia la guía, **Then** se destaca respectivamente Validar, Recalcular o Descargar; fallos, resultados incompletos o históricos de otros datos no producen un avance falso.
4. **Given** movimiento reducido o colores forzados, **When** cambia la recomendación, **Then** sigue siendo identificable sin movimiento ni dependencia exclusiva del color.

---

### User Story 2 - Elegir solo las celdas que requieren una decisión (Priority: P1)

Como analista que ha validado, quiero encontrar al inicio de Recalcular «Elegir qué celdas recalcular», interviniendo solo donde existan alternativas o conflictos.

**Why this priority**: Validar sirve para consultar cumplimiento; decidir modificaciones pertenece a Recalcular. Preparar o guardar manualmente una decisión inequívoca añade pasos sin valor.

**Independent Test**: Abrir Recalcular con destino único, ambos lados elegibles, conflictos y ninguna regla recalculable, incluyendo entrada directa y cambios de configuración sin cambios de datos.

**Acceptance Scenarios**:

1. **Given** una igualdad con una única celda declarada elegible como destino, **When** se entra en Recalcular, **Then** queda preparada automáticamente y se puede simular sin «Preparar revisión» ni «Guardar configuración»; entrar, volver o recargar no cambia importes ni crea versiones repetidas.
2. **Given** dos lados elegibles, **When** se prepara el recálculo, **Then** se pide elegir u omitir. Si varias reglas compiten por una celda, se conserva la elección de productor o la omisión del grupo, sin ganador automático.
3. **Given** decisiones resueltas y pendientes, **When** se abre el panel, **Then** se muestran solo las pendientes y un resumen breve, con acceso deliberado a revisar las resueltas; navegar o filtrar no borra elecciones u omisiones previas.
4. **Given** resultados completos adecuados al catálogo y datos actuales, **When** cambia únicamente la configuración de destinos, **Then** no se exige volver a validar para preparar esos mismos destinos ni se entra en un ciclo de nuevas versiones. Si no hay resultados adecuados, se ofrece ir a Validar; no se usan resultados históricos de otros datos.
5. **Given** una validación completa sin candidatos, **When** se abre Recalcular, **Then** se explica que no hay recálculos y se permite ir a Descargar, sin guardar una configuración vacía.
6. **Given** una decisión pendiente o una base obsoleta, **When** se intenta simular o aplicar, **Then** se impide usarla como resuelta o vigente y se indica cómo continuar; cambiar propuestas o selección invalida la confirmación afectada. Aplicar sigue requiriendo aceptación explícita.

---

### User Story 3 - Descargar exactamente el resultado elegido (Priority: P1)

Como analista, quiero una única acción principal en Descargar para preparar y obtener el archivo elegido, con versión, contenido y ejecución coherentes.

**Why this priority**: Varios accesos a preparación, descarga aplicada y repetición pueden asociar el resumen o archivo anterior a una elección distinta.

**Independent Test**: Descargar los contenidos disponibles, alternar versiones y ejecuciones, y comprobar el archivo real ante cambios de elección, respuestas tardías, fallos y reintentos.

**Acceptance Scenarios**:

1. **Given** recálculos aplicados, **When** se consulta Recalcular, **Then** no hay descarga directa allí. El acceso desde los resultados de Validar navega a Descargar con la ejecución correspondiente preseleccionada.
2. **Given** una elección válida, **When** se prepara el archivo, **Then** un único botón expresa preparación, progreso, listo o reintento; no convive con ningún otro botón de preparación, descarga rápida o repetición, aunque se presente como secundario. Cancelar es una acción distinta cuando proceda.
3. **Given** versión 1 seleccionada y un archivo previamente preparado para versión 6, **When** se abre Descargar, **Then** elección, resumen y archivo ofrecido coinciden; no se presenta el archivo de versión 6 como perteneciente a versión 1.
4. **Given** una preparación en curso, **When** se cambia versión, contenido o ejecución, **Then** una respuesta anterior no sustituye la elección ni habilita un archivo incompatible. Fallar conserva la elección y permite reintentar sin duplicar resultados confirmados.
5. **Given** un histórico elegido voluntariamente, **When** se descarga, **Then** se identifica y conserva ese histórico, sin reemplazarlo por la última aplicación. Si falta una ejecución compatible, se explica cómo obtenerla o cambiar la elección.

---

### User Story 4 - Encontrar controles que aporten una elección útil (Priority: P2)

Como analista, quiero una interfaz breve en la que cada selector, desplegable, casilla o interruptor tenga una utilidad reconocible y funcione con teclado.

**Why this priority**: Simplificar no debe ocultar contexto, errores, cifras o decisiones. La revisión debe cubrir toda la interfaz.

**Independent Test**: Contrastar el inventario completo con la interfaz final y comprobar cero, una y varias opciones, errores, históricos y decisiones pendientes.

**Acceptance Scenarios**:

1. **Given** un único contexto, ejecución o versión posible, **When** se muestra, **Then** aparece como lectura; si existen alternativas reales, un selector accesible conserva la elección mientras sea válida.
2. **Given** un apartado desplegable, **When** se revisa, **Then** la decisión pendiente y la acción necesaria no quedan ocultas; el detalle útil sigue accesible y los apartados redundantes, vacíos o inoperantes se eliminan o corrigen.
3. **Given** un error, exclusión, ausencia, conflicto o dependencia, **When** se simplifica la pantalla, **Then** se conserva su efecto, la acción posible y el acceso al localizador, regla, importe u origen necesarios para entenderlo.
4. **Given** un control conservado, **When** se usa con teclado o en pantalla estrecha, **Then** tiene nombre, estado y función claros; no hay controles sin alternativas reales o que no cambien ningún comportamiento.

---

### User Story 5 - Probar la demo sin compartir datos con otros visitantes (Priority: P2)

Como visitante, quiero utilizar archivos sintéticos propios compatibles o las demos, conservar el trabajo durante mi sesión y no acceder al de otra persona.

**Why this priority**: El funcionamiento local no acredita continuidad o aislamiento cuando distintas peticiones se atienden en procesos diferentes.

**Independent Test**: Usar dos sesiones independientes, alternar el proceso que atiende operaciones y comprobar continuidad, aislamiento, interrupciones, caducidad y reintentos; separar esta prueba controlada de la verificación del alojamiento real.

**Acceptance Scenarios**:

1. **Given** dos visitantes sin cuenta, **When** cargan archivos y operan, **Then** conjuntos, originales, trabajos, versiones y descargas son independientes; conocer una referencia ajena no permite consultar ni modificar su contenido.
2. **Given** una sesión vigente, **When** se recarga o la siguiente operación se atiende en otra instancia, **Then** conserva los datos y estados confirmados. El seguimiento automático no prolonga indefinidamente su duración.
3. **Given** un trabajo aceptado, **When** se interrumpe el proceso o se pierde la respuesta, **Then** se recupera un estado consistente o un fallo explícito, sin resultados parciales ni aplicaciones duplicadas; se conservan los originales necesarios para exportar.
4. **Given** cierre o caducidad, **When** se intenta reutilizar la sesión, **Then** se revoca el acceso y se explica la situación; estado, archivos y residuos se eliminan dentro del plazo fijado aunque no se cierre el navegador.
5. **Given** frontend y backend en orígenes distintos autorizados, **When** se completa el recorrido, **Then** funcionan carga, seguimiento, escrituras, descarga y errores; se rechazan orígenes ajenos y abrir o recargar directamente una ruta del frontend no produce un error de página inexistente.
6. **Given** preparación para alojamientos separados, **When** se revisa la entrega, **Then** se identifican dependencias, configuración, cuotas, costes y evidencia local con dos orígenes, y se distingue la comprobación real realizada de la pendiente por falta de entorno autorizado.

---

### User Story 6 - Entender y arrancar el proyecto con documentación final (Priority: P3)

Como lector del repositorio, quiero entender qué hace el proyecto, cómo se organiza y cómo probarlo, con imágenes que correspondan al flujo terminado.

**Why this priority**: Documentar y capturar antes de terminar produciría instrucciones desfasadas; README será la última tarea funcional de la implementación.

**Independent Test**: Seguir README desde sus prerrequisitos y contrastar enlaces, diagramas y capturas con el recorrido final.

**Acceptance Scenarios**:

1. **Given** implementación comprobada, **When** se actualiza README, **Then** empieza explicando el proyecto en menos de diez líneas y después organiza tecnologías, arquitectura y puesta en marcha; declara que la demo se ha desarrollado mediante Spec Driven Development (SDD), utilizando Spec Kit, con enlace portable a `specs/`.
2. **Given** README final, **When** se consulta, **Then** incluye diagramas Mermaid de flujo y arquitectura y al menos cuatro capturas reales versionadas y enlazadas, una por etapa, con datos sintéticos de la interfaz final.
3. **Given** falta de entorno de alojamiento autorizado, **When** se documenta la preparación, **Then** se explica lo necesario y lo pendiente sin inventar cuentas, credenciales, despliegues o resultados.

### Edge Cases

- Ratón seguido de teclado, foco programático tras navegación o error, movimiento reducido y colores forzados; anchuras de 320, 390 y 1440 px; el halo no captura interacciones ni recorta texto.
- Validación incompleta o histórica de otros datos; configuración que crea una versión sin cambiar importes; entrada directa en Recalcular; ninguna regla elegible y decisiones pendientes fuera de la primera página.
- Destinos únicos que colisionan con otros productores, omisiones previas, ciclos y consumidores bloqueados; decisiones sin confirmar al salir o cambiar base; respuestas tardías de una revisión anterior.
- Cero, una o varias propuestas; dependencias fuera de la página; cambiar selección después de confirmar y reintentar una aplicación de resultado incierto.
- Cambiar versión, contenido o ejecución mientras se prepara; resumen o archivo anterior; ejecución incompatible; descarga caducada, fallida o cancelada; histórico elegido después de aplicar.
- Detalles vacíos, selectores sin alternativas y controles deshabilitados sin explicación; errores y exclusiones que siguen siendo esenciales aunque se reduzca texto.
- Sesiones simultáneas y referencias cruzadas, recarga y cambio de instancia, caducidad durante una operación, respuesta tardía tras cerrar, archivos huérfanos y fallo de limpieza.
- Archivos compatibles mayores de 4,5 MB dentro del límite admitido y paquetes de salida grandes; exceso de tamaño o capacidad pública, interrupciones y peticiones repetidas, sin reducir silenciosamente límites.
- Ausencia de cuenta, credenciales o servicios para alojamiento: queda pendiente la comprobación real, sin publicar ni contratar recursos automáticamente.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Corregir el contorno innecesario de títulos y cabeceras desplegables tras usar ratón, conservando orientación programática y foco visible por teclado. No se eliminarán globalmente contornos ni indicadores útiles de formularios, controles o errores.
- **FR-002**: El realce DEBE acompañar el contorno completo de la etapa recomendada, sin rectángulo interior, desplazamientos ni «Siguiente paso». La animación terminará antes de cinco segundos por hito; movimiento reducido y colores forzados tendrán una indicación estática perceptible.
- **FR-003**: La guía DEBE relacionar carga confirmada→Validar, validación completa de datos vigentes→Recalcular y aplicación confirmada→Descargar. No exigirá configurar destinos para entrar en Recalcular; cero candidatos no bloqueará Descargar. Se distinguirán etapa actual y recomendada.
- **FR-004**: Mantener una sola acción principal habilitada por objetivo y etapa, con nombre comprensible, contraste y acceso por teclado. Destacar una acción no permite ejecutarla automáticamente.
- **FR-005**: La elección de destinos DEBE desaparecer de Validar y situarse al inicio de Recalcular con el título exacto «Elegir qué celdas recalcular».
- **FR-006**: Los destinos inequívocos válidos DEBEN estar disponibles para simular sin preparación o guardado manuales. Entrar, volver o recargar no modificará importes ni publicará versiones repetidas. Se usarán resultados completos adecuados al catálogo y datos vigentes; cambiar solo configuración no obligará a repetir la validación ni generará un ciclo de validaciones y versiones.
- **FR-007**: Dos lados elegibles DEBEN requerir elección u omisión; productores que compitan por una celda requerirán resolución u omisión explícita. Se conservarán elecciones y omisiones previas mientras sean vigentes, sin ganador automático ni restablecimiento por navegación.
- **FR-008**: El panel inicial DEBE mostrar decisiones pendientes y un resumen de lo resuelto, permitiendo revisar y cambiar deliberadamente decisiones previas. Filtros, páginas y contextos no borrarán decisiones; una salida con cambios sin confirmar no los perderá silenciosamente. No se simulará como si las decisiones pendientes estuvieran resueltas.
- **FR-009**: Se DEBEN conservar simulación, selección múltiple, cierre de dependencias, vigencia de la base y aplicación atómica con confirmación explícita. Un cambio relevante de propuestas o selección invalidará la confirmación; no habrá autoaplicación. Condicionales, texto, fechas y desigualdades seguirán ofreciendo solo validación.
- **FR-010**: Toda descarga de archivos generados a partir del conjunto DEBE centralizarse en Descargar, incluidos resultados hoy accesibles desde Validar. Otras etapas podrán navegar allí con la elección pertinente, pero no descargar directamente. Demos y plantillas de Cargar quedan fuera de esta unificación.
- **FR-011**: Descargar DEBE ofrecer un único botón para preparar, descargar o reintentar el contenido elegido, con estado de progreso cuando corresponda. No habrá otros botones de descarga, aunque se presenten como secundarios; se retirarán atajos de última aplicación y repetición. Cancelar seguirá disponible como acción distinta cuando proceda.
- **FR-012**: Elección visible, resumen, trabajo y archivo DEBEN corresponder a la misma versión, contenido y ejecución compatible. Nunca se identificará un archivo de versión 6 como versión 1 ni se sustituirá un histórico por la última versión aplicada sin elección del usuario.
- **FR-013**: Cambiar la elección DEBE invalidar un archivo incompatible. Respuestas tardías, reintentos y recargas no sobrescribirán la elección ni duplicarán trabajos confirmados. El resumen describirá contenido, versión y ejecución o carácter histórico cuando corresponda, con etiquetas comprensibles; fallos y caducidad tendrán recuperación clara.
- **FR-014**: Se DEBE revisar todo el inventario de selectores, desplegables, casillas e interruptores de las cuatro etapas y contexto global. Cada tipo tendrá una decisión verificable: conservar por utilidad, simplificar, trasladar, eliminar por redundancia o reparar.
- **FR-015**: Un dato de una única opción DEBE mostrarse como lectura; se conservará selector cuando haya elección real. No se perderá acceso a contextos, históricos, perfiles ambiguos, filtros, escala, precisión o presentación de tablas necesarios para el trabajo.
- **FR-016**: Los desplegables DEBEN reservarse para detalle útil y funcionar con teclado. Una decisión pendiente, error o acción necesaria no dependerá de descubrir un apartado oculto; se retirarán detalles vacíos, duplicados o inoperantes.
- **FR-017**: Conservar cifras, reglas, antes→después, ausencia frente a cero, exclusiones, diagnósticos localizados y acceso al origen útil; no presentar hojas preservadas como validadas ni eliminar información que cambie una decisión.
- **FR-018**: Preparar frontend y backend para proyectos Vercel separados, con direcciones propias, configuración y pasos reproducibles. El recorrido completo DEBE funcionar entre orígenes distintos autorizados: carga, seguimiento, escrituras, descarga, errores y comprobaciones previas del navegador; se rechazarán orígenes ajenos y abrir o recargar rutas del frontend no producirá errores de página inexistente. Esta entrega no publicará servicios, creará cuentas ni contratará recursos; dos configuraciones por sí solas no acreditarán un recorrido alojado funcional.
- **FR-019**: La demo pública DEBE indicar brevemente que admite solo datos sintéticos y permitir archivos sintéticos propios compatibles además de las demos. No incluirá cuentas o SSO ni afirmará detectar automáticamente si un archivo representa información real.
- **FR-020**: Cada visitante DEBE tener una sesión anónima privada e independiente. Ninguna referencia de conjunto, archivo, trabajo, versión o descarga permitirá consultar o modificar otra sesión; no habrá sesión global compartida.
- **FR-021**: La sesión vigente DEBE continuar tras recargar y entre distintas instancias, conservando originales, versiones, decisiones, selecciones y estados confirmados durante su vigencia, sin depender de que un único proceso permanezca vivo.
- **FR-022**: Los trabajos aceptados DEBEN tener estado recuperable, límites y resultado terminal definido. Interrupciones, concurrencia y reintentos no publicarán resultados parciales ni duplicarán importaciones, configuraciones o aplicaciones; se conservarán atomicidad, vigencia e idempotencia.
- **FR-023**: Por defecto, la sesión DEBE caducar tras 60 minutos sin actividad significativa o 24 horas desde su creación, lo que ocurra antes; el seguimiento automático no renueva esos plazos. Debe avisarse al acercarse la caducidad sin banner técnico permanente. Cierre o caducidad revocarán acceso inmediatamente y eliminarán estado, archivos y residuos en un máximo de 24 horas, sin depender del cierre del navegador. Una configuración distinta será explícita y comprobable.
- **FR-024**: Mantener los límites de carga vigentes: 10 MiB por archivo, 50 MiB por lote, 100 MiB expandidos, un catálogo y hasta 20 informes. Las cuotas públicas por sesión y despliegue serán finitas y explícitas; excederlas rechazará la operación de forma comprensible sin sobrescribir datos ajenos ni reducir silenciosamente límites. Se comprobarán también salidas grandes dentro de sus cuotas vigentes.
- **FR-025**: La preparación DEBE identificar servicios necesarios, variables, orígenes permitidos, protección de credenciales, cuotas, costes previsibles y pasos de operación, priorizando planes gratuitos con cuotas públicas y comprobación de capacidad. No se contratarán upgrades automáticamente ni se rebajarán límites de producto para aparentar compatibilidad. Producción y entornos de revisión tendrán autorizaciones explícitas, sin admitir indiscriminadamente todos los dominios de Vercel; los secretos del backend no se incluirán en el frontend. Proveedores y configuración concreta se elegirán en el plan, sin darlos por decididos en esta especificación.
- **FR-026**: La evidencia DEBE separar la comprobación local obligatoria con dos orígenes, continuidad y aislamiento de la comprobación en alojamiento real. Si falta un entorno autorizado, esta última quedará pendiente, sin inventar despliegue correcto ni adquirir servicios para obtener evidencia.
- **FR-027**: README DEBE actualizarse como última tarea funcional de la implementación, tras comprobar el recorrido final. Esta fase no lo reescribirá ni presentará capturas actuales como resultados futuros.
- **FR-028**: README DEBE empezar explicando el proyecto en menos de diez líneas y organizar después tecnologías, arquitectura, requisitos, configuración, arranque local, preparación de alojamiento, pruebas y límites. Declarará que la demo se ha desarrollado mediante Spec Driven Development (SDD), utilizando Spec Kit, y enlazará de forma portable a `specs/`. Incluirá diagramas Mermaid de flujo y arquitectura coherentes con lo implementado.
- **FR-029**: README DEBE enlazar al menos cuatro capturas reales versionadas, una por etapa final, con datos sintéticos y sin información privada ni credenciales; sus enlaces funcionarán desde el repositorio.
- **FR-030**: Conservar las regresiones COREP y FINREP F 01.01, los originales oficiales intactos, valores exactos, orden de dependencias y distinción entre soporte limitado y conformidad general. Esta especificación no acredita implementación, nuevo rendimiento ni aceptación humana de ninguna iteración.

### Key Entities *(include if feature involves data)*

- **Etapa y recomendación**: vista actual y siguiente acción útil, vinculadas a resultados confirmados de los datos vigentes y presentación accesible.
- **Decisión de recálculo**: celda, regla o productor, contexto y base; inequívoca, pendiente, elegida u omitida; separada de la aceptación de importes.
- **Elección de descarga**: versión, contenido y ejecución cuando corresponda; vincula resumen, preparación y archivo ofrecido.
- **Sesión de demo**: espacio privado anónimo con actividad, caducidad y cuotas, aislado de los demás visitantes.
- **Trabajo y artefacto**: operación aceptada y resultado publicado para una sesión y base, con estado recuperable, identidad para reintentos y vigencia.
- **Evidencia de entrega**: inventario resuelto, pruebas, capturas y documentación que distinguen resultado local, alojamiento y observación humana.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: En 320, 390 y 1440 px, los tres hitos destacan la etapa correcta sin «Siguiente paso», rectángulos innecesarios de título o cabecera desplegable tras ratón ni halo limitado al texto; teclado, movimiento reducido y colores forzados permiten identificar etapa y foco en todos los casos probados. La animación termina antes de cinco segundos y se conservan los indicadores útiles de formularios y errores.
- **SC-002**: Los casos de destino único, ambos lados, conflictos y cero candidatos cumplen el recorrido definido: 100 % de destinos inequívocos disponibles sin preparación/guardado manual y todas las ambigüedades resueltas u omitidas expresamente antes de simular. Diez entradas o recargas sin cambios no crean versiones ni alteran importes; cambiar solo configuración no exige revalidar los mismos datos.
- **SC-003**: No existe descarga directa de resultados del conjunto fuera de Descargar. Cada estado de preparación, progreso, listo o fallo muestra un único botón de preparación, descarga o reintento, sin otro botón de descarga secundario; se conservan cancelación y recuperación cuando correspondan.
- **SC-004**: En todos los casos probados de cambio de versión, contenido, ejecución, respuesta tardía y reintento, el archivo coincide con elección y resumen. Se incluye versión 1 seleccionada frente a archivo previo de versión 6 y descarga voluntaria de histórico después de aplicar.
- **SC-005**: El 100 % de los tipos de controles inventariados tiene decisión y comprobación final; todos los conservados funcionan con teclado. Casos de una opción, error, exclusión, conflicto, dependencia y origen útil mantienen acceso a la información necesaria sin controles vacíos o duplicados.
- **SC-006**: Dos visitantes simultáneos completan independientemente carga, validación, recálculo y descarga; ningún intento cruzado de las referencias probadas obtiene acceso. Recarga y cambio de instancia conservan trabajo confirmado antes de caducar; interrupciones y respuestas perdidas no duplican aplicaciones ni publican versiones parciales.
- **SC-007**: Se acredita revocación al cumplirse cualquiera de los plazos de sesión y limpieza completa, incluidos residuos, en 24 horas. Se comprueban cargas por debajo, en el límite y por encima de las cuotas, incluido un archivo válido mayor de 4,5 MB, y descargas grandes dentro de las cuotas, sin rebajar límites de producto.
- **SC-008**: Existe una guía reproducible de los dos proyectos, dependencias, configuración, cuotas y costes. La prueba local con dos orígenes autorizados completa carga, seguimiento, escrituras, descarga y errores, rechaza otro origen y permite acceso directo y recarga de rutas. Cada comprobación se identifica como local, realizada en alojamiento o pendiente; no se declara verificado un despliegue sin entorno autorizado.
- **SC-009**: Las demos mantienen los resultados de sus recorridos guiados fijados: COREP 7 pasan/8 fallan/1 no aplica antes y 14/1/1 después de sus cinco recálculos y elecciones previstas; FINREP F 01.01 2 pasan/3 fallan antes y 4/1 después, con 90→100 y 105→120; texto/fechas 6 pasan/2 fallan y solo valida. Se conservan descarga/reimportación e integridad de originales.
- **SC-010**: README cumple introducción de menos de diez líneas, declaración de desarrollo mediante Spec Driven Development (SDD) con Spec Kit, enlace portable a `specs/`, dos diagramas y cuatro capturas reales enlazadas; un lector puede localizar prerrequisitos y completar el arranque local siguiendo sus instrucciones, registrando cualquier ayuda necesaria. Esta comprobación se realiza tras terminar el flujo.

## Assumptions

- Esta entrega comprende especificación, evidencia e inventario; no plan, tareas, producto, nuevas pruebas ni publicación. La aceptación humana SC-010 de 004 sigue pendiente y no se cierra con esta fase.
- Se mantienen Angular, Node.js, ANTLR con salida JavaScript y Kahn, elegidos por el usuario. Vercel y proyectos separados son restricciones explícitas; los proveedores de estado, almacenamiento y ejecución se decidirán en el plan.
- La autorización de demo pública constituye una excepción explícita al uso exclusivamente local para datos sintéticos; no autoriza enviar informes reales ni cambia las garantías del modo local. Se excluyen cuentas, SSO, colaboración sobre el mismo conjunto, recuperación permanente y continuidad entre dispositivos.
- La sesión continúa en el mismo navegador mientras sea vigente. Se adoptan 60 minutos de inactividad significativa, 24 horas de duración absoluta y hasta 24 horas de limpieza tras revocación; cualquier revisión del plan será explícita, sin debilitarlas silenciosamente.
- Se conserva el alcance de perfiles y plantillas existente, incluidos COREP CA1 y FINREP F 01.01 del layout fijado. Compatibilidad con varios informes no significa aceptar cualquier Excel ni conformidad EBA completa.
- Una decisión inequívoca puede automatizarse, pero elegir productor, seleccionar propuestas y aceptar aplicación son actos distintos. Reutilizar resultados adecuados a los datos evita bucles por versiones que solo cambian configuración; su diseño se concretará en el plan.
- Una única descarga significa un único botón para la elección actual y su ciclo de preparación, sin otros botones secundarios de descarga; no elimina contenidos, históricos, cancelación ni ejecución cuando haya una elección útil. Demos y plantillas permanecen en Cargar.
- Mermaid se adopta como formato documental para los diagramas de flujo y arquitectura solicitados; no representa una decisión sobre la arquitectura del alojamiento.
- Disponibilidad de servicios, autorización, límites y costes condicionan la comprobación real. Antes de implementar se concretarán en el plan, manteniendo límites de producto o exponiendo una incompatibilidad que deba resolverse.
- Se priorizan planes gratuitos por elección explícita del usuario, con límites públicos de admisión y evidencia de capacidad. Esto no garantiza coste cero ni disponibilidad continua frente a uso ajeno, cambios o interrupciones del proveedor; un upgrade requerirá otra decisión expresa.
- Hallazgos y fuentes se conservan en [evidence.md](evidence.md); son evidencia del estado actual y del alcance solicitado, no una arquitectura elegida ni cambios ya implementados.
