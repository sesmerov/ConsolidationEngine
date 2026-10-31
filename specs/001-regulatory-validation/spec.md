# Feature Specification: Validación y recálculo de informes regulatorios

**Feature Branch**: `main`

**Feature Directory**: `specs/001-regulatory-validation`

**Created**: 2026-10-31

**Status**: Especificación inicial preparada para planificación; sin implementación.

**Input**: Crear un motor que reciba un Excel reducido de reglas EBA y unos informes,
muestre qué reglas se cumplen y proponga recálculos cuando sean posibles, respetando
dependencias entre operaciones. El usuario confirmó informes Excel con plantilla propia.
Las restricciones tecnológicas solicitadas se recogen en la constitución.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Cargar y comprobar reglas e informes (Priority: P1)

Como analista, quiero cargar un catálogo reducido y los informes de una entidad y periodo,
comprobar qué se ha entendido y corregir los problemas de entrada antes de confiar en resultados.

**Why this priority**: Sin una identificación correcta de reglas, contexto y datos, los resultados
pueden corresponder a otra versión regulatoria o a otra celda.

**Independent Test**: Importar un catálogo de prueba y un informe de la plantilla propia permite
inspeccionar registros, contexto, coordenadas y errores sin ejecutar validaciones ni recálculos.

**Acceptance Scenarios**:

1. **Given** un catálogo con las cabeceras del fichero EBA de referencia y un informe válido,
   **When** se importan, **Then** se conservan las expresiones y su procedencia y se muestra el
   número de registros, hechos y diagnósticos, sin alterar los archivos.
2. **Given** dos registros con el mismo código de regla y distintos módulos o vigencias,
   **When** se selecciona el contexto del informe, **Then** se elige el registro aplicable;
   si dos variantes incompatibles coinciden, se indica el conflicto y no se elige arbitrariamente.
3. **Given** un cero, una celda vacía y un código de fila `0010`,
   **When** se importan, **Then** se distingue cero de ausencia y se conserva el identificador
   textual con sus ceros iniciales.
4. **Given** un archivo dañado, una cabecera obligatoria ausente, una coordenada duplicada o un
   límite de carga excedido, **When** se importa, **Then** se muestra el motivo y localizador;
   el conjunto de trabajo válido anterior permanece disponible.
5. **Given** un catálogo con una regla válida, otra mal formada y otra con una operación no
   soportada, **When** se inspecciona, **Then** cada registro conserva su diagnóstico y la regla
   válida puede utilizarse sin que las otras desaparezcan del resumen de cobertura.

### User Story 2 - Entender los resultados de validación (Priority: P1)

Como analista, quiero ejecutar las reglas aplicables y ver sus resultados, los datos utilizados
y el motivo de cada incumplimiento o imposibilidad de evaluación.

**Why this priority**: Es el valor principal del producto y evita interpretar una omisión como éxito.

**Independent Test**: Con datos y reglas de resultado conocido, ejecutar una validación y comprobar
los estados y explicaciones sin configurar ningún recálculo.

**Acceptance Scenarios**:

1. **Given** la igualdad ilustrativa `A = B + C` con A=12, B=5 y C=7,
   **When** se valida, **Then** pasa; con A=11 falla y se muestran ambos valores comparados.
   A, B y C son alias de prueba de coordenadas regulatorias, no sintaxis de entrada.
   Este escenario usa valores puntuales con `interval:false`; los casos con intervalos se
   comprueban por separado con precisión y resultados esperados explícitos.
2. **Given** una ausencia que vuelve indeterminada la expresión o su precondición según la
   semántica del perfil, sin sustitución aplicable,
   **When** se valida, **Then** el resultado es «no evaluable» con la causa; un cero explícito
   sigue siendo un dato disponible. Una ausencia que pueda resolverse mediante `isnull`, `nvl`
   o el tratamiento documentado de nulos en agregados no impide por sí sola la evaluación.
