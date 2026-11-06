# Contrato de interfaz del recorrido 003

Diseño para la fase de implementación. Las cuatro etapas comparten los stores que provee `WorkspaceShellComponent`. El shell coordina las indicaciones aunque la vista que inició el trabajo ya esté desmontada. `SessionStore` continúa siendo la fuente de la versión publicada, la lista de contextos y la versión elegida por el usuario para exportar.

## Cargar y consultar reglas · FR-001–004

La carga interactiva presenta catálogo e informes, declaración de contexto, inspección, revisión y confirmación. Se retiran el bloque del formato anterior, el acceso a su plantilla, sus dos archivos de ejemplo, su guía de ocho pasos y las ramas de formulario que iniciaban la carga directa. Se conservan las dos demos visuales y la compatibilidad de la API para el ensayo FINREP y datos anteriores.

El botón «Información técnica» abre una ayuda secundaria reconocible desde teclado y pantalla táctil. El botón expone su nombre y estado expandido. El contenido permite leer y copiar identificadores, huella y detalles de precisión o límites. Al cerrar con su acción de cierre o Escape, vuelve el foco al botón que la abrió si sigue disponible. Si se descartó la revisión y el botón desapareció, el foco regresa al encabezado de Cargar. Un error localizable, una exclusión que exige aceptación y una caducidad que impide confirmar permanecen junto a la operación.

El código de regla se busca en todo el catálogo publicado. La clave de consulta comprende conjunto, versión, código, estado y tabla. `GET /rules` ya acepta estos filtros y firma el cursor con esa misma identidad. En Cargar, el cliente y el store trasladarán también la tabla elegida. Las filas mostradas corresponden a la combinación completa de filtros.

1. Escribir, pegar o borrar actualiza el texto visible y hace obsoletos inmediatamente la generación y el cursor anteriores. Tras 250 ms desde la última entrada se solicita la primera página. Elegir estado o tabla aplica la combinación actual e invalida cualquier temporizador anterior.
2. Solo se acepta una página, un error o una actualización del estado de carga si pertenecen a la generación y clave vigentes. «Cargar más» exige el cursor de la respuesta aceptada para esa clave. Durante un cambio de consulta se inhabilita el cursor previo.
3. Los controles y la cobertura publicada se mantienen montados para la versión. El listado distingue consulta en curso, coincidencias, búsqueda sin coincidencias y error recuperable. Borrar el texto recupera las reglas que corresponden a los otros filtros. Los errores de peticiones obsoletas tampoco se anuncian.
4. El campo conserva el foco durante las actualizaciones. Un estado breve anuncia el total cuando llega el resultado válido. Cambiar de etapa conserva los filtros del conjunto. Cambiar de versión invalida filas y cursores, luego consulta la primera página para esa versión. Cerrar el conjunto cancela la espera y descarta el estado local.

La búsqueda usa coincidencia parcial sin distinguir mayúsculas. Para SC-002 se mide desde la última entrada hasta que se presentan las filas vigentes, incluida la pausa, con hasta 500 registros en el equipo de referencia. El objetivo es un segundo.

## Revisar destinos · FR-005–009

El panel solo permite guardar desde una revisión completa y vigente de la ejecución correspondiente. La tabla identifica cada instancia y su celda con etiquetas humanas. Los datos de clasificación, el resumen global y la resolución de productores proceden de la revisión descrita en [el contrato de destinos](direction-review.md).

| Situación | Presentación y acción |
| --- | --- |
| Un solo lado elegible y otro descartado con certeza | Celda y origen «Automático». El analista puede incluir u omitir la instancia. |
| Ambos lados elegibles | Elección identificada por las dos celdas u omisión. Una decisión guardada válida se presenta como tal. |
| Solo validación o ningún lado elegible | Grupo con recuento y razón consultable. Cero selectores de dirección. |
| Comprobación indeterminada por plazo, cuota o datos insuficientes | Motivo visible al revisar los casos pendientes. La aplicación espera una decisión verificable para incluir la instancia. |
| Varios productores para el mismo destino | Se identifican celda, contexto y reglas del grupo completo, aunque alguno esté en otra página. Se elige qué productor usar o se omite el grupo. |

