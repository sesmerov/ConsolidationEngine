# Feature Specification: Interfaz clara, plantillas COREP y demo verificable

**Feature Branch**: `codex/002-ui-eba-demo`

**Created**: 2026-11-04

**Status**: Draft — especificación; funcionalidades pendientes de planificación e implementación.

**Input**: Solicitud del usuario: mejorar la estética y la experiencia con Angular Material; presentar recálculos como «antes → después» y reducir el ruido de procedencia; cargar informes con el formato visual de las plantillas EBA; ampliar y comprobar la demo con condicionales, fechas, textos y desigualdades; revisar otras mejoras de legibilidad.

## Clarifications

### Session 2026-11-04

- El usuario aclara que las reglas con condicionales, texto o fechas son **solo de validación**. No se ofrecerán ni aceptarán recálculos para ellas, incluso si contienen una igualdad o devuelven un número. La restricción incluye la expresión y su precondición formal; no afecta a las fechas administrativas de vigencia de una regla numérica ni a su descripción textual.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Revisar resultados y cambios sin ruido técnico (Priority: P1)

Como analista, quiero localizar los problemas del informe y entender cada cambio en una vista compacta antes de aceptarlo, conservando acceso a su explicación y origen cuando los necesite.

**Why this priority**: La presentación actual obliga a recorrer tarjetas extensas, repite metadatos y expone claves internas. Esto dificulta comparar los importes y distinguir una regla fallida de la severidad que tendría su incumplimiento.

**Independent Test**: Con un conjunto existente del formato anterior, recorrer las etapas, filtrar resultados, revisar dos propuestas dependientes y consultar una comparación histórica, sin necesitar el nuevo importador ni la demo ampliada.

**Acceptance Scenarios**:

1. **Given** resultados que pasan y fallan, **When** el analista abre Validar, **Then** ve una tabla con regla y descripción, resultado, severidad y ubicación; «Pasa» no aparece presentado como un error porque la severidad de la regla sea `error`.
2. **Given** propuestas disponibles, **When** abre Recalcular, **Then** cada fila muestra celda o concepto, «Anterior 11,00 → Propuesto 12,00 EUR», estado y dependencias; los identificadores, intervalos y localizadores detallados no ocupan la vista principal.
3. **Given** una propuesta que depende de otra, **When** selecciona solo la dependiente, **Then** identifica qué falta, puede navegar a ese antecedente y debe seleccionarlo expresamente antes de aplicar.
4. **Given** una selección en varias páginas, **When** filtra u ordena resultados, **Then** la selección se conserva, su resumen incluye también elementos ocultos y ninguna operación cambia los datos del informe.
5. **Given** una aplicación completada, **When** consulta el resultado, **Then** ve la comparación de estados y valores, la versión creada y «Descargar esta versión»; el formulario de confirmación ya ejecutado no se presenta como una acción pendiente.
6. **Given** una lectura con procedencia, **When** abre «Ver cálculo y origen», **Then** puede reconstruir entradas, cálculo y destino mediante referencias legibles, sin tener que interpretar claves serializadas.

---

### User Story 2 - Cargar un informe con el aspecto de la plantilla EBA (Priority: P1)

Como analista, quiero rellenar los importes en la tabla COREP conocida y cargarla directamente, sin convertirlos manualmente a listas de coordenadas.

**Why this priority**: La plantilla propia de la primera versión obliga a preparar `Contexts`, `Coordinates` y `Facts`; ese trabajo no corresponde al uso habitual de un informe regulatorio.

**Independent Test**: Cargar un libro del perfil oficial admitido, completar únicamente su contexto en pantalla y comprobar todos sus datos y localizadores frente al libro de origen, antes de ejecutar ninguna regla nueva.

**Acceptance Scenarios**:

