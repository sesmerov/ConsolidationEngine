# Revisión de interfaz y prueba FINREP

El 6 de noviembre de 2026 se revisaron las cuatro capturas de Diego y las pantallas correspondientes de la iteración 002. Se probó el importador y el motor existentes en la revisión `6bd2476`. La especificación recoge el comportamiento propuesto para 003. [Especificación](spec.md)

## Qué merece espacio en la pantalla

| En la interfaz actual | Decisión para 003 |
| --- | --- |
| La primera captura combina el formato anterior, una casilla, descargas y una guía de ocho pasos. | Diego confirmó retirar de la interfaz la carga anterior y su ejemplo, incluida la descarga de esa plantilla. Las demostraciones visuales de COREP y de texto y fechas son las que se ofrecen al analista. |
| Las capturas 2 y 3 muestran un identificador de inspección, una huella larga y varios párrafos sobre aritmética y cuotas. | Dar prioridad a qué informe se cargará, a la cobertura y a las exclusiones que exigen aceptación. Reunir el material de consulta tras un botón de ayuda. Un panel permite leer, copiar una huella y cerrar desde teclado o móvil. La caducidad o un error que requieran actuar permanecen visibles. |
| En la cuarta captura, una desigualdad presenta «Sin dirección» y repite el mismo motivo para izquierda y derecha. Una regla con una sola opción útil también pide abrir un selector. | Mostrar el destino deducido como celda legible. Reservar la elección del lado para dos destinos elegibles. Agrupar las reglas de solo validación o sin destino y permitir consultar por qué. |
| El menú identifica la etapa abierta. Cargar, guardar y aplicar producen efectos distintos en momentos distintos. | Indicar «Siguiente paso» junto a Validar, Recalcular o Descargar cuando se confirme el resultado correspondiente. Usar texto y contraste para que también se entienda con movimiento reducido. Mantener el control de la navegación en manos del analista. |

El filtro existente busca por subcadena sin distinguir mayúsculas y sus páginas tienen 50 filas. La búsqueda mientras se escribe debe conservar esos resultados, volver a la primera página y proteger el texto nuevo frente a una respuesta tardía de la búsqueda anterior.

La demo contiene un caso para evaluar los destinos automáticos. Tanto `v0174_m` como `DEMO_RANGE` pueden apuntar a C_01.00, fila 0070, columna 0010. Conocer el lado correcto en cada regla deja una segunda decisión de negocio: cuál de ellas puede escribir en esa celda. La guía deberá permitir reproducir los cinco cambios originales eligiendo explícitamente los productores del ejemplo. La semántica y los importes de la demo ya están documentados. [Corpus de la iteración 002](../002-ui-eba-demo/contracts/demo-corpus.md)

### Simplificaciones revisadas con Diego

El 6 de noviembre Diego incorporó dos de las cuatro propuestas a la especificación.

| Propuesta incorporada | Efecto esperado |
| --- | --- |
| Mostrar la confirmación de aplicación cuando haya al menos una propuesta seleccionada (FR-016). | La confirmación acompaña una selección concreta. Su total incluye propuestas seleccionadas fuera de la página visible. |
| Presentar el contexto único como dato de lectura y mostrar el selector cuando haya varios contextos disponibles (FR-017). | El analista lee la entidad, el periodo y el módulo una sola vez en la cabecera y puede cambiar de contexto cuando tiene alternativas. |

Las otras dos propuestas quedan para una decisión posterior.

| Prioridad | Propuesta | Qué gana el analista |
| --- | --- | --- |
| Alta | Colocar los campos «Catálogo de reglas» e «Informes» antes de las demos. Dejar «Probar una demo» como acción secundaria desplegable. | Quien llega con sus propios archivos puede empezar en la primera vista. Las dos demos siguen siendo fáciles de encontrar. |
| Media | Retirar el progreso terminado cuando ya esté visible el resultado de esa misma operación. | El espacio queda para la versión publicada o el siguiente paso. Progreso en curso, cancelación, errores y ejecuciones incompletas conservan su lugar. |

Las fuentes de la revisión son las capturas y las plantillas del proyecto. [Cargar](../../apps/web/src/app/import/import-page.component.html) · [Destinos](../../apps/web/src/app/recalculation/directions.component.html) · [Navegación y progreso](../../apps/web/src/app/workspace/workspace-shell.component.html) · [Recalcular](../../apps/web/src/app/recalculation/preview-page.component.html)

## Identidad y descubrimiento

