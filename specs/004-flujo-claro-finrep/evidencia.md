# Base comprobada y decisiones de alcance — iteración 004

Fecha: 2026-11-07. Revisión de partida: `9504cf3`, rama anterior `codex/003-simplificar-flujo`, árbol de trabajo limpio al comenzar. Nueva especificación: [spec.md](spec.md).

## Qué se ha comprobado en esta fase

Se revisaron las tres capturas de Diego, las plantillas de las cuatro etapas, el detalle del cálculo, la selección de propuestas y el reconocimiento/exportación de informes. Se contrastaron los artefactos FINREP anteriores y la fuente local fijada. Esta fase no modifica la aplicación, no ejecuta una nueva prueba integral ni acredita el futuro soporte visual FINREP.

CodeGraph no tenía índice local; el intento de inicialización no pudo ejecutarse porque `gentle-ai` no estaba disponible. La consulta MCP confirmó la ausencia de índice. La revisión continuó con lecturas directas.

| Hallazgo actual | Fuente del repositorio | Consecuencia para 004 |
| --- | --- | --- |
| El menú añade un elemento visible «Siguiente paso». | [Navegación](../../apps/web/src/app/workspace/workspace-shell.component.html) | Sustituirlo por realce de la etapa completa, con pulso finito y alternativa estática. |
| Las acciones de avance usan estilos distintos; confirmar carga y guardar configuración no comparten jerarquía. | [Cargar](../../apps/web/src/app/import/import-page.component.html), [Destinos](../../apps/web/src/app/recalculation/directions.component.html) | Definir una acción principal verde por estado. El color no sustituye texto ni requisitos de confirmación. |
| La ayuda de carga contiene perfiles internos, identificador, huella, caducidad y explicación del motor. Hay otros bloques de identificadores y volcados en sesión, validación y recálculo. | [Carga](../../apps/web/src/app/import/import-page.component.html), [Detalle](../../apps/web/src/app/shared/calculation-detail.component.html), [Validación](../../apps/web/src/app/validation/validation-page.component.html) | Retirarlos de la interfaz según el inventario de la especificación, conservando explicaciones y problemas útiles. |
| Cada productor de un conflicto aparece como botón «Conservar…». | [Destinos](../../apps/web/src/app/recalculation/directions.component.html) | Lista de elección única, opción de omisión y resumen editable. No presentar valores futuros antes de simularlos. |
| Las propuestas disponen de casillas individuales y comienzan sin selección; las selecciones fuera de página ya forman parte del recuento. | [Propuestas](../../apps/web/src/app/recalculation/preview-page.component.html), [Selección](../../apps/web/src/app/recalculation/preview.store.ts) | Incorporar selección masiva del filtro completo y preselección inicial controlada, sin restaurar deselecciones. |
| La carga visual y el reconocimiento siguen vinculados a COREP CA1 y a la demo tipada. El contexto y la exportación visual también requieren ampliación para FINREP. | [Registro](../../apps/api/src/import/profiles/registry.ts), [Inspección](../../apps/api/src/import/xlsx-preflight.ts), [Exportación](../../apps/api/src/export/recalculated-report.ts) | Una prueba positiva requiere ampliar el recorrido de producto completo. No basta con admitir el nombre de una hoja. |

## Decisiones confirmadas y decisiones de diseño

Diego confirmó mediante respuesta explícita que «selector múltiple» significa casillas de propuestas en Recalcular y «Seleccionar todas», con preselección y confirmación de aplicación.

Se adoptan como decisiones de diseño revisables en esta especificación:

- Tres pulsos suaves durante seis segundos y después realce estático, con movimiento reducido respetado.
- Verde para la acción principal del estado actual y jerarquía secundaria para consultas, omisiones y descartes.
- Opciones excluyentes por conflicto, con descripción y expresión consultable.
- Selección masiva de todas las páginas del filtro; limpieza de toda la selección, con recuentos explícitos.
- Retirada de información interna y progreso exitoso duplicado. Las advertencias sobre exclusiones, datos temporales y errores permanecen en el lugar donde ayudan a decidir.

Estas decisiones sustituyen los aspectos correspondientes de 003. No se ha ejecutado todavía una prueba humana de esta nueva interfaz. Las capturas y el comentario de Diego son evidencia de problemas en la interfaz anterior.

## FINREP: punto de partida y aceptación futura

La prueba anterior rechazó el extracto visual durante la inspección con `INVALID_WORKBOOK` y motivo `UNRECOGNIZED_COREP_SHEETS`. Quedaron cero versiones. La representación de las mismas cuatro cifras en el formato anterior sí produjo el resultado esperado para sus dos reglas propias. [Resultado conservado](../003-simplificar-flujo/resultado-finrep.json) · [Guion reproducible](../003-simplificar-flujo/finrep-probe.mjs) · [Verificación de 003](../../docs/verification-003.md).

Ese resultado describe el punto de partida. La aceptación de 004 exige cargar la plantilla visual, evaluar el catálogo, obtener los cambios previstos, exportar y volver a cargar el informe.

### Fuente local contrastada

| Dato | Valor |
| --- | --- |
| Archivo | `tests/fixtures/eba/official-annexes-4.0.xlsx` |
| Procedencia registrada | EBA, paquete ITS on supervisory reporting; libro original `C_2024_8389_1_ANNEX_EN_V3_P1_3682615.XLSX` |
| Edición fijada del proyecto | 4.0; no se afirma que sea la última edición disponible |
| SHA-256 comprobado en esta fase | `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` |
| Hoja y parte del libro | `1.1` / `xl/worksheets/sheet69.xml`, «1.1 Assets» |
| Cuadrícula de importes | 38 posiciones, F8:F45; c0010; códigos de fila en B y conceptos en C |
| Códigos especiales observados | 0096–0099, 0141–0144, 0181–0183; última fila 0380, TOTAL ASSETS |
| Primeras cuatro posiciones | F8/r0010, F9/r0020, F10/r0030, F11/r0040 |

[Manifiesto de las fuentes](../../tests/fixtures/eba/source-manifest.json). La fuente oficial se ha leído sin modificarla. El libro anotado COREP existente no acredita metadatos FINREP.

El plan deberá fijar el módulo y metadatos FINREP que correspondan a la fuente. `FINREP_SYNTHETIC` fue una etiqueta del ensayo anterior; no es prueba de identificación de un módulo regulatorio oficial. Tampoco procede identificar este informe como COREP.

US5 define un nuevo catálogo de cinco reglas sintéticas y valores conocidos. Se exige reconocer las 38 posiciones aunque las reglas de ejemplo solo lean algunas. Sus dos igualdades producen 90 → 100 y 105 → 120 en orden de dependencia; las desigualdades y el condicional solo validan. Se comprobarán por separado ausencia frente a cero, precisión, estructura alterada y conservación del libro exportado.

## Límites de esta entrega

- Se entregan especificación, esta evidencia de partida y checklist de calidad documental.
- No hay cambios de código, nuevos archivos de demo, migración de datos, despliegue ni prueba positiva FINREP en esta fase.
- No se han iniciado plan ni tareas de 004. La siguiente fase es `$speckit-plan`.