1. **Given** el libro oficial identificado de COREP 4.0 o un extracto admitido de su hoja CA1, **When** se cargan los importes y se completa el contexto, **Then** el sistema identifica C_01.00 y muestra los conceptos, valores y celdas originales sin solicitar filas `row`/`column` al usuario.
2. **Given** el libro completo con otras hojas, **When** se prepara la carga, **Then** el sistema enumera las tablas admitidas y las excluidas y requiere confirmar ese alcance antes de sustituir el conjunto; no afirma haber importado todo COREP o FINREP.
3. **Given** una plantilla alterada, ambigua o de versión no admitida, **When** se carga, **Then** se informa del problema y se conserva el conjunto previo; una posición parecida no autoriza a adivinar el significado de una celda.
4. **Given** una celda reportable con cero y otra vacía, **When** se importan, **Then** se distinguen ambos estados; una zona no reportable no crea un dato nulo.
5. **Given** una fórmula en una celda de datos seleccionada, **When** se prepara la carga, **Then** se identifica la celda incompatible sin ejecutar la fórmula ni aceptar silenciosamente su valor almacenado.

---

### User Story 3 - Aprender y comprobar el motor con una demo variada (Priority: P1)

Como analista, quiero descargar ejemplos coherentes, entender por qué pasa o falla cada regla y comprobar que las familias de operaciones anunciadas se evalúan realmente.

**Why this priority**: Dos igualdades sintéticas no demuestran cobertura de condiciones, tipos o casos límite. Reconocer la sintaxis de una regla tampoco demuestra que se evalúe su significado.

**Independent Test**: Ejecutar los dos conjuntos de demostración y contrastar cada resultado con una matriz de expectativas independiente, incluyendo casos antes y después de los recálculos seleccionados.

**Acceptance Scenarios**:

1. **Given** la demo COREP, **When** se carga y valida, **Then** se ejecutan al menos 16 reglas distintas sobre datos de C_01.00, con resultados esperados documentados y una separación visible entre reglas oficiales verificadas y reglas sintéticas.
2. **Given** el complemento sintético de tipos, **When** se carga y valida, **Then** al menos ocho reglas adicionales leen datos de texto y fecha del libro y demuestran comparaciones y condiciones; no se atribuyen esos campos a celdas monetarias de COREP.
3. **Given** un condicional, **When** se prueba con condición verdadera y falsa, **Then** se obtiene el resultado previsto de cada rama y no se evalúa la rama no seleccionada; una división por cero en esa rama no causa un error de ejecución.
4. **Given** fechas límite, textos distintos y desigualdades, **When** se ejecutan sus casos, **Then** los resultados respetan las políticas declaradas y un caso inválido se identifica como tal, sin presentarlo como una validación aprobada.
5. **Given** una cadena de tres recálculos, **When** se simula y aplica una selección completa, **Then** cada consumidor usa el valor calculado y redondeado de su antecedente, y la revalidación coincide con las expectativas publicadas.
6. **Given** una regla con condicional, texto o fecha en la expresión o precondición, incluso en una rama no ejecutada, **When** se valida o se intenta configurar un recálculo, **Then** puede producir un resultado de validación, pero se identifica como «Solo validación» y no admite destinos, propuestas ni aplicación, tampoco mediante una petición directa al servicio.

---

### User Story 4 - Descargar el informe actualizado y comparar versiones (Priority: P2)

Como analista, quiero obtener el informe corregido en el mismo formato visual que reconozco y ver qué cambió, sin descargar por error una versión histórica.

**Why this priority**: La nueva entrada debe tener una salida utilizable. La selección histórica persistente actual puede pasar inadvertida después de aplicar cambios.

**Independent Test**: Exportar una versión con cambios conocidos, abrir su hoja CA1 y reimportarla; contrastar datos, contexto y registro de cambios, conservando el original.

**Acceptance Scenarios**:

1. **Given** una aplicación completada, **When** se pulsa «Descargar esta versión», **Then** la descarga corresponde exactamente a la versión indicada, aunque la consulta del histórico tenga seleccionada otra versión.
2. **Given** un informe COREP recalculado, **When** se exporta, **Then** la hoja admitida mantiene conceptos, códigos, distribución visual y valores de esa versión; incluye un registro de cambios separado y no sustituye el archivo original.
3. **Given** el informe exportado, **When** se reimporta con el mismo contexto declarado, **Then** conserva tipos, valores, unidades, precisión y ausencia de los datos reportables; no se afirma que la reimportación restaure el historial de aplicaciones.
4. **Given** una versión histórica, **When** se solicita su descarga, **Then** la interfaz identifica claramente su carácter histórico y no cambia silenciosamente la selección del usuario.

