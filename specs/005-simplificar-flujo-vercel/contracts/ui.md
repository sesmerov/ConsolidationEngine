# Contrato de interfaz — 005

Aplicable a modo local y alojado. FR/SC remiten a [spec.md](../spec.md); transporte y autoridad están en [api.md](api.md). Angular nunca decide elegibilidad, identidad de base ni resultado del cálculo.

## Navegación, foco y jerarquía

Hitos confirmados: `importPublished → Validar`, `validationCompleted(currentBasisId) → Recalcular`, `applicationPublished → Descargar`. Un evento de validación no se finge como publicación de versión; guardar configuración no produce salto adicional. Históricos de otra base, fallos, cancelaciones o resultados incompletos no avanzan guía.

El botón de etapa permanece estable dentro de envoltorio propio; el halo es su hermano, no contenido proyectado en la etiqueta Material. Mismo contorno/radio y caja, sin desplazamiento, sin capturar eventos y oculto al árbol accesible. Animación 4,5 s por hito; flecha/borde estáticos con movimiento reducido o colores forzados. No aparece «Siguiente paso».

Conservar `StageFocus` y `tabindex=-1` de títulos. Estilos acotados de títulos y `summary` suprimen solo el contorno de ratón cuando no hay `:focus-visible`; teclado, formularios y errores conservan foco perceptible. Reproducir el caso de `summary` antes de corregirlo; no usar `blur()` ni reglas globales que borren outlines. No acceder a clases privadas de Material. Probar geometría, foco e indicadores en 320/390/1440 px y alternancia ratón/teclado.

## Cargar y Validar

- Cargar conserva plantillas y demos, contexto, ambigüedad de perfil, escala/precisión, presentación y aceptación de hojas excluidas. Se retira la explicación genérica de nulos como desplegable, no la distinción de ausencia/cero en datos y diagnósticos.
- Validar muestra cumplimiento y explicación; deja de montar `DirectionsComponent`. Su control de resultados navega a Descargar con intención explícita `{workspaceId,versionId,kind:'results',runId}` y no inicia ni descarga un archivo.
- Ejecución única se muestra como lectura; varias permiten historial. El histórico elegido para consulta no determina qué ejecución usa Recalcular.
- No reinstaurar paneles técnicos o identificadores internos; errores, localizadores, exclusiones y fuentes útiles conservan acceso.

## Recalcular: estado y decisiones

Título inicial exacto: **Elegir qué celdas recalcular**. Estado cargado desde `GET .../recalculation-state`: versión y base actuales, ejecución compatible, configuración/revisión recuperables y contadores globales.

| Estado | Presentación y acción |
| --- | --- |
| Sin ejecución completa compatible | Mensaje breve + «Ir a Validar»; no tomar la selección histórica del navegador. |
| Preparación necesaria | Crear/reusar borrador automáticamente mediante aceptación recuperable; progreso breve. No publicar versión ni renovar sesión por una recarga automática. |
| Cero candidatos | «No hay recálculos disponibles» + navegación a Descargar; sin guardado vacío. |
| Pendientes | Solo alternativas de lado y conflictos globales pendientes, paginados; Simular deshabilitado con motivo. |
| Resuelto | Resumen breve y «Revisar decisiones» opcional; acción principal «Simular recálculos». |
| Obsoleto/caducado | Recuperar estado y explicar necesidad de revisar; no sobrescribir un editor local sin confirmar. |

Un destino único elegible se prepara automáticamente salvo elección/omisión previa vigente; si colisiona con otro productor continúa pendiente. Dos lados válidos requieren elegir u omitir. Cada conflicto requiere productor u omisión del grupo. Quitar el bypass de aceptación parcial con pendientes: continuar sin una regla requiere una omisión explícita persistida. Inelegibles se explican como solo validación fuera de la lista inicial de decisiones.