3. **Given** una regla inactiva, fuera de vigencia o con precondición falsa,
   **When** se valida, **Then** aparece como «no aplicable» con el motivo concreto.
4. **Given** una división por cero, una función no admitida y una expresión mal formada,
   **When** se valida, **Then** se distinguen respectivamente el error de evaluación, la falta
   de soporte y el error sintáctico; ninguno cuenta como regla que pasa.
5. **Given** reglas reales seleccionadas del catálogo, datos sintéticos identificados como tales
   y resultados esperados derivados de la documentación,
   **When** se valida el perfil admitido, **Then** se contrastan precondiciones, valores por
   defecto explícitos, intervalos y referencias entre tablas con esos resultados.
6. **Given** un rango de códigos DPM con huecos y su catálogo de coordenadas,
   **When** se agrega, **Then** se incluyen solo las coordenadas existentes en el rango según
   su orden regulatorio, sin inventar filas intermedias ni omitir ausentes silenciosamente.

### User Story 3 - Previsualizar recálculos y sus dependencias (Priority: P2)

Como analista, quiero ver cambios propuestos solo cuando el destino y la operación están definidos,
incluyendo los cambios de los que dependen, para decidir si debo aplicarlos.

**Why this priority**: Un incumplimiento no determina por sí solo qué dato es incorrecto.

**Independent Test**: Sobre un conjunto de trabajo preparado y direcciones de cálculo explícitas,
generar propuestas con sus valores anteriores y nuevos, sin modificar datos.

**Acceptance Scenarios**:

1. **Given** `A = B + C` incumplida y A seleccionado expresamente como destino, B=5 y C=7,
   **When** se solicita una propuesta, **Then** se propone A=12 con sus fuentes y explicación.
   Sin esa selección no se propone sobrescribir un operando por intuición.
2. **Given** A=11, D=22, B=5, C=7 y cálculos dirigidos `A <- B + C`, `D <- A * 2`,
   **When** se previsualizan, **Then** se muestran A=12 y después D=24, indicando que D usa
   el A propuesto. Estas fórmulas son ejemplos conceptuales de dirección de cálculo.
3. **Given** dos cálculos productores para A, aunque coincidan numéricamente,
   **When** se prepara la propuesta, **Then** se exige resolver el conflicto antes de ofrecer
   cambios para A y sus consumidores.
4. **Given** una dependencia circular A→B→A, un consumidor C de B y otra rama independiente,
   **When** se prepara la propuesta, **Then** A y B se identifican como ciclo, C como bloqueado
   por ese ciclo y la rama independiente puede continuar. A→A también se detecta.
5. **Given** una desigualdad, varias incógnitas, una operación no admitida, una referencia
   ambigua o precisión insuficiente para determinar el nuevo valor,
   **When** se solicita recálculo, **Then** se explica por qué no se ofrece una propuesta segura.
6. **Given** una dependencia cuya propuesta ha fallado,
   **When** se prepara una propuesta consumidora, **Then** queda bloqueada y no usa en silencio
   el valor antiguo como si el productor hubiese terminado.
7. **Given** un productor que cambia una celda leída por la precondición de otro cálculo,
   **When** se prepara la simulación, **Then** la precondición se evalúa después del productor
   sobre los valores propuestos; solo si resulta verdadera se ofrece el cálculo condicionado.

### User Story 4 - Aplicar cambios y comparar resultados (Priority: P2)

Como analista, quiero aceptar un conjunto coherente de propuestas y volver a validar una nueva
versión de mis datos, conservando la original y la explicación de los cambios.

**Why this priority**: Un recálculo útil debe permitir comprobar su efecto sobre el conjunto.

**Independent Test**: Con propuestas preparadas, aceptar o cancelar y comprobar versiones,
trazabilidad y resultados posteriores, sin volver a importar los originales.

**Acceptance Scenarios**:

1. **Given** las propuestas A=12 y D=24 de la historia anterior,
   **When** se acepta D, **Then** se muestra que requiere también A y se solicita confirmar
   el conjunto completo; no se aplica D aislado sobre una base incoherente.
