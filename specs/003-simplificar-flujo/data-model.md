# Modelo de datos y estados

Diseño de la iteración 003. El workspace conserva snapshots inmutables. Una ejecución evalúa una versión concreta y una revisión de destinos usa exclusivamente las instancias de esa ejecución. El borrador de destinos, la configuración guardada y la selección de propuestas corresponden a tres decisiones consecutivas. [Especificación](spec.md) · [Decisiones técnicas](research.md)

## Configuración y revisión de destinos

| Entidad | Identidad y contenido | Reglas |
|---|---|---|
| Snapshot | `versionId`, padre, perfil, catálogo, contextos, coordenadas, hechos, `directions`, `configVersion` y nuevo `directionDecisionState?`. | La lista `directions` sigue siendo la autoridad para simulación. Cada entrada se obtiene del resolutor de la versión. La publicación de configuración es atómica. |
| Ejecución | `workspaceId,runId,versionId`, estado y resumen. Cada fila tiene `resultId` y puede tener `instanceId,variantIds,binding`. | Solo una ejecución completa de la versión vigente produce una revisión editable. La identidad de instancia incluye su ámbito de resolución. Las filas de cobertura se cuentan como excluidas. |
| Revisión temporal | `id,workspaceId,baseVersionId,runId,state,revision,readyAt?,expiresAt?,jobId?,counts?,receipt?`. Mantiene la proyección global de instancias, grupos y decisiones temporales. | Como máximo una viva por workspace. Cada edición aceptada cambia la revisión una vez. Filtrar, leer otra página o navegar por las etapas conserva el borrador. |
| Fila de revisión | `rowId`, referencia al resultado, instancia si existe, lados elegibles, ubicación legible, motivo, decisión y origen. | Una referencia única por sí sola puede ser destino. La elegibilidad exige el contexto correcto, la política de la regla completa y la resolución de ambos lados. Un resultado «Pasa» puede ser productor y «Falla» puede carecer de destino. |
| Grupo de productores | Un destino canónico interno (`target.factKey`) y el conjunto de productores que lo proponen en la revisión actual. Se expone como `groupId` opaco, ubicación y cardinalidad. | Comparar la identidad completa del hecho, incluidas entidad, periodo y dimensiones que correspondan. Una igualdad ambigua incorpora al grupo su lado elegido. Propuestas de dos reglas para el mismo destino exigen un ganador explícito u omitir el grupo. |
| Recibo de configuración | `reviewId,runId,baseVersionId,newVersionId,configVersion,included`. | Acredita un guardado y permite señalar Recalcular con destinos utilizables. El recibo de aplicación existente acredita, en otra operación, qué versión tiene los valores recalculados para Descargar. |

### Procedencia y compatibilidad de los snapshots

`directionDecisionState` es un campo opcional y versionado de `SnapshotContent`. La representación propuesta incluye `schemaVersion:1`, `mode:"new"|"reviewed"`, y, cuando se revisó, `source:"review"|"replace"`, la procedencia de las elecciones y las omisiones explícitas por identidad estructural. Se guardan referencias y excepciones canónicas, ordenadas y sin duplicados. El caso «omitir todo» admite un valor por defecto y excepciones dispersas, evitando enumerar un millón de omisiones. La interfaz diferencia que una elección ya estaba guardada de cómo se obtuvo originalmente.

En modo `new` bastan la versión del esquema y el modo. En `reviewed` se guardan los siguientes campos junto con `source`:

| Campo | Semántica |
|---|---|
| `originDefault` y `originExceptions:[{instanceId,origin}]` | Origen de los productores incluidos en `directions`. Se admite `automatic`, `explicit` o `previous` para una elección anterior de origen desconocido. Las excepciones deben apuntar a una dirección incluida. El PUT compatible usa `explicit` como origen de las elecciones recibidas. |
| `unselectedDefault` y `unselectedExceptions:[instanceId]` | Decisión para instancias configurables de esta base que quedaron fuera de `directions`. Con valor `pending`, las excepciones identifican omisiones explícitas. Con `omitted`, identifican las que quedaron pendientes. Los ids son disjuntos de las direcciones incluidas. Las categorías estructurales excluida e indeterminada se recalculan al preparar la revisión. |

La normalización elige la representación con menos excepciones a igualdad de decisiones, con desempate fijo (`explicit` y `pending`, respectivamente) y orden por `instanceId`. En una nueva importación se reinicia el modo, de modo que una decisión para una instancia antigua nunca se extiende a otro catálogo importado por compartir el código visible.

| Estado de origen | Base de las sugerencias y decisiones |
|---|---|
| Importación en 003 (`new`) | Empieza sin decisiones. Los lados demostrablemente únicos se proponen automáticamente en la primera revisión. Con dos lados la instancia queda pendiente. Se presentan todas las competencias antes de guardar. |
| Guardado en 003 (`reviewed`, `source:review`) | Conservar las direcciones válidas, su procedencia y las omisiones explícitas. El conjunto de destinos aceptados está definido por `directions`. Una instancia previamente pendiente que quedó fuera de una sustitución parcial se muestra pendiente, sin reactivarse al abrir la revisión. Una omisión puede recuperarse mediante una acción del analista. |
| Reemplazo mediante PUT compatible (`reviewed`, `source:replace`) | Las entradas enviadas son elecciones explícitas. La ausencia significa «fuera de esta configuración completa». El reemplazo vacío se distingue de una importación nueva. Se puede volver a proponer una instancia mediante la revisión. |
| Snapshot anterior con campo ausente | Reconocer el modo derivado `previous`. Conservar las direcciones guardadas válidas y mostrar las demás sugerencias sin activar decisiones por la mera ausencia de una fila. Una indicación «Revisar sugerencias» permite adoptar explícitamente recomendaciones comprobadas. Un hash de configuración vacía histórico no permite distinguir «importado» de «quitar todas». |

