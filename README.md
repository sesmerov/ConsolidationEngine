# ConsolidationEngine

Motor de validación y recálculo de informes regulatorios. El analista cargará un catálogo reducido
de reglas EBA y sus informes en una plantilla Excel propia, consultará resultados y podrá aceptar
propuestas de recálculo con sus dependencias.

La implementación está en curso con Spec Kit. T001–T030 están completadas: sesión local,
plantilla Excel, importación atómica, análisis ANTLR y pantalla de carga con cobertura y diagnósticos.
La evaluación de reglas y los recálculos corresponden a los siguientes incrementos.
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
- El motor interpretará las reglas con semántica explícita; reconocer sintaxis no equivale a
  ejecutar una validación correctamente.
- Kahn ordenará los recálculos por sus productores y consumidores. Compartir una lectura no crea
  precedencia; los ciclos y los consumidores bloqueados se explicarán por separado.
- Los informes usarán una plantilla Excel propia, confirmada por el usuario, con coordenadas
  regulatorias, contexto y precisión. La plantilla está disponible para descargar desde la aplicación.
- Las igualdades de validación no decidirán por sí solas qué celda modificar. Las propuestas
  requerirán destino explícito, previsualización y aceptación; conservarán los datos originales.
- La primera versión tendrá un perfil de lenguaje acotado, con intervalos cuando la regla los
  declare. Las construcciones no soportadas se mostrarán como no evaluables.
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
El primer incremento carga e inspecciona archivos; el MVP validador completa US1 y US2,
incluida la exportación de resultados. US3 y US4 añaden propuestas y aplicación de recálculos.
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
