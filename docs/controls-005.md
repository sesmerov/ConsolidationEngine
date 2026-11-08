# Inventario de controles — iteración 005

Fecha: 2026-11-08. Base: [contrato UI](../specs/005-simplificar-flujo-vercel/contracts/ui.md) y código anterior a la implementación de US1–US5. **Inventario y decisiones previstas, no comprobación de interfaz final.**

Un tipo repetido por cada regla, fila o informe se cuenta una vez. Hay **17 tipos de selectores y 11 tipos de desplegables**; casillas, radios y acciones de apertura se inventarían aparte. T052 completa resultados locales y T100 reconcilia controles nuevos de la demo pública. No eliminar una fila del inventario para ocultar un caso pendiente: registrar su eliminación y la prueba correspondiente.

## Convenciones y comprobación común

Las rutas de las tablas son relativas a `apps/web/src/app/`. Para cada control conservado se comprobarán nombre accesible, estado, foco, Tab/Shift+Tab y activación con teclado; pantalla estrecha320/390 px y1440 px; estados ocupado/error/histórico donde proceda. «Una opción» significa una alternativa **real**, no contar un placeholder como alternativa. Con cero opciones se explica recuperación y no se ofrece un selector vacío. Cambiar filtros/páginas no borra elecciones persistidas. La evidencia se enlazará a un caso y a su resultado real, no solo a una captura de que el control existe.

## Selectores

| ID | Control y componente actual | Decisión prevista | Casos específicos de comprobación | Evidencia final |
| --- | --- | --- | --- | --- |
| S01 | Contexto global — `workspace/workspace-shell.component.html`, `#context-selector` | Mantener con varios; lectura con uno. | Cero sin conjunto; uno con contexto legible; varios cambian ámbito y conservan identidad; devolver foco cuando desaparezca el selector. | Pendiente T048/T100. |
| S02 | Demostración — `import/import-page.component.html`, `#demo-selector` | Mantener elección COREP/FINREP/tipos. | Tres opciones modifican archivos e instrucciones; texto/fecha solo valida; sin alternativa futura se muestra lectura. | Pendiente T047/T100. |
| S03 | Plantilla ambigua por archivo — `import/import-page.component.html`, `[data-profile-choice]` | Mantener solo para ambigüedad real. | Cero perfiles da diagnóstico; uno no pregunta; dos requieren elección y nueva inspección; conservar exclusiones. | Pendiente T047/T100. |
| S04 | Origen del contexto — `import/import-page.component.html`, `#context-source` | Mantener libro/formulario cuando ambas opciones sean válidas. | Contexto ausente/inválido explica corrección; cambio no conserva una inspección obsoleta ni pierde borrador silenciosamente. | Pendiente T047/T100. |
| S05 | Tipo de informe manual — `import/import-page.component.html`, `#context-framework` | Mantener elección real COREP/FINREP. | Tipo cambia tabla/módulo esperado; lectura si solo uno aplicable, error si ninguno; no mezclar perfiles. | Pendiente T047/T100. |
| S06 | Escala — `import/import-page.component.html`, `#context-scale` | Mantener; nunca inferir escala por conveniencia. | Vacío exige decisión; unidades/miles/millones cambian interpretación; dato de lectura solo si ya está declarado inequívocamente. | Pendiente T047/T100. |
| S07 | Tabla presentada — `import/import-page.component.html`, `#context-filing` | Mantener Sí/No; nunca inferir el indicador. | Vacío no es No; Sí/No son decisiones distintas; contexto declarado de libro puede mostrarse como lectura. | Pendiente T047/T100. |
| S08 | Estado del catálogo — `import/import-page.component.html`, `select[name=status]` | Mantener filtro útil. | Todos/error/no soportada/aplicable/no aplicable/falta contexto cambian filas; cero resultados da estado vacío, no borra catálogo. | Pendiente T047/T100. |
| S09 | Ejecución de validación — `validation/validation-page.component.html`, `#validation-run` | Lectura con una; historial con varias. | Cero invita a validar; única tiene fecha/versión/estado; histórico se conserva y nunca elige la base de Recalcular. | Pendiente T048/T100. |
| S10 | Estado del resultado — `validation/validation-page.component.html`, `#result-status` | Mantener filtro. | Cada estado filtra correctamente; sin resultados no inventa aprobación; combinación con código/tabla mantiene ámbito. | Pendiente T048/T100. |
| S11 | Estado de revisión — `recalculation/directions.component.html`, selector de `stateFilter` | Trasladar al inicio de Recalcular; pendientes primero y resueltos deliberadamente. | Pendientes globales en página51; revisar resueltos conserva elecciones/omisiones; cero pendientes habilita Simular. | Pendiente T023/T028/T100. |
| S12 | Lado u omisión — `recalculation/directions.component.html`, selector por fila | Mostrar solo decisiones ambiguas; inequívocos automáticos. | Dos lados requieren izquierda/derecha/omitir; único destino no pregunta, pero colisión sigue pendiente; guardas de editor/base. | Pendiente T021/T028/T100. |
| S13 | Historial de simulación — `recalculation/preview-page.component.html`, `#preview-history` | Lectura con una; selector con varias. | Cero no presenta control vacío; histórico aplicado/descartado/obsoleto legible; elegir no altera datos. | Pendiente T048/T100. |
| S14 | Estado de propuesta — `recalculation/preview-page.component.html`, `#proposal-status` | Mantener filtro y estados útiles. | Disponibles/bloqueadas/obsoletas/descartadas/aplicadas; selección global y dependencias no se pierden al filtrar. | Pendiente T048/T100. |
| S15 | Versión para exportar — `recalculation/exports.component.html`, `#export-version` | Lectura con una, elección con varias. | Versión1 frente a artefacto6; opciones tardías; histórico voluntario tras aplicar; DOM/store/resumen/petición/archivo coinciden. | Pendiente T036/T040/T044/T100. |
| S16 | Contenido de exportación — `recalculation/exports.component.html`, `#export-kind` | Mantener informes/cambios o resultados donde exista elección. | Sin contenido válido explicar recuperación; cambiar intención invalida artefacto ajeno; aceptación incierta bloquea cambio. | Pendiente T038/T040/T100. |
| S17 | Ejecución para exportar resultados — `recalculation/exports.component.html`, `#export-run` | Lectura con una compatible; selector con varias. | Cero explica validar/elegir versión; versión exacta, no solo misma base; ejecución en curso no exportable; late response no sustituye elección. | Pendiente T034/T040/T100. |

