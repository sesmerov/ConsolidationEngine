# Contrato de perfil visual FINREP F 01.01

Estado: diseño de 004, pendiente de implementación. [Especificación](../spec.md), FR-016–023; [decisiones de investigación](../research.md), D7–D8. Este contrato no acredita soporte ya ejecutado.

## 1. Identidad y fuente

| Propiedad | Valor fijado |
| --- | --- |
| Perfil del producto | `eba-finrep-4.0-f0101-v1` |
| Perfil semántico del motor | `ce-dpmxl-0.9-closed-v2`, sin ampliación de operadores |
| Framework | `FINREP` |
| moduleVersion local | `FINREP_F0101_4.0` |
| Nombre visible | FINREP · F 01.01 · plantilla 4.0 |
| Tabla / columna / hoja regulatoria | `F_01.01` / `0010` / `sheetCode=""` |
| Hoja Excel | `1.1`, «1.1 Assets» |
| Fuente de presentación | `tests/fixtures/eba/official-annexes-4.0.xlsx` |
| SHA-256 original | `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` |
| Procedencia registrada | `C_2024_8389_1_ANNEX_EN_V3_P1_3682615.XLSX`, paquete ITS de EBA fijado en el proyecto |
| Filing indicator admitido | exactamente `{"F_01.01": boolean}` |

`FINREP_F0101_4.0` identifica la edición de presentación soportada por el producto. No es un identificador oficial de módulo XBRL ni una afirmación de conformidad integral. La demo y su catálogo propio usan ese mismo alias. No se reutiliza `COREP_OF_4.0` ni `FINREP_SYNTHETIC`.

El [manifiesto de fuentes](../../../tests/fixtures/eba/source-manifest.json) conserva la procedencia original. El paquete anotado COREP del repositorio no aporta metadatos FINREP. No se inventan datapoint IDs para este mapping: la autoridad de las 38 coordenadas es la cuadrícula del anexo, el tipo monetario declarado por este perfil y los códigos de fila/columna leídos en ella.

## 2. Mapping y reconocimiento

Cada entrada del nuevo `finrep-f0101-mapping.json` contiene tabla, columna, fila regulatoria, hoja Excel, celda del código, concepto y celda del importe. Se conserva la etiqueta exacta de la fuente, incluidos espacios significativos, como anclaje; la identidad usa códigos, no etiquetas.

| Fila regulatoria | Código | Concepto | Importe |
| --- | --- | --- | --- |
| 0010 | B8 | C8 | F8 |
| 0020 | B9 | C9 | F9 |
| 0030 | B10 | C10 | F10 |
| 0040 | B11 | C11 | F11 |
| 0050 | B12 | C12 | F12 |
| 0060 | B13 | C13 | F13 |
| 0070 | B14 | C14 | F14 |
| 0080 | B15 | C15 | F15 |
| 0090 | B16 | C16 | F16 |
| 0096 | B17 | C17 | F17 |
| 0097 | B18 | C18 | F18 |
| 0098 | B19 | C19 | F19 |
| 0099 | B20 | C20 | F20 |
| 0100 | B21 | C21 | F21 |
| 0120 | B22 | C22 | F22 |
| 0130 | B23 | C23 | F23 |
| 0141 | B24 | C24 | F24 |
| 0142 | B25 | C25 | F25 |
| 0143 | B26 | C26 | F26 |
| 0144 | B27 | C27 | F27 |
| 0181 | B28 | C28 | F28 |
| 0182 | B29 | C29 | F29 |
| 0183 | B30 | C30 | F30 |
| 0240 | B31 | C31 | F31 |
| 0250 | B32 | C32 | F32 |
| 0260 | B33 | C33 | F33 |
| 0270 | B34 | C34 | F34 |
| 0280 | B35 | C35 | F35 |
| 0290 | B36 | C36 | F36 |
| 0300 | B37 | C37 | F37 |
| 0310 | B38 | C38 | F38 |
| 0320 | B39 | C39 | F39 |
| 0330 | B40 | C40 | F40 |
| 0340 | B41 | C41 | F41 |
| 0350 | B42 | C42 | F42 |
| 0360 | B43 | C43 | F43 |
| 0370 | B44 | C44 | F44 |
| 0380 | B45 | C45 | F45 |

