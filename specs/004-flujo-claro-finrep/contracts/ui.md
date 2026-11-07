# Contrato de interfaz y revisión de conflictos — 004

Estado: diseño definido para implementación; no describe cambios ya desplegados. [Especificación](../spec.md) · [Investigación](../research.md).

Este contrato cubre US1–US3 y FR-001–009/022. El comportamiento de selección y aplicación de propuestas se define en [proposal-selection.md](proposal-selection.md).

## 1. Dependencias y fronteras

Conservar Angular, Material y CDK 22.2.4, RxJS 7.8.2 y el tema M3 actual. Reutilizar `WorkspaceViewStore`, `StageFocus`, los stores de etapa, el control de versión y la revisión de destinos del servidor.

La presentación no decide elegibilidad, productores, dependencias ni valores. La elección de un productor modifica el borrador de configuración; guardar publica configuración y aplicar publica datos, en operaciones separadas.

Rutas de trabajo:

- `apps/web/src/styles.scss` y `workspace/workspace-shell.component.{ts,html,scss}`.
- `workspace/workspace-view.store.ts`, `core/stage-title.directive.ts`.
- Componentes de `import/`, `validation/`, `recalculation/` y `shared/calculation-detail.component.*`.
- `packages/contracts/src/direction-review.ts`.
- `packages/engine/src/recalculation/direction-review{,-index}.ts`.
- `apps/api/src/recalculation/direction-review-service.ts`, `routes/direction-reviews.ts`, `presentation/rule-presentation.ts`.

## 2. Recomendación de etapa

### Estado y activación

La publicación existente identifica `workspaceId`, `operationId`, `baseVersionId`, `newVersionId`, etapa y, para descargar, recibo. Se añade estado de presentación de la animación ligado a esa identidad, separado de la recomendación persistente.

- Carga publicada → Validar.
- Configuración publicada con destinos utilizables → Recalcular.
- Aplicación publicada y recibo confirmado → Descargar.
- Un resultado de solo validación permite descargar sus resultados sin exigir recálculo.
- El identificador consumido no se vuelve a anunciar ni animar por reconsulta, respuestas repetidas o montaje de una vista.
- El cambio de conjunto/versión invalida los hitos anteriores; visitar la etapa consume su recomendación. Se conserva la entrada de descarga de la versión aplicada.

### Presentación

Eliminar el elemento y selector CSS `next-stage-badge`. La etapa actual mantiene `aria-current="step"`; la recomendada añade borde y fondo verde claro y un indicador direccional decorativo. No se añade texto visible «Siguiente paso».

La animación consiste en tres pulsos de 1,5 segundos, total 4,5 segundos, sobre un halo o borde decorativo. Texto y fondo legible no desaparecen, no se desplaza el botón ni se cambia su tamaño. El realce estático permanece después.

`prefers-reduced-motion: reduce` desactiva animación y transiciones no esenciales. En colores forzados se mantiene un borde distinguible mediante colores del sistema. La señal no requiere movimiento para interpretarse.

Conservar los botones de navegación en el DOM con clave de etapa estable. Si se reinicia una animación por una operación nueva, se recrea solo el adorno, no el control que puede tener foco. El store registra el inicio/consumo: desmontar y montar el adorno no autoriza otros tres pulsos.

El anuncio `aria-live="polite"` indica «Etapa recomendada: Validar/Recalcular/Descargar» una vez por publicación. No se mueve el foco hasta que el usuario activa la navegación; entonces sigue actuando `StageFocus`. La recomendación por sí misma no hace scroll.

## 3. Acción principal y color

Aplicar un estilo semántico compartido `ce-primary-action` a la acción principal definida en la tabla de estados de la especificación. Se utiliza sobre `mat-flat-button`, con `mat.button-overrides` público; no depender de selectores privados MDC ni modificar el tema global.

Tokens de Material 22.2.4 contrastados localmente:

- `button-filled-container-color`: `#146c43`.
- `button-filled-label-text-color`: `#ffffff`.
- Interacción: fondo `#105835`, texto blanco.
- Foco visible: contorno `#175caa`, separado del botón.
- Estado deshabilitado: fondo `#e3e8e5`, texto `#405447`, sin apariencia habilitada ni activación; conservar una explicación de los requisitos pendientes.