Las elecciones que han dejado de ser válidas se identifican como pendientes de revisión con motivo y se incluyen en el resumen de alcance. Una revisión interrumpida por cuota, cancelación o timeout conserva el snapshot publicado. Al guardar, `configVersion` se calcula con la ordenación canónica de las direcciones **y** del estado de decisión de la nueva representación. Para snapshots previos se respeta la huella almacenada. Una aplicación que solo cambia hechos transporta las decisiones guardadas al nuevo snapshot. Una importación inicia otra base con `mode:new`. El ejecutor comprueba la política contra la nueva base al preparar cualquier simulación o aplicación.

### Estados de decisión

- `included` identifica el único productor aceptable de un destino en el borrador. La resolución puede proceder de la sugerencia única, de una elección del usuario o de una decisión guardada. Una competencia mueve todos sus productores efectivos a `conflicted`.
- `omitted` registra exclusión expresa de instancia o grupo. `pending` requiere elección de lado o revisión de una decisión anterior. `conflicted` permite consultar todos los candidatos al mismo hecho, incluidas otras páginas.
- `excluded` abarca reglas solo validación, ninguna dirección admisible y cobertura sin instancia. `undetermined` identifica comprobaciones inconclusas por una causa conocida. Estas categorías nunca generan propuestas de escritura. Agotar el presupuesto de todo el recorrido termina el trabajo sin borrador listo.
- Los grupos se vuelven a calcular para las decisiones afectadas cada vez que se elige un lado o un productor. Las propuestas resultan después de guardar y simular. La clasificación de productores conserva las barreras sobre dependencias, ciclos y conflictos que el motor evalúa mediante Kahn.

La revisión pasa de preparación a lista y después a confirmación. Puede terminar confirmada, descartada, caducada, obsoleta o fallida. Una confirmación en curso sella su revisión. El [contrato de revisión](contracts/direction-review.md) fija los límites, la política de replay, el caso de reintento y las condiciones para volver a lista tras un fallo.

## Estado de consulta y de presentación

| Estado | Identidad y datos mínimos | Transición observable |
|---|---|---|
| Consulta del catálogo | Workspace, versión, código introducido, estado, tabla, generación, cursor y página aceptada. | Escribir, pegar o borrar actualiza el texto e invalida inmediatamente las peticiones antiguas. Tras 250 ms sin otra entrada se consulta desde la primera página. Cambiar otros filtros o la base invalida cursores y generaciones anteriores. Un resultado vacío conserva los filtros montados y el foco. |
| Contexto de cabecera | `WorkspaceDTO.contexts` y `SessionStore.selectedContextId`. La presentación utiliza entidad, fecha civil de referencia y módulo. | Cero contextos limpia la referencia y muestra cero selectores. Con uno se presenta una sola descripción de lectura. A partir de dos aparece el selector con el elemento activo. Se conserva el id válido al cambiar de etapa y al refrescar los datos. Si desaparece, se usa el primer contexto de la lista vigente como ya hace el store. |
| Próximo paso | En el store del workspace, `workspaceId,operationId,versionId,nextStage` para una operación exitosa. Las etapas activas y sugeridas tienen identidades separadas. | Una carga publicada recomienda Validar. Guardar una configuración con destinos recomienda Recalcular. Una aplicación publicada recomienda Descargar y apunta a su `newVersionId`. Visitar el destino consume la indicación, una nueva base invalida la antigua y otra operación confirmada puede sustituirla. El replay de la misma operación no crea un segundo anuncio en el mismo recorrido. |
| Selección de propuestas | En `PreviewStore`, ids globales seleccionados de una simulación. La respuesta de cierre aporta ids requeridos, hash de cierre y estado. `ApplyStore` guarda aceptación e intento incierto. | En una simulación pendiente de aplicación, `0 → 1 → 2 → 0` da panel oculto → visible → visible → oculto. Una propuesta seleccionada fuera de la página sigue contando. La comparación de una aplicación publicada se presenta sin panel de confirmación. |

Un solo contexto se presenta una vez en la cabecera, con la entidad, fecha y módulo correspondientes. Las opciones de varios contextos deben distinguirse por sus etiquetas humanas, incluso si comparten entidad y fecha. El selector usa el id para decidir cuál está activo. La guía del siguiente paso se calcula con la versión publicada, no con la lista de contextos ni con el contenido visible de una página.

La visibilidad del panel depende de la selección global en la simulación, incluso mientras se calcula el cierre. La habilitación de Aplicar se sigue evaluando por separado. Exige simulación/base vigentes, filas disponibles, cierre completo y aceptación explícita del mismo conjunto. Cambiar selección o base invalida la aceptación anterior. El estado de un envío incierto pertenece al store del workspace, se conserva para el reintento de la solicitud original y se comunica aunque el panel de confirmación no esté montado. [Store de aplicación actual](../../apps/web/src/app/recalculation/apply.store.ts)

Las ayudas técnicas empiezan cerradas. Su control, la posición de retorno del foco y el texto seleccionable son estado de presentación. La portada y el favicon se distribuyen con datos de producto estáticos y locales. Los identificadores, importes y nombres de archivo del workspace se reservan a sus vistas y contratos de sesión. La prueba FINREP y sus datos sintéticos son evidencia separada de esta configuración. [Resultado FINREP](resultado-finrep.json)