El manifiesto también fija los 144 anclajes no vacíos fuera de F8:F45, merges esperados (ninguno), hash de la firma estructural y hash del mapping generado. Se genera de forma reproducible desde la fuente contrastada y se versiona con bytes UTF-8/LF. El hash se mide después de generar el archivo; no se inventa durante planificación.

El inspector resuelve la hoja mediante las relaciones verificadas del paquete. `sheet69.xml` es la localización en el original de referencia, no un requisito para los archivos del usuario. Reconocer requiere:

- Hoja `1.1`, códigos y anclajes exactos; cero fórmulas en esa hoja.
- Celdas de importe solo en las 38 posiciones; cualquier contenido no vacío inesperado en la hoja seleccionada produce un diagnóstico.
- Rechazo de duplicados de filas/celdas/hojas, merges alterados, celdas desplazadas y datos incompatibles. Un nombre de hoja por sí solo no acredita el perfil.
- Aplicación previa del preflight global de XML/ZIP, CRC, relaciones y límites a todas las hojas y partes, incluidas las excluidas.
- Admisión del extracto y de libros con hojas adicionales. Solo `1.1` se normaliza; las demás se enumeran como excluidas, salvo hojas de producto reconocidas `Contexto` e `Instrucciones`.
- `Contexto` reservado: debe cumplir su contrato si existe. No se reemplaza una hoja ajena con ese nombre.

La búsqueda de candidatos no convierte el orden de registro en una prioridad. Un libro oficial completo puede reconocer COREP CA1 y FINREP; requiere la elección descrita en la sección 4.

## 3. Contexto, importes e identidad

Se reutiliza la política decimal del adaptador monetario vigente, aislando los campos específicos FINREP:

- `currency`: tres letras mayúsculas; demo `EUR`.
- `scaleExponent=s`: 0, 3 o 6 (unidades, miles, millones).
- `displayDecimals=p`: entero entre −18 y 18, o `INF`.
- Si p no es INF, p−s también debe estar entre −18 y 18.
- Importe normalizado = literal decimal × 10^s. `Coordinate.decimals` = cadena de p−s o `INF`; `unit` = divisa; `dataType="number"`; `axes={}`.
- No se infiere precisión ni escala del estilo Excel. Un estilo de fecha/hora/porcentaje o un tipo no monetario produce error.
- Se admiten los literales decimales ya admitidos por el motor, incluidos números XML exponenciales acotados y texto decimal exacto. No se ejecutan fórmulas Excel.
- Vacío: existe coordenada, no existe hecho. Cero: existe hecho con valor cero. El perfil no transforma texto inválido ni ausencia en cero.
- Entidad obligatoria, fecha de referencia civil válida, envío opcional civil válido. Los demás límites del formulario vigente permanecen.
- La hoja `Contexto` contiene A1=Campo, B1=Valor y, en filas 2–11, Perfil, Framework, Módulo, Entidad, Fecha de referencia, Fecha de envío, Divisa, Escala, Decimales del importe, Tabla presentada. Las tres primeras constantes corresponden a la sección 1; Tabla presentada es true/false para F_01.01.
- Una plantilla de producto en blanco puede tener constantes y campos de negocio vacíos; entonces se requiere formulario. Un contexto parcial se diagnostica.
- Cuando libro y formulario declaran contexto completo, deben coincidir; no se elige silenciosamente uno de los dos.

Para evitar colisiones entre archivos FINREP, el `contextId` normalizado es `finrep_` seguido del UUID de `SourceFile.id` sin guiones. Es un identificador interno derivado en el servidor y no figura en la hoja Contexto. `canonicalContextKey` se deriva de entidad, fecha, framework y alias de módulo, como actualmente. La identidad de hecho añade tabla, sheetCode, fila y columna.