2. **Given** un conjunto aceptado y vigente,
   **When** se aplica, **Then** se crea una nueva versión con todos sus cambios, se conserva
   la anterior y se vuelven a evaluar todas las reglas aplicables mostrando la comparación.
3. **Given** una previsualización pendiente,
   **When** se cancela o falla la aplicación, **Then** no cambia ningún dato de la versión vigente.
4. **Given** una previsualización basada en una versión anterior de informes, reglas o configuración,
   **When** se intenta aplicar tras un cambio, **Then** se rechaza como obsoleta y se exige regenerarla.
5. **Given** resultados antes y después,
   **When** se exporta el informe de resultados y la versión recalculada,
   **Then** se incluyen las versiones, cambios aceptados y estados; no se sobrescribe el original
   ni se presenta la exportación como fichero oficial de remisión.

### Edge Cases

- Una referencia válida en otra tabla o periodo no debe enlazarse con un dato de contexto distinto.
- Un hecho repetido, aunque tenga el mismo valor, requiere corregir la entrada; no se suma ni elige uno.
- Regla sin precondición: se evalúa si cumple las demás condiciones de aplicabilidad.
- Precondición con una construcción no soportada: «no evaluable», no «no aplicable».
- Nulo explícito, ausencia implícita, cero, cadena vacía y dato de tipo incorrecto conservan diferencias.
- Rango vacío o coordenada no definida en el catálogo: diagnóstico acorde al perfil, nunca cero inventado.
- Operación entre unidades incompatibles, desbordamiento o intervalo divisor que contenga cero:
  error explicado y sin recálculo aplicado.
- Una igualdad cumplida puede coexistir con fallos de otras reglas; el resumen debe reflejarlo.
- Reordenar filas del Excel no debe cambiar el resultado ni resolver conflictos por posición.
- Reimportar o cambiar el contexto invalida resultados y propuestas previos, sin mezclarlos.
- Un archivo con fórmulas, macros o enlaces externos no autoriza su ejecución.
- Cancelación o límite de tiempo deja la ejecución incompleta visible; nunca un resumen «todo correcto».

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001 — Catálogo**: El sistema DEBE importar un catálogo reducido en Excel con campos
  equivalentes a los del fichero de referencia. Debe identificar las cabeceras, incluida
  `Precondtion`, y usar `Expression` y esa precondición como expresiones; `Description`
  es texto explicativo. Debe conservar valor original, archivo, hoja, fila y versión de cada registro.
- **FR-002 — Identidad y aplicabilidad**: El código de regla no es una clave única. La selección
  DEBE considerar framework, módulo/versión, entidad, fecha de referencia, fecha de remisión cuando
  intervenga en la vigencia, estado y alcance. Fechas ausentes no pueden inventarse. Variantes
  incompatibles simultáneas deben diagnosticarse. Debe preservarse la severidad original y mostrar
  una categoría normalizada sin confundir «warning» con «Error».
- **FR-003 — Plantilla propia**: El usuario DEBE poder descargar una plantilla versionada con
  instrucciones y ejemplo sintético. Debe expresar entidad, periodo, módulo/versión, tabla, fila,
  columna y, cuando proceda, hoja/ejes, además de valor, tipo, unidad y precisión. La posición A1
  de Excel no sustituye la coordenada regulatoria. La plantilla debe aportar el catálogo de
  coordenadas válidas y el contexto necesario para distinguir una celda ausente de una inexistente.
- **FR-004 — Integridad de carga**: Las cargas DEBEN validarse antes de sustituir el conjunto vigente.
  Errores de estructura de informes, tipos, contexto o hechos duplicados rechazan la carga con
  localizador. Los errores de una regla se conservan por registro y permiten ejecutar otras válidas.
  El sistema debe comunicar un catálogo vacío o sin reglas aplicables.
