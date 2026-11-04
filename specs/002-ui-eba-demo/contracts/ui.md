# Contrato de interfaz y navegación

Fecha: 2026-11-04. Diseño de fase 1, pendiente de implementación y pruebas.
Deriva de [spec.md](../spec.md), FR-001–012, FR-015–016, FR-023 y FR-029,
y de las decisiones [R1, R6 y R8](../research.md). No modifica el significado del perfil v1.

## 1. Tema y componentes

- Fijar Angular Material y CDK en 22.2.4, compatibles con Angular 22.2.4 y TypeScript 6.0.3.
- Tema claro en `styles.scss` mediante `mat.theme`, densidad 0 y overrides públicos.
  Los colores, tipografía, bordes, espaciado y foco forman un sistema común.
- Fuentes de sistema e iconos SVG locales; ninguna petición a proveedores de fuentes/iconos.
- Retirar los estilos globales de botones, inputs, selects y tablas que interfieran con Material.
  La disposición propia usa clases del producto; no se manipulan clases internas MDC ni `::ng-deep`.
- Usar tablas nativas con `mat-table`, campos Material, botones, checkboxes, paneles de detalle
  y mensajes asociados al contexto. Importar solo los componentes necesarios.
- Mantener los presupuestos de compilación existentes: 700 kB de aviso y 1 MB de error.
  La integración debe medirse; este contrato no acredita tamaño ni accesibilidad alcanzados.

## 2. Etapas y vida del estado

`WorkspaceShell` presenta Cargar, Validar, Recalcular y Descargar. La etapa activa tiene
nombre, título y estado reconocibles. Cabecera compacta con conjunto, entidad, periodo y
versión; acceso secundario a sesión temporal, histórico y cierre. Solo la etapa activa
ocupa la zona principal; el progreso del trabajo en curso sigue visible al navegar.

Los stores de carga, resultados y propuestas y los borradores de configuración/descarga
viven en el ámbito del workspace. Desmontar una etapa no borra selección, filtros, borrador
de destinos, ejecución elegida ni versión histórica de descarga. Cerrar o cambiar workspace
libera esos datos y descarta respuestas tardías mediante identidad y generación de petición.
No se introducen almacenamiento del navegador, cuenta ni recuperación entre reinicios.

Una nueva versión invalida selección y confirmación de aplicación de la base anterior;
su previsualización sigue consultable como histórica. Cambiar selección invalida la
confirmación previa. Cambiar etapa nunca publica datos, valida, simula ni aplica por sí solo.

## 3. Carga con revisión explícita

| Paso | Información principal | Acción |
|---|---|---|
| Elegir archivos | Catálogo, informes, perfil admitido y límites útiles. | Preparar la carga. |
| Declarar contexto | Usar Contexto del libro, o formulario con entidad, referencia, envío, divisa, escala, precisión y tablas declaradas. | Inspeccionar archivos y contexto. |
| Revisar inspección | Perfil, tabla incluida, datos, problemas y hojas excluidas. | Confirmar carga o descartar. |
| Carga publicada | Versión creada y resumen de cobertura. | Ir a Validar. |

El flujo nuevo usa el recurso `/import-inspections`; inspeccionar no sustituye el conjunto.
El servidor aporta el perfil reconocido, candidato, contexto y hash que vincula la revisión.
La confirmación de publicación usa el contrato API, ETag e idempotencia; el cliente no envía
coordenadas calculadas, AST ni una elección de perfil semántico para eludir controles.

Para el libro oficial completo se muestra «1 hoja incluida: CA1 · 190 hojas excluidas»
con la lista consultable y una aceptación de cobertura sin marcar. Para otros extractos,
los números y nombres proceden de la inspección, no de constantes del frontend.
No se ofrece «Importar todo COREP» ni se aceptan exclusiones automáticamente.

Los campos de contexto son comprensibles; no se solicitan `row`, `column`, `presence` ni
tablas técnicas. Modificar archivos o contexto tras revisar invalida esa revisión y exige
una nueva inspección. Caducidad, descarte o base obsoleta deshabilitan confirmar y ofrecen
repetir la inspección, conservando el conjunto vigente y los valores válidos del formulario.