El binding incluye sourceFileId, contextIds, perfil, mappingSha256, selectedSheets=[1.1], excludedSheets, escala, precisión y origen del contexto. Un archivo tiene un contexto y 38 coordenadas. Se mantiene la prohibición de coordenadas de negocio duplicadas entre archivos; distintos archivos/entidades o periodos no se confunden. La reimportación crea nuevos IDs internos y conserva el contexto de negocio.

Las cargas mixtas de perfiles continúan fuera del alcance de 004; una carga contiene informes del mismo perfil. Se mantiene el máximo existente de veinte informes, sin inventar un contexto común cuando difieren los declarados en cada libro.

## 4. Inspección: candidatos, elección y reintento

Se conserva `POST /api/v1/workspaces/:workspaceId/import-inspections`, multipart con un catálogo, reports y un único campo JSON `context` de máximo 16 KiB.

Se amplían ambas ramas actuales `source:"workbook"` y `source:"form", declaration:...` con:

```text
reportProfiles?: [
  { reportIndex: integer 0..19, sha256: 64 hex minúsculas, profileId: perfil visual admitido }
]
```

El índice corresponde exclusivamente al orden de los archivos del campo reports; se prohíben índices repetidos o inexistentes. El hash debe coincidir con los bytes recibidos. La elección es opcional, se incluye en la huella de idempotencia y solo puede designar un candidato reconocido por el servidor. No se admiten mappings ni paths del cliente.

Flujo:

1. Examinar el paquete y obtener candidatos estructurales válidos.
2. Si hay elección explícita, comprobar índice/hash y pertenencia a candidatos.
3. Sin elección, un contexto de producto completo y válido puede resolver el candidato; si contradice la elección explícita, devolver CONTEXT_MISMATCH.
4. Sin elección ni contexto decisivo, usar el único candidato; con varios, detener la inspección y devolver diagnóstico REPORT_PROFILE_REQUIRED.
5. Con perfil resuelto, normalizar y preparar la inspección ordinaria. Hojas excluidas requieren `acceptedExcludedSheets:true` en el commit existente.
6. Una carga con perfiles distintos no publica una combinación parcial; devuelve el diagnóstico de incompatibilidad de perfiles del lote.

Para REPORT_PROFILE_REQUIRED se añade a `Diagnostic` un campo opcional acotado:

```text
profileChoice: {
  reportIndex, sha256,
  candidates: [{ profileId, label, tableCode }] // máximo 3; solo datos del registro
}
```

Se amplían el esquema de diagnóstico y la traducción controlada de errores de worker para conservar solo ese dato permitido. El mensaje visible explica que el libro contiene varias tablas compatibles. No se transmite un volcado de detalles internos.

La inspección asíncrona puede terminar failed con ese diagnóstico; conserva cero versiones nuevas y limpia sus fuentes temporales. La UI mantiene los archivos locales y ofrece las opciones por archivo. Reintenta enviando los mismos archivos con reportProfiles y una nueva Idempotency-Key. Un reintento idéntico de la misma petición mantiene la clave existente. Si cambian los archivos, se borran las elecciones anteriores.

Una elección que ya no es candidata produce PROFILE_NOT_RECOGNIZED; índice/hash obsoletos producen INVALID_REQUEST. Las respuestas de otra carga o conjunto no alteran las opciones actuales. No se añade una nueva operación de commit ni se publican datos para descubrir candidatos.

El formulario presenta F 01.01, divisa, escala y precisión cuando corresponde. Los identificadores de perfil se mantienen en el contrato y no se muestran como ayuda técnica.

## 5. Exportación conservando el original

La nueva ruta interna `writeFinrepReport` parte del archivo realmente importado. La ruta COREP mantiene su comportamiento actual y sus regresiones.