La portada inicial declara el idioma español y el título «ConsolidationEngine». La cabecera utiliza las letras CE. La propuesta es un signo sencillo relacionado con una tabla de informe y una marca de verificación, reconocible en la cabecera y en una pestaña pequeña. Como texto de partida para la portada se propone **«ConsolidationEngine | Validación de informes regulatorios»**. La descripción puede explicar que se cargan informes Excel, se validan reglas y se revisan recálculos. Los ejemplos, nombres de entidades e identificadores de sesiones pertenecen al área de trabajo. [Portada actual](../../apps/web/src/index.html)

La comprobación de rastreo se hará sobre el contenido inicial y el icono que recibe un lector anónimo en el entorno local. Para aparecer en un buscador público se requiere una dirección pública accesible al rastreador. Una eventual publicación es una decisión independiente que requeriría definir esa superficie y su dominio. [Requisitos técnicos de Google Search](https://developers.google.com/search/docs/essentials/technical) · [Favicons en resultados de búsqueda](https://developers.google.com/search/docs/appearance/favicon-in-search)

La señal de siguiente paso será estática y distinguible de la etapa abierta. Un anuncio breve del resultado puede orientar a quien usa lector de pantalla. Para la ayuda extensa se propone apertura explícita, con acceso por teclado y toque. [W3C sobre mensajes de estado](https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html) · [W3C sobre ayuda al pasar el puntero o enfocar](https://www.w3.org/WAI/WCAG22/Understanding/content-on-hover-or-focus.html)

## Prueba de compatibilidad FINREP

**El perfil visual actual rechaza este extracto FINREP antes de publicar el informe. El motor sí evalúa correctamente las dos reglas cuando recibe los mismos importes mediante el formato de coordenadas anterior.** Al retirar esa carga de la interfaz en 003, el resultado positivo seguirá siendo una prueba de la capa de cálculo. Para ofrecer ese recorrido visual a un analista se necesitaría un adaptador FINREP.

Se tomó la hoja «1.1 Assets» del libro de presentación EBA 4.0 versionado, tabla F_01.01. El guion conserva la disposición de la hoja `1.1`, omite los elementos de impresión externos al extracto, incorpora cuatro importes sintéticos y relee el archivo para verificar cabecera, filas y valores. Se declaró la entidad SYNTHETIC, fecha 31/12/2025 y EUR. La etiqueta de módulo `FINREP_SYNTHETIC` identifica el control experimental. [Procedencia y huella del original](../../tests/fixtures/eba/source-manifest.json)

| Columna regulatoria 0010 | F8 / r0010 | F9 / r0020 | F10 / r0030 | F11 / r0040 |
| --- | ---: | ---: | ---: | ---: |
| Importe en EUR | 100 | 40 | 35 | 25 |

Se preparó un único catálogo propio con dos reglas. El resultado esperado se fijó antes de enviarlo al motor.

| Regla | Comprobación | Esperado | Observado en el control de cálculo |
| --- | --- | --- | --- |
| `CUSTOM_FIN_TOTAL` | 100 = 40 + 35 + 25 | Pasa | Pasa, con lecturas de las cuatro filas |
| `CUSTOM_FIN_GREATER` | 40 > 100 | Falla | Falla, con lecturas de r0020 y r0010 |

| Entrada y punto de prueba | Resultado observado |
| --- | --- |
| Extracto visual FINREP, inspección ordinaria y contexto declarado | La petición recibe 202 y el trabajo termina con `INVALID_WORKBOOK` («El libro contiene datos no válidos»). El reconocedor devuelve el motivo interno `UNRECOGNIZED_COREP_SHEETS`. Quedan cero versiones y la validación no llega a iniciarse. |
| Las mismas cuatro posiciones en `ce-report-1`, importación anterior y validación | Una versión, cuatro coordenadas y cuatro hechos. Ejecución completa con una regla que pasa, una que falla, cero errores y cero no evaluables. |

Ambos envíos usan los mismos bytes de catálogo y trabajos reales de la aplicación compilada. Cada vía crea su propia sesión de prueba sin abrir un puerto ni usar el conjunto de un analista. Se comprobó antes y después la huella SHA-256 del XLSX original, `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7`. La prueba cubre un extracto, cuatro valores y dos reglas sintéticas. El resultado detallado identifica las huellas de las tres entradas, las expresiones y las lecturas. [Resultado de la ejecución](resultado-finrep.json)

### Reproducir desde la raíz del proyecto

Con el entorno del proyecto preparado y la API compilada, ejecutar en PowerShell:

```powershell
.\.tools\node\node-v24.22.2-win-x64\node.exe specs/003-simplificar-flujo/finrep-probe.mjs
```

Si falta la API compilada, el comando del proyecto es `.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','build:api')`. Cada ejecución guarda el catálogo, el extracto visual, el control en coordenadas y el resultado en una carpeta nueva dentro de `.cache/003-finrep-probe/`. La salida indica la carpeta concreta. [Guion reproducible](finrep-probe.mjs)