Contrastes calculados de diseño: blanco/verde base 6,45:1; blanco/verde de interacción 8,50:1; texto verde/fondo de navegación `#e9f5ee` 5,76:1; foco azul/blanco 6,67:1. Son cálculos de pares de color, no evidencia del resultado renderizado: verificar también capas de interacción de Material, foco y modo deshabilitado.

Como máximo una acción verde habilitada por estado. Al pasar a inspección lista, Confirmar carga adquiere prioridad; al abrir revisión de destinos, la adquiere Guardar configuración; al disponer de simulación utilizable, Aplicar cambios ocupa ese lugar, sujeto a selección y aceptación. Repetir validación/simulación, consultar, filtrar, descargar ejemplos o cancelar tienen estilo secundario. Cerrar y descartar es una acción destructiva diferenciada y nunca usa el verde.

No aplicar el estilo primario a «Confirmar elección» de un grupo: es una decisión preparatoria. La acción principal de la etapa continúa siendo Guardar configuración.

## 4. Información visible

Retirar contenido del DOM de usuario, no simplemente ocultarlo mediante CSS. Los campos de trazabilidad necesarios siguen en los contratos/registros; no se borran datos de cálculo para simplificar las pantallas.

| Ubicación | Retirada | Presentación útil que permanece |
| --- | --- | --- |
| Cargar | Botón/panel Información técnica, IDs, huella, perfil interno, caducidad en bruto, cuotas y aritmética internas | Archivos, cobertura y exclusiones, contexto, restricciones breves para preparar archivos; error concreto y acción de recuperación |
| Cabecera de conjunto | Bloque de identificador interno de versión/sesión | Versión numerada, entidad, periodo y módulo; aviso breve de temporalidad al crear y al cerrar |
| Validar | IDs de ejecución/versión y recuentos de variantes/instancias del bloque técnico | Totales comprensibles, resultados y motivos de reglas sin destino |
| Recalcular | IDs/política interna y número de aristas/direcciones del grafo | Propuestas disponibles/bloqueadas, versión base legible y dependencias que afectan a las seleccionadas |
| Detalle de cálculo | Detalle técnico y volcado de objetos | Expresión original, valores exactos, unidad, origen con archivo/hoja/celda y explicación de redondeo/intervalo relevante |
| Comparación | Recibo y UUID de versiones en `comparison.component.html` | Antes → después y versiones numeradas |
| Confirmación de aplicación | `receiptId`/`proposalId` de «Origen del valor anterior» | «Recalculado en una aplicación anterior», versión y regla legibles cuando estén disponibles |
| Descargar | UUID de versión/ejecución en «Detalle del paquete y trazabilidad» | Versión seleccionada/aplicada, contenido de la descarga, nombre del archivo y alcance de hojas |

Los identificadores internos no se usan como alternativa visible cuando falla una resolución de etiquetas. Mostrar «Versión no disponible» o una descripción legible del contexto y permitir actualizar; no exponer UUID para llenar el hueco. Los códigos regulatorios, reglas y nombres aportados por el usuario son información de negocio.

Mantener decimal exacto y cifras pequeñas mediante `ce-exact-value`; no convertir cantidades a coma flotante para resumirlas. Un intervalo o redondeo que explique un resultado se presenta como «Cómo se obtiene este importe», sin IDs ni estructuras serializadas.


En las propuestas, «Cómo se obtiene este importe» consume ProposalExplanationDTO y sus secciones paginadas definidas en [el contrato de selección](proposal-selection.md). Mostrar «Datos utilizados» a partir de las lecturas registradas de la simulación, con origen legible; si existe fromProposalId, resolver código/celda del antecedente sin mostrar su ID. La igualdad FIN_TOTAL_ASSETS_DEMO debe explicar 100 + 20 = 120. No cargar el ProposalDTO legado completo ni sustituir esas lecturas por los importes anteriores de la versión base. Si un histórico no tiene esa evidencia, mostrar que no está disponible, sin reconstruirla silenciosamente. El detalle de resultados de validación conserva su propio contrato; el nuevo detalle paginado corresponde a propuestas.

### Progreso y terminales

El bloque global de un trabajo exitoso solo se retira cuando la etapa ha presentado un resultado de esa misma operación y versión. Registrar en el estado de vista una confirmación de presentación vinculada a `jobId/workspaceId/versionId`; que una petición haya finalizado no demuestra que su resultado sea visible.

