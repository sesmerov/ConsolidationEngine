# Contrato de selección de propuestas — 004

Diseño para FR-010–015 y la aplicación del recorrido FINREP. [Especificación](../spec.md) · [Decisiones D5–D6](../research.md).

Este contrato amplía la API local sin sustituir la selección por arrays existente. El servidor mantiene la selección completa y su revisión; el navegador consulta resúmenes y páginas. Una selección predefinida nunca equivale a aceptar la aplicación.

## Identidad, seguridad y publicación inicial

Prefijo `/api/v1/workspaces/{w}/previews/{p}`. Se mantienen `X-CE-Session`, comprobaciones de origen/host, esquemas cerrados, cuotas y cuerpo JSON máximo de 1 MiB. El servidor comprueba que preview, selección y propuestas pertenecen al workspace antes de devolver datos.

Cada preview nuevo tiene un único `SelectionRecord`, con id UUID propio, `workspaceId`, `previewId` y `baseVersionId`. El worker de simulación prepara también su selección inicial: todas las propuestas `available` de ese preview con destino/productor resueltos, sin añadir las bloqueadas. Verifica el cierre transitivo y obtiene contadores y huella. Se publica junto con el preview en una única operación, con `revision=1` e `initializationJobId` igual al trabajo de simulación. Si la preparación o la cuota falla, no se publica un preview con selección incompleta.

GET, recuperación de conexión, recarga de página y consulta de históricos nunca inicializan ni restauran esta selección. La UI cambia a la nueva simulación únicamente al confirmar el job que inició en ese workspace; consultar un job antiguo no dispara esa transición. La selección persistida puede recuperarse sin volver a aceptar su aplicación. Una simulación antigua sin record admite preparación explícita vacía por la ruta POST indicada abajo.

La publicación inicial pertenece al mismo resultado de trabajo `preview`: no requiere un segundo job ni modifica valores del informe. El replay del job ya completado devuelve el resultado existente y no repite la preselección.

## Representación y resumen público

El orden ordinal de filas procede del orden estable del `PreviewBundle`, manteniendo la ordenación de dependencias. Un ordinal solo tiene significado dentro de ese preview; nunca se acepta como identidad pública de una propuesta enviada por el cliente.

Internamente, `SelectionRecord` referencia ese bundle y conserva máscaras de disponibles, seleccionadas y requeridas como bloques base64 inmutables de 4 KiB, longitud declarada y comprobada. Los bits fuera de la cardinalidad son cero. Los buffers/Maps usados para trabajar son temporales del worker; los records siguen siendo JSON plano compatible con el contador de estado. Se comparten bloques sin cambios. No se duplica el array de `ProposalDTO` ni se guarda un segundo conjunto global de objetos UUID.

Resumen `ProposalSelectionSummaryDTO`:

| Campo | Contrato |
| --- | --- |
| `id, workspaceId, previewId, baseVersionId` | UUID y pertenencia verificada. |
| `revision` | Entero; 0 mientras no exista ninguna revisión publicada (`preparing` o `failed` sin proyección); 1 al publicar la primera selección y aumenta por cada edición publicada. Los estados que conservan una proyección tienen revisión positiva. |
| `state` | `preparing \| ready \| updating \| applying \| applied \| obsolete \| discarded \| failed`. |
| `availableCount` | Número global de propuestas actualmente disponibles para seleccionar. Cero en estados terminales del preview. |
| `selectedCount` | Cardinalidad de la selección publicada; en estado `applied` describe lo aceptado en esa revisión. |
| `requiredCount` | Antecedentes transitivos necesarios que no están seleccionados. |
| `complete` | `requiredCount === 0`, con comprobación terminada. No equivale por sí solo a permiso de aplicar. |
| `closureHash` | Huella de 64 caracteres hexadecimales del cierre, compatible con `selectionClosureHash` del motor. |
| `initializationJobId` | Job que publicó la selección inicial, incluida la preparación vacía compatible. |
| `pendingJobId` | Solo mientras una preparación, edición o aplicación está en curso. |

Los cinco campos de proyección `availableCount, selectedCount, requiredCount, complete, closureHash` están presentes cuando existe una revisión publicada. Se omiten en `preparing` o `failed` si nunca se llegó a publicar una. La UI muestra «Preparando selección», no ceros fabricados. En `updating` se conserva la proyección anterior como información de lectura hasta publicar el reemplazo.

