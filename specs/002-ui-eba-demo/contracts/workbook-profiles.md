# Contrato de libros y correspondencias visuales

Fecha: 2026-11-04. Diseño pendiente de implementación. Requisitos FR-013–022, FR-030–035.
La inspección, confirmación, idempotencia, cuotas y estados se rigen por
[http-api.md](http-api.md); este contrato define los datos y las formas de libro admitidas.

## 1. Perfiles y compatibilidad

| Perfil de libro | Motor | Uso |
|---|---|---|
| `ce-report-1` | `ce-dpmxl-0.9-closed-v1` | Compatibilidad del formato anterior, sin cambiar su interpretación. |
| `eba-corep-of-4.0-ca1-v1` | `ce-dpmxl-0.9-closed-v2` | COREP 4.0 C_01.00 visual, solo hoja CA1. |
| `ce-demo-types-1` | `ce-dpmxl-0.9-closed-v2` | Ejemplo propio de textos y fechas; exclusivamente validación. |

El servidor selecciona el motor por el perfil de libro validado. No acepta coordenadas,
tipos, AST ni identificadores de perfil semántico suministrados para eludir sus controles.
No se mezcla el perfil anterior con perfiles visuales en un lote. Una tabla y contexto
de negocio no pueden repetirse en archivos diferentes aunque cambie su alias.

Los perfiles generan alias internos estables: `corep` y `demo_types`; no se derivan
del UUID aleatorio del archivo ni se solicitan al usuario. El alias lógico `demo` del
oráculo COREP se asocia al contexto importado por sus campos de negocio, conservando
sus expectativas y sin incorporar ese alias a la identidad canónica de una celda.

## 2. Fuente y manifiesto COREP