- **FR-005 — Cobertura**: Antes de ejecutar, el sistema DEBE informar qué versión del lenguaje y
  operaciones soporta, qué reglas quedan fuera y por qué. Una expresión sintácticamente reconocida
  pero sin semántica implementada se considera no soportada.
- **FR-006 — Perfil inicial**: La versión inicial DEBE soportar, sobre tablas cerradas y coordenadas
  finitas explícitas, referencias dentro y entre tablas, constantes numéricas y booleanas,
  paréntesis, `+`, `-`, `*`, `/`, signos unarios, `=`, `!=`, `<`, `<=`, `>` y `>=`,
  `and`, `or`, `not`, precondiciones, contexto `with`, sustituciones `default` explícitas,
  `isnull`, `nvl` y `sum` sobre rangos acotados. La selección `s*` se expandirá únicamente
  sobre las hojas finitas declaradas en el catálogo propio, con resultados identificados por hoja.
  Debe respetar la precisión e intervalos declarados cuando se activen. El perfil y sus casos de
  referencia deben publicarse; agrupaciones dimensionales, filtros generales, tablas abiertas,
  desplazamientos temporales y demás construcciones no incluidas producen «no evaluable».
- **FR-007 — Significado numérico**: El sistema DEBE aplicar la semántica documentada del perfil,
  incluido el tratamiento de nulos y precondiciones indeterminadas. No debe aplicar cero por defecto
  ni una tolerancia global tácita. Si falta información necesaria sobre precisión, coordenadas o
  unidades, debe indicar que no puede evaluar. Los rangos usan los códigos DPM existentes, no una
  secuencia de enteros ni únicamente los hechos presentes.
- **FR-008 — Estados**: Cada instancia de regla DEBE terminar en exactamente uno de los estados
  definidos en la tabla inferior, o quedar pendiente/incompleta durante una ejecución cancelada.
  La severidad de una regla es un atributo independiente de su resultado.
- **FR-009 — Explicación y resumen**: Cada resultado DEBE mostrar código y variante, expresión,
  precondición, coordenadas, valores o ausencias utilizados, valores comparados cuando existan,
  causa, severidad y versiones. El resumen debe reconciliar todos los registros importados,
  sus instancias y los conteos por estado, separando cobertura, aplicabilidad y cumplimiento.
  Se debe poder filtrar por estado, código y tabla y exportar los resultados.
- **FR-010 — Inmutabilidad y repetibilidad**: Validar o previsualizar DEBE conservar los originales.
  Con iguales datos, reglas, contexto y configuración se deben reproducir valores, estados y
  orden observable; cambiar una entrada debe crear otra versión e invalidar resultados dependientes.
- **FR-011 — Elegibilidad de recálculo**: Solo se DEBE proponer un cambio con destino único y
  operación soportada, procedente de una regla activa y aplicable, cuya precondición sea verdadera
  en la versión simulada (o esté ausente). Una asignación admitida puede aportar la dirección;
  para una igualdad de validación, el usuario debe seleccionar el lado formado por una única
  celda como destino,
  y el otro lado debe poder calcularse sin depender de esa misma celda. No se resolverán
  algebraicamente ecuaciones generales, desigualdades ni varias incógnitas.
- **FR-012 — Dependencias**: Las propuestas DEBEN considerar qué datos producen y consumen,
  incluidos sus contextos, precondiciones y selecciones de ámbito. Un consumidor debe usar el
  valor propuesto por su productor y reevaluar su precondición con esos valores. Las referencias
  deben poder resolverse sobre el catálogo finito antes de ofrecer el conjunto; una selección
  dinámica no resoluble en el perfil impide la propuesta con un diagnóstico explícito.
  Compartir entradas no crea precedencia. El orden debe ser estable y los productores deben
  preceder a los consumidores, cualquiera que sea el orden de las filas importadas.
- **FR-013 — Bloqueos**: Antes de ofrecer un conjunto aplicable se DEBEN detectar múltiples
  productores del mismo destino, ciclos y consumidores bloqueados por ellos. Debe distinguirse
  pertenecer a un ciclo de depender de él, con una explicación de las operaciones implicadas.
  Las ramas independientes sin errores pueden continuar.