La huella identifica contenido y dependencias; la revisión distingue dos decisiones sucesivas aunque terminen con el mismo contenido. La aceptación visual se liga a `id + revision + closureHash + baseVersionId` y se invalida al iniciar cualquier edición.

## Operaciones de selección

| Método y ruta relativa | Entrada | Resultado |
| --- | --- | --- |
| GET `/selection-state` | Sin cuerpo | 200 resumen actual, sin efectos. 404 si ese preview antiguo aún no tiene selección. |
| POST `/selection-state` | `{baseVersionId, seed:"empty"}` | 202 JobDTO `select-proposals` para preparar una selección vacía de un preview antiguo vigente, sin record previo. |
| POST `/selection-state/edits` | `{selectionId, expectedRevision, operations}` | 202 JobDTO `select-proposals`; publicación atómica de la revisión siguiente. |
| GET `/selection-state/rows` | Consultas y paginación descritas abajo | 200 página de propuestas, selección y recuentos de esa revisión. |
| GET `/selection-state/proposals/{proposalId}/dependencies` | `scope=all|missing`, `limit`, `cursor` | 200 página de antecedentes **directos** de esa propuesta, con la selección de la revisión actual. |
| GET `/selection-state/proposals/{proposalId}/explanation` | Sin cuerpo ni filtros | 200 explicación escalar y recuentos de secciones de la propuesta. |
| GET `/selection-state/proposals/{proposalId}/explanation/items` | `section=operands|origins|diagnostics|descriptions`, `limit`, `cursor` | 200 página acotada de la sección pedida; nunca un listado completo anidado. |

Los POST requieren `If-Match` del workspace e `Idempotency-Key` UUID. El recurso resultante del trabajo tiene `resultRef:{type:"proposal-selection",id:selectionId}`; consulta y cancelación usan las rutas de jobs existentes. El cuerpo no incluye AST, expresiones ejecutables, claves de hechos, máscaras ni valores calculados del cliente.

Una preparación vacía puede reintentarse con clave nueva cuando el intento previo terminó con fallo y no publicó una revisión. Preparar con una nueva clave cuando ya existe una selección publicada devuelve `PROPOSAL_SELECTION_NOT_APPLICABLE`; la UI recupera el recurso existente. Una lectura nunca realiza ese POST automáticamente al descubrir un histórico.

### Ediciones admitidas

`operations` contiene de 1 a 200 operaciones `set`, o una única operación global:

| Operación | Efecto |
| --- | --- |
| `{op:"set", proposalId, selected:true\|false}` | Seleccionar o desmarcar una propuesta disponible de ese preview. Cada id solo aparece una vez en el lote. |
| `{op:"selectMatching", filter:{status?,code?,table?,contextId?}}` | Añadir todas las propuestas disponibles que coincidan con el filtro completo, en todas sus páginas, conservando las seleccionadas fuera de él. |
| `{op:"clear"}` | Vaciar la selección global, sin depender de filtros o página. |

Una regla preseleccionada que el usuario desmarca no reaparece por consultar, filtrar o paginar. Sí puede volver a seleccionarse mediante una acción explícita posterior de selección individual o masiva cuyo alcance la incluya. Esta diferencia se comunica con la etiqueta «Seleccionar todas las disponibles de este filtro».

La edición no añade antecedentes implícitamente. Calcula el cierre para informar cuáles faltan. Una selección masiva o inicial puede incluirlos porque esos mismos antecedentes coinciden con su alcance, nunca como corrección silenciosa de una deselección.

El trabajo recibe la referencia a la revisión esperada y una entrada compacta. Solo acepta estado `ready`, preview vigente y ausencia de otro trabajo activo. Publica máscaras, contadores, huella, revisión y estado conjuntamente. Incluso una edición válida que deja el mismo conjunto publica una nueva revisión: la aceptación anterior no se recupera. Un replay idéntico devuelve su job original y no incrementa otra vez la revisión.

Durante `updating`, las páginas de la revisión anterior siguen disponibles como lectura. Casillas, acciones masivas y aplicar están deshabilitados y se indica que la selección se está comprobando. Cancelar, fallar o exceder el plazo conserva íntegra la selección publicada anterior; vuelve a `ready` solo si preview y base siguen siendo aplicables.