No retirar un error, cancelación o resultado incompleto por esta regla. La respuesta de un trabajo antiguo no oculta el progreso de otro nuevo. Un único mensaje confirma la publicación cuando el resultado ya la explica.

## 5. Modelo estable de grupos

El índice actual `members` representa productores activos. Resolver un grupo lo reduce a uno o cero y `publicRow` deja de emitir `groupId`; por eso el grupo desaparece actualmente y `resolveGroup` no admite una segunda edición.

Separar en la proyección:

- **Opciones elegibles por grupo**: pertenencia estable a una celda/contexto por `instanceId` y lado, derivada de `ReviewRow.options`. Conservar índices compactos, no DTO de presentación repetidos.
- **Productores activos**: pertenencia mutable según decisiones; mantiene sus contadores e índice actual.
- **Grupos observados**: conjuntos que en algún momento de esta revisión tuvieron más de un productor activo. Se marcan al preparar o editar y siguen consultables tras resolver, omitir o cambiar otra dirección.
- **Omisión explícita del grupo**: decisión necesaria para distinguir cero productores por omisión de un grupo pendiente de decisión. `omitAll` marca omitidos los grupos observados.

No se convierten todas las opciones potenciales en conflictos: la lista expone grupos observados, no cada celda para la que existen varias opciones hipotéticas.

Estados del resumen:

| Estado | Condición |
| --- | --- |
| `conflicted` | Más de un productor activo en el destino |
| `resolved` | Exactamente un productor activo; se identifica su candidato |
| `omitted` | Cero productores activos y omisión explícita vigente |
| `pending` | Cero productores activos sin omisión explícita vigente |

La pertenencia contiene el contexto completo de la celda; compartir códigos de fila/columna en periodos o entidades diferentes no mezcla grupos.

Un candidato activo en otro destino aparece como `assignedElsewhere`. Elegirlo no lo traslada silenciosamente. Para usarlo aquí, el usuario cambia antes su decisión de destino en la tabla correspondiente. Elegir un ganador válido omite solo otros productores activos de esta celda; las decisiones activas de otras celdas se conservan.

Si los dos lados elegibles apuntan exactamente a la misma celda/contexto, no se duplica la regla en la lista: conservar el lado ya elegido para ese destino y, en su ausencia, usar izquierda como representación canónica de ese único destino. Esto no resuelve ciclos ni autoriza aplicar una autorreferencia.

## 6. Contratos HTTP de lectura

Prefijo: `/api/v1/workspaces/{workspaceId}/direction-reviews/{reviewId}`. Todas las lecturas requieren la sesión propietaria; no hacen mutaciones ni prolongan el TTL de 15 minutos. Solo admiten revisión utilizable `ready` de la versión vigente.

### GET /groups

Query cerrada: `limit` entero textual 1–200, predeterminado 50; `cursor` opcional hasta 8192 caracteres.

Respuesta:

- `reviewId`, `revision`.
- `items: DirectionConflictGroupDTO[]`, `total`, `nextCursor`.
- Cada grupo incluye `groupId`, `targetLabel`, `contextLabel`, `conceptLabel?`, `candidateCount`, `activeCount`, `state` y `selectedCandidate?`.
- `selectedCandidate`: `instanceId`, `code`, `targetSide`; presente solo en `resolved`.

Orden estable por identidad canónica del destino/contexto, independiente del estado resuelto. El cursor firmado incluye recurso, conjunto, revisión, revisión numérica y filtros de la consulta; se invalida ante edición. Los límites de IDs, etiquetas y contadores siguen las restricciones existentes de contratos; `groupId` e `instanceId` son digest internos que no se muestran al usuario.

### GET /groups/{groupId}/candidates

Mismos límites/cursor. Devuelve `reviewId`, `revision`, `group`, `items`, `total`, `nextCursor`.

Cada candidato:

- `instanceId`, `rowId`, `code`, `targetSide`.
- `descriptionPreview?` y `expressionPreview`, máximo 512 caracteres cada uno.
- `descriptionTruncated`, `expressionTruncated`.
- `availability: selectable | assignedElsewhere`.
- `assignedTargetLabel?`, presente cuando está activo en otro destino.
- `selected`, derivado de la decisión actual.

