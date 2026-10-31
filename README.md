# ConsolidationEngine

Motor de validación y recálculo de informes regulatorios. El analista cargará un catálogo reducido
de reglas EBA y sus informes en una plantilla Excel propia, consultará resultados y podrá aceptar
propuestas de recálculo con sus dependencias.

El proyecto está en la primera fase de Spec Kit. Hay una constitución y una especificación inicial;
todavía no existen una aplicación, un parser generado ni resultados de rendimiento.

## Documentos del proyecto

- [Constitución 1.0.0](.specify/memory/constitution.md): principios y restricciones.
- [Especificación 001](specs/001-regulatory-validation/spec.md): historias, requisitos y aceptación.
- [Comprobación de calidad](specs/001-regulatory-validation/checklists/requirements.md): estado
  documental de la especificación, sin acreditar pruebas de producto.
- [Notas de las fuentes](specs/001-regulatory-validation/source-notes.md): evidencia del Excel,
  gramáticas y documentación aportados.

## Decisiones de partida

- Frontend Angular y backend Node.js.
- ANTLR generará lexer y parser JavaScript a partir de las gramáticas de `grammar/`.
- El motor interpretará las reglas con semántica explícita; reconocer sintaxis no equivale a
  ejecutar una validación correctamente.
- Kahn ordenará los recálculos por sus productores y consumidores. Compartir una lectura no crea
  precedencia; los ciclos y los consumidores bloqueados se explicarán por separado.
- Los informes usarán una plantilla Excel propia, confirmada por el usuario, con coordenadas
  regulatorias, contexto y precisión. La plantilla se construirá durante la implementación.
- Las igualdades de validación no decidirán por sí solas qué celda modificar. Las propuestas
  requerirán destino explícito, previsualización y aceptación; conservarán los datos originales.
- La primera versión tendrá un perfil de lenguaje acotado, con intervalos cuando la regla los
  declare. Las construcciones no soportadas se mostrarán como no evaluables.

El uso local por un analista, los límites de carga y el perfil inicial son supuestos de alcance
documentados y revisables en la especificación.

## Continuación con Spec Kit

Se ha inicializado **Specify CLI 1.1.3**, integración **Codex**, con scripts PowerShell.
Las skills viven en `.agents/skills/` y los recursos compartidos en `.specify/`.

La siguiente fase es `$speckit-plan`. Antes puede utilizarse `$speckit-clarify` si se desea ajustar
el alcance. En planificación se concretarán la plantilla, las versiones de herramientas, las
políticas de cálculo y los contratos. Después: `$speckit-tasks` y `$speckit-implement`.
Estos nombres se invocan en el chat de Codex; no son comandos de PowerShell.

Para comprobar la instalación desde la raíz:

```powershell
specify version
specify integration status --json
```

No se ha creado `plan.md` ni `tasks.md`: corresponden a las siguientes fases.

## Fuentes y Git

Los originales se conservan en `grammar/`, `2. DPM-XL-docs-v0.9/` y en el Excel EBA de la raíz.
La gramática principal está duplicada en la carpeta documental; ambas copias se conservan.
Los nombres de los archivos `.g4` incluyen `-v0.9`, mientras sus declaraciones internas no;
la generación deberá resolver esa diferencia sin editar los originales.

Git se ha iniciado localmente en esta misma carpeta, en `main`. Se harán commits acotados a
medida que se completen funcionalidades y sus comprobaciones. Las cargas, exportaciones y
credenciales locales se excluyen del control de versiones. No se ha configurado un remoto.

El desarrollo con recibos sigue `disabled/unmanaged`; la lista de calidad de Spec Kit comprueba
documentación y no representa una aprobación de ese sistema.

CodeGraph no pudo inicializarse porque `gentle-ai` no está disponible en el entorno; esta fase
ha usado inspección directa de los archivos. No se ha creado ni reutilizado un índice externo.