## Filtrado, páginas y revisión de cambios

La ruta de filas admite:

- `scope=all|selected|missing`, por defecto `all`. `missing` son los antecedentes pendientes; `selected` sirve para revisar todo el conjunto antes de aplicar.
- `status` entre los estados de propuesta existentes, `code` de hasta 128 caracteres con búsqueda parcial sin distinguir mayúsculas, `table` de hasta 128 caracteres con coincidencia exacta y `contextId` con el patrón existente `[A-Za-z0-9_-]{1,64}`.
- `limit` de 1 a 200, por defecto 50, y `cursor` firmado de hasta 8192 caracteres. Un contexto bien formado pero inexistente en la base devuelve `INVALID_REQUEST`.

El contexto limita únicamente la consulta y el alcance de `selectMatching`; no cambia la selección global ni el contexto de otras propuestas. Añadir `contextId` a GET `/proposals` y a su cliente, manteniendo la semántica anterior cuando se omite. Ambas rutas y la edición masiva utilizan el mismo predicado normalizado para evitar diferencias entre lo que se muestra y lo que se selecciona.

La respuesta `ProposalSelectionPageDTO` contiene:

- `selectionId, previewId, revision, state, scope, items, total, nextCursor`.
- `summary`: el resumen compacto de esa misma revisión.
- `filterCounts:{matched,available,selected,selectedOutsideFilter,selectedOutsidePage}`.
- `sourceFiles`: referencias de origen necesarias para las filas, limitadas a los archivos citados en esa página; no se hidrata la procedencia completa de cada propuesta.

Cada item es un `ProposalSelectionRowDTO` compacto. **No** contiene un `ProposalDTO` anidado. Sus campos son:

| Campo | Contenido |
| --- | --- |
| `id, code, state` | Identidad pública, código y estado de la propuesta. |
| `target` | `contextId, tableCode, sheetCode, rowCode, columnCode` y etiquetas legibles de contexto y concepto cuando existan; sin claves canónicas serializadas. |
| `description, descriptionTruncated` | Resumen descriptivo de hasta 500 caracteres y marca explícita de truncamiento. No altera la expresión original conservada. |
| `before` | Presencia y, cuando existe, valor normalizado exacto, unidad y precisión; es un escalar de presentación, no un `FactReadDTO`. Se omite si no se pudo identificar destino. |
| `after` | Valor propuesto exacto, unidad y precisión cuando existe; se omite para propuestas sin resultado. |
| `origin` | Localizador único del destino (`fileId, sheet, cell`) cuando exista; no es la lista de lecturas o procedencia completa. |
| `selected, required` | Pertenencia a las máscaras de selección y antecedentes globalmente pendientes de esa revisión. |
| `predecessorCount` | Número de antecedentes **directos** distintos de la propuesta. |
| `requiredPredecessorCount` | Número de sus antecedentes directos que están en la máscara **global** de pendientes de la selección actual. |
| `rounded, hasInterval, diagnosticCount` | Indicadores escalares para orientar la consulta de explicación o motivos. |

Los valores exactos reutilizan los contratos escalares existentes; no se redondean ni truncan para reducir la respuesta. Etiquetas/resúmenes de presentación se acotan y señalan truncamiento cuando proceda. Esta fila omite `predecessorIds`, `variantIds`, `readKeys`, `metadataReads`, listas de procedencia y arrays completos de diagnósticos. Paginar filas no justificaría devolver un millón de antecedentes dentro de una sola fila.

`total` corresponde a `scope` y filtros. `matched`, `available` y `selected` cuentan coincidencias del filtro independientemente del scope. `selectedOutsideFilter = summary.selectedCount - filterCounts.selected`. `selectedOutsidePage` resta del total seleccionado las seleccionadas de los items devueltos. Ambos recuentos exteriores pueden solaparse; no se suman.

Los cursores se vinculan a workspace, preview, selección, revisión, estado, scope, filtros y orden. Si cambia la revisión o el estado relevante, el cursor previo devuelve `INVALID_CURSOR` y se comienza desde la primera página. La respuesta tardía de otra revisión no sustituye páginas más recientes.