## Desplegables

| ID | Apartado y componente actual | Decisión prevista | Casos específicos de comprobación | Evidencia final |
| --- | --- | --- | --- | --- |
| D01 | Pasos/resultados de demo — `import/import-page.component.html` | Conservar ayuda opcional. | Abrir/cerrar con Enter/Space; cambia con demo; no contiene pasos obsoletos de guardar destinos. | Pendiente T047/T100. |
| D02 | Hojas excluidas de inspección — `import/import-page.component.html` | Conservar cuando existan exclusiones. | Cero no muestra detalle vacío; nombres/efecto legibles; aceptación necesaria visible fuera del detalle. | Pendiente T047/T100. |
| D03 | Cómo se identifican datos ausentes — `import/import-page.component.html` | Eliminar ayuda genérica duplicada. | El detalle desaparece; ausencia/cero siguen distintos en datos y diagnóstico donde afectan decisión. | Pendiente T047/T100. |
| D04 | Detalle de regla — `import/import-page.component.html` | Conservar expresión/diagnóstico/origen útiles. | Error/no soportada/falta contexto siguen localizables; texto largo accesible; no ejecutar contenido como código. | Pendiente T047/T100. |
| D05 | Cómo se obtiene este importe — `shared/calculation-detail.component.html` | Mostrar solo con explicación numérica real. | Número con operandos/intervalo muestra cálculo; texto/fecha/sin datos no produce panel vacío; origen útil permanece accesible. | Pendiente T046/T049/T100. |
| D06 | Formato de resultados — `validation/results-export.component.ts` | Retirar; información breve necesaria en Descargar. | Validar navega con intención y no descarga; no duplicar explicación estática ni perder identificación del contenido. | Pendiente T041/T048/T100. |
| D07 | Motivos de reglas sin destino — `recalculation/directions.component.html` | Fuera de pendientes; acceso útil conservado. | Condicional/texto/fecha/desigualdad explica solo validación; sin motivos no hay detalle vacío; ninguna decisión oculta aquí. | Pendiente T028/T100. |
| D08 | Revisión completa de selección — `recalculation/apply.component.html` | Conservar revisión paginada. | Cero seleccionadas no presenta confirmación; varias/página51/cambio de selección actualiza revisión e invalida aceptación. | Pendiente T031/T050/T100. |
| D09 | Resumen completo del catálogo — `recalculation/comparison.component.html` | Convertir en resumen normal, sin cierre sin valor. | Antes/después completos y tabla accesible; desaparece desplegable abierto por defecto; sin descarga directa. | Pendiente T041/T050/T100. |
| D10 | Informes y contexto — `recalculation/exports.component.html` | Conservar ligado a intención exacta. | Un/múltiples informes y versión histórica; ratón sin rectángulo innecesario, teclado con foco visible. | Pendiente T011/T040/T051/T100. |
| D11 | Hojas excluidas por archivo exportado — `recalculation/exports.component.html` | Conservar cuando existan. | Cero sin detalle; hojas FINREP preservadas no se presentan como validadas; cambiar versión cambia contenido. | Pendiente T051/T100. |

## Casillas, radios, toggles y acciones de apertura