### Edge Cases

- Nombres de hojas repetidos o cambiados, filas insertadas, códigos duplicados, celdas combinadas y modificaciones de cabeceras: detectar incompatibilidad o aceptar únicamente transformaciones declaradas por el perfil.
- Libro completo con hojas no admitidas, enlaces o fórmulas fuera de las tablas seleccionadas: mantener visible el alcance; no leer datos derivados de esas partes ni ejecutarlas.
- Importes numéricos de Excel, notación científica, escalas, signos y cadenas con separadores ambiguos: conservar el valor almacenado y rechazar interpretaciones ambiguas; no prometer recuperar precisión perdida antes de la carga.
- Ceros, blancos, textos vacíos y celdas no reportables: distinguir su significado y conservarlo en la salida.
- Fechas inválidas, años bisiestos y sistemas de fechas Excel 1900/1904: diagnóstico explícito; el día ficticio 1900-02-29 no es una fecha válida.
- Texto con mayúsculas, espacios, acentos, saltos de línea o apariencia de fórmula: comparación declarada y exportación como dato, sin ejecución.
- Condición nula, condición de tipo incorrecto o ramas de tipos incompatibles: resultado explicado, nunca selección arbitraria de una rama.
- Un condicional anidado con resultado numérico, una rama inactiva con texto o fecha, o una precondición formal con esos tipos: toda la regla es solo de validación, independientemente de los datos de esa ejecución.
- Ciclos, productores en conflicto y ramas independientes entre reglas numéricas admitidas para recálculo: conservar los bloqueos y el orden verificable del motor.
- Propuesta obsoleta, aplicada, descartada o sin cambio de valor: estado y acciones coherentes; no permitir reutilizar una confirmación antigua.
- Filtros que ocultan propuestas seleccionadas, ausencia de resultados y fallos de carga: resumen claro, selección visible y recuperación sin perder el conjunto válido.
- Números largos, precisión elevada, textos extensos y pantallas estrechas: acceso al valor completo sin truncamiento engañoso ni pérdida de controles.

## Requirements *(mandatory)*

### Functional Requirements

**Experiencia y presentación**

- **FR-001**: El sistema DEBE organizar el trabajo en Cargar, Validar, Recalcular y Descargar, con etapa actual identificable y resumen persistente de entidad, periodo y versión; el analista puede volver a etapas anteriores sin perder la selección válida.
- **FR-002**: Los resultados DEBEN presentarse en una tabla con regla y descripción, resultado, severidad diferenciada, ubicación y acción de detalle; la cobertura de importación no se confundirá con el cumplimiento de reglas.
- **FR-003**: Las propuestas DEBEN mostrar selección, regla, concepto o celda, valor anterior, valor propuesto, unidad, estado y dependencias. La comparación posterior DEBE mostrar «Antes → Después» y «Falla → Pasa» cuando corresponda, con etiquetas accesibles además de la flecha.
- **FR-004**: Los valores DEBEN alinearse y formatearse de forma consistente para lectura en español, manteniendo acceso al valor exacto. El formato visual no cambiará el cálculo, la precisión ni el valor exportado; no ocultará una diferencia real mediante redondeo de presentación.
- **FR-005**: La vista principal DEBE omitir claves internas serializadas y listas repetidas de localizadores. «Ver cálculo y origen» DEBE conservar entradas, valores, regla, destino y referencias legibles al archivo, hoja y celda; los identificadores técnicos seguirán disponibles en un detalle específico o exportación.
- **FR-006**: Precisión, intervalo, resultado previo al redondeo y política de cálculo DEBEN quedar en el detalle. Si el redondeo cambia el valor o un intervalo afecta la interpretación del resultado, la fila principal DEBE señalarlo y permitir consultar su explicación.
- **FR-007**: Búsqueda, filtros y paginación DEBEN mantener recuentos coherentes. Cualquier ordenación ofrecida DEBE abarcar todos los resultados filtrados, no solo la página visible; ordenar la presentación no altera el orden de ejecución de dependencias.
- **FR-008**: La selección DEBE ser explícita, conservarse entre páginas y filtros, y enumerarse completa antes de confirmar. Las dependencias faltantes DEBEN identificarse y permitir su consulta; nunca se aceptarán automáticamente.
- **FR-009**: Tras aplicar cambios, el sistema DEBE presentar comparación, versión creada y descarga de esa versión; las confirmaciones y acciones incompatibles con un estado aplicado u obsoleto DEBEN dejar de aparecer como pasos pendientes.
- **FR-010**: Las etapas, filtros, tablas, detalles y confirmación DEBEN poder manejarse mediante teclado, con foco visible, nombres accesibles y errores asociados a los campos. Los estados no dependerán exclusivamente del color.
- **FR-011**: La presentación DEBE ser utilizable a 320, 390 y 1440 píxeles de ancho: sin desbordamiento horizontal de la página; si una tabla requiere desplazamiento propio, este será identificable y no impedirá leer valores ni acceder a acciones.
- **FR-012**: El sistema DEBE priorizar información de trabajo —informes, tablas, datos, reglas evaluables y problemas— y ubicar cuotas técnicas, identificadores y estructura de archivos en ayuda o detalles, conservando los avisos necesarios para decidir una carga, aplicación o descarga.