La UI obtiene el estado de la casilla global con `available` y `selected` del filtro sobre filas disponibles; para filtros de estados no disponibles la acción está deshabilitada. No deriva «todas» de la primera página. Una vista histórica es de lectura, conserva los resultados y no presenta casillas editables ni confirmación.

El panel de confirmación consume el total global y páginas `scope=selected`, con anterior → propuesto y localización legible. Las dependencias se consultan por páginas `scope=missing`. La disponibilidad de aplicar no exige descargar ni renderizar todos los DTO en el navegador: exige revisión completa y vigente, total mayor que cero, cero pendientes y aceptación explícita.

### Antecedentes directos y cierre transitivo

GET `/selection-state/proposals/{proposalId}/dependencies` devuelve `ProposalDependencyPageDTO` con `selectionId, previewId, revision, state, proposalId, scope, items, total, nextCursor, predecessorCount, requiredPredecessorCount`. Sus items son las mismas filas compactas; orden estable de la simulación, cardinalidad sin duplicados, `scope=all` por defecto y paginación de 50 con máximo 200.

- `scope=all` devuelve exclusivamente los antecedentes directos de la propuesta indicada.
- `scope=missing` devuelve la intersección de esos antecedentes directos con la máscara global de pendientes de la selección. Su `total` coincide con `requiredPredecessorCount`.
- Esta ruta no admite filtros de contexto, estado, código o tabla: una dependencia necesaria situada en otro contexto no debe desaparecer por el filtro de la vista de origen. Cada fila identifica su contexto real. La consulta valida pertenencia del padre y los antecedentes al mismo preview.
- Los cursores incluyen también `proposalId` y scope. El servidor usa el índice de adyacencia para obtener la página; no retorna el array de identidades completo para que el navegador lo pagine.

Ejemplo: C depende directamente de B y B depende directamente de A; solo C está seleccionado. El resumen global indica `requiredCount=2` y GET `/selection-state/rows?scope=missing` devuelve A y B, porque el cierre es **transitivo**. La fila de C tiene `predecessorCount=1` y `requiredPredecessorCount=1`; su ruta de dependencias devuelve solamente B. La fila de B permite consultar A. Si B y C están seleccionados, falta globalmente A; C tiene cero antecedentes directos pendientes, pero aplicar sigue bloqueado por `summary.requiredCount=1`. El resumen global es la autoridad del cierre, nunca la suma de contadores por fila.

El GET legado `/proposals/{proposalId}` conserva el detalle completo y su contrato de diagnóstico para clientes existentes. Sus arrays y coste pertenecen a ese contrato distinto; no están cubiertos por la garantía de paginación de estas rutas. El nuevo recorrido de consulta/selección/confirmación/aplicación no llama a ese detalle para hidratar filas ni obtiene `predecessorIds` completos. «Ver cálculo» usa las rutas escalares y paginadas siguientes.

### Explicación de cálculo y origen sin volcado técnico

GET `/selection-state/proposals/{proposalId}/explanation` devuelve `ProposalExplanationDTO`:

| Campo | Contrato |
| --- | --- |
| `selectionId, previewId, baseVersionId, revision, state, proposalId` | Identidades y revisión comprobadas; no se muestran como contenido de ayuda técnica. |
| `code, target, before?, after?, origin?` | Las mismas proyecciones escalares y legibles de la fila, con valores exactos y sin listas de lecturas. |
| `evidenceState` | `recorded` cuando existe evidencia de simulación conservada; `unavailable` para históricos o propuestas bloqueadas que no la tengan. |
| `expression?, precondition?` | Textos originales conservados, cada uno de hasta 32.767 caracteres. `expression` es obligatorio si `evidenceState=recorded`; si no hay evidencia ni un original vinculado inequívocamente, se omite. Se presentan como texto, no se ejecutan ni se reconstruyen a partir del valor calculado. |
| `sourceValue?, preconditionValue?` | Proyección escalar de los valores registrados por la simulación: tipo, nominal/valor, intervalo cuando corresponda, unidad y presencia; sin coordenadas/axes ni listas anidadas. |
| `exactNominal?, interval?` | Resultado exacto anterior al redondeo y extremos `lo/hi` registrados, cuando sean aplicables. Cada racional conserva numerador y denominador; no se convierte a coma flotante para mostrarlo. |
| `rounded, roundingLabel?, decimals?, unit?` | Indicadores y explicación breve del efecto de precisión; por ejemplo «Redondeo al par», sin identificadores internos de política. |
| `operandCount, originCount, diagnosticCount, descriptionCount` | Cardinalidades de las cuatro secciones paginadas, nunca sus listas. |

