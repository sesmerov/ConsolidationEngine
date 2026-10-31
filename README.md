# ConsolidationEngine

Motor de validación y recálculo de informes regulatorios. El analista cargará un catálogo reducido
de reglas EBA y sus informes en una plantilla Excel propia, consultará resultados y podrá aceptar
propuestas de recálculo con sus dependencias.

La implementación está en curso con Spec Kit. El incremento actual permite crear una sesión local,
descargar la plantilla Excel, importar archivos, analizar reglas con ANTLR y ejecutar validaciones
con cálculo exacto. Incluye explicaciones, resultados históricos y exportación a ZIP.
También permite configurar destinos y simular propuestas de recálculo con sus dependencias.
La aceptación expresa publica una nueva versión, revalida y permite comparar y exportar sus datos.
Quedan las comprobaciones finales de rendimiento, accesibilidad y recorrido del analista.
Los resultados comprobados se registran en [verificación](docs/verification.md).

## Ejecutar el incremento actual

Con el toolchain y dependencias preparados según [scripts/README.md](scripts/README.md):

```powershell
./scripts/run-with-toolchain.ps1 run build
./scripts/run-with-toolchain.ps1 start
```

Abrir `http://127.0.0.1:3000`. Node sirve Angular y la API en el mismo origen.
Para desarrollo con recarga: `./scripts/run-with-toolchain.ps1 run dev` y
`http://127.0.0.1:4200`. La sesión se descarta al cerrar el conjunto o reiniciar el servidor.

Para probar la carga, usar `tests/fixtures/generated/eba-subset.xlsx` con
`report-42.xlsx` o, en otra carga, `report-40.xlsx` del mismo directorio. Sus datos de informes
y declaraciones de presentación son sintéticos; las tres filas de reglas proceden del Excel EBA
original y conservan sus precondiciones. El catálogo completo supera el límite de 500 filas.
También se puede descargar la plantilla desde la aplicación.

Tras cargar los archivos, pulsar **Validar informes**. Los resultados separan estado y severidad;
cada detalle muestra valores comparados, datos leídos, precisión, indicadores y procedencia.
Los filtros permiten consultar por estado, código y tabla. Una ejecución incompleta o sin reglas
evaluadas no acredita que el informe sea correcto. Los resultados de una versión anterior se
conservan como históricos durante la sesión.

**Exportar resultados (ZIP)** descarga `results.json`, con valores exactos y trazabilidad, y
`results.xlsx`, como vista literal sin fórmulas activas. La descarga corresponde a la ejecución
seleccionada. Los límites de tamaño y espacio acumulado se publican en las capacidades de la API;
si se superan, el trabajo falla sin ofrecer un archivo parcial.

Para previsualizar recálculos, elegir los lados elegibles en **Configurar destinos de recálculo** y guardar
la configuración completa. Después, **Simular recálculos** muestra los valores anteriores,
los propuestos, su precisión, los predecesores y los bloqueos. La selección muestra los antecesores
que faltan sin seleccionarlos automáticamente. Los informes permanecen intactos durante esta fase.
El historial de validaciones y previsualizaciones se recupera también al refrescar el navegador;
descartar una previsualización conserva su estado histórico dentro de la sesión.

Para aplicar cambios, seleccionar un conjunto completo con sus dependencias y confirmar todos
sus destinos. La aplicación conserva la versión original, publica la nueva sólo cuando termina
la revalidación y muestra los resultados antes/después, incluidos los fallos y errores restantes.
Una propuesta aceptada sin cambio de valor queda auditada, pero no cuenta como hecho modificado.
El recibo y la comparación se recuperan tras recargar; cancelar después de publicar no deshace
la aplicación. Una respuesta incierta se puede reintentar sin aplicar el conjunto dos veces.

El panel de exportación permite elegir una versión o ejecución histórica. `report.zip` incluye
un Excel ce-report-1 por informe original y `changes.json`/`changes.xlsx` con su historial de cambios.
Para reimportar, extraer los informes del ZIP y cargarlos junto con el catálogo original separado.
Se conservan valores exactos, precisión, códigos, contextos e indicadores; la carga crea una nueva
versión y no restaura recibos desde el log. Al cerrar el conjunto se eliminan sus temporales del
servidor y permanecen las descargas ya guardadas por el usuario.

## Documentos del proyecto

- [Constitución 1.0.0](.specify/memory/constitution.md): principios y restricciones.
- [Toolchain y comandos de desarrollo](scripts/README.md): Node/npm aislados y generación ANTLR.
- [Especificación 001](specs/001-regulatory-validation/spec.md): historias, requisitos y aceptación.
- [Plan técnico](specs/001-regulatory-validation/plan.md): arquitectura, versiones y secuencia de construcción.
- [Tareas de implementación](specs/001-regulatory-validation/tasks.md): siete fases con dependencias,
  pruebas y trazabilidad de requisitos; cada checkbox refleja su implementación verificada.
