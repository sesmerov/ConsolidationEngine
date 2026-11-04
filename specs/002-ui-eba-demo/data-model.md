# Modelo de datos de la ampliación

Diseño 2026-11-04. Extiende el código y los contratos de la primera entrega, sin
reescribir su evidencia. No describe clases ya implementadas ni una base de datos.

## Versiones y compatibilidad

| Elemento | Contrato |
|---|---|
| Lenguaje anterior | `ce-dpmxl-0.9-closed-v1`, usado por `ce-report-1`; semántica numérica/booleana existente. |
| Lenguaje ampliado | `ce-dpmxl-0.9-closed-v2`, con texto, fecha y condicionales solo de validación. |
| Plantilla COREP | `eba-corep-of-4.0-ca1-v1`, con manifiesto congelado y procedencia EBA. |
| Plantilla didáctica | `ce-demo-types-1`, propia, campos legibles y sin atribución regulatoria. |
| API | Se extiende `/api/v1` con rutas y esquemas cerrados; nuevas capacidades declaradas explícitamente. |

El adaptador determina el perfil del snapshot. No se admite un `profileId` arbitrario
en la confirmación de una carga. V1 no acepta AST ni valores nuevos. En V2, una regla
numérica con condicional también es solo de validación. La restricción es de la regla
entera y no depende de sus datos, del lado elegido o de la rama ejecutada.

## Entidades nuevas y extendidas

### ReportTemplateProfile

- `id`, `languageProfileId`, `version`, `framework`, `moduleVersion`, `supportedTables`.
- `sourceArtifacts`: URL, nombre original, SHA-256 y finalidad —presentación o metadatos—.
- `mappingSha256`, anclas estructurales, formas de libro admitidas y límites específicos.
- `cells`: hoja/celda física, código de tabla/fila/columna, concepto, tipo y metadatos DPM.
- `excludedContentPolicy`, reglas de contexto y formato de salida saneado.

Es configuración confiable del producto. Nunca se recibe un mapping ejecutable desde
un archivo subido. El JSON de planificación es evidencia para construir y verificar el
registro de perfiles; cambiarlo exige nueva versión o huella, no reutilizar una identidad.

### Valores y coordenadas

`Coordinate.dataType` se amplía de `number | boolean` a `number | boolean | text | date`.
Se mantiene la identidad canónica existente de contexto/tabla/hoja/fila/columna y la
separación entre coordenada válida sin valor y coordenada inexistente.

`ReportedFact.normalizedValue` y las lecturas admiten:

| Tipo | Representación JSON | Unidad/decimales |
|---|---|---|
| number | `{numerator:string, denominator:string}` | Políticas exactas existentes. |
| boolean | `true` o `false` | Convención existente de v1. |
| text | `{kind:"text", value:string}` | `unit:""`, `decimals:""`. |
| date | `{kind:"date", value:"YYYY-MM-DD"}` | `unit:""`, `decimals:""`. |

`presence:"null"` no tiene valor normalizado. El tipo del nulo se conoce por la
coordenada. `presence:"value"` con texto vacío es un valor y se distingue de ausencia.
Las fechas del perfil nuevo son civiles válidas de 0001 a 9999. No se modifica de forma
implícita el validador de fechas administrativas de v1.

El AST añade literales tipados y condicional. `RuleAnalysis` puede conservar features
estáticas internas; la resolución de tipos de referencias se completa por instancia.
No se envían AST al cliente. `RuleResult.values` amplía su unión discriminada, manteniendo
los operandos efectivos separados de las lecturas originales y los metadatos.

### ImportContextDeclaration

Contexto proporcionado por el formulario o leído de la hoja Contexto reconocida:
`contextId`, `entityId`, `referenceDate`, `submissionDate?`, `framework`, `moduleVersion`,
`filingIndicators`, `currency?`, `scaleExponent?`, `displayDecimals?`.

- Se valida contra el perfil; COREP fija framework/módulo y permite escala 0, 3 o 6.
- La precisión del importe escrito `p` se transforma en precisión base `p-s`, o INF.
- El valor base es el decimal crudo multiplicado exactamente por `10^s`.
- No se toman moneda o precisión del estilo Excel. No se convierten monedas.
- Fuente del contexto: `contextOrigin:"form" | "workbook"` más localizadores solo cuando
  existen celdas reales. Una captura manual nunca inventa una celda de origen.