1. El servidor resuelve cada sourceFileId usando SessionFiles dentro del workspace. Se añaden al input interno del worker fuentes con path, ID, tamaño y SHA-256 verificados contra SourceFile. Ningún endpoint acepta esos paths.
2. El worker vuelve a medir hash/tamaño y pasa preflight/reconocimiento antes de producir el artefacto. Revalida binding, perfil, mapping, contexto derivado del sourceFileId, selected/excludedSheets, 38 identidades y propiedad de cada locator.
3. Un original ausente, cambiado, de otro informe/workspace o con binding incompatible produce EXPORT_NOT_AVAILABLE; no se reconstruye silenciosamente otra plantilla.
4. Se leen las partes originales con yauzl y se copian conservando sus bytes descomprimidos. Solo se modifican importes de F8:F45 cuyo estado/valor en el snapshot elegido difiera del original y los metadatos de producto autorizados.
5. Se añade o actualiza Contexto con la declaración completa. Sus etiquetas y valores se emiten como celdas propias inlineStr, incluidos escala, precisión y booleano de tabla como los literales de texto que exige su lector; los importes modificados de F 01.01 usan celdas numéricas o inlineStr según serializeWorkbookAmount. No se añaden ni reindexan shared strings. Si se añade la hoja, se asignan nombre de parte, sheetId y relationshipId libres, y se actualizan workbook.xml, sus relaciones y Content_Types. Los IDs existentes no se renumeran.
6. Si es necesario serializar un decimal exacto como texto para evitar pérdida de cifras, se reutiliza serializeWorkbookAmount y se permite añadir un estilo derivado de alineación derecha, preservando los demás atributos. No se redondea de nuevo.
7. La fuente oficial no se modifica. El resultado se escribe a una nueva ubicación de sesión, se cierra y se somete a la comprobación integral de salida definida debajo. Solo después se incorpora al manifiesto de descarga y se publica.

Partes autorizadas para cambiar:

- XML de la hoja seleccionada: únicamente las celdas de importe autorizadas que difieran del original.
- XML de Contexto: únicamente el contenido conforme al contrato de esa hoja; añadir la parte si no existía.
- workbook.xml, sus relaciones y [Content_Types].xml: las entradas mínimas para registrar Contexto cuando se añade. Los elementos preexistentes conservan orden e identificadores.
- docProps/app.xml, si existe y mantiene un catálogo de hojas: solo actualizar su lista de títulos y el recuento correspondiente para incluir Contexto. Si no existe ese catálogo, no se crea por este motivo; los demás metadatos no se alteran.
- styles.xml: solo añadir el estilo derivado de alineación necesario para un importe exacto escrito como texto. Nunca reindexar, eliminar o cambiar estilos preexistentes ni referencias de otras hojas.

sharedStrings.xml no cambia. Las hojas excluidas y las demás partes permanecen iguales en contenido descomprimido. No se reescriben todas las celdas ni se reconstruyen hojas excluidas.

Si el libro ya ocupa el máximo permitido de hojas y carece de Contexto, la inspección detecta que no puede reservar la hoja necesaria para el retorno y lo diagnostica antes de confirmar. Se comprueba también que los nombres de partes son compatibles con el escritor acotado; no se eliminan partes para hacer caber el resultado.

### Comprobación integral antes de publicar

El archivo temporal terminado pasa una nueva lectura completa, dentro del mismo trabajo y de su plazo de 60 s:

1. Medir tamaño y SHA-256 de los bytes finales; comprobar límites por archivo y por lote con el catálogo original, límites expandidos, entradas y recursos de sesión. La compresión no permite eludir las cuotas XML o de expansión.
2. Ejecutar el preflight global sobre la salida cerrada, verificando CRC, tamaños declarados, partes, XML, relaciones y política de contenido para todo el paquete. No basta con comprobar que el ZIP se puede abrir.
3. Reconocer de nuevo el perfil FINREP esperado usando el mapping de confianza y su hash; comprobar que el contexto añadido resuelve ese perfil aunque el libro también contenga CA1.
4. Normalizar la salida a un candidato de lectura, sin publicar un conjunto ni ejecutar sus fórmulas. Comparar las 38 identidades de negocio, tipos, divisa, precisión, presencia/ausencia y valores racionales exactos con la partición del snapshot solicitado. Comparar entidad, fechas, framework, alias de módulo, filing indicator, escala y precisión; los IDs derivados de la nueva fuente se excluyen de esa comparación.
5. Contrastar el inventario de partes y hojas con el original y la lista de modificaciones permitidas. Para cada parte no autorizada a cambiar, comparar longitud y SHA-256 de contenido descomprimido mediante lectura acotada. En las partes modificadas comprobar que las diferencias se limitan al parche autorizado; no aprobar la desaparición de una hoja excluida o un cambio ajeno al cálculo.
6. Construir changes.json y el manifiesto usando únicamente los hashes y tamaños de las salidas verificadas, y cerrar el report.zip exterior medido. Antes de publicar el registro de artefacto se exige que todos los informes hayan superado la comprobación y que el artefacto final corresponda al hash/tamaño devueltos por el escritor. El archivo cerrado queda gestionado como salida inmutable de la sesión.

