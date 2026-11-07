# Modelo de datos y estados — 004

[Especificación](spec.md) · [Decisiones](research.md). Este documento define el estado propuesto; las interfaces de transporte normativas están en los contratos.

## 1. Navegación y acción principal

Se amplía el estado de presentación de `WorkspaceViewStore`, sin crear versiones de informe al navegar.

| Dato | Significado / regla |
| --- | --- |
| Etapa actual | `import / validation / preview / exports`; solo cambia por navegación del usuario. |
| Hito confirmado | Identidad de workspace, operación, base y nueva versión; debe estar relacionado con la versión publicada. |
| Etapa recomendada | A lo sumo una; Validar tras carga, Recalcular tras destinos utilizables guardados, Descargar tras aplicación. |
| Identidad del realce | Dedupe por hito; volver a renderizar o recuperar el mismo resultado no reinicia animación ni anuncio. |
| Inicio/fin del pulso | Tres ciclos de 1,5 s; máximo 4,5 s. Sin pulso para movimiento reducido. El estado recomendado persiste hasta visitarlo o sustituirlo. |
| Acción principal | Derivación del estado de la etapa según la tabla de la especificación. No se almacena como autorización. |
| Progreso visible | Trabajo activo o mensaje necesario de fallo/cancelación/incompletitud. El éxito se retira cuando su resultado ya está presentado. |

Un resultado tardío de otra base no modifica la recomendación. La descarga vinculada al recibo conserva su versión propia independientemente del selector histórico.

## 2. Revisión de destinos y grupos persistentes

Se conserva `DirectionReview` y su ciclo de vida actual. La proyección distingue **opciones elegibles**, **asignaciones activas** y **grupos que tuvieron conflicto**, en lugar de usar miembros activos como única fuente de información.

### CandidateOption e identidad de destino

- Se deriva de una instancia de regla, lado elegible y clave completa de celda/contexto. El candidato no copia los árboles, lecturas, descripciones o expresiones del snapshot.
- Si ambos lados de una instancia identifican exactamente la misma celda, se presenta un candidato único con el lado activo o una elección estable definida en el contrato.
- La identidad de destino incluye el contexto de negocio; entidades/periodos distintos no forman un mismo grupo.
- Descripción/expresión breves se obtienen al presentar una página. Los textos completos se consultan bajo demanda.

### ConflictGroup

| Campo conceptual | Validación |
| --- | --- |
| `groupId`, revisión y clave destino | Identifican un grupo dentro de una revisión; no se aceptan miembros de otra revisión o contexto. |
| `targetLabel / contextLabel / conceptLabel?` | Presentación de negocio; no sustituye las claves de identidad. |
| Catálogo de candidatos | Estable durante la revisión; cada opción debe seguir siendo elegible para esta base. |
| Miembros activos | Asignaciones actualmente dirigidas a esa clave. Pueden cambiar sin destruir el catálogo. |
| `candidateCount / activeCount` | Totales completos, no tamaño de la página. |
| `state` | `conflicted / resolved / omitted / pending`, según decisión y asignaciones efectivas. |
| `selectedCandidate?` | Ganador elegido o ausencia; no se elige por código, orden o posición de página. |

Solo se exponen grupos que hayan tenido conflicto real en esa revisión; una vez expuestos permanecen consultables para modificar la decisión. Resolver una celda no omite asignaciones activas a otras celdas. Un candidato asignado a otro destino exige cambiar antes ese destino explícitamente.

### Borrador local del editor

Un editor abierto contiene grupo, revisión leída, candidato u omisión propuesta y página de candidatos. Cambiar radio modifica este borrador, no el servidor. «Confirmar elección» envía la mutación con CAS e idempotencia; «Cancelar» recupera la decisión publicada. Guardar configuración no se habilita con una elección local pendiente o respuesta incierta.

Confirmar una elección modifica el borrador de direcciones; guardar configuración publica una versión con destinos. Ninguna de estas acciones escribe importes. [Contrato UI y grupos](contracts/ui.md).

## 3. Selección de propuestas

### SelectionRecord

Un registro pertenece a un único workspace, preview y base. La publicación de una nueva simulación crea exactamente uno y preselecciona los disponibles. Para un preview anterior sin registro existe una creación explícita vacía; un GET nunca crea estado.