- Versiona contenido y contexto como cualquier carga; no modifica un snapshot vigente.

### ReportSourceBinding

Se añade `reportSourceBindings` a `SnapshotContent` para los formatos nuevos:

`sourceFileId`, `contextIds`, `profileId`, `mappingSha256`, `selectedSheets`,
`excludedSheets`, `scaleExponent?`, `displayDecimals?`, `contextOrigin`.

Relaciona explícitamente archivo, contexto y presentación. Es necesario porque la
exportación actual particiona mediante `filingIndicatorsLocator.fileId`, que no existe
para un contexto declarado en pantalla. El exportador nuevo usa bindings, no localizadores
ficticios. V1 conserva su partición anterior; sus snapshots no requieren bindings nuevos.
Los bindings se conservan por copia lógica en configuración/aplicación y cambian al reimportar.

`SourceFile.sha256` siempre corresponde al archivo realmente importado; no al original EBA
vacío. El hash del original normativo pertenece al perfil. `originalText` conserva el lexema
importado, mientras `normalizedValue` expresa unidades base. La UI evita mezclarlos al comparar.

### ImportInspection

Recurso local con:

- `id`, `workspaceId`, `baseVersionId?`, `createdAt`, `expiresAt`, `state`, `inspectionHash`.
- Resumen de archivos, perfiles, contexto, hojas incluidas/excluidas, conteos y diagnósticos.
- Referencia privada a candidato inmutable y lease de archivos; nunca rutas en la API.
- `commitJobId?`, `committedVersionId?` para consulta del resultado.

Solo una inspección viva por workspace. TTL fijo de 15 minutos desde su publicación ready,
sin renovación por GET. Candidato, bindings, resumen y tombstones se cuentan en 512 MiB
de estado; archivos y reservas, en los 512 MiB de archivos propios. La inspección no
consume un slot de snapshot ni altera el ETag actual.

El hash de inspección vincula base, bytes de entradas, declaración canónica, perfiles,
huella de mapping, alcance y hash de candidato. No incluye una ruta del filesystem.
El usuario no suministra ni puede sustituir su candidato al confirmar.

### Política de recálculo y presentación

La proyección de cada resultado de v2 incorpora:

`recalculation.policy = {mode, profileId, reasons}`

- `mode:"validation_only"`: motivos `CONDITIONAL`, `TEXT`, `DATE`; ambos lados no elegibles,
  diagnóstico `RULE_VALIDATION_ONLY`, sin destino sugerido.
- `mode:"standard"`: aplican las comprobaciones numéricas por lado; no significa que ambos
  sean elegibles ni que exista una propuesta disponible.
- `mode:"undetermined"`: comprobación incompleta o tipos/referencias sin resolver;
  ambos lados no elegibles y diagnóstico. Nunca equivale a permiso.

Los campos existentes `left/right` permanecen. La misma política se obtiene antes de
guardar, simular y aplicar; no se deduce de un resultado `pass` o `fail`.
La clave de memoización incluye snapshot, perfil e instancia. La clasificación inspecciona
ambas ramas y la precondición formal, sin evaluar valores ni realizar lecturas ficticias.

Proyección opcional `presentation:{description?,conceptLabel?}`: datos de catálogo/mapping
para lectura, no autoridad de cálculo. La descripción procede de registros fuente de la
variante; si hay varias distintas se muestran en detalle y se usa un resumen estable,
sin modificar la identidad semántica de la regla. Todo se renderiza como texto.

`ProposalDTO.calculation?` conserva la explicación capturada al simular:
`{expression, precondition?, sourceValue?, preconditionValue?, reads}`; cada lectura
es `{fact: FactReadDTO, fromProposalId?:string}`. Son entradas del estado simulado
efectivamente utilizado antes del parche, incluidos valores de antecesores. No se
reconstruyen leyendo el snapshot original ni se inventa una derivación aplicada para
un cambio aún propuesto. `fromProposalId` identifica al productor simulado cuando lo
hay. Expresión y valores son datos, nunca AST. Esta explicación se contabiliza junto
al bundle; se entrega en el detalle de propuesta y se omite en la lista paginada.
La ausencia en una propuesta anterior no autoriza a inventar lecturas.