Un fallo de integridad, discrepancia con el snapshot, cambio de la fuente, cuota excedida, cancelación o timeout impide publicar la descarga y libera las salidas temporales mediante el cleanup de la operación. No se publica un informe parcial ni se intenta corregirlo eliminando partes. Esta lectura de control no altera el archivo ni los informes del workspace. Las pruebas inyectarán una salida truncada, CRC incorrecto, celda equivocada y hoja excluida alterada para demostrar que no aparece un artefacto descargable.

### ZIP, recursos y contenido inerte

Se reutiliza [bounded-files.ts](../../../apps/api/src/export/bounded-files.ts), que ya comprime las partes XLSX con `node:zlib.createDeflateRaw({level:6})`, mide CRC/tamaños y aplica backpressure. Se amplía `WorkbookPart.chunks` a Iterable o AsyncIterable para leer partes originales mediante streams de yauzl. El consumidor medido usa iteración asíncrona, con cancelación y cierre de streams/ZIP en finally. No se incorpora otra librería ZIP ni se materializa el libro completo en memoria.

Los chunks y buffers siguen acotados; solo se materializan metadatos y la pequeña hoja seleccionada/contexto que se parchea. Se reutilizan límites actuales de 10 MiB por informe, 50 MiB por lote comprimido, 100 MiB expandidos, 64 MiB por parte/carga de vista cuando corresponda, 60 s por trabajo y cuotas de sesión. El report.zip exterior sigue usando STORED sobre los XLSX ya comprimidos. El SHA-256 y tamaños publicados corresponden a la salida final medida.

El preflight aplica al libro entero las prohibiciones vigentes de macros, conexiones, queries, OLE/DDE estructural, rutas o relaciones peligrosas, CRC/XML inválidos, duplicados y expansión excesiva. Las excepciones de contenido visual existente solo se admiten después de reconocer el perfil confiable; una hoja excluida no exonera al resto del paquete.

Fórmulas/cachés y relaciones inertes en hojas excluidas que la política vigente permita se conservan como bytes opacos. El motor no ejecuta fórmulas ni resuelve/enlaza recursos externos. Fórmulas en la hoja seleccionada o el contexto se rechazan. Este contrato no amplía el conjunto de contenido externo permitido por el preflight.

## 6. Demostración y expresiones

Se preparan `demo-finrep-report.xlsx` y `demo-finrep-catalog.xlsx`, con copias en fixtures de prueba, generación reproducible, hashes en el manifiesto de demo y la descarga accesible desde Cargar. La plantilla deriva del anexo original conservando la cuadrícula; las reglas e importes se identifican como propios/sintéticos.

Contexto: entidad SYNTHETIC, referencia 2025-12-31, EUR, escala 0, precisión 2, tabla presentada true. Framework FINREP y Modules FINREP_F0101_4.0 en las cinco filas de catálogo; estado Active y sin precondición. Se usan cabeceras de catálogo ya soportadas. Los límites de vigencia incluyen la fecha de demo.

Valores: r0010=90, r0020=40, r0030=35, r0040=25, r0050=20, r0380=105; resto de las 38 posiciones=0.

Prefijo común de las cinco expresiones:

```text
with {tF_01.01,c0010,interval:false}:
```

| VR Code | Expresión tras el prefijo | Inicial | Tras aplicar | Escritura |
| --- | --- | --- | --- | --- |
| FIN_TOTAL_CASH | {r0010}={r0020}+{r0030}+{r0040} | Falla | Pasa | r0010 90 → 100 |
| FIN_TOTAL_ASSETS_DEMO | {r0380}={r0010}+{r0050} | Falla | Pasa | r0380 105 → 120 |
| FIN_GREATER_PASS | {r0020}>{r0030} | Pasa | Pasa | Ninguna |
| FIN_GREATER_FAIL | {r0040}>{r0020} | Falla | Falla | Ninguna |
| FIN_CONDITIONAL | if {r0020}>0 then {r0030}>=0 else {r0040}=0 endif | Pasa | Pasa | Ninguna |

Las construcciones siguen los ejemplos condicionales ya admitidos por el perfil cerrado. Durante la planificación se analizaron las cinco expresiones con el parser compilado disponible y se obtuvieron cero diagnósticos. La generación y las pruebas de implementación deben repetir la comprobación en el build de la entrega y verificar los resultados de negocio; la comprobación sintáctica no acredita carga visual ni ejecución integral.

La primera igualdad tiene destino izquierdo único. La segunda depende de la primera y también tiene destino izquierdo único. No hay conflictos entre productores. La configuración guardada contiene dos destinos; la simulación produce dos propuestas disponibles, preseleccionadas por el nuevo contrato de selección. Kahn debe usar 100 para producir 120, no el 90 original. Antes: 2 pasa/3 falla; después: 4 pasa/1 falla. El condicional y las dos desigualdades nunca generan propuestas.

## 7. Pruebas y aceptación

| Grupo | Comprobaciones mínimas |
| --- | --- |
| Fuente/mapping | Hash original inalterado; generación determinista; 38 posiciones y códigos exactos; 144 anchors; merges; relocalización de la parte por relaciones. |
| Lectura numérica | Ausencia/cero; escalas 0/3/6; precisión INF y extremos válidos/invalidos; decimal largo/exponencial acotado; fechas/porcentajes/error Excel rechazados; ninguna inferencia desde formato. |
| Contexto | Formulario; libro; coincidencia/conflicto; tabla false; hoja reservada incompatible; diferentes entidades/periodos sin colisión; coordenadas de negocio duplicadas rechazadas. |
| Candidatos | Extracto único; libro completo COREP+FINREP; elección explícita; contexto decisivo; perfil no reconocido; hash/índice cambiado; idempotencia y respuesta obsoleta. |
| Seguridad/recursos | Fórmula seleccionada; macros/conexiones/relaciones prohibidas también en excluidas; CRC/ZIP/XML inválido; entradas y expansión excesivas; cancelación; fuente cambiada o binding de otro informe. |
| Recálculo | Cinco resultados iniciales/finales de la tabla; dos destinos; dependencia y orden estable; cambios solo tras aceptación; desigualdades/condicional solo validación. |
| Conservación | Sentinelas en hojas excluidas; igualdad de bytes descomprimidos de partes no autorizadas a cambiar; estilos/cuadrícula; archivo original sin cambios; versión histórica y aplicaciones sucesivas. |
| Retorno | Descargar, crear otro conjunto y reimportar: 38 coordenadas, valores finales y contexto de negocio idénticos; nuevos IDs internos permitidos; cinco resultados finales idénticos. |
| Regresión | COREP mantiene cinco cambios y sus resultados; demo tipada conserva cero propuestas; catálogos/formatos anteriores mantienen sus rutas de compatibilidad. |

En implementación, los fixtures y tests se incorporan a las suites de contrato, integración, frontend y E2E existentes. Las nuevas pruebas reproducibles cubrirán US5/SC-007–008 y regresiones SC-009. Una captura de Excel, el parseo de cuatro celdas o el ensayo histórico en ce-report-1 no constituyen aceptación del recorrido definido aquí.