Orden estable por código e identidad de instancia, no por la elección actual. El total representa todos los candidatos elegibles del grupo observado; no solo los productores que siguen activos. La precondición y expresión son texto del catálogo, nunca HTML ejecutable.

### GET /groups/{groupId}/candidates/{instanceId}

Lectura individual sin query. Devuelve `reviewId`, `revision`, el candidato y `expression`, `precondition?`, `descriptions` con origen legible de catálogo. Los textos completos conservan el límite de celda de 32767 caracteres; no se adjuntan valores de una simulación ni conjuntos de lecturas.

Resolver la presentación bajo demanda desde la versión y el catálogo que originaron la revisión, usando el orden de fuentes determinista de `rulePresentation`. No añadir descripciones/expresiones completas a un millón de filas de la proyección. Deduplicar descripciones iguales y acotar las alternativas por las filas de catálogo admitidas.

Grupo o candidato desconocido/ajeno a la revisión: 404 `RESOURCE_NOT_FOUND`. No buscar por una subcadena de código para recuperar su expresión, ya que varios resultados pueden compartirlo.

## 7. Contrato de edición del grupo

Se conserva PATCH sobre la revisión y el formato existente:

`expectedRevision`, `mutationId` y `operations:[{op:"resolveGroup",groupId,winnerInstanceId}]`, con `If-Match` de la versión del conjunto. `winnerInstanceId:null` significa omitir.

Extender el alcance de `resolveGroup` a grupos observados resueltos, omitidos o pendientes. Verificar candidato sobre pertenencia elegible estable, no sobre la lista activa ya reducida.

1. Comprobar propiedad, revisión utilizable y versión.
2. Recuperar el recibo de `mutationId` si existe con el mismo contenido; una repetición no vuelve a editar ni reordena la UI.
3. Comprobar revisión esperada, estado inactivo del conjunto, elegibilidad y asignación del candidato.
4. Editar de forma atómica los bloques afectados de decisión y membresía, recalcular contadores y conservar el catálogo de candidatos.
5. Incrementar revisión y devolver el resumen existente y `appliedRevision`.

Una omisión vacía que ya estaba omitida o repetir un ganador con un nuevo `mutationId` puede publicar una nueva revisión, pero nunca modificar datos del informe. La misma mutación repetida conserva `appliedRevision`.

| Situación | Respuesta |
| --- | --- |
| Query, body o identificador mal formado | 400 `INVALID_REQUEST` |
| Cursor firmado de otra revisión/grupo | 400 `INVALID_CURSOR` |
| Sin sesión válida | 403 `INVALID_SESSION` |
| Revisión/grupo/candidato desconocido | 404 `RESOURCE_NOT_FOUND` |
| Revisión esperada desactualizada | 409 `STALE_DIRECTION_REVIEW` |
| Candidato actualmente activo en otra celda | Nuevo 409 `GROUP_CANDIDATE_ASSIGNED_ELSEWHERE`, con mensaje «Esta regla ya tiene otro destino elegido. Revisa su destino antes de seleccionarla aquí.» |
| Revisión no editable/trabajo en curso | 409 `DIRECTION_REVIEW_NOT_APPLICABLE` / `WORKSPACE_BUSY` |
| Reutilizar mutación con otro contenido | 409 `IDEMPOTENCY_CONFLICT` |
| Revisión caducada | 410 `DIRECTION_REVIEW_EXPIRED` |
| Versión distinta | 412 `STALE_VERSION` |
| Falta If-Match | 428 `PRECONDITION_REQUIRED` |
| Lado inelegible o decisión incompatible | 422 `INVALID_DIRECTION`, motivo interno y mensaje accionable |

Las nuevas colecciones requieren esquemas JSON cerrados y serialization allowlist. Las rutas `/rows`, preparación, guardado y descarte siguen disponibles; sus consumidores anteriores conservan el contrato. La UI nueva obtiene conflictos mediante `/groups`, no reconstruyéndolos a partir de una página de filas.

### Cuotas

La preparación del índice estable usa el worker y presupuesto actuales. Las lecturas hidratan solo la página solicitada; la consulta individual no reconstruye el conjunto de resultados. Ediciones preservan copy-on-write por bloques e idempotencia. El índice adicional y el pico anterior/candidato cuentan para la cuota de sesión antes de publicar; superar el presupuesto deja intacta la revisión anterior.

## 8. Interacción local, paginación y foco