| ID | Control y componente actual | Decisión prevista y casos de comprobación | Evidencia final |
| --- | --- | --- | --- |
| C01 | Aceptación de exclusiones — `import/import-page.component.html` | Conservar confirmación visible cuando corresponda; inspección cambiada/obsoleta/caducada invalida aceptación; no se oculta en D02. | Pendiente T047/T100. |
| C02 | Productor u omisión — `recalculation/directions.component.html`, `mat-radio-group` | Conservar elección explícita y reversible; 2/3/51 productores, flechas/Space, candidato inelegible explicado y sin ganador automático. | Pendiente T019/T028/T100. |
| C03 | Confirmar/cancelar editor — `recalculation/directions.component.html` | Conservar; edición local no publica antes de confirmar, cancelar restaura, navegación advierte; foco retorna a origen. | Pendiente T028/T030/T100. |
| C04 | Aceptar subconjunto con pendientes — `recalculation/directions.component.html` | Eliminar bypass; omitir requiere decisión persistida, Simular no trata pendientes como resueltos. | Pendiente T028/T100. |
| C05 | Seleccionar todas las disponibles del filtro — `recalculation/preview-page.component.html` | Conservar selección global filtrada, estado parcial y cero opciones; no limitar a primera página ni autoaceptar cambios. | Pendiente T031/T050/T100. |
| C06 | Selección individual de propuesta — `recalculation/preview-page.component.html` | Conservar nombre por regla y elegibilidad; preselección inequívoca se puede desmarcar; consentimiento invalidado al cambiar. | Pendiente T031/T100. |
| C07 | Selección de antecedentes — `recalculation/preview-page.component.html` | Conservar dependencia explícita, incluso fuera de página/contexto; histórico de solo lectura; selección no confirma aplicación. | Pendiente T031/T050/T100. |
| C08 | Aceptación de aplicación — `recalculation/apply.component.html` | Conservar solo con selección; cambio relevante/base obsoleta invalida consentimiento; ningún cambio se aplica automáticamente. | Pendiente T031/T050/T100. |
| C09 | Propuestas aplicadas visibles — `recalculation/preview-page.component.html` | Conservar cuando existan; nombre/aria-expanded coherentes y alternancia visible, sin ocultar resultado principal. | Pendiente T050/T100. |
| C10 | Revisar dependencias pendientes / Volver — `recalculation/preview-page.component.html` | Conservar un único regreso; eliminar «Volver a las propuestas» duplicado, mantener cantidades y acción pendiente visibles. | Pendiente T050/T100. |
| C11 | Abrir/cerrar antecedentes — `recalculation/preview-page.component.html` | Conservar solo si hay antecedentes; paginación real, foco restaurado, sin panel vacío. | Pendiente T050/T100. |
| C12 | Ver regla / Cerrar regla — `recalculation/directions.component.html` | Conservar detalle del candidato y procedencia; texto largo no truncado al abrir, cambio de candidato no mezcla respuestas. | Pendiente T028/T100. |
| C13 | Cálculo/origen y cierre de detalle — `validation/validation-page.component.html`, `recalculation/preview-page.component.html`, `shared/calculation-detail.component.html` | Conservar nombres por regla, foco programático y retorno; información útil accesible aunque D05 no exista para texto/fecha. | Pendiente T012/T049/T100. |
| C14 | Solo cambios / Todos y comparación Antes/Después — `recalculation/comparison.component.html` | Conservar filtros/detalle con efecto real; selección cambia filas o cálculo mostrado y no mezcla ejecuciones. | Pendiente T050/T100. |
| C15 | Descartar revisión/simulación — `recalculation/directions.component.html`, `recalculation/preview-page.component.html` | Conservar donde proceda; confirmar/cancelar no altera datos de informe, respeta histórico y respuestas inciertas. | Pendiente T028/T050/T100. |
| C16 | Cerrar conjunto / cancelar cierre — `workspace/workspace-shell.component.html` | Conservar confirmación y foco; en hosted revocación efectiva, sin borrado implícito por navegación. | Pendiente T069/T100. |
| C17 | Preparar revisión / Guardar configuración — `recalculation/directions.component.html` | Retirar pasos manuales inequívocos; preparación automática al entrar, una acción Simular y resumen de decisiones. | Pendiente T026–T029/T100. |
| C18 | Descargas del conjunto — `validation/results-export.component.ts`, `recalculation/comparison.component.html`, `recalculation/exports.component.html` | Centralizar en Descargar con único botón por estado y Cancelar distinto; ninguna descarga rápida o repetir paquete secundaria. Demos/plantillas de Cargar se conservan. | Pendiente T036/T040–T044/T100. |

## Registro final pendiente

Al completar T052/T100 sustituir cada estado pendiente por resultado, nombre de caso ejecutado y enlace a evidencia. Para una eliminación, verificar además que sigue accesible toda información que cambia una decisión. Registrar por separado controles nuevos de aviso de sesión, recuperación y valores paginados; no declararlos incluidos en el conteo inicial hasta inventariarlos. No confundir este inventario con aceptación humana de004 ni005.
