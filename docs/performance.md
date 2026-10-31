# SC-006: protocolo y resultados

La referencia de hardware, versiones, límites y protocolo se escribe con `--prepare` **antes del piloto**. No se reemplaza: cada referencia usa una carpeta nueva. Los archivos son sintéticos y no modifican el catálogo EBA original.

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'build:api')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'build', '--workspace', '@ce/web')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'prepare', '.cache/benchmark/reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'pilot', '.cache/benchmark/reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run', 'bench', '--', 'cohort', '.cache/benchmark/reference')
```

El informe contiene 100000 coordenadas y hechos numéricos, unidad EUR y precisión 2. Cada una de las 500 reglas admitidas suma un rango distinto de 200 hechos. Se leen los 100000 hechos: no hay filas duplicadas, reglas inactivas ni construcciones no admitidas. Se esperan 500 instancias, 250 resultados pasa y 250 falla; las diferencias de un céntimo se introducen deliberadamente. Los valores tienen signo y céntimos variados. Los hashes y los resultados esperados quedan en `manifest.json`.

Cada ejecución usa un proceso API y contexto Chromium nuevos. El tiempo de arranque y la carga real por la interfaz se registran aparte. T0 es el evento de respuesta de Chromium que comunica por primera vez que la importación terminó, antes del refresco de la interfaz y del clic en Validar. T1 exige ejecución completa, resumen de 500 filas/variantes/instancias sin duplicadas, primera página de 50 resultados renderizada y dos cuadros de animación. «Completo» significa ejecución y resumen completos con todos los resultados disponibles por paginación; no 500 filas simultáneas en el DOM.

Después del cronómetro se auditan las 500 filas por HTTP paginado: estados esperados, 200 lecturas por resultado y 100000 FactKeys distintos. Una auditoría fallida invalida la medición. Diez ejecuciones formales seriales, sin reintentos ni descartes: al menos nueve deben tardar como máximo 30 segundos. Una ejecución superior a 60 segundos debe mostrar un diagnóstico, nunca un éxito parcial. El piloto se conserva aparte y no cuenta en las diez mediciones.

El piloto instrumenta tiempos de llamadas al almacén. La cohorte sólo muestrea memoria del proceso API cada 250 ms; los picos entre muestras pueden no observarse. RSS del proceso, heap total, límite de generación antigua del worker (256 MiB) y cuota canónica de estado (512 MiB) son magnitudes distintas. La instrumentación no cambia límites ni trabajo de validación.

## Referencia fijada antes del primer piloto

Capturada el 2026-10-31 a las 23:06:20 UTC (2026-11-01, Madrid), commit previo `3e3b90ffa71ca7c474e7bd459b452007e6f57223`:

| Dato | Valor |
|---|---|
| CPU | AMD Ryzen 5 3600X, 6 núcleos / 12 procesadores lógicos |
| RAM física | 34 277 588 992 bytes |
| Sistema | Windows 11 Pro x64, 10.0.26200 |
| Plan energético | Alto rendimiento |
| Node / V8 | 24.22.2 / 13.6.233.17-node.63 |
| Chromium / Playwright | 156.0.8078.4 / 1.64.1, headless |
| Workers / sesión | 256 MiB de generación antigua; 512 MiB de estado canónico |
| Cronómetro técnico | 60 000 ms; no se amplió |

La referencia completa se conserva en `.cache/benchmark/sc006-2026-11-01-v2/reference.json`. La cohorte mantiene trace y vídeo desactivados. Los procesos ajenos habituales del equipo no se cierran; durante la cohorte no se ejecutan otros builds o pruebas del proyecto.

| Archivo congelado | Bytes comprimidos | Bytes expandidos | SHA-256 |
|---|---:|---:|---|
| catalog.xlsx | 30 802 | 376 135 | `d76eaad8a4e2a06659163df996bb2c3fbe69e25f1c3fb941ca20ba50bf7c73bd` |
| report.xlsx | 5 476 198 | 77 857 406 | `e893027a81ec189be87b3f98022be69c5e9ca06ac8982f6153dbe18ce9c31f00` |

Cada piloto/cohorte verifica los hashes antes de empezar. `code.json` conserva el commit, diff y hashes de los archivos modificados, incluidos los nuevos; las carpetas de ejecución se crean sin sobrescribir las anteriores.

## Pilotos y corrección comprobada

1. `pilot-2026-10-31T23-06-34-536Z`: fallo. Carga 28,870 s excluida; tras 75,127 s no había ejecución completa y la interfaz mostraba `JOB_TIMEOUT`. El contador original recorrió el estado 59 veces y consumió 71,169 s; 50 actualizaciones de progreso consumieron 60,118 s. Este intento no satisface SC-006.
2. `pilot-2026-10-31T23-11-40-490Z`: abortado después de más de 240 s del ensayo por el coste de centenares de miles de matchers individuales en la auditoría posterior. Se conservan código, captura de la interfaz y `aborted.json`. Esa revisión sólo retenía T1 en memoria y no lo persistió al interrumpirse: **no hay tiempo recuperable ni resultado válido**. No se reconstruye un tiempo a partir de la captura.
3. `pilot-2026-10-31T23-16-17-161Z`: 13,855 s; carga 28,577 s excluida. Auditoría completa correcta de los 500 resultados y 100000 valores, identidades, precisiones y localizadores. Las 501 actualizaciones de progreso consumieron 43,079 ms, sin descartar ninguna. Los 504 controles de cuota consumieron 1,129 s, casi todo al incorporar el nuevo resultado; siete lecturas del workspace consumieron 0,609 ms. La publicación de la validación duró 3,136 s. Es un piloto, no una de las diez mediciones.
4. `pilot-2026-10-31T23-18-16-779Z`: 16,106 s; carga 28,909 s excluida. Verificación final del ensayo con hashes congelados y auditoría de operandos exactos además de cada hecho: correcta. Tampoco cuenta en la cohorte.

La corrección de producto se limita al almacén: un contador por identidad conserva el conteo de objetos compartidos de `canonicalStateBytes`. Prepara las diferencias de raíces y sólo las confirma después de superar cuota y guardas de publicación. Las referencias que dejan de estar retenidas se eliminan. No se omitieron reglas, lecturas, trazas o mensajes de progreso; tampoco se cambiaron límites, resolución, evaluator o UI. El control `closing:false` se cuenta desde la creación; pasar a `true` no aumenta el estado y permite cerrar al alcanzar la cuota exacta.

El ensayo corregido guarda T1 inmediatamente antes de auditar. Las invariantes directas sustituyen sólo el mecanismo costoso de aserción del ensayo; comprueban todos los valores racionales y originales, unidad, precisión, localizador, identidad, rangos, operandos agregados y estados esperados. Una auditoría fallida sigue invalidando el trial.

Antes de la cohorte: build y typecheck del API correctos; 71 regresiones correctas (25 del contador/oráculo, incluidas dos de cierre en cuota exacta; 46 de sesiones, publicación atómica, importación y ciclo de vida). Los pilotos se conservan aparte y no se incorporan a los siguientes resultados.

## Diez ejecuciones formales

Cohorte `cohort-2026-10-31T23-19-48-870Z`, sin reintentos y sin pruebas o builds concurrentes del proyecto. Todos los tiempos son segundos; carga incluye importación/publicación y se excluye del criterio SC-006.

| Ejecución | Carga excluida | Fin de carga → visible | Auditoría 500 reglas / 100000 hechos |
|---:|---:|---:|---|
| 1 | 29,590 | 13,511 | Correcta |
| 2 | 28,917 | 13,923 | Correcta |
| 3 | 28,645 | 13,943 | Correcta |
| 4 | 28,913 | 15,825 | Correcta |
| 5 | 28,608 | 15,542 | Correcta |
| 6 | 28,792 | 14,382 | Correcta |
| 7 | 28,462 | 13,826 | Correcta |
| 8 | 28,850 | 13,523 | Correcta |
| 9 | 30,434 | 16,320 | Correcta |
| 10 | 29,286 | 15,214 | Correcta |

**10/10 ≤30 s**, ninguna supera 60 s. Media 14,601 s; mediana 14,162 s; percentil 90 por rango más próximo 15,825 s; máximo 16,320 s. Cada ejecución produjo 500 instancias completas, 250 pasa y 250 falla deliberadamente, sin errores, no evaluables, no aplicables ni duplicadas. En total se auditaron un millón de lecturas de hechos en las diez ejecuciones, incluidos valor racional y texto original.

En la fase de validación, el máximo **observado por muestreo** del RSS del proceso API fue 965 242 880 bytes; el máximo observado de `heapUsed` del hilo principal fue 772 494 632 bytes. RSS comprende el proceso que aloja workers; no es la cuota JSON de sesión ni el límite de generación antigua de un worker. No se midió el RSS de Chromium, y las muestras cada 250 ms pueden omitir máximos transitorios.

Los datos completos, muestras, timestamps, códigos de ejecución y capturas están en `.cache/benchmark/sc006-2026-11-01-v2/cohort-2026-10-31T23-19-48-870Z/`: `summary.json`, `code.json`, `trial-N.json`, `trial-N-visible.json` y `trial-N.png`. El directorio `.cache` es evidencia local ignorada por Git; el generador y este resumen sí forman parte del proyecto.

SC-006 queda verificado para este equipo y carga fijada. No se extrapola a cualquier combinación de 500 reglas: otras expansiones, expresiones o conjuntos de lecturas pueden consumir más trabajo y siguen sujetos a las mismas cuotas. Esta medición tampoco sustituye el ensayo de uso con un analista de SC-007.