Una fórmula o estructura incompatible muestra archivo, hoja y celda afectados y una acción
de corrección. El mensaje no revela rutas locales, trazas ni contenido ajeno a la carga.
Los metadatos externos ignorados se explican como exclusiones, nunca como valores leídos.
La entrada antigua se ofrece en una opción avanzada y mantiene su contrato v1.

## 4. Tablas de trabajo

| Vista | Columnas principales | Detalle secundario |
|---|---|---|
| Resultados | Regla y descripción, resultado, severidad, ubicación, capacidad, detalle. | Expresión, operandos, entradas leídas, causas y origen. |
| Configuración | Regla elegible, concepto/celda, destino elegido. | Restricción de cada lado y configuración completa. |
| Propuestas | Selección, regla, destino, anterior → propuesto, estado, dependencias, detalle. | Nominal, redondeo, intervalo, fuentes y entradas. |
| Comparación | Regla, estado antes → después, datos cambiados, detalle. | Expresión y datos completos de ambas versiones. |

Resultado y severidad tienen etiquetas distintas: una regla puede pasar y tener severidad
`error` sin que la fila se presente como error de ejecución. La cobertura de carga no se
mezcla con el resumen de cumplimiento. Datos no aplicables, no evaluables y errores se
distinguen de un fallo de la regla.

Descripción, concepto y etiquetas proceden de `presentation?: {description?, conceptLabel?}`,
proyección del servidor sobre variantes y mapping de plantilla. Si no existen para un resultado antiguo, usar código y referencia
legible de tabla/fila/columna; no inferir etiquetas por posición ni enviar AST al navegador.
Los identificadores de asociación permanecen en el modelo y no son el texto de trabajo.

La comparación abre inicialmente el resumen y los valores que cambiaron. La acción
«Ver todos los resultados» conserva acceso a reglas sin cambio y a sus dos evaluaciones.
El cambio «Pasa → Pasa» puede tener datos diferentes y no se debe eliminar por su estado.

## 5. Política de solo validación

La política recibida del servidor es `recalculation.policy.{profileId,mode,reasons}`;
los campos `left` y `right` de elegibilidad se conservan. V2 siempre devuelve la política:

| mode | Presentación | Configuración de destinos |
|---|---|---|
| `validation_only` | «Solo validación»; motivos `CONDITIONAL`, `TEXT` o `DATE` traducidos. | No se ofrecen destinos ni selección de recálculo. |
| `standard` | Capacidad normal del perfil; consultar elegibilidad de cada lado. | Solo lados declarados elegibles por el servidor. |
| `undetermined` o política ausente | Capacidad no disponible; resultado consultable. | No habilitar guardar hasta obtener clasificación completa. |

`standard` no significa «recalculable»: una desigualdad o un destino compuesto puede seguir
siendo inelegible. Una política ausente nunca se interpreta como permiso. No se escanean
expresiones con regex ni se ignora una construcción por estar en una rama no ejecutada.

`RULE_VALIDATION_ONLY` en configuración, simulación o aplicación se presenta como rechazo
explicado y conserva los datos. No se transforma en una propuesta bloqueada ni se reintenta
quitando restricciones. Se retiene el borrador para que el usuario revise su corrección,
sin quitar destinos silenciosamente. Los metadatos administrativos no activan esta política.
V1 mantiene sus reglas y posibilidades anteriores; el backend entrega su clasificación.

## 6. Páginas, filtros y selección

- Mostrar 50 filas por página mediante `MatPaginator` con Anterior/Siguiente y etiquetas en
  español. No ofrecer saltos aleatorios, última página ni cambio de tamaño en esta entrega.
- Adaptador de cursor sobre `items`, `total`, `nextCursor`; el total pertenece a la consulta
  filtrada completa. Reiniciar cursor al cambiar filtros, recurso, versión o revisión.
- Guardar solo cursores de páginas visitadas: hasta 20 001 referencias de un máximo de
  8 192 caracteres ASCII por cursor, límite de la API existente, para un máximo de 1 000 000 de instancias y páginas de 50.
  Anterior funciona para todas las páginas visitadas. Mantener solo la página actual y
  los detalles seleccionados, no los payloads anteriores ni todas las filas en DOM.
  Un total superior al límite produce diagnóstico; no se recorta ni reinterpreta en la UI.