El resumen muestra los destinos incluidos, omitidos y pendientes de toda la revisión, incluso al cambiar de página o filtro. Si se decide guardar un subconjunto, el analista revisa su alcance. Guardar publica la configuración. Simular y aplicar siguen siendo acciones independientes. La guía COREP muestra las dos decisiones del ejemplo: conservar `v0174_m` frente a `DEMO_RANGE` y `DEMO_PRECONDITION` en r0070 y omitir `DEMO_ZERO` y `DEMO_INTERVAL` en r0200. Quedan los cinco productores oficiales.

## Guiar el siguiente paso · FR-010–012

`WorkspaceViewStore` mantiene un único hito efímero identificado por conjunto, operación y versión publicada. En el menú, `aria-current="step"` identifica la etapa abierta. La etapa recomendada incluye una marca estática y el texto «Siguiente paso» en su nombre o descripción accesible. Se anuncia una vez al confirmar el hito, conservando el foco y la etapa activa.

| Operación | Evidencia necesaria | Recomendación |
| --- | --- | --- |
| Confirmar carga | Trabajo de importación asociado al commit de la inspección, éxito y versión publicada corroborada en el conjunto | Validar |
| Guardar configuración | Confirmación del guardado de la revisión correcta, versión resultante corroborada y al menos un destino utilizable | Recalcular |
| Aplicar cambios | Trabajo de aplicación terminado correctamente y recibo de esa aplicación, con versión resultante corroborada | Descargar |

El 202, la inspección lista, el envío de una solicitud, la simulación, un fallo, una cancelación y una respuesta incierta carecen por sí solos de efecto sobre la recomendación. Un guardado rechazado por versión obsoleta exige refrescar el conjunto y revisar sus decisiones. Un reintento de la misma operación espera la confirmación y reutiliza su identidad. Los eventos tardíos de otro conjunto/base y las repeticiones de un hito consumido se descartan.

Cada actualización contrasta la identidad del conjunto y su versión: si primero llega el éxito y luego el refresco que acredita la versión resultante, se retiene el dato pendiente hasta reconciliarlo. Solo se muestra el hito que corresponde a la versión vigente y a la operación confirmada. Se consume al entrar en la etapa señalada; si ya se está allí, se considera atendido. Un cambio de base que invalida el hito o el cierre del conjunto lo retira. Un refresco ordinario del mismo conjunto y versión conserva una señal vigente. Recargar por completo el navegador recrea el estado de presentación. La recuperación de trabajos activos puede acreditar un hito recién completado. La mera consulta de un recibo histórico no lo recrea.

Al seguir la indicación de Descargar se entrega a la etapa la referencia al recibo y su `newVersionId`. Consumir la marca del menú conserva ese dato de entrada mientras sea pertinente. Una acción explícita etiquetada con la versión aplicada usa `ExportStore.startForVersion(newVersionId)`, como la acción de comparación. Se mantiene el valor que el analista tenía en el selector histórico. Entrar en la etapa permite revisar qué descargar. El archivo se solicita al pulsar su acción. Para una ejecución exclusivamente de validación o con todos los destinos omitidos se conserva la descarga de resultados de esa ejecución.

## Selección y confirmación de aplicación · FR-009 y FR-016

La visibilidad depende del conjunto global de identificadores elegidos en la simulación actual, `PreviewStore.selected`. La respuesta de comprobación de dependencias puede tardar y solo determina la posibilidad de aplicar. Consultar una dependencia mantiene su selección explícita en manos del analista.

| Situación | Confirmación | Acción de aplicar |
| --- | --- | --- |
| Simulación vigente, cero seleccionadas | Oculta, sin casilla ni botón en el recorrido de teclado | Inactiva |
| Una o más seleccionadas, incluso fuera de página | Visible con el total global, al seleccionar la primera | Espera el cierre válido y el consentimiento de esa selección |
| Dependencias pendientes, detalle insuficiente o cierre aún en consulta | Visible mientras haya selección vigente, con el motivo de espera o bloqueo | Inactiva |
| Última propuesta desmarcada | Desaparece en la misma actualización y se revoca la aceptación | Inactiva |
| Simulación obsoleta, descartada o aplicada | Consulta de estado y, cuando corresponda, comparación y recibo | Sin confirmación de escritura |

El bloque visual puede ocultarse sin destruir la sincronización del store. Cada cambio efectivo de selección, de simulación, de base o de cierre invalida inmediatamente la aceptación anterior. Esto incluye desmarcar y volver a marcar exactamente los mismos identificadores antes de que termine una consulta. Un contador local de revisión de selección o una invalidación explícita en `toggle` evita reutilizar un consentimiento si los arrays y el hash finales coinciden. Paginar sin cambiar la selección conserva el estado correspondiente.