**Entrada y salida de plantillas**

- **FR-013**: La primera cobertura DEBE admitir COREP 4.0, tabla C_01.00, hoja CA1 del libro oficial identificado en Fuentes, tanto dentro del libro completo como en un extracto admitido de esa hoja. FINREP y otras tablas no forman parte de esta entrega.
- **FR-014**: Cada perfil de plantilla DEBE identificar fuente, versión, tabla, estructura admitida, conceptos, celdas reportables, tipos y correspondencia con las referencias de reglas. El nombre del archivo o el parecido visual por sí solos no bastan para aceptar una plantilla.
- **FR-015**: El analista DEBE introducir o confirmar entidad, periodo, módulo, divisa, escala, precisión e indicadores de presentación cuando no estén en el libro. Esa captura se hará con campos comprensibles, sin preparar manualmente listas de coordenadas.
- **FR-016**: Antes de publicar la carga, el sistema DEBE mostrar el perfil detectado, contexto, tablas incluidas, hojas excluidas y errores. Un libro completo requiere aceptación explícita de su cobertura parcial; los errores conservan el conjunto anterior.
- **FR-017**: La importación DEBE distinguir datos reportables, etiquetas, cabeceras y zonas no reportables; conservar los localizadores físicos, el valor decimal almacenado, la escala y la precisión declaradas; diferenciar blanco de cero y rechazar conversiones ambiguas.
- **FR-018**: Los archivos DEBEN tratarse exclusivamente como datos: no ejecutar macros, fórmulas o enlaces externos, ni usar resultados almacenados de fórmulas como valores reportados. Una fórmula en una celda de datos seleccionada DEBE impedir publicar esa carga e identificar su localización.
- **FR-019**: La presencia de fórmulas o referencias externas en partes ajenas a la cobertura DEBE resolverse mediante una política explícita del perfil que permita admitir la fuente oficial sin ejecutar ni consumir esas partes. No se relajarán globalmente las protecciones de los demás formatos.
- **FR-020**: La exportación COREP DEBE producir un libro de las tablas admitidas con distribución visual reconocible, etiquetas y códigos conservados, valores de la versión elegida y registro de cambios separado. DEBE informar de las hojas excluidas y no presentarse como fichero oficial de remisión.
- **FR-021**: La reimportación de la salida DEBE conservar los datos de negocio y el contexto confirmado. Los archivos originales y las versiones históricas DEBEN permanecer intactos durante la sesión.
- **FR-022**: El formato anterior `ce-report-1` DEBE conservar su compatibilidad como entrada y salida avanzada para conjuntos de ese formato; no será la plantilla recomendada ni un paso requerido para usar COREP o la nueva demo.
- **FR-023**: «Descargar esta versión» DEBE identificar inequívocamente su versión de destino. La descarga histórica DEBE seguir disponible mediante una selección explícita que no se cambie silenciosamente tras un recálculo.