Usar `MatRadioModule`, un `mat-radio-group` con nombre accesible por grupo y radios de disposición vertical. El texto de cada opción contiene código y descripción breve; el botón «Ver regla» es hermano del radio, nunca un control interactivo dentro de su etiqueta. La opción de omisión dice «No recalcular esta celda».

Las flechas del teclado cambian únicamente la elección local. «Confirmar elección», botón secundario, envía una sola mutación. «Cancelar» restaura el valor confirmado. Guardar configuración queda deshabilitado mientras haya un borrador local, con «Confirma o cancela la elección pendiente».

Abrir como máximo un editor de grupo a la vez. Conservar su elección local al paginar candidatos; el valor controlado de Material permite conservar un seleccionado no presente en esa página. Indicar «La regla elegida está en otra página» cuando corresponda. La omisión permanece disponible en todas las páginas.

No cerrar un editor con cambios por cambiar de filtro, grupo o etapa sin ofrecer confirmar o cancelar ese borrador. Un cambio real de versión/caducidad invalida el borrador y lo explica; no se reenvía automáticamente.

Tras confirmar, consultar el grupo en la revisión publicada y mostrar el resumen «Regla elegida: …» / «Omitida», con «Cambiar elección». Mantener la tarjeta montada con clave `groupId`; trasladar el foco al resumen o su botón solo como continuación de esa confirmación, no por una actualización remota. Los demás grupos no se reordenan por haber sido resueltos.

Al cambiar de página explícitamente, el encabezado de la lista anuncia página y total. Tras un cambio de revisión se descartan cursores anteriores; el grupo editado permanece anclado por su ID mientras se refrescan las páginas. La respuesta tardía de una revisión anterior no reemplaza ni foco ni elección.

Durante PATCH pendiente, respuesta incierta o recuperación, impedir nuevas decisiones y el guardado de configuración. Un reintento conserva `mutationId`, contenido y revisión esperada. Ante 409/410/412, recuperar el estado confirmado y explicar por qué el borrador no puede enviarse tal cual.

## 9. Verificación requerida

- Navegación: hito confirmado, duplicado, fallo, cancelación, versión ajena, visita de etapa, remontaje y dos operaciones consecutivas con la misma etapa recomendada; tres ciclos/4,5 s, estático después, cero animaciones con movimiento reducido.
- Tema: conteo de acciones verdes por estado, foco con teclado, contraste de colores renderizados incluidos hover/pressed/disabled y capturas 320/390/1440. No considerar el cálculo de contraste de diseño una prueba de navegador.
- Información: inspeccionar las cuatro etapas, detalle, comparación y descarga buscando los identificadores internos conocidos de la sesión sintética; conservar explicaciones de redondeo, dependencias, exclusión, caducidad, cierre y error.
- Progreso: éxito antes/después de presentar resultado, error que persiste, operación nueva mientras llega resultado antiguo.
- Grupos: 2, 3 y 51 candidatos; cambiar ganador, omitir, volver a elegir; candidato 51; grupo resuelto consultable; grupos en contextos distintos; participante con ambos lados; participante asignado a otro destino rechazado sin tocar ese destino.
- Interacción: flecha de radio no produce PATCH; confirmar produce uno; cancelar produce cero; cambiar de página conserva borrador; guardado global bloqueado con borrador; labels sin descripción y expresiones largas; foco tras confirmar/recuperar.
- Contratos: ownership, esquema cerrado, límites de página, cursor mezclado, revisión obsoleta, expiración, idempotencia y rechazo atómico por cuotas.
- Regresión: las decisiones finales compiladas y los cinco cambios COREP siguen siendo los previstos; ningún control de conflicto modifica hechos antes de aplicar.
- Aceptación humana SC-010: registrar acciones, ayudas e incidencias reales cuando exista la interfaz. No inferirla de capturas ni de una aprobación global.

## Fuentes primarias de componentes y accesibilidad

- [Material radio: grupos, etiquetas y controles anidados](https://github.com/angular/components/blob/main/src/material/radio/radio.md).
- [Overrides de botones](https://github.com/angular/components/blob/main/src/material/button/_button-theme.scss), contrastados con `node_modules/@angular/material/button/_m3-button.scss` 22.2.4.
- [Contraste mínimo](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [animación por interacción](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html) y [pausar/detener/ocultar](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).