### DemoCase

Cada caso contiene identidad, origen oficial/sintético, expresión y precondición completas,
fuentes, contexto, entradas, resultado inicial/posterior, familia, elegibilidad y selección
prevista. La matriz se almacena en [demo-corpus.json](contracts/demo-corpus.json).
Sus expectativas son el oráculo propuesto, no la respuesta observada del motor nuevo.

## Estados, publicación y liberación

| Operación/estado | Transición e invariante |
|---|---|
| Inspección en curso | Job `inspect-import`; staging y parsing sin publicación de snapshot. |
| Inspección válida | Publica candidato privado y recurso `ready`; libera slot de Job, retiene lease. |
| Inspección fallida/cancelada | Job terminal y cleanup; no deja recurso ready ni cambia datos vigentes. |
| Confirmar ready | Valida hash, aceptación de alcance, ETag y TTL; pasa a `committing` al aceptar Job `import`. |
| Confirmación correcta | Crea un único snapshot y pasa a `committed` atómicamente; libera candidato/lease al transferir publicación. |
| Commit fallido/cancelado | No publica snapshot; vuelve a ready si base, archivos y TTL siguen válidos, o libera y marca invalidated/expired. |
| Otra mutación cambia la base | Inspección ready pasa a `invalidated`; libera candidato/lease, conserva diagnóstico mínimo. |
| Caducidad o descarte | `ready → expired | discarded`; libera recursos. GET no renueva el plazo. |
| Cierre de workspace | Cancela trabajos/preparaciones, espera la liberación y borra recursos propios, incluidos los de inspección. |

Si el commit se aceptó antes del vencimiento, la lease queda protegida por el plazo del
Job; el TTL no cancela a mitad. Una petición de descarte durante committing devuelve
conflicto; la cancelación usa el Job. Un replay idéntico consulta idempotencia antes de
ETag, TTL o existencia del recurso y devuelve la misma operación, sin segunda aplicación.

El propietario mutable sigue siendo el hilo principal. La transferencia del candidato,
registro de Job e inspección usan una transacción de publicación con comprobación final
de base, cierre, cancelación, plazo y cuotas. No se introduce otro estado mutable fuera
del contabilizador incremental existente.

## Reglas de integridad y hashing

1. No mezclar formatos/perfiles distintos dentro de una nueva inspección; se informa
   del conflicto y no se elige el primero. Los dos conjuntos demo se cargan por separado.
2. Conservar la regla existente de una entidad/fecha por conjunto. Coordenadas repetidas
   o contexto inconsistente entre archivos siguen siendo errores, nunca suma implícita.
3. Snapshot, runs, previews, recibos y direcciones quedan vinculados a su perfil. V2 no
   reutiliza una elegibilidad o caché calculada con v1.
4. Nuevo formato serializado de texto/fecha, bindings y declaraciones entra en los hashes
   canónicos del contenido nuevo. La identidad de una celda no incorpora su etiqueta visual.
5. Reglas solo de validación no producen nodos ni propuestas, tampoco bloqueadas. Una
   configuración antigua/interna que las contenga se rechaza completa antes del grafo.
6. Cambios numéricos mantienen originales y derivación. Se revalida todo el catálogo,
   incluidas reglas solo de validación que lean celdas modificadas.
7. La exportación usa perfil/binding de la versión elegida y plantillas confiables; nunca
   la versión vigente por defecto ni el archivo original como paquete copiable.

## Impacto y migración

No hay migración persistente: el estado sigue siendo efímero y local. Contratos compartidos,
schemas JSON, proyecciones HTTP, worker protocol, import/export, contabilidad de recursos
y presentación se amplían coordinadamente. Las rutas/formato/perfil v1 permanecen válidos.
Los cambios no autorizan cerrar el conjunto activo del usuario durante desarrollo o pruebas;
las comprobaciones usarán procesos y datos aislados.