`ScalarExplanationValueDTO` es una unión cerrada de número (`nominal`, `interval`, `unit`), booleano/texto/fecha (`value`), nulo (`presence`, `dataType`, `unit?`) o desconocido. Reutiliza los escalares exactos del contrato de validación, eliminando los campos de coordenadas y procedencia que pudieran contener estructuras adicionales. Los textos originales y valores no se truncan silenciosamente. La expresión de una propuesta con evidencia procede de `calculation.expression` y la precondición de `calculation.precondition`. Una propuesta sin evidencia puede mostrar la expresión de catálogo vinculada inequívocamente, con `evidenceState=unavailable`; no inventa lecturas, valores de la fuente ni cálculo ejecutado.

Para propuestas nuevas disponibles, la publicación de simulación conserva la evidencia necesaria para estas consultas. En históricos sin ella, la UI indica «No hay detalle de cálculo conservado para esta propuesta», muestra lo disponible y no lo confunde con cero operandos leídos. Consultar una explicación nunca vuelve a calcular sobre los hechos actuales para rellenar datos faltantes.

GET `/explanation/items` devuelve `ProposalExplanationPageDTO` con `selectionId, previewId, baseVersionId, revision, state, proposalId, section, items, total, nextCursor`. `section` es obligatorio; `limit` admite 1–200, con 50 por defecto. Los items de cada sección tienen forma cerrada y campos de contexto/origen planos, sin arrays propios:

| Sección | Item público |
| --- | --- |
| `operands` | Una lectura registrada: `itemId`, campos de contexto/tabla/hoja/fila/columna, etiqueta del concepto cuando exista, `presence`, `value?` exacto, `unit`, `decimals`, `fileName`, `sheet`, `cell`, `originKind` y, si procede, `fromProposalId`, `fromProposalCode`. `originKind` distingue informe original, propuesta antecesora y aplicación anterior. |
| `origins` | Un origen distinto: `itemId`, `kind`, `fileName`, `sheet?`, `row?`, `column?`, `cell?`, `label`. No incluye un array de localizadores ni de IDs. |
| `diagnostics` | Un diagnóstico: `itemId`, `severity`, `code`, `message`, localización legible y `messageTruncated`. El mensaje de presentación se limita a 4.096 caracteres; si se acorta se indica expresamente. El código sirve al cliente para su mensaje, no para añadir un bloque técnico a la pantalla. |
| `descriptions` | Un registro de catálogo vinculado: `itemId`, `description`, `expression`, `precondition?`, `fileName`, `sheet?`, `row?`. Cada texto original está limitado a 32.767 caracteres. Un registro con varias procedencias produce items separados, sin listas anidadas. |

Los `itemId` son referencias opacas estables dentro de la sección y propuesta; no se imprimen como explicación. Los valores de `operands` proceden **exclusivamente de `ProposalCalculationDTO.reads` retenido en el momento de simular**. Una lectura con `fromProposalId` muestra el valor consumido de ese antecesor después de su recálculo y cuantización, no el valor original de la versión base. Se verifica la pertenencia de ese productor al mismo preview y se presenta su código/contexto legibles. En FINREP, la explicación de FIN_TOTAL_ASSETS_DEMO debe mostrar r0010=100 como operando y resultado 120; mostrar r0010=90 y recalcular 110 desde la base sería incorrecto.

La presencia, el cero, el dato ausente y los valores derivados mantienen su distinción registrada. Los orígenes se deduplican por localizador y tipo mediante procesamiento acotado; las descripciones se consultan en el catálogo de la base del preview, no en el catálogo vigente de otra versión. La sección de operandos conserva el orden registrado; las otras secciones usan orden estable por identidad/localizador. No se permite que una página mezcle evidencias de simulaciones diferentes.