`no_candidates` significa ausencia de reglas elegibles. Si el analista omite explícitamente todas, el estado es `ready`: se muestra «Todas las reglas se han omitido», con revisión y navegación a Descargar; una simulación deliberada puede publicar esa configuración y un preview vacío, nunca habilita Aplicar ni confirmación y una configuración idéntica no crea otra versión. Entrar o recargar no publica nada. Antes de preparar el borrador los contadores son `null`, no ceros que aparenten ausencia de candidatos; una revisión vigente conserva su ejecución compatible aunque exista otra más reciente de la misma base.

Ámbito inicial de pendientes calculado en servidor, no filtrando únicamente las primeras 50 filas. Contadores globales, grupos/candidatos de páginas posteriores, contextos y edición preservan contratos004. Guard de decisión local sin confirmar al navegar, cambiar base/revisión o abrir otro editor; mismo mutationId y payload para repetición incierta.

**Simular** envía una única operación durable con base, basis, ejecución, revisión esperada y clave de idempotencia. Un job reutiliza configuración equivalente o reserva una versión y simula contra el snapshot virtual; solo al terminar publica configuración, preview, selección inicial y recibo juntos. Recargar recupera la operación. Fallo/cancelación conserva versión y borrador; un reintento de transporte usa la misma clave y los mismos IDs reservados. Una nueva simulación tras fallo terminal es otra acción explícita, sin revalidar los mismos datos.

Preselección, selección global/filtrada, dependencias y consentimiento conservan contratos004. Ninguna selección equivale a aceptar aplicación. Ante cambios relevantes se invalida consentimiento. Aplicar sigue siendo una publicación atómica y revalidación; ciclos, bloqueados y ramas independientes siguen distinguidos. La comparación no inyecta ni invoca exportación: muestra cambios y deja la etapa Descargar como continuación.

## Descargar: una intención, un botón

`DownloadIntent = {workspaceId,versionId,kind,runId?}`. `kind` conserva los contenidos actuales admitidos; resultados exigen `run.versionId === intent.versionId`, aunque otra ejecución comparta base de validación. Si la versión de configuración aún no tiene ejecución propia, elegir la versión original o validar expresamente para obtener resultados de esa versión; esto nunca se exige para Simular. Resumen y artefacto incluyen esa identidad y su fingerprint; el cliente compara ambos, nunca solo el último job recibido.

| Estado | Único botón de preparación/descarga | Selectores |
| --- | --- | --- |
| Sin elección válida | «Descargar», deshabilitado con motivo | Habilitados donde haya alternativas. |
| `idle` | «Descargar»: solicita preparación | Se bloquean mientras se acepta. |
| `accepting` / `uncertain` | «Preparando…» / «Reintentar descarga» | Bloqueados; se ve la intención del intento original. |
| Trabajo conocido en curso | «Preparando…», deshabilitado; Cancelar separado | Se pueden cambiar; el trabajo conserva su propia identidad. |
| Artefacto compatible listo | «Descargar» | Habilitados. |
| Transferencia | «Descargando…», deshabilitado; cancelación de transferencia separada | Cambio de intención aborta la transferencia actual. |
| Fallo recuperable | «Reintentar descarga» | Si aceptación incierta, bloqueados; si trabajo/artefacto conocido, habilitados. |

Al terminar una preparación puede empezar la transferencia únicamente si sigue activa exactamente la intención que el usuario pidió y la sesión está vigente. Si cambió, conservar el artefacto por identidad sin tocar selección/resumen ni descargarlo automáticamente. La entrada ordinaria conserva el histórico voluntario; una navegación contextual explícita desde Validar/guía puede seleccionar su intención correspondiente.

Eliminar botones de informes aplicados, descarga de comparación y «Descargar paquete de nuevo». No esconderlos como acciones secundarias. Reintento de transferencia usa el mismo artefacto; no regenera ZIP. Reintento incierto de aceptación usa exactamente clave, cuerpo y ETag originales. Si operación terminal falló, volver a prepararla es una nueva acción explícita y nueva clave.