El checkbox y el botón de aplicar mantienen las comprobaciones de `ApplyStore`: simulación vigente, cierre completo, ausencia de dependencias exigidas, filas disponibles y verificadas para los IDs exactos, ETag válido y ausencia de mutaciones incompatibles. La casilla se marca por acción del usuario. La recuperación de un envío incierto, sus errores y el progreso del trabajo permanecen accesibles fuera de la condición visual del panel. El reintento conserva cuerpo, ETag y clave de la solicitud original hasta reconciliarla.

## Contexto de la cabecera · FR-017

La cardinalidad se calcula con los contextos disponibles en `WorkspaceDTO.contexts`. La selección efectiva es `SessionStore.selectedContextId`. Entidad, fecha civil de referencia y módulo identifican el contexto en la cabecera.

| Contextos disponibles | Cabecera | Selección efectiva |
| --- | --- | --- |
| 0 | Datos generales del conjunto; se omiten selector y datos de contexto anterior | Vacía |
| 1 | Entidad, fecha y módulo se leen una sola vez como datos de lectura, sin control enfocable | ID del único contexto |
| 2 o más | Un selector etiquetado «Contexto» permite elegir con teclado y refleja la opción activa | ID elegido si continúa en la lista, o el primer ID disponible |

Se usa la identidad estable de los contextos, aunque dos opciones compartan entidad, fecha y módulo. Cuando haga falta, distinguirlas con los datos de ámbito disponibles o una numeración estable para esa lista. En cambios 2 → 1 → 0 y al sustituir el conjunto se reconcilia la selección antes de pintar. Si desaparece un selector mientras tenía el foco, se devuelve al encabezado del conjunto o a su dato de contexto, sin activar otra etapa. La navegación entre etapas y el refresco del mismo conjunto conservan un ID válido. El selector de contexto informativo y el origen de contexto del formulario de carga tienen propósitos separados.

## Icono y contenido inicial · FR-014–015

El mismo símbolo de producto se utiliza en cabecera y pestaña. Se propone un SVG cuadrado local de trazos sencillos que combine un informe tabular con una marca de verificación. Debe distinguirse a 16 y 32 px y sobre los fondos de uso. Junto al nombre de marca visible actúa como imagen decorativa. Cuando aparece solo, se proporciona el nombre accesible «ConsolidationEngine».

El build web empaqueta el recurso local y el documento inicial en español incluye título, descripción breve, enlace al favicon y nombre/finalidad legibles antes de arrancar la aplicación. Este contenido genérico puede ocupar el interior inicial del elemento raíz y ceder el sitio al shell interactivo al iniciar Angular. Una petición anónima a la portada obtiene los mismos contenidos de descubrimiento tanto con una sesión vacía como con un conjunto cargado. El nombre del conjunto, entidad, informes, reglas privadas, importes, tokens y URLs de trabajo pertenecen al contenido de sesión. La prueba de esta fase futura usa el servidor local y lee la respuesta inicial y el recurso del icono. El rastreo público requiere una superficie pública y queda fuera del despliegue previsto.

## Comprobaciones de aceptación

- SC-001–002: navegar con teclado y toque, abrir y cerrar la ayuda, copiar una huella y confirmar una exclusión. Buscar una regla más allá de los 50 primeros registros y probar una respuesta tardía después de borrar o cambiar de versión.
- SC-003–005: probar los tres casos de dirección, productores en páginas separadas, las ocho reglas tipadas y los tres hitos a 320, 390 y 1440 px. Confirmar la versión descargada cuando el histórico tiene otra seleccionada. Remitirse al [contrato de revisión de destinos](direction-review.md).
- SC-007: comprobar título, descripción, nombre y acceso al icono con lectura del HTML inicial, luego reconocer el símbolo a los dos tamaños y verificar que el arranque presenta el nombre del producto una sola vez en la cabecera.
- SC-008: 0 → 1 → 2 → 0 con dos seleccionadas fuera de la página. Añadir el retorno rápido a la misma selección, respuesta de cierre tardía, dependencia no elegida, intento incierto y revisión histórica tras aplicar.
- SC-009: 0, 1 y múltiples contextos, cambio por teclado, refresco con ID aún válido y retirada de la opción activa. En el caso 2 → 1 se muestra el contexto restante una sola vez.