**Lenguaje y demostración**

- **FR-024**: El motor DEBE evaluar condicionales con condición booleana y ramas de resultado compatibles, ejecutando únicamente la rama seleccionada. Condición nula produce un resultado no evaluable explicado; condición no booleana o ramas incompatibles producen un diagnóstico de tipo.
- **FR-025**: El sistema DEBE admitir datos y literales de texto en el perfil ampliado, con igualdad y desigualdad exactas, sensibles a mayúsculas y espacios, sin normalización oculta. Cadena vacía y nulo son distintos. No se promete ordenación lingüística, concatenación ni expresiones regulares.
- **FR-026**: El sistema DEBE admitir datos y literales de fecha civil válida, sin hora ni conversión de zona horaria, y comparaciones `=`, `!=`, `<`, `<=`, `>` y `>=`. La representación de intercambio será inequívoca y las fechas inválidas tendrán diagnóstico localizable.
- **FR-027**: Los nuevos tipos y condicionales DEBEN mantener ausencia, errores de tipo y construcciones no soportadas diferenciados. La ampliación tendrá un perfil semántico identificable; aceptar la sintaxis nunca equivaldrá a aprobar una regla.
- **FR-028**: El grafo de recálculo DEBE incluir exclusivamente operaciones elegibles y conservar la detección de conflictos, ciclos y descendientes bloqueados, permitiendo continuar a las ramas independientes válidas. Las reglas solo de validación no crean productores ni propuestas; sus lecturas efectivamente evaluadas conservan trazabilidad y sus resultados se actualizan en la revalidación tras cambios numéricos.
- **FR-029**: Los recálculos DEBEN limitarse a igualdades numéricas con destino único elegido expresamente y resultado numérico compatible. Toda regla que contenga condicionales, valores u operaciones de texto o fecha en su expresión o precondición formal DEBE ser solo de validación, aunque el destino o el resultado sean numéricos o la construcción esté en una rama no ejecutada. La interfaz DEBE indicar «Solo validación» y el servicio DEBE rechazar configuración, simulación o aplicación de recálculos de esas reglas. Las desigualdades tampoco ofrecen una corrección automática. Descripciones y fechas administrativas de vigencia no activan esta exclusión.
- **FR-030**: La demo principal DEBE incluir al menos 16 reglas distintas sobre un informe COREP C_01.00 visual, con igualdades, sumas o rangos, desigualdades, nulos y ceros, precondiciones, condicionales y un caso de precisión o intervalos. DEBE incluir una cadena de al menos tres propuestas dependientes.
- **FR-031**: La demo de tipos DEBE aportar al menos ocho reglas adicionales sobre datos importados de texto y fecha, incluidos condicionales. Será un conjunto sintético separado, con plantilla propia versionada de campos legibles, sin pedir al usuario editar `row`/`column` ni atribuir esos campos a celdas oficiales COREP.
- **FR-032**: Las demos DEBEN distinguir origen oficial y sintético por regla y por conjunto. La demo COREP incluirá al menos cuatro reglas del catálogo EBA suministrado, conservando expresión, precondición, estado, severidad y procedencia y comprobando tabla, módulo y vigencia para el periodo elegido. Los datos serán sintéticos y las reglas adicionales inventadas estarán identificadas; reutilizar códigos COREP no convierte una ecuación inventada en regla EBA.
- **FR-033**: Cada regla de demo DEBE disponer de una expectativa independiente: propósito, familia, datos leídos, resultado inicial, elegibilidad de recálculo y resultado tras la selección prevista. La matriz DEBE cubrir ambas ramas de condiciones, textos sensibles a espacios y mayúsculas, fechas límite y desigualdades que pasan y fallan.
- **FR-034**: Los casos negativos de fecha inválida, tipo incorrecto, construcción no soportada, ciclo y conflicto DEBEN probarse con expectativas explícitas, separados cuando impidan cargar o completar la demo normal. Una regla no evaluable no cuenta como demostración positiva de soporte.
- **FR-035**: Los dos conjuntos DEBEN entregarse preparados para descargar, cargar y ejecutar, con una guía breve y resultados esperados. La guía DEBE explicar qué fallos son intencionados y qué cambios se esperan, sin exigir que el analista construya los archivos.