| Campo | Contenido / invariante |
| --- | --- |
| `id / workspaceId / previewId / baseVersionId` | Pertenencia y aislamiento. La selección no puede trasladarse a otra base. |
| `revision` | Entero monotónico: 0 mientras no existe revisión publicada (preparing o failed), positivo a partir de ready; cada edición publicada tiene una revisión nueva. |
| `state` | `preparing / ready / updating / applying / applied / obsolete / discarded / failed`. |
| `initializationJobId?` | Operación que creó la selección inicial; evita repetirla al recuperar una pantalla. |
| `pendingJobId?` | Trabajo de preparación, edición o aplicación en curso. |
| Índice ordinal | Orden topológico estable de las propuestas del PreviewBundle; incluye pertenencia de cada propuesta/contexto. |
| Máscaras disponibles/seleccionadas/requeridas | Bloques canónicos JSON/base64, tamaño de bloque fijado en contrato; los typed arrays solo existen transitoriamente en worker. |
| `availableCount / selectedCount / requiredCount` | Totales de todo el recurso, omitidos si todavía no hay revisión publicada; no simular ceros. No exponer sus arrays globales a la interfaz nueva. |
| `complete / closureHash` | Resultado de comprobar selección/cierre para la revisión publicada. El hash solo no autoriza aplicación. |

El índice remite al bundle inmutable existente; no se duplica un ProposalDTO por seleccionado. Estado, índices, caches y revisiones candidata/anterior cuentan para la cuota. No se introducen objetos no serializables en `RetainedSize` o snapshots canónicos.

### Transiciones

| Suceso | Resultado |
| --- | --- |
| Nueva simulación válida | Publicación atómica de bundle + registro inicial `ready`; disponibles con destino/productor resueltos preseleccionados. |
| Consulta, navegación, filtro o recarga | Solo lectura de la selección publicada; no restablece opciones desmarcadas. |
| Edición aceptada | Se reserva revisión esperada y pasa a `updating`; la revisión anterior sigue íntegra y no se puede aplicar mientras la edición sea incierta. |
| Edición finaliza correctamente | Publica masks, totales/cierre y revisión nueva; pasa a `ready`. |
| Fallo/cancelación/timeout de edición | No publica ningún prefijo. Restaura la revisión anterior como `ready` si la base sigue vigente; de otro modo queda obsoleta. |
| Aplicación aceptada | Reserva referencia inmutable, pasa a `applying` y bloquea ediciones. |
| Aplicación confirmada | Por referencia, la selección queda `applied`; se publica recibo/versión y se conserva la consulta histórica necesaria. Una aplicación por arrays deja la selección independiente `obsolete`, sin atribuirle los IDs aceptados. |
| Cambio de base, descarte o cierre | Invalida edición y libera recursos propios conforme a retención; no convierte el recurso en una selección nueva. |
| Preview anterior sin selección | Inicialización explícita `seed:empty`; nunca preselección inferida al abrir histórico. |

Las ediciones admiten `set` individual, `selectMatching` del filtro completo y `clear` global. La selección masiva añade disponibles del filtro, conservando el exterior; quitar una selección no dispara incorporación automática de dependencias. Los filtros comparten `status / code / table / contextId`.

### Proyección paginada y aceptación

Una página contiene revisión, filtros, total coincidente, total disponible coincidente, seleccionadas coincidentes y recuentos fuera de filtro/página, junto con filas acotadas. Los recuentos fuera de filtro y de página pueden solaparse. Los scopes `all / selected / missing` permiten consultar propuestas, cambios a aceptar y dependencias pendientes sin hidratar la simulación completa.


Las filas son proyecciones escalares compactas, no ProposalDTO con arrays completos anidados. predecessorCount y requiredPredecessorCount cuentan antecedentes directos; requiredCount del resumen representa el cierre transitivo global. Una propuesta con más de 50 antecedentes se consulta por su propia ruta paginada, sin aplicar el filtro de contexto de la tabla a sus dependencias.

La explicación usa el resultado y las lecturas de la simulación, incluidas las entradas procedentes de otros recálculos. Expresión original, precisión/intervalo y valores escalares se consultan separadamente de las páginas de operandos, orígenes, motivos y descripciones. No se fuerza descargar el detalle legado completo para seleccionar o aceptar cambios.

La aceptación reside en la UI y queda vinculada a workspace, base, preview, selectionId, revisión y huella. Cualquier intención de editar la invalida inmediatamente. Recuperar una vista no restaura una casilla de aceptación. Incluso si se vuelve al mismo contenido, una aceptación anterior no vale para la nueva revisión.

## 4. Aplicación por referencia y recibos

`ApplicationRequest` tiene dos formas excluyentes:

- Compatibilidad: identificadores explícitos ya admitidos.
- Nueva UI: `selectionRef:{id,revision}` y `closureHash`, además de base y preview.

Una aplicación no admite ambas formas ni resuelve la referencia contra una revisión posterior. El servidor conserva la referencia reservada durante reintentos e incertidumbre. La consulta de idempotencia precede las comprobaciones que podrían rechazar una operación ya confirmada.

El worker resuelve los ordinales y revalida pertenencia, disponibilidad, destino único, cierre y base usando la política existente. La aplicación publica versión, recibo y resultados de revalidación atómicamente.