Estas consultas no aceptan filtros de contexto: una lectura u origen perteneciente a otro contexto debe permanecer accesible y etiquetado. Verifican propiedad de workspace/preview/propuesta/selección y sirven una única revisión. Los cursores se firman con esas identidades, revisión, estado, sección y posición. Una edición que cambie la revisión invalida los cursores previos; la UI refresca el resumen de explicación y su primera página.

El resumen y cada página de explicación tienen además un máximo de 1 MiB de JSON serializado. Una página puede devolver menos items que `limit`, con un cursor que avance por los items realmente entregados. Un resumen o item exacto que por sí solo no quepa provoca `EXPANSION_LIMIT`, sin truncar sus valores ni generar un cursor que no avance. Los textos de presentación acotados no sustituyen los textos originales. Las consultas usan las reservas, índices y recorridos cooperativos cancelables del resto del recurso; no materializan todo el conjunto de operandos/orígenes en el hilo HTTP para luego recortarlo.

La UI presenta «Cómo se obtiene», «Datos utilizados» y «Archivos y celdas de origen», con efecto de redondeo/intervalo cuando sea relevante. No ofrece «Detalle técnico», un volcado JSON ni un listado de huellas o identificadores internos. El resumen inicial y sus secciones reemplazan el uso del DTO legado completo en este recorrido.

## Aplicación por referencia inmutable

POST `/api/v1/workspaces/{w}/applications` mantiene sesión, `If-Match`, clave de idempotencia y respuesta 202 JobDTO. El esquema es una unión cerrada y exclusiva:

| Forma | Cuerpo |
| --- | --- |
| Compatible | `{baseVersionId,previewId,selectedIds,closureHash}` |
| Compacta | `{baseVersionId,previewId,selectionRef:{id,revision},closureHash}` |

Se rechazan ambas formas mezcladas, referencias de otro workspace/preview, revisiones inexistentes y campos extra. En la forma compacta, el servidor exige selección `ready`, base vigente, revisión y huella coincidentes, `selectedCount>0` y cierre completo. La aplicación reserva la revisión inmutable junto con el job y pasa el recurso a `applying`. La referencia no se resuelve a un array global dentro de la aceptación HTTP.

El worker recibe la selección sellada y los datos necesarios del preview/base. Materializa los identificadores únicamente dentro del trabajo y presupuesto cuando el motor los requiera. Comprueba nuevamente disponibilidad, destino único, elegibilidad del perfil y cierre, y reutiliza el orden y cálculo del motor. El trabajo publica hechos, recibo, revalidación y estado de la selección en la misma operación atómica. Ningún cambio se atribuye a una selección editada después.

Los recorridos grandes de preparación y comprobación se realizan en worker o preparación asíncrona acotada; las últimas comprobaciones CAS antes de publicar verifican las identidades/revisiones reservadas. No reconstruyen un millón de DTO en el callback síncrono de aceptación HTTP.

### Respuesta incierta y liberación de la reserva

El navegador conserva `workspaceId, If-Match, Idempotency-Key` y el cuerpo exacto del intento hasta conocer el desenlace. Mientras la respuesta sea incierta, no permite cambiar selección ni producir un intento distinto desde esa vista.

La búsqueda de idempotencia se realiza después de autenticar y normalizar el cuerpo, pero **antes** de comprobar versión, estado o revisión. La misma clave/cuerpo recupera el mismo job aunque ya se haya publicado otra versión. Misma clave con cuerpo distinto devuelve `IDEMPOTENCY_CONFLICT`.

GET del resumen permite recuperar `pendingJobId` y continuar el sondeo después de recargar. El cliente solo habilita un nuevo intento cuando conoce el estado terminal del anterior. Un fallo o cancelación conserva los datos originales y devuelve la selección a `ready` si la base sigue vigente; de otro modo la deja `obsolete`. Un nuevo intento exige nueva clave y nueva aceptación del usuario. El resultado incierto no se interpreta como fallo ni libera una reserva que pudiera estar aplicándose.

## Recibos compactos y compatibilidad

Los recibos almacenados conservan las identidades aceptadas necesarias para auditar y aplicar las reglas existentes. La vía nueva no vuelve a enviarlas completas al navegador.

Añadir `includeAcceptedIds=false` a:

- GET `/api/v1/workspaces/{w}/applications/{receiptId}`.
- GET `/api/v1/workspaces/{w}/applications/{receiptId}/comparison`, junto a sus filtros actuales.