**Continuidad y evidencia**

- **FR-036**: La iteración DEBE conservar cálculos exactos, selección y confirmación explícitas, aplicación atómica, conservación del original, revalidación y consulta histórica. Las mejoras visuales no cambian el significado de los resultados existentes.
- **FR-037**: El trabajo DEBE permanecer local y sujeto a límites de tamaño, tiempo y recursos. El perfil del libro oficial DEBE contemplar sus hojas y columnas reales sin eliminar límites ni extender indiscriminadamente la admisión de otros formatos.
- **FR-038**: La verificación DEBE cubrir reglas y datos conocidos, celdas del perfil oficial, exportación y reimportación, errores de entrada y recorrido de interfaz. Los resultados automatizados, las fuentes oficiales y la aceptación humana se registrarán por separado; la evidencia de la primera entrega no certifica esta ampliación.

### Key Entities *(include if feature involves data)*

- **Perfil de plantilla**: edición oficial o sintética identificada, tablas admitidas, estructura esperada, celdas y conceptos reportables, tipos, política de contexto y exclusiones.
- **Informe visual**: libro de origen y tablas seleccionadas, contexto confirmado, datos tipados y correspondencia con celdas físicas; conserva su identidad al validar y recalcular.
- **Dato tipado**: valor numérico, booleano, texto o fecha, ausencia diferenciada, unidad y precisión cuando correspondan, y procedencia.
- **Vista de resultado o cambio**: referencia legible de regla y dato, estado, severidad, valor anterior y posterior, dependencias y acceso al detalle completo.
- **Conjunto de demostración**: libros de reglas e informe, origen declarado, perfil admitido, guía y matriz de resultados iniciales y posteriores verificables.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: En las vistas de resultados, propuestas y comparación, el 100 % de las filas del corpus de aceptación permite identificar regla, estado y ubicación; las propuestas y cambios muestran ambos valores sin abrir el detalle técnico. Ninguna clave interna serializada aparece en la vista principal.
- **SC-002**: El recorrido cargar → validar → seleccionar → aplicar → comparar → descargar se completa con teclado, con foco y errores identificables, y sin pérdida de acciones o valores a 320, 390 y 1440 píxeles de ancho.
- **SC-003**: En los libros de aceptación del perfil C_01.00, el 100 % de las celdas reportables coincide con una expectativa independiente de concepto, coordenada, valor, tipo, unidad y localizador; modificaciones incompatibles y fórmulas en datos producen los diagnósticos previstos sin sustituir el conjunto.
- **SC-004**: Las al menos 24 reglas de las dos demos coinciden al 100 % con su matriz de expectativas, tanto inicialmente como después de los recálculos previstos. «Coincidir» incluye fallos intencionados; no exige que todas las reglas aprueben ni admite reglas sin soporte como evidencia positiva.
- **SC-005**: El 100 % de los datos de negocio exportados y reimportados del corpus coincide con la versión elegida, incluidos blancos, ceros, textos, fechas y decimales; los archivos originales conservan su contenido.
- **SC-006**: Los casos de selección entre páginas, dependencias faltantes, conflicto, ciclo, obsolescencia, cancelación y exportación histórica conservan las decisiones y datos esperados, sin aplicaciones parciales ni selecciones automáticas. El 100 % de los casos con condicionales, texto o fecha carece de destinos y propuestas, y los intentos directos o con configuración obsoleta se rechazan sin modificar el informe.
- **SC-007**: La verificación de esta iteración conserva los límites de 500 reglas y 100 000 datos del alcance existente y registra una nueva medición reproducible del recorrido representativo; no reutiliza un resultado antiguo como medición de la interfaz o el importador nuevos. El objetivo de validación sigue siendo al menos 9 de 10 ejecuciones en 30 segundos o menos y ninguna superior a 60 segundos, con carga medida por separado.
- **SC-008**: Al menos un analista identifica los valores anterior y posterior de dos cambios, completa una demo y descarga la versión esperada. La aceptación humana registra esos resultados, la ayuda que necesitó y los problemas encontrados; una confirmación global solo acredita aceptación global, nunca tiempos ni observaciones de pasos no comunicados.