- **FR-014 — Previsualización**: Cada propuesta DEBE mostrar regla y dirección elegida, destino,
  valor anterior, nuevo valor y precisión, entradas, dependencias y versión base. Un conjunto
  seleccionado debe incluir y explicar todos los cambios previos que necesita, sin aceptarlos
  silenciosamente en nombre del usuario.
- **FR-015 — Aplicación**: Solo una confirmación expresa DEBE aplicar el conjunto mostrado y
  vigente, de forma completa o sin cambios. Cambiar reglas, contexto, datos o configuración
  invalida la previsualización. Cancelar conserva la versión actual. Debe mantenerse el vínculo
  entre versión anterior, nueva versión, propuestas aceptadas y momento de aplicación.
- **FR-016 — Revalidación y exportación**: Después de aplicar se DEBEN evaluar todas las reglas
  aplicables sobre la nueva versión y comparar sus estados con los anteriores. La versión de
  informes recalculada debe poder exportarse en la plantilla propia junto con un registro de
  cambios. Esta salida no implica aprobación regulatoria ni remisión a un supervisor.
- **FR-017 — Límites**: La configuración inicial DEBE admitir hasta 500 registros de reglas,
  20 archivos de informes, 100.000 hechos, 10 MiB por archivo y 50 MiB por carga conjunta. Debe
  rechazar excesos con explicación, limitar también la expansión del contenido comprimido y
  permitir cancelar. Una ejecución que exceda 60 segundos debe terminar como incompleta, con
  diagnóstico y sin aplicar cambios. Son límites de producto iniciales, no límites de la EBA.
- **FR-018 — Tratamiento de archivos**: El sistema DEBE aceptar datos de archivos `.xlsx`,
  rechazar formatos distintos y fórmulas en campos de datos, y no ejecutar macros, fórmulas
  ni enlaces externos. Los archivos y resultados deben permanecer en el entorno local; no se
  enviarán a servicios externos. Al cerrar el conjunto de trabajo deben eliminarse sus copias
  temporales; las exportaciones elegidas por el usuario se conservan.

| Estado | Significado |
| --- | --- |
| Pasa | Regla aplicable y evaluada cuyo resultado es verdadero. |
| Falla | Regla aplicable y evaluada cuyo resultado es falso. |
| No aplicable | Exclusión demostrada por estado, contexto, vigencia o precondición falsa. |
| No evaluable | Falta información o soporte, o el resultado/precondición es indeterminado. |
| Error | Expresión mal formada, operación inválida u otro error de ejecución identificado. |
| Bloqueada | Una dependencia necesaria del proceso de recálculo no puede completarse; se identifica cuál. |

La validación inicial de datos existentes no espera un recálculo para emitir sus resultados.
«Bloqueada» corresponde a la evaluación dependiente dentro de una simulación de recálculo;
no se ocultará con ese estado un fallo observado en la versión original. Las propuestas tienen
además su propio estado: disponible, bloqueada, aceptada, aplicada, descartada u obsoleta.

### Key Entities *(include if feature involves data)*

- **Catálogo de reglas**: archivo y versión con registros identificados por código y contexto.
- **Registro de regla**: expresión, precondición, procedencia, vigencia, estado, severidad y soporte.
- **Contexto de informe**: entidad, periodo, módulo/versión y metadatos necesarios para aplicabilidad.
- **Catálogo de coordenadas**: tablas cerradas, sus coordenadas válidas y el significado de sus datos.
- **Hecho reportado**: coordenada completa, valor o ausencia explícita, tipo, unidad y precisión.
- **Conjunto de trabajo y versión**: reglas seleccionadas, contexto, datos y configuración inmutables
  para una ejecución; conserva relación con versiones anteriores.
- **Instancia y resultado de regla**: aplicación concreta de una regla a un contexto y coordenadas,
  con estado y evidencia.