Con el parámetro omitido o `true`, se mantiene exactamente la proyección compatible que contiene `acceptedIds`. Con `false`, `receipt` es `CompactApplyReceiptDTO`, un objeto cerrado con:

| Campo | Contrato |
| --- | --- |
| `id, previewId, baseVersionId, newVersionId, beforeValidationRunId, validationRunId` | UUID, como el recibo existente. |
| `closureHash` | La huella de la selección aplicada. |
| `appliedAt` | Fecha/hora del recibo existente. |
| `acceptedCount` | Entero positivo igual a la cardinalidad aceptada. |
| `selectionRef` | `{id,revision}` de la selección sellada cuando la aplicación procede de esta forma; se omite en aplicaciones antiguas sin recurso. |

La forma compacta no lleva `acceptedIds`. Los otros campos de detalle/comparación permanecen iguales. La proyección de recibo forma parte del dominio del cursor para impedir mezclar modos al paginar. La UI nueva solicita siempre `false`, incluidas las aplicaciones históricas; identifica la versión publicada mediante el recibo y no por la vista filtrada.

Para aplicaciones por referencia, `scope=selected` del recurso aplicado conserva la selección sellada como lectura. Las aplicaciones antiguas continúan teniendo la comparación y los exports existentes. No se fabrica una nueva selección editable a partir de un recibo.

POST `/previews/{p}/selection` con `selectedIds`, la aplicación por arrays y los parámetros previos de propuestas siguen admitidos. La selección compatible es de consulta y no altera el record nuevo. Una aplicación por arrays invalida la selección editable del preview y la deja `obsolete`, no `applied`: el historial del recibo es la autoridad de qué IDs se aceptaron por esa vía. Solo la aplicación que reserva una `selectionRef` sella ese recurso como `applied`.

## Lifecycle, cuotas y errores

- Una sola operación activa por workspace, con la exclusión de trabajos ya existente. Las lecturas no cambian revisión.
- Publicar otra base deja obsoletas las selecciones editables anteriores. Descartar preview termina su selección; aplicar la vuelve de lectura. Cerrar workspace cancela trabajos y libera sus registros, índices y reservas.
- No hay temporizador que vuelva a seleccionar automáticamente. No se descartan silenciosamente elecciones mientras el preview siga editable. Si la cuota impide conservar el recurso, se rechaza la operación nueva sin alterar el estado previo.
- Respetar 1.000.000 posiciones/aristas, 10.000.000 lecturas, 60 s por job y worker con 256 MiB de generación antigua. Esos límites son cotas de seguridad, no garantía de que cualquier combinación de máximos quepa.
- Respetar 512 MiB de estado y 20 snapshots. La selección no crea una versión del informe. Proyección, máscara, índices, cache, reservas y estado candidato cuentan antes de la publicación, incluido el pico anterior+candidato.
- Cache de consultas acotada a ocho filtros por preview editable, sin crecimiento por navegación. Los índices de coincidencias se reutilizan entre páginas; los contadores de selección se invalidan por revisión. Una nueva consulta que requiera explorar muchas posiciones lo hace por bloques cooperativos, con cancelación y presupuesto, sin un bucle largo que monopolice el hilo HTTP.
- La UI retiene páginas, resumen y detalle abierto; no un conjunto global de IDs o todos los objetos seleccionados. Un fallo de consulta completa muestra recuperación y bloquea aplicar; nunca presenta un prefijo como selección completa.

| Error | Uso |
| --- | --- |
| 400 `INVALID_REQUEST` | Esquema mixto, filtro/contexto inválido, IDs duplicados en lote o propuesta ajena al preview indicada como edición. |
| 400 `INVALID_CURSOR` | Revisión, estado, filtro, scope o proyección de recibo distintos a los del cursor. |
| 404 `RESOURCE_NOT_FOUND` | Workspace/preview/selección no perteneciente a la sesión, recurso inexistente o preview antiguo sin record al consultar. |
| 409 `STALE_PROPOSAL_SELECTION` | Revisión esperada distinta de la publicada; recuperar resumen antes de decidir de nuevo. |
| 409 `PROPOSAL_SELECTION_NOT_APPLICABLE` | Preparación duplicada no idempotente, edición de estado terminal, selección sin preparar o propuesta no disponible. |
| 409 `SELECTION_NOT_CLOSED` | Aplicación con antecedentes pendientes o huella de cierre no coincidente. |
| 409 `WORKSPACE_BUSY` / `IDEMPOTENCY_CONFLICT` | Contratos existentes de exclusión e idempotencia. |
| 412 `STALE_VERSION` / 428 `PRECONDITION_REQUIRED` | Contratos existentes de base e If-Match. |
| 413 `EXPANSION_LIMIT` / `SESSION_LIMIT` | Presupuesto o capacidad insuficientes, sin publicación parcial. |