## Assumptions

- Esta es una nueva iteración del producto existente. La solicitud del 2026-11-04 sustituye, para el flujo recomendado, la elección anterior de una plantilla propia; no invalida ni reescribe la evidencia histórica de `001-regulatory-validation`.
- Se mantiene un analista local, una entidad y fecha de referencia por conjunto y la sesión temporal actual. No se añaden cuentas, persistencia entre reinicios ni envío a terceros.
- La primera cobertura visual se limita a COREP 4.0 C_01.00. La fuente examinada usa CA1, códigos de fila en B5:B114, conceptos en la columna D e importes en E; la correspondencia con la columna regulatoria c0010 debe conservar su evidencia, pues no basta inferirla de una cabecera visible.
- El libro oficial completo incluye 191 hojas; las plantillas anotadas contienen metadatos DPM, no importes de un informe. La planificación debe fijar el reconocimiento del libro y del extracto admitidos, y la política segura para partes fuera de cobertura.
- FINREP y otras tablas COREP son extensiones futuras. No se declara compatibilidad con cualquier libro EBA ni con versiones más recientes por semejanza del diseño.
- La demo numérica se reconstruirá con conceptos coherentes de CA1. Los actuales valores A/B/C/D no se trasladarán a conceptos oficiales suponiendo que sus ecuaciones representan relaciones regulatorias reales.
- El complemento tipado es deliberadamente sintético y separado. Permite demostrar textos y fechas importados sin inventar campos oficiales ni ampliar de forma implícita la cobertura regulatoria.
- La medición de 500 reglas y 100 000 datos de SC-007 corresponde al alcance general ya existente y se repetirá con la interfaz nueva y un conjunto admitido de ese tamaño. El perfil CA1 tiene 110 posiciones de fila: su carga completa, exclusiones y recorrido se medirán por separado, sin atribuirle capacidad para 100 000 celdas reportables.
- La planificación debe cerrar el manifiesto de celdas, tipos, fuentes y expectativas antes de implementar el adaptador y las demos. La cobertura solo se declarará entregada después de contrastar la implementación con esos casos.

### Restricciones explícitas del usuario y continuidad técnica

- La interfaz usará **Angular Material**, incluidas tablas para resultados, propuestas y comparaciones, y se rehacerán los estilos con una presentación consistente. Es una elección expresa del usuario; los criterios de aceptación anteriores describen los resultados que debe conseguir.
- Se mantienen Angular, Node.js, la generación JavaScript con ANTLR y Kahn para ordenar dependencias. Se conservan las fuentes EBA originales y no se ejecutan expresiones como código.
- La planificación fijará versiones compatibles y exactas, semántica del perfil ampliado, formatos y pruebas; esta especificación no prescribe su implementación interna ni acredita que estén disponibles.

### Fuentes

- [Inspección local: observaciones de interfaz, estructura de libros y huellas de las fuentes](inspection.md).
- [EBA — ITS on supervisory reporting, paquete de plantillas usado como base](https://www.eba.europa.eu/sites/default/files/2025-02/1b4c4008-4224-450f-aa7b-c6fe5284872a/ITS%20on%20supervisory%20reporting.zip).
- [EBA — Annotated templates, referencia de metadatos y correspondencias](https://www.eba.europa.eu/sites/default/files/2024-12/7ae0363a-ad3d-42d9-a192-34711416c039/annotated_templates.zip).

Estas fuentes identifican material oficial; los informes cumplimentados, reglas añadidas y expectativas de demostración son artefactos del proyecto salvo atribución oficial verificada por regla.