- No usar filtrado/ordenación cliente de una página como resultado global ni añadir MatSort.
  Identificar el orden estable; las propuestas conservan el orden de dependencias del servidor.
- Mantener selección por identificadores estables y sus detalles, fuera de la página visible.
  El resumen indica seleccionadas totales y cuántas no están visibles por página/filtro.
- Cada dependencia faltante muestra regla y destino legibles y una acción de consulta.
  Consultarla no la selecciona; no mostrar como etiqueta un UUID sin resolver.
- Selección, configuración completa, petición de cierre de dependencias y confirmación
  deben corresponder a la misma base. Respuestas obsoletas no reactivan una selección anterior.

## 7. Valores y explicación

Importes alineados y con cifras tabulares. Una unidad común aparece una vez en la comparación:
«Anterior 11,00 → Propuesto 12,00 EUR». Ambas etiquetas están disponibles para lectura asistida.
No convertir racionales o importes arbitrarios a `Number` para formatear. Para un decimal finito,
conservar sus cifras exactas; si es periódico, mostrar fracción exacta y una aproximación solo
si se identifica como tal. La presentación no puede hacer parecer iguales dos valores distintos.

Mostrar «Sin dato» para ausencia, «Texto vacío» cuando corresponda y cero como valor. Las fechas
se muestran como fechas civiles sin `Date`/zona horaria. Texto se trata como contenido, no HTML.
Valores largos permiten leer/copiar el contenido completo sin truncamiento engañoso.

«Ver cálculo y origen» reúne expresión, operandos, lecturas reales y referencias archivo/hoja/celda.
Precisión, intervalo y valor previo al redondeo están en ese detalle; una marca visible en la fila
avisa si cambian la interpretación. No imprimir claves JSON ni hashes como explicación.
Los valores recalculados se identifican como calculados: su celda de origen no implica que
el archivo original ya contuviera el valor nuevo. La trazabilidad completa sigue accesible.

## 8. Aplicación, descarga y estados

Antes de aplicar: resumen completo de propuestas elegidas, dependencias satisfechas, base vigente
y confirmación expresa. Mientras se aplica, no repetir operaciones; seguir el Job existente.
Tras éxito: estado Aplicada, versión creada, recuentos antes/después y «Descargar esta versión».
No seguir mostrando el formulario de selección/confirmación como trabajo pendiente.

La descarga posterior usa `newVersionId` del recibo consultado. No toma por defecto la selección
histórica de la etapa Descargar ni la cambia a escondidas. Descargar muestra la versión exacta,
perfil de salida y contenido de negocio; composición ZIP/JSON e identificadores son secundarios.
Históricos, exportación de resultados incompletos y registro de cambios conservan sus reglas.

Cada vista contempla sin datos, cargando, error recuperable, histórica y trabajo activo. El botón
de la acción principal tiene un nombre concreto; un spinner no sustituye texto de estado ni resultado.

## 9. Accesibilidad y aceptación visual

Mantener salto al contenido, navegación por teclado y foco visible con contraste. Al cambiar etapa,
enfocar su título; al cerrar un detalle, devolver foco a su activador. Formularios tienen etiquetas,
errores asociados y resumen cuando proceda. Estado y redondeo no se expresan solo por color.
Las tablas tienen nombre/caption y encabezados; usar `role="table"`, sin prometer teclado de grid.

A 320 y 390 px no hay desplazamiento horizontal de la página. Una tabla ancha dispone de región
de desplazamiento propia, identificable y accesible; sus acciones y valores siguen alcanzables.
A 1440 px se aprovecha el ancho para comparación compacta y navegación persistente. La revisión
visual comprobará texto largo, cantidades grandes, controles, foco, contraste y estados vacíos.

Pruebas previstas: harnesses Material y stores para navegación sin pérdida, cursores/filtros,
respuestas tardías, exactitud visual, `validation_only`/`undetermined` y selección fuera de página;
E2E para carga inspeccionada del libro completo, teclado, confirmación explícita, comparación,
descarga de versión concreta y recorridos a 320/390/1440 px. Guardar capturas y resultados reales.
La aceptación humana se registra aparte: ningún test visual sustituye la respuesta del analista.