- [Investigación](specs/001-regulatory-validation/research.md): decisiones, alternativas y fuentes.
- [Modelo de datos](specs/001-regulatory-validation/data-model.md): identidades, snapshots y estados.
- Contratos de [HTTP](specs/001-regulatory-validation/contracts/http-api.md),
  [Excel](specs/001-regulatory-validation/contracts/workbook.md) y
  [lenguaje/cálculo](specs/001-regulatory-validation/contracts/language-profile.md).
- [Guía de validación](specs/001-regulatory-validation/quickstart.md): comandos y escenarios previstos;
  distingue lo verificable hoy de lo que requiere implementar el producto.
- [Comprobación de calidad](specs/001-regulatory-validation/checklists/requirements.md): estado
  documental de la especificación, sin acreditar pruebas de producto.
- [Notas de las fuentes](specs/001-regulatory-validation/source-notes.md): evidencia del Excel,
  gramáticas y documentación aportados.

## Decisiones de partida

- Frontend Angular y backend Node.js.
- ANTLR genera lexer y parser JavaScript a partir de las gramáticas de `grammar/`.
- El motor interpreta las reglas con semántica explícita; reconocer sintaxis no equivale a
  ejecutar una validación correctamente.
- Kahn ordena los recálculos por sus productores y consumidores. Compartir una lectura no crea
  precedencia; los ciclos y los consumidores bloqueados se explican por separado.
- Los informes usarán una plantilla Excel propia, confirmada por el usuario, con coordenadas
  regulatorias, contexto y precisión. La plantilla está disponible para descargar desde la aplicación.
- Las igualdades de validación no decidirán por sí solas qué celda modificar. Las propuestas
  requerirán destino explícito, previsualización y aceptación; conservarán los datos originales.
- El perfil de lenguaje es acotado, con intervalos cuando la regla los declare. Las construcciones
  no soportadas se muestran como no evaluables.
- El perfil documenta una diferencia frente a fórmulas inconsistentes observadas en el PDF v0.9
  para multiplicación/división de intervalos. No afirma conformidad literal completa con DPM-XL.
- La sesión inicial será local y efímera: los datos cargados no se recuperan tras reiniciar la
  aplicación. Las exportaciones guardadas por el usuario se conservan.

El uso local por un analista, los límites de carga y el perfil inicial son supuestos de alcance
documentados y revisables en la especificación.

## Continuación con Spec Kit

Se ha inicializado **Specify CLI 1.1.3**, integración **Codex**, con scripts PowerShell.
Las skills viven en `.agents/skills/` y los recursos compartidos en `.specify/`.

`$speckit-implement` está en ejecución, siguiendo las dependencias de tasks.md.
US1 y US2 forman el MVP validador, incluida la exportación de resultados.
US3 y US4 están completadas: propuestas con dependencias, aplicación confirmada, revalidación y
exportación de informes recalculados. El checkpoint reúne 893 pruebas correctas sin omisiones;
incluye 14 recorridos Chromium. La fase final comprobará recursos, rendimiento y accesibilidad.
Si cambia el alcance, se actualizarán primero la especificación y el plan afectados.
Estos nombres se invocan en el chat de Codex; no son comandos de PowerShell.

Para comprobar la instalación desde la raíz:

```powershell
specify version
specify integration status --json
```

`plan.md` y `tasks.md` están preparados. Generar las tareas no las ejecuta ni acredita pruebas del motor.

## Fuentes y Git

Los originales se conservan en `grammar/`, `2. DPM-XL-docs-v0.9/` y en el Excel EBA de la raíz.
La gramática principal está duplicada en la carpeta documental; ambas copias se conservan.
Los nombres de los archivos `.g4` incluyen `-v0.9`, mientras sus declaraciones internas no;
la generación resuelve esa diferencia mediante copias temporales, sin editar los originales.

Git se ha iniciado localmente en esta misma carpeta, en `main`. Se harán commits acotados a
medida que se completen funcionalidades y sus comprobaciones. Las cargas, exportaciones y
credenciales locales se excluyen del control de versiones. No se ha configurado un remoto.

El desarrollo con recibos sigue `disabled/unmanaged`; la lista de calidad de Spec Kit comprueba
documentación y no representa una aprobación de ese sistema.

CodeGraph no pudo inicializarse porque `gentle-ai` no está disponible en el entorno; esta fase
ha usado inspección directa de los archivos. No se ha creado ni reutilizado un índice externo.