Una vez aceptado un job, su fallo, cancelación o timeout se consulta como JobDTO terminal con diagnóstico. No se transforma en un éxito vacío. Los mensajes visibles explican el problema y la acción posible sin exponer huellas ni identificadores internos.

## Verificación del contrato

1. Nueva simulación: selección inicial y preview se publican juntos; cinco propuestas COREP seleccionadas y aceptación desmarcada. Replay no recrea la selección.
2. Preview antiguo: GET no modifica nada; preparación explícita vacía y sin preselección.
3. 51 disponibles y varias bloqueadas, con antecedente en segunda página: selección inicial/masiva, scope de revisión y recuentos coinciden con toda la simulación.
4. Dos contextos con las mismas coordenadas visibles: filtro de contexto y selección global separados; ninguna mezcla de identidad.
5. Desmarcar antecedente y cambiar filtros/páginas/etapa/recargar: se conserva la decisión, falta el mismo antecedente y aplicar permanece bloqueado.
6. Selección parcial, filtro sin coincidencias y selección exterior: casilla global, limpieza y recuentos no dependen de la página.
7. Quitar/añadir rápidamente la misma propuesta: aceptación invalidada aun cuando el contenido final produzca la misma huella.
8. Dos pestañas, revisión antigua, respuestas fuera de orden y cursor de revisión anterior: no sobrescribir decisiones nuevas.
9. Pérdida de respuesta antes/después de publicación, replay durante `updating/applying`, fallo, timeout, cierre y cambio de base: misma operación recuperable y ningún prefijo publicado.
10. Aplicación por referencia y por arrays: mismas reglas de cierre/eligibilidad y cambios; petición mixta rechazada. Recibos compactos y compatibles presentan la misma versión y cardinalidad.
11. Selección controlada de 100.000 destinos disponibles distintos: peticiones compactas por debajo de 1 MiB y páginas limitadas, sin hidratar 100.000 DTO en navegador. La entrada limita los destinos únicos por sus 100.000 coordenadas; no se promete un millón de recálculos aplicables.
12. Proyección mínima de 1.000.000 posiciones y exceso de cuota/presupuesto: máscara/índice acotados y rechazo atómico. Medir tiempos y memoria durante implementación, incluida convivencia de estado anterior y candidato.
13. Una sola propuesta con más de 50 antecedentes directos: fila y página siguen acotadas, recuentos correctos y acceso al último antecedente mediante cursor sin ningún array global. Cadena A → B → C y dependencia entre contextos: distinguir pendientes directos de cierre transitivo, sin ocultar el antecedente por el filtro activo.
14. Explicación con más de 50 lecturas/orígenes y datos entre contextos: páginas acotadas, cursores por sección/revisión, cero listas anidadas y conservación de valores exactos. En la cadena FINREP, el segundo cálculo muestra el 100 consumido del primer recálculo y resultado 120; no el 90 original ni un 110 reconstruido desde la base. Históricos sin traza muestran `unavailable`, no evidencia inventada. Comprobar el límite de página de 1 MiB sin perder items ni truncar valores.

Puntos actuales a ampliar: [rutas de previews](../../../apps/api/src/routes/previews.ts), [selección existente](../../../apps/api/src/recalculation/preview-store.ts), [aplicación](../../../apps/api/src/recalculation/application-service.ts), [contratos de recálculo](../../../packages/contracts/src/recalculation.ts), [contratos de aplicación](../../../packages/contracts/src/application.ts), [PreviewStore](../../../apps/web/src/app/recalculation/preview.store.ts) y [ApplyStore](../../../apps/web/src/app/recalculation/apply.store.ts).