Persistencia mínima de intento en `sessionStorage` antes de enviar: namespace de conexión, intención con IDs, clave, ETag y operation/jobId si ya se conoce. Recuperar con recibo autorizado tras recarga; ninguna regla, dato, archivo ni credencial de proveedor se guarda allí. Una operación desconocida no se repite con otra clave de forma automática.

Selectores dinámicos mediante `FormsModule`, `[ngModel]` y `(ngModelChange)` con IDs string y cero/una/varias opciones; sin escritura imperativa de `selectedIndex`. Probar DOM del select = señal = resumen = payload = contenido real. El síntoma versión 1/resumen6 requiere reproducción antes de atribuirle una causa definitiva.

## Inventario resuelto: 17 selectores

| Grupo | Tipos | Decisión |
| --- | ---: | --- |
| Contexto global | 1 | Selector con varios, lectura con uno, conservar contexto útil. |
| Cargar | 7 | Conservar demo, perfil ambiguo, origen de contexto, tipo manual, escala, presentación y estado de catálogo; no preguntar si existe una sola alternativa válida ni inferir escala/presentación. |
| Validar | 2 | Ejecución de lectura si única; historial con varias; estado de resultado conserva filtro. |
| Destinos | 2 | Trasladar estado de revisión y lado/omisión; pendientes por defecto, revisión de resueltos deliberada. |
| Recalcular | 2 | Historial de lectura si único; conservar filtro de estado, incluidos históricos válidos. |
| Descargar | 3 | Versión/contenido/ejecución con elección real; cero opciones explica recuperación; uno es lectura. |

## Inventario resuelto: 11 desplegables y controles relacionados

| Grupo | Tipos | Decisión |
| --- | ---: | --- |
| Cargar | 4 | Conservar guía opcional, exclusiones y regla; retirar explicación genérica de nulos, manteniendo su semántica visible donde afecta. |
| Cálculo compartido | 1 | Mostrar solo con explicación numérica real; nunca vacío para texto/fecha. |
| Validar | 1 | Retirar «Formato de resultados»; información breve necesaria en Descargar. |
| Destinos | 1 | Motivos sin destino en explicación accesible, fuera de pendientes. |
| Recalcular | 2 | Conservar revisión completa paginada; resumen siempre abierto pasa a resumen normal. |
| Descargar | 2 | Conservar informes/contexto y exclusiones, ligados a la intención correcta. |

Casillas/radios conservados: aceptación de exclusiones, productor/omisión, selección del filtro, fila y antecedentes, aceptación de aplicación. Retirar aceptación parcial de pendientes. Conservar confirmar/cancelar editor y cierre/descarte. Toggles conservados cuando hay contenido: propuestas aplicadas, solo cambios/todos, regla/cálculo y antecedentes; eliminar «Volver» duplicado de dependencias. Errores y decisiones pendientes no quedan detrás de un detalle cerrado.

## Sesión pública y evidencia

Aviso breve de uso sintético, sin afirmar detección del contenido real. Al acercarse a diez minutos del vencimiento efectivo, mostrar aviso contextual accesible; no hacer heartbeat ni banner técnico permanente. Acciones manuales significativas renuevan inactividad según contrato API; foco, GET, recarga, preparación automática y polling no. Expirar/cerrar limpia credenciales y estado visual; no crea otra sesión silenciosamente.

Pruebas: 320/390/1440, teclado, colores forzados y movimiento reducido; 51 decisiones/propuestas con páginas y conflictos; diez reentradas sin versiones nuevas; datos versus configuración; JSON y valores grandes por páginas; intención1/artefacto 6; respuestas perdidas/recarga; dos visitantes y cambio de instancia. README y cuatro capturas sintéticas reales se realizan después de comprobar el producto, declarando SDD con Spec Kit y enlazando `specs/`.
