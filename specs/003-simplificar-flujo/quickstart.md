# Guía de comprobación del flujo 003

Usar esta guía después de implementar la iteración. Los resultados esperados proceden de la [especificación](spec.md), el [contrato de interfaz](contracts/ui.md) y la [revisión de destinos](contracts/direction-review.md). SC-006 ya cuenta con una ejecución documentada sobre la versión anterior. Para los demás criterios se recogerán resultados sobre el commit que se vaya a entregar.

## Preparar una copia de prueba

Desde la raíz del repositorio, en PowerShell, preparar la herramienta local, los libros de demo y el build de producción. La preparación de plantillas comprueba la procedencia de los originales. Las pruebas trabajan con copias y datos sintéticos.

```powershell
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','prepare:templates')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','fixtures')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','build')
```

Si falta Chromium para las pruebas de navegador, instalarlo en la caché del proyecto.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache/playwright'
.\scripts\run-with-toolchain.ps1 -NpmArguments @('exec','--','playwright','install','chromium')
```

Playwright inicia el servidor de pruebas en `127.0.0.1:3318` con `reuseExistingServer:false`. El benchmark de volumen crea su proceso en `3317`. Mantener el puerto 3000 y el conjunto del analista reservados para su trabajo. Para la comprobación manual, abrir otra consola en la raíz y ejecutar este bloque en un puerto exclusivo disponible. Cerrar ese proceso mediante Ctrl+C al terminar.

```powershell
$puertoPrueba = 3330
if ($puertoPrueba -in [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port) { throw 'Elige otro puerto de prueba disponible.' }
$env:PORT = [string]$puertoPrueba
$env:NODE_ENV = 'production'
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

Cuando la consola de ese proceso confirme su dirección de escucha, abrir la dirección indicada (por defecto en este ejemplo, `http://127.0.0.1:3330/`) y crear un conjunto con un nombre sintético reconocible. El protocolo usa únicamente los procesos que inicia para la comprobación.

## Matriz de aceptación

| Criterio 003 | Acción | Evidencia esperada |
| --- | --- | --- |
| SC-001 | En Cargar, abrir las dos demos visuales y revisar una inspección con exclusiones. Abrir, copiar y cerrar su ayuda con teclado y con toque. Provocar también un rechazo de carga. | Cero entradas para plantilla, archivos, selector o guía `ce-report-1`, incluidos los controles secundarios. Las demos COREP y Texto y fechas están disponibles. Los datos técnicos empiezan plegados. Cobertura, aceptación necesaria y errores accionables siguen visibles. El cierre de la ayuda devuelve el foco. |
| SC-002 | Con 500 registros, escribir parte de un código con mayúsculas distintas, pegar el de una regla situada después de las primeras 50, buscar un código ausente y borrar el campo. Repetir con estado y tabla elegidos. | La consulta afecta a todo el catálogo. La primera página, el total y las filas corresponden a los filtros vigentes. Cada actualización medida tarda como máximo 1.000 ms desde la última entrada. El campo conserva el foco incluso con cero coincidencias. |
| SC-003 | Revisar una igualdad con destino solo izquierdo, otra solo derecho, una con ambos lados posibles y otra excluida. Omitir y recuperar una sugerencia, paginar y guardar el subconjunto revisado. | Ambas sugerencias requieren cero elecciones de lado. La igualdad ambigua mantiene ambas opciones y omitir. La excluida tiene cero selectores. Los recuentos abarcan el borrador completo y el contenido guardado coincide con el resumen confirmado. |
| SC-004 | En la demo COREP, elegir `v0174_m` en el grupo de r0070 y omitir por completo el grupo de r0200. Guardar los cinco productores oficiales. Simular, seleccionar el conjunto de propuestas con todos sus predecesores, confirmar y aplicar. Validar aparte Texto y fechas. | Los cinco destinos alcanzan los valores de la tabla inferior y los diagnósticos previstos para conflictos y ciclos siguen disponibles en sus casos de prueba. La demo tipada devuelve sus ocho resultados esperados y cero propuestas de escritura. |
| SC-005 | Completar publicación de carga, guardado de destinos utilizables y aplicación. En cada hito usar teclado, ratón o toque y comprobar la navegación a 320, 390 y 1440 px, también con movimiento reducido. Repetir con fallo, cancelación y respuesta obsoleta. | Cada éxito señala una sola etapa mediante «Siguiente paso» (Validar, Recalcular, Descargar). El foco y la etapa actual se conservan hasta que el analista navega. La recomendación se consume al entrar. Las operaciones fallidas conservan el estado adecuado. La descarga explícita usa la versión del recibo incluso al tener otra versión histórica elegida. |
| SC-006 | Contrastar las dos vías FINREP con las mismas cuatro cifras y el mismo catálogo. | Se identifica la etapa alcanzada en cada vía, su resultado o diagnóstico y la huella de la fuente. Véase la reproducción más abajo. |
| SC-007 | Leer el documento HTML inicial y el recurso indicado por `rel="icon"` con el workspace vacío y con datos sintéticos cargados. Examinar el símbolo también en la cabecera y la pestaña. | Idioma `es`, nombre, título, finalidad e icono local reconocibles. A 16 y 32 px se distingue el símbolo. Las dos lecturas de portada contienen cero datos del conjunto. |
| SC-008 | En una simulación pendiente, observar 0 → 1 → 2 → 0 seleccionadas, ocultar las dos mediante filtros o páginas y volver a seleccionar la misma combinación. Probar impedimentos, reintento e histórico según el recorrido inferior. | Panel oculto → visible → visible → oculto. Con dos fuera de pantalla indica dos. La nueva selección exige confirmación propia. El histórico aplicado muestra comparación y recibo y tiene cero paneles de confirmación. |
| SC-009 | Comprobar los estados de cabecera con 0, 1 y 2 contextos, elegir el segundo con teclado, navegar, actualizar la lista y volver a 1 y 0. | Se encuentran respectivamente 0, 0 y 1 selectores al inicio. Con uno aparecen entidad, fecha y módulo una sola vez. La elección válida persiste. Si desaparece, la cabecera pasa al contexto vigente o queda vacía. |

### Medir la búsqueda de catálogo

Preparar una muestra sintética de 500 códigos distintos sobre un informe visual admitido. Fijar de antemano las coincidencias de cada entrada, incluida una exclusiva de otra página. Registrar commit, navegador, máquina de referencia de 002 y hashes de los dos libros. La pausa de búsqueda de 250 ms forma parte del tiempo percibido.

Medir T0 en el último evento `input` de cada gesto de teclado, pegado o borrado. Medir T1 en el mismo reloj del navegador cuando las filas y el total esperados están en el DOM y han transcurrido dos cuadros de render. Guardar T1−T0 de cada gesto, el código consultado y el resultado visible. Una media inferior a un segundo puede ocultar un gesto que superó el límite. Comprobar cada muestra contra 1.000 ms en la API local y con la ventana enfocada.

En una prueba de carrera separada, retrasar la respuesta A, completar la consulta B y después entregar A. Hacerlo también al cambiar la versión o el filtro y al borrar. Deben permanecer la búsqueda B, sus filas, el recuento y el foco. La demora inyectada verifica orden de respuestas y se documenta aparte de las medidas de latencia real.

### Revisar destinos, recomendaciones y protección del informe

Antes de guardar, verificar la regla, el contexto y la coordenada completa de cada productor. Una elección guardada válida prevalece sobre una sugerencia. El corpus declara nueve instancias con un lado admisible. En r0070 compiten `v0174_m`, `DEMO_RANGE` y `DEMO_PRECONDITION`. La precondición falsa de esta última afecta al resultado actual, pero su destino sigue siendo estructuralmente elegible. En r0200 compiten `DEMO_ZERO` y `DEMO_INTERVAL`. Elegir `v0174_m` en el primer grupo y omitir el segundo deja cinco incluidas, cuatro omitidas y siete excluidas. Comprobar estos recuentos globales antes de guardar. [Oráculo de elegibilidad](../002-ui-eba-demo/contracts/demo-corpus.json) Un cambio de filtro conserva las exclusiones explícitas. Cambiar de base exige volver a revisar la elegibilidad y la confirmación del alcance.

| Regla oficial | Fila COREP | Valor esperado en EUR |
| --- | --- | ---: |
| `v0174_m` | r0070 | 60 |
| `v0173_m` | r0030 | 185 |
| `v0176_m` | r0150 | 50 |
| `v0175_m` | r0130 | 100 |
| `v0172_m` | r0020 | 285 |

Comparar las celdas de la versión resultante con la matriz y comprobar que el original conserva sus valores. Probar separadamente una configuración vacía y una validación exclusiva de texto/fecha. La descarga de resultados permanece disponible en ambos casos. Una precondición formal tipada o una rama condicional inactiva sigue perteneciendo a la política de solo validación. [Matriz de referencia de las demos](../002-ui-eba-demo/contracts/demo-corpus.md)

### Selección global, reintento y contextos

1. Con cero seleccionadas, contar cero paneles «Confirmar la aplicación». Seleccionar una propuesta con predecesor pendiente. El panel aparece de inmediato con una seleccionada. Hasta obtener cierre válido permanece impedida la aplicación.
2. Elegir otra, llevar ambas fuera de la página visible y comprobar que el panel muestra dos. Al volver, deseleccionarlas hasta cero y comprobar que el panel desaparece. Seleccionar de nuevo las mismas supone una nueva aceptación. Un cambio de filtro o página conserva el conjunto global.
3. Con base obsoleta, dependencias pendientes o confirmación sin marcar, verificar que no se envía la aplicación. Al aplicar un conjunto válido, registrar una sola versión y su recibo. En la prueba de respuesta incierta, perder la respuesta tras el envío y reintentar el mismo intento. Verificar misma clave de idempotencia, cuerpo y base, un único recibo y una sola publicación. La comparación histórica sigue disponible.
4. Contar selectores únicamente dentro de la cabecera. Con dos contextos de identidad distinta, elegir el segundo por teclado y comprobar que continúa activo al cambiar de etapa y al refrescar la lista con distinto orden. Al retirar el elegido, verificar el otro contexto. Al cerrar el conjunto o cambiar a uno vacío, comprobar que desaparecen sus datos anteriores.

### Leer la portada y comprobar el favicon

Guardar la respuesta anónima `GET /` con el workspace vacío y repetirla tras cargar un conjunto con marcas sintéticas reconocibles para entidad, fichero, regla e importe. Leer ambas como HTML sin ejecutar JavaScript. Comparar el título, descripción, cabecera genérica y enlace local al icono. Rastrear en las dos respuestas y sus metadatos las marcas de prueba, identificadores de trabajo y credenciales de sesión. La evidencia persistida incluirá el resultado de la comprobación y omitirá tokens.

Solicitar el icono por la URL declarada y verificar estado 200, MIME de imagen y recurso gráfico válido. Examinar las representaciones de 16 y 32 píxeles y comprobar la misma identidad en la cabecera. Conservar la comprobación de fallback HTML de la SPA y las respuestas de protección de rutas API y archivos internos en el servidor aislado. El alcance de SC-007 es la portada local y su legibilidad para un lector automático.

## Reproducir el control FINREP existente

La ejecución registrada en `6bd2476` usó el extracto visual F_01.01 y, para el control del motor, cuatro posiciones equivalentes de `ce-report-1`. En ambos envíos se usó el mismo catálogo. F8/F9/F10/F11 contenían 100/40/35/25 EUR. En la inspección visual el trabajo terminó con `INVALID_WORKBOOK`, motivo `UNRECOGNIZED_COREP_SHEETS`, y cero versiones. En el control del motor, `CUSTOM_FIN_TOTAL` pasó y `CUSTOM_FIN_GREATER` falló como estaba previsto. [Evidencia de la especificación](evidencia.md) · [Resultado registrado](resultado-finrep.json)

El guion existente crea su propia aplicación por vía y utiliza inyección de peticiones sin abrir puerto. Con dependencias instaladas y la API compilada se reproduce desde la raíz con el comando siguiente.

```powershell
.\.tools\node\node-v24.22.2-win-x64\node.exe specs/003-simplificar-flujo/finrep-probe.mjs
```

El resultado nuevo queda en una carpeta específica bajo `.cache/003-finrep-probe/`. Contrastar `sourceUnchanged`, los hashes del catálogo y de ambas entradas, y el resultado de cada regla. El SHA-256 de la plantilla oficial debe seguir siendo `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` antes y después. Conservar el resultado de la especificación 003 y registrar cada repetición con su commit. [Guion](finrep-probe.mjs) · [Manifiesto de la fuente oficial](../../tests/fixtures/eba/source-manifest.json)

## Regresiones y protocolo de volumen

Estos comandos ya existen. Ejecutarlos tras adaptar las pruebas de esta iteración y compilar el código.

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','typecheck')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:unit')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:integration','--','--maxWorkers=1','--no-file-parallelism')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:contract','--','--maxWorkers=1','--no-file-parallelism')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:e2e')
```

En E2E, migrar el recorrido del analista y los errores de carga a las demos visuales con inspección y publicación reales. Las suites `analyst-journey`, `import`, `validation`, `preview`, `apply-export`, `material-workflow` y `material-long-values` usaban `enableLegacyFormat`. Para conservar casos específicos de v1, preparar los archivos por la ruta de compatibilidad `/imports` en el servidor exclusivo y continuar desde la interfaz real al validar, simular, aplicar o exportar. Registrar qué acciones fueron preparación por API. Verificar la ausencia del control antiguo como comportamiento del producto y actualizar sus pruebas de componentes.

El benchmark actual de 500 reglas y 100.000 datos también activaba el control retirado. Durante implementación se adaptará su preparación por API y se versionará el protocolo. Definir T0 en la primera respuesta terminal satisfactoria de la importación, antes de rehidratar la interfaz, y T1 con la ejecución completa, el resumen, las primeras 50 filas visibles y dos cuadros renderizados. Mantener auditoría de 500 resultados, 100.000 lecturas y 250 que pasan/250 que fallan. La referencia 002 documenta un recorrido de entrada distinto y seguirá identificada con ese protocolo.

Una vez adaptado el harness, se podrán utilizar estos comandos existentes en una carpeta de referencia nueva. El piloto y las diez ejecuciones de cohorte se registran por separado. Para esta regresión de volumen conservar el umbral de 002: diez auditorías completas, al menos nueve ejecuciones ≤30 s y todas ≤60 s. Registrar la carga por separado. SC-002 de **003** se mide con el gesto de búsqueda descrito arriba. SC-007 de **003** corresponde a la portada y favicon.

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','prepare','.cache/benchmark/003-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','pilot','.cache/benchmark/003-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','cohort','.cache/benchmark/003-reference')
```

Para cerrar la comprobación, registrar por criterio el commit, entradas y hashes, esperado, observado, incidencias y diagnósticos. Guardar medidas de latencia y capturas de los tres anchos cuando correspondan. Distinguir ejecución automatizada, evidencia visual revisada y comentarios del analista. Esta guía fija el procedimiento que se ejecutará en la fase de implementación.