El recibo interno mantiene la evidencia necesaria. La nueva proyección compacta devuelve total aceptado y referencia cuando exista, omitiendo `acceptedIds`. Las lecturas de comparación y cambios siguen paginadas. El contrato legado conserva sus respuestas; `includeAcceptedIds=false` solicita el formato compacto. [Contrato de selección y aplicación](contracts/proposal-selection.md).

## 5. Informe FINREP y sus vínculos

### Definición de perfil

| Propiedad | Valor |
| --- | --- |
| `profileId` | `eba-finrep-4.0-f0101-v1` |
| Framework | `FINREP` |
| `moduleVersion` | `FINREP_F0101_4.0`, alias local del layout/edición, sin equivalencia afirmada con módulo XBRL oficial |
| Tabla / hoja | `F_01.01` / `1.1`; la parte ZIP se resuelve por relaciones |
| Cuadrícula | 38 posiciones F8:F45; c0010; filas y conceptos de la fuente fijada |
| `sheetCode / axes` | Cadena vacía / objeto vacío; tabla cerrada |
| Fuente | Anexo oficial de SHA-256 `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` |
| Semántica | Perfil numérico actual del motor; condicionales, texto, fechas y desigualdades sin recálculo |

### ReportContext y declaración numérica

Entidad, fechas civiles, framework, módulo y `filingIndicators["F_01.01"]` identifican el contexto de negocio. El identificador técnico FINREP se deriva del sourceFileId para evitar colisiones entre archivos; no cambia la identidad canónica de negocio ni evita detectar hechos duplicados en un mismo contexto.

Divisa de tres letras, escala s=0/3/6 y precisión p=−18…18 o INF se declaran en formulario o Contexto. El valor base es literal × 10^s; la precisión base es p−s dentro de los límites admitidos o INF. No se infieren de estilos. Vacío declara coordenada sin hecho, cero declara hecho numérico. Si libro y formulario declaran datos, deben coincidir.

La importación vigente exige misma entidad y fecha de referencia por conjunto. El contextId derivado del archivo no elude esa comprobación ni la prohibición de coordenadas de negocio duplicadas; los contextos de entidades/periodos distintos se aíslan entre conjuntos o se rechazan en un lote incompatible. El límite de veinte informes es una cota, no una garantía de admitir copias completas de F_01.01.

Al reimportar, se comparan los campos de negocio, valores, divisa, escala y precisión. Los identificadores transitorios de archivo, contexto y sesión pueden cambiar.

### Selección de perfil de informe

El contexto de inspección incorpora opcionalmente `reportProfiles`, una lista de `reportIndex / sha256 / profileId`. Índices únicos identifican cada archivo y sus bytes verificados. La elección se incluye en la huella de la solicitud y solo puede seleccionar un perfil realmente reconocido.

Si hay varios candidatos, el diagnóstico curado `REPORT_PROFILE_REQUIRED` incluye `profileChoice` con índice, hash y candidatos etiquetados. La UI pide elegir y reenvía una nueva inspección. Ni el diagnóstico ni la cadena de perfil aportada por el usuario suministran mappings o rutas.

### ReportSourceBinding y exportación

Se reutilizan sourceFileId, origen de contexto, mapping, hojas seleccionadas/excluidas, escala y precisión del binding existente. Perfil y fuente deben pertenecer al informe/workspace. Los paths se resuelven en SessionFiles por el servidor.

La exportación selecciona la versión, comprueba hash, reinspecciona estructura y binding, y modifica solo las posiciones monetarias autorizadas y partes necesarias de Contexto. El resto de partes se conserva según el contrato. La ausencia o alteración de la fuente falla de forma explícita. La salida completa se valida antes de publicarse; no se entrega un ZIP parcial.

El libro puede conservar hojas excluidas con fórmulas admitidas como contenido opaco; se mantiene el preflight global y nunca se evalúan. Las hojas seleccionadas y Contexto rechazan fórmulas. [Contrato de perfil y exportación](contracts/finrep-f0101.md).

## 6. Persistencia, invalidación y compatibilidad

- No hay migración de base de datos: el producto mantiene estado efímero. Se actualizan schemas, variantes discriminadas y contadores antes de producir los nuevos registros.
- Versiones históricas sin los nuevos registros conservan su lectura y contratos anteriores. No se reconstruye una selección automática a partir de una consulta.
- La publicación de una versión invalida recursos editables de la base previa; un worker no puede publicar después contra una base sustituida.
- Cierre de workspace cancela trabajos y libera fuentes/reservas/índices que le pertenezcan. No se afectan sesiones o archivos de otro conjunto.
- La retirada de controles técnicos no elimina los datos de auditoría. Se mantienen los requisitos de trazabilidad y propiedad en motor/API.