- **Dirección de recálculo**: regla, destino explícito y operación que obtiene su valor.
- **Propuesta y conjunto aceptado**: cambios antes/después, dependencias, versión base y decisión.
- **Ejecución**: proceso de validación o simulación con versiones, estado final y resultados.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: El 100% de los registros y hechos del conjunto de aceptación conserva sus
  identificadores y procedencia; duplicados de hechos y variantes de regla incompatibles
  se detectan sin perder registros ni seleccionar uno por orden.
- **SC-002**: El 100% de los escenarios de aceptación produce el estado y valor esperado,
  incluidos casos reales seleccionados con datos sintéticos. Ninguna regla omitida,
  no soportada o indeterminada aparece como «pasa».
- **SC-003**: La cadena de prueba A=12 y D=24 se propone en orden correcto y produce el mismo
  resultado al permutar las filas; los casos de ciclo, autociclo, conflicto y dependencia
  fallida bloquean solo los conjuntos afectados e identifican su causa.
- **SC-004**: En el 100% de los casos de cancelación, propuesta obsoleta o fallo de aplicación,
  la versión vigente conserva todos sus valores; una aceptación válida aplica el conjunto
  completo, conserva la anterior y genera una nueva validación.
- **SC-005**: Cada resultado y cambio exportado permite localizar su regla, fuentes y versiones;
  los conteos del resumen coinciden exactamente con el detalle.
- **SC-006**: En un equipo de referencia documentado antes de las pruebas, al menos 9 de 10
  ejecuciones de un conjunto de 500 reglas admitidas y 100.000 hechos muestran el resultado
  completo en 30 segundos o menos desde que termina la carga. Ninguna supera el límite de
  60 segundos sin diagnóstico. Es un objetivo por medir, no un resultado actual.
- **SC-007**: Un analista que siga las instrucciones de la plantilla puede completar el caso
  guiado de carga, validación, aceptación y comparación sin editar reglas ni datos fuera del
  flujo previsto; la prueba de aceptación registra cada paso y cualquier ayuda necesaria.

## Assumptions

- **Confirmado por el usuario**: los informes se cargarán en Excel con una plantilla definida por
  nosotros. El catálogo será parecido al ejemplo EBA, pero contendrá menos reglas.
- **Supuesto inicial revisable**: uso local por un analista y un contexto de entidad/periodo por
  conjunto de trabajo; puede haber varias tablas y módulos declarados compatibles. No incluye
  colaboración simultánea, cuentas, despliegue público ni control de acceso multiusuario.
- **Supuesto inicial revisable**: recálculos como propuestas con aceptación expresa sobre una
  nueva versión, preservando originales. No se interpretan las igualdades del catálogo como
  autorización automática para modificar datos.
- **Supuesto de alcance**: perfil numérico de tablas cerradas de FR-006 para entregar una primera
  versión verificable. Admitir un archivo EBA no implica soportar todas sus reglas.
- **Dependencia**: documentación DPM-XL v0.9 y gramáticas aportadas. Las notas de fuentes registran
  observaciones y limitaciones; no se ha generado ni ejecutado un parser en esta fase.
- **Dependencia**: el catálogo de coordenadas de las tablas elegidas debe acompañar los informes
  en la plantilla propia. No se descargará ni inferirá automáticamente una taxonomía completa.
- **Supuesto de producto**: límites y rendimiento de FR-017/SC-006 son objetivos iniciales para
  validar durante implementación; una modificación posterior debe actualizar esta especificación.
- **Fuera de alcance inicial**: XBRL/xBRL-CSV, presentación oficial ante EBA, extracción automática
  de taxonomías, todos los dialectos históricos, tablas abiertas, cálculo algebraico general,
  optimización de correcciones y resolución iterativa de ciclos.
- Los ejemplos A/B/C/D son escenarios didácticos con hechos sintéticos. Los casos tomados del
  catálogo conservarán referencia a la celda de origen y expectativas documentadas; aún no son
  pruebas ejecutadas ni una certificación de cumplimiento.