Fuente de presentación: [ITS on supervisory reporting](https://www.eba.europa.eu/sites/default/files/2025-02/1b4c4008-4224-450f-aa7b-c6fe5284872a/ITS%20on%20supervisory%20reporting.zip),
entrada `C_2024_8389_1_ANNEX_EN_V3_P1_3682615.XLSX`.
Fuente de correspondencia: [Annotated Templates](https://www.eba.europa.eu/sites/default/files/2024-12/7ae0363a-ad3d-42d9-a192-34711416c039/annotated_templates.zip),
entrada `20241217 Annotated Table Layout  COREP_OFCOREP 4.0.xlsx`.

| Fuente | SHA-256 del XLSX original |
|---|---|
| ITS | `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` |
| Anotada COREP_OF | `610d72d283dd74a6d572c49e1959fba43a662548df4e5399dca2f4b3523c7e5f` |

[corep-ca1-mapping.json](corep-ca1-mapping.json) contiene las **110 correspondencias**,
335 anclas no vacías, los nombres de las 191 hojas originales y las huellas de fuente.
Cada fila identifica código, concepto ITS, celda de importe, identificador DPM y evidencia
anotada. Las 110 filas tienen marcador monetario `€£$`, 110 códigos y 110 IDs DPM únicos.
La columna regulatoria `0010` procede de D6 de la hoja anotada, no de una inferencia sobre E.
Las etiquetas difieren en 17 posiciones entre libros: la unión se hizo por código de fila.
Se conserva como etiqueta de presentación la del ITS.

El manifiesto es evidencia de diseño y entrada versionada del adaptador futuro. No es
una declaración de que el adaptador esté implementado ni de conformidad completa EBA.
`mappingSha256` identifica los bytes del manifiesto congelado incorporado a la versión
del producto; se obtiene al empaquetarlo, no se guarda autorreferencialmente dentro de él.

## 3. Reconocimiento del diseño

Formas admitidas, con nombres exactos y únicos:

- Libro completo: conjunto de 191 nombres de hoja del manifiesto, con `Contexto` e
  `Instrucciones` propios opcionales. La posición de las hojas en el libro no es significativa.
- Extracto: `CA1`, con `Contexto` e `Instrucciones` propios opcionales, sin otras hojas.
- Cualquier otra combinación se diagnostica como estructura no admitida.

En CA1 son invariantes B2, B4:E4, B5:D114 y la combinación B2:E2. Deben coincidir las
335 parejas dirección/contenido del manifiesto. Los importes permitidos son E5:E114.
No se admiten valores adicionales en otras celdas de CA1, cambios de fila, etiquetas,
códigos, IDs o combinaciones; las celdas vacías de estilo no alteran el reconocimiento.
Se permiten cambios cosméticos de fuente, color, ancho e impresión que no cambien esos
contenidos ni conviertan importes en tipos incompatibles. No se admiten fórmulas en CA1.

Algoritmo de la firma estructural: resolver shared strings/inline strings y texto rico
sin incluir anotaciones fonéticas; decodificar ST_Xstring **una vez** con el codec del
producto; conservar espacios, mayúsculas, Unicode y saltos de línea resultantes del
parser XML; descartar solo las 110 celdas de importe y celdas realmente vacías; ordenar
por dirección ordinal; serializar como JSON compacto de pares `[dirección,texto]`, UTF-8
sin BOM, sin escape de Unicode no ASCII; SHA-256 de esos bytes. Sin normalización Unicode
ni recortes. También se comparan combinaciones y ausencia de fórmulas por separado.

Firma de las anclas de la fuente inspeccionada:
`44268bbb2cf0a044b60130acbfbb9aab8de2ec89737e6f6078fea5023a0bbc17`.
La implementación verificará esta firma y las anclas explícitas; no confiará solo en un
nombre de archivo. El hash completo del XLSX no identifica un informe rellenado.

Un extracto sin metadatos de edición solo acredita compatibilidad del diseño: el usuario
confirma que desea interpretarlo con COREP_OF_4.0. No se afirma haber demostrado la edición
de origen por apariencia. Framework 4.0 es una base reproducible, no «la última versión».

## 4. Preflight acotado y contenido excluido

Se aplica un preflight de perfil distinto al antiguo; catálogo y `ce-report-1` mantienen
sus límites y rechazos. El paquete se escanea íntegro, contando tamaños reales y CRC,
incluidas partes excluidas. Solo CA1 y los metadatos propios producen datos del conjunto.

| Límite | Perfil COREP visual |
|---|---:|
| Archivos | 1 catálogo y 1–20 informes; identidad de tabla/contexto única |
| Comprimido por archivo / lote | 10 MiB / 50 MiB |
| Expandido acumulado por lote / por entrada | 100 MiB / 64 MiB |
| Entradas ZIP / hojas por libro | 2.048 / 256 |
| Filas / columnas por hoja | 1.024 / 16.384 |
| Celdas físicas por libro / por hoja | 500.000 / 100.000 |
| Shared strings / caracteres por celda | 500.000 / 32.767 |
| Profundidad XML | 64 |
| XML externalLink / relaciones externas de tipos admitidos | 32 / 64 |
| Recepción / trabajo | 120 s / 60 s |

El original tiene 639 entradas, 7.905.907 bytes expandidos, 166.645 celdas físicas y
celdas hasta XFD. CA1 llega a J114. Los duplicados se detectan con un índice disperso
acotado por hoja; **no** con un bitmap de filas por columnas. Las celdas de estilo también
cuentan. Se retienen únicamente las celdas seleccionadas y metadatos acotados, y se
comprueba cancelación durante el escaneo; no se materializan 191 matrices.

El reconocimiento estructural es obligatorio antes de aceptar el candidato con excepciones
del perfil; las protecciones ZIP/XML se aplican desde el primer byte. No hace falta
interpretar fórmulas o destinos externos para reconocer las anclas.

- Fuera de CA1, las fórmulas se leen como XML inerte: ni ejecución ni uso de su caché.
- El original verificado incluye la instrucción de procesamiento vacía
  `<?mso-contentType?>` en `customXml/item2.xml`. Se admite únicamente esa PI sin
  contenido, en esa parte del candidato COREP y condicionada al reconocimiento
  final; no se procesa ni ejecuta. Otras PI, la misma con contenido y cualquier
  DTD siguen rechazadas. Esta excepción no se aplica a v1, catálogos ni hojas propias.
  El original tiene 68 en CA4, 2 en IRRBB.8 y 2 en IRRBB.9.
- Se admiten como metadatos aislados `externalBook` y relaciones `externalLinkPath` y
  `externalLinkLongPath`, e hipervínculos, dentro de las cotas. No se abren destinos ni
  se consumen valores almacenados en esos vínculos. El original tiene 22 XML externalLink;
  sus partes de relaciones se cuentan además, no dentro de ese 22.
- Se rechazan en cualquier parte macros/VBA, DDE, OLE, ActiveX, conexiones, query tables,
  relaciones externas de otros tipos, cifrado, symlinks, rutas ZIP inseguras, entradas
  duplicadas, DTD y XML inválido. Los enlaces y fórmulas admitidos nunca se exportan.
- `Contexto` e `Instrucciones` propios no admiten fórmulas ni relaciones externas.

La inspección enumera las 190 hojas oficiales excluidas cuando se aporta el libro completo.
No declara cuántos hechos contienen porque no interpreta su semántica. La confirmación
de cobertura parcial sigue el contrato HTTP y no equivale a aceptar sus datos.

## 5. Contexto y semántica de los importes

El contexto confirmado incluye entidad, fecha de referencia, fecha de envío opcional,
framework `COREP`, módulo `COREP_OF_4.0`, divisa (tres letras mayúsculas), escala y precisión
escrita. El indicador de presentación de C_01.00 es una decisión explícita; ni el número
de celdas ni la carga del archivo lo convierten automáticamente en verdadero.

Escala `s`: `0` unidades, `3` miles o `6` millones. Precisión escrita `p`: entero de
−18 a 18 o `INF`, declarado por el usuario. Para el importe decimal `v`:

En los DTO, `scaleExponent` es un número entero y `displayDecimals` es un número
entero o la cadena `"INF"`; `Coordinate.decimals` conserva la representación textual
existente. El Excel de Contexto mantiene su representación textual definida más abajo.

- `normalizedValue = v × 10^s`, racional exacto en divisa base.
- `Coordinate.decimals = p − s`, o `INF`; el resultado debe estar en [−18,18] o `INF`.
- La exportación divide por `10^s` exactamente, sin un segundo redondeo.

Ejemplo: 12,34 miles de EUR, `s=3`, `p=2`, representa 12.340 EUR con precisión base −1.
Estilo de Excel y número de decimales visibles no definen la precisión regulatoria.

Se admiten celdas numéricas XML y textos decimales inequívocos, con signo, punto decimal
y exponente permitido por el parser decimal exacto. Se usa el lexema OOXML sin pasar por
`Number`. Se rechazan booleanos, errores, formatos de fecha/hora/porcentaje ambiguos y
cadenas con separadores regionales ambiguos. Se conservan los límites de 128 dígitos
significativos/fraccionarios y 4.096 bits tras normalizar; no se recuperan cifras perdidas
por Excel antes de la carga.

Las 110 coordenadas existen siempre. Celda vacía o con estilo sin valor: hecho ausente,
no cero. Cero: hecho numérico. CA1 no distingue nulo explícito de ausencia; no se inventa
esa distinción. Fórmula no equivale a vacío. Las etiquetas y zonas ajenas no generan hechos.

`originalText` conserva lo escrito; el valor normalizado es independiente. La UI muestra
la escala del origen o el valor en unidad base, nunca presenta «12,34 miles» como «12,34 EUR».
Cada dato y coordenada tiene un SourceLocator real (`CA1`, fila y columna E/B según el
campo localizado); los nombres de concepto se resuelven por el manifiesto.

## 6. Binding de fuente y metadatos propios

`ReportSourceBinding` conserva `sourceFileId`, `contextIds`, `profileId`, `mappingSha256`,
`scaleExponent`, `displayDecimals` y `contextOrigin`. Permite resolver diseño y escala
sin alterar la identidad canónica de los hechos. La propiedad del informe procede de
`sourceFileId`, **no** de un localizador ficticio para los indicadores de presentación.

`contextOrigin` discrimina captura UI de origen en libro. Para captura UI registra los
campos confirmados sin inventar hoja/fila/celda. Para libro conserva los localizadores
reales por campo y la confirmación del usuario. Un dato aportado por UI y uno leído del
libro se muestran con su origen correcto. La representación exacta se define junto al
[modelo de datos](../data-model.md); los metadatos y binding cuentan en la cuota de estado.

Salida propia COREP: hojas `CA1`, `Contexto`, `Instrucciones`. `Contexto` es visible:
columnas A «Campo», B «Valor», cabeceras en fila 1; pares fijos desde fila 2:
Perfil, Framework, Módulo, Entidad, Fecha de referencia, Fecha de envío, Divisa, Escala,
Decimales del importe, Tabla presentada. Valores de metadatos como texto; fecha ISO;
escala `0`/`3`/`6`; indicador `true`/`false`; fecha de envío puede estar vacía.
Estos metadatos rellenan el formulario y se confirman. Discrepancias o duplicados se
diagnostican; no se cambia silenciosamente un dato del libro con un valor por defecto.

## 7. Exportación y reimportación

La salida usa una plantilla saneada versionada del producto, derivada reproduciblemente
del ITS cuyo hash está fijado. Conserva títulos, códigos, etiquetas, combinación B2:E2,
anchos y estilos relevantes de CA1. No copia el OOXML del usuario. La preparación de esa
plantilla comprueba anclas/huellas y elimina otras hojas, vínculos, fórmulas y contenido
ajeno. No requiere una nueva biblioteca XLSX: se reutilizan yauzl/sax y escritor ZIP/XML.

Se escriben los valores de la versión seleccionada y las hojas propias, junto al registro
de cambios separado. El paquete identifica perfil, mappingSha256, contexto, fuentes,
versión y exclusiones. Se rotula como extracto derivado para trabajo local, sin prometer
formato oficial de remisión. Los archivos originales no se sustituyen.

La política conservadora de salida emite como número XML solo cero o importes con hasta
15 dígitos significativos y magnitud entre 10^-128 y 10^128, construidos desde su decimal
exacto; los demás se emiten como texto decimal exacto,
alineado a la derecha, con aviso en Instrucciones. No se convierte a Number para escribir.
Texto con apariencia de fórmula se emite como texto y se aplica el codec OOXML existente.
La elección de almacenamiento no cambia valor, unidad, escala o precisión declarada.

El serializador mantiene esos umbrales dentro del dominio importable del perfil.
El exportador completo rechaza estados internos incompatibles (racionales sin
decimal finito, representaciones que superen las cotas de dígitos/decimales de
entrada, nulos explícitos COREP o hechos tipados obligatorios ausentes), en vez de
crear un libro que pierda información al reimportarse. Los bordes matemáticos del
serializador fuera de ese dominio pueden probarse aisladamente, sin atribuirles
roundtrip de un informe admitido. El corpus normal sí exige reimportación completa.

La reimportación conserva el dato de negocio y su contexto confirmado, pero produce nuevos
localizadores de archivo; no restaura recibos históricos. Los libros del perfil anterior
siguen usando su exportador anterior. Un libro anotado con IDs DPM no se admite como informe.

## 8. Complemento tipado y catálogo

`ce-demo-types-1` usa `Instrucciones`, `Datos` y `Contexto`, sin listas de coordenadas
para el usuario. La hoja Datos tiene campos legibles y estado «Informado/Sin dato»;
texto vacío informado se distingue de un nulo. Su mapping, valores, tipos y ocho reglas
se fijan en [demo-corpus.md](demo-corpus.md) y [demo-corpus.json](demo-corpus.json).
Se aplica el preflight estricto sin excepciones de enlaces/fórmulas del COREP completo.
Todas sus reglas son solo de validación; el libro nunca se atribuye a una plantilla EBA.

Los catálogos mantienen las 15 cabeceras EBA, incluida `Precondtion`, metadatos de origen,
vigencia y severidad, y el límite de 500 filas. Los campos auxiliares de procedencia de
las demos no cambian el análisis de Expression/Precondtion ni activan el cálculo.

## 9. Evidencia requerida al implementar

- Correspondencia independiente de las 110 celdas; libro completo y extracto equivalentes;
  etiquetas/códigos desplazados, duplicados, versión incompatible y fórmulas rechazados.
- Escaneo XFD y celdas vacías de estilo dentro de cotas, sin matriz densa; límites justo
  por debajo/encima; cancelación durante hojas excluidas; ninguna solicitud de red.
- Cero/ausencia, precisión y escalas, notación científica y cifras largas contra racionales
  conocidos; nulos/texto vacío/fechas civiles en el perfil tipado según su contrato.
- Inspección sin publicación, confirmación vinculada a hash/base, caducidad, replay,
  cancelación, cuota y cierre sin snapshots parciales ni archivos huérfanos.
- Exportación/reimportación exacta de datos y contexto, layout reconocible, ausencia de
  vínculos/fórmulas en salida y originales intactos. Automatización y aceptación humana separadas.
