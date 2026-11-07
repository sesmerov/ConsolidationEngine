# Guía de validación — iteración 004

Esta guía se ejecutará **después de implementar** el [plan](plan.md). Describe resultados esperados, no pruebas ya superadas. En esta fase se han comprobado fuentes y contratos; la compatibilidad visual FINREP positiva sigue pendiente.

## Preparación y aislamiento

Usar la raíz del proyecto en PowerShell. En una copia nueva o si falta la herramienta local:

```powershell
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
```

Con las dependencias preparadas y los cambios implementados:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','prepare:templates')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','prepare:demos')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','fixtures')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','build')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','typecheck')
```

Los scripts de preparación se ampliarán durante implementación para generar los assets FINREP definidos en el contrato. Comprobar hashes de originales y manifiestos antes/después; no editar las fuentes oficiales ni usar informes privados.

Playwright reserva `127.0.0.1:3318` con `reuseExistingServer:false`; el protocolo de volumen reserva `3317`. No reutilizar ni detener el proceso del usuario. Para un recorrido manual, en otra consola elegir un puerto libre:

```powershell
$puertoPrueba004 = 3340
if ($puertoPrueba004 -in [Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners().Port) {
    throw 'El puerto está ocupado. Elige otro sin detener el proceso existente.'
}
$env:PORT = [string]$puertoPrueba004
$env:NODE_ENV = 'production'
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

Abrir la dirección que anuncie ese proceso y crear un conjunto sintético de prueba. El cierre del proceso propio se realiza al terminar; no se cierran conjuntos del analista.

## Ejecutar las comprobaciones automatizadas

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:unit')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:contract')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:integration')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:e2e')
```

Si falta el navegador de pruebas, instalar Chromium en la caché del proyecto:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache/playwright'
.\scripts\run-with-toolchain.ps1 -NpmArguments @('exec','--','playwright','install','chromium')
```

Primero ejecutar los casos focales del incremento; una vez integrado el conjunto, ejecutar estas suites y el build. Repetir únicamente lo afectado por correcciones posteriores. Las suites deberán incorporar los escenarios siguientes; que las pruebas antiguas pasen no acredita por sí solo los requisitos nuevos.

## 1. Acciones, navegación e información

1. Cargar una demo e inspeccionar sin confirmar. Comprobar que no se recomienda Validar antes de la publicación.
2. Confirmar carga. La etapa Validar debe recibir tres pulsos de 1,5 s y conservar luego el realce estático. No hay etiqueta visible «Siguiente paso», cambio automático de pantalla ni movimiento de foco.
3. Repetir tras guardar destinos y aplicar: recomendaciones Recalcular y Descargar. Repetir con errores, cancelación, duplicación y respuestas tardías.
4. A 320, 390 y 1440 px, comprobar la acción verde de cada estado de la tabla de la especificación. Guardar, aplicar y descargar no deben competir con consultas/descarte como acciones principales.
5. Activar movimiento reducido antes de completar un hito: cero animaciones y misma señal estática. Comprobar teclado, anuncio accesible y foco. Contraste de textos ≥4,5:1 e indicadores necesarios ≥3:1 sobre el color final renderizado.
6. Recorrer Cargar, Validar, Recalcular, Descargar, comparación y detalle. No debe haber controles técnicos, hashes, identificadores internos ni volcados. Provocar exclusión de hoja, límite de archivo, caducidad y redondeo: deben verse causa, efecto y acción útil.
7. El progreso exitoso desaparece solo cuando aparece el resultado de la misma operación. Error, cancelación y estado incompleto no se borran como si hubiera éxito.

Evidencia: capturas por ancho, registro de foco, estilos/contrastes medidos, eventos/tiempos de animación y prueba separada de carreras. Cubre SC-001–003.

## 2. Conflictos COREP y edición de la decisión

Cargar el catálogo e informe COREP actuales. Validar y preparar la revisión:

- Grupo de r0070: elegir `v0174_m`, confirmar elección, volver a abrir, cambiar a otra candidata y finalmente recuperar `v0174_m`.
- Grupo de r0200: elegir «No recalcular esta celda» y confirmar.
- Mientras un radio tenga una elección local sin confirmar, Guardar configuración permanece inactivo y explica cómo continuar.
- El grupo resuelto conserva un resumen editable. No se ven botones «Conservar…» ni importes simulados en esta etapa.
- Deben quedar cinco incluidas, cuatro omitidas y siete excluidas. Guardar configuración y continuar a Recalcular.

En un caso específico de más de 50 candidatas, elegir la 51, volver a la primera página, comprobar el resumen y editar. Un candidato activo en otro destino debe indicar esa situación y no moverse silenciosamente. Comprobar caducidad, CAS, dos pestañas y respuesta incierta. Cubre SC-004.

## 3. Selección múltiple y aplicación

En la demo COREP:

1. Simular: aparecen cinco propuestas preseleccionadas, pero la casilla de aceptación para aplicar empieza vacía.
2. Desmarcar una, filtrar, cambiar de página si procede, salir y volver. La selección debe conservarse. Recargar recupera la edición del servidor, sin restaurar la aceptación.
3. Usar «Seleccionar todas las disponibles de este filtro»: afecta a todas las páginas coincidentes y conserva la selección exterior. El total declara qué queda fuera del filtro y de la página, sin sumar recuentos solapados.
4. «Limpiar selección» deja cero en toda la simulación y oculta la confirmación. Volver a seleccionar obliga a aceptar de nuevo.
5. En un caso con dependencias, quitar un antecedente: aparece en la página de pendientes y Aplicar queda inactivo. No se vuelve a marcar automáticamente.
6. Revisar las páginas de cambios, completar selección/cierre, aceptar y aplicar. Durante el trabajo no se edita la selección. La versión publicada y su descarga corresponden al recibo.
7. Repetir quitando y volviendo a añadir una propuesta después de aceptar: la aceptación previa queda invalidada aunque el contenido final coincida.

Resultados COREP conservados:

| Regla | Antes → después, EUR |
| --- | --- |
| v0174_m | 5 → 60 |
| v0173_m | 100 → 185 |
| v0176_m | 10 → 50 |
| v0175_m | 20 → 100 |
| v0172_m | 1.000 → 285 |

La revalidación conserva 14 pasa, 1 falla y 1 no aplicable. La demo Texto y fechas mantiene ocho resultados previstos y cero propuestas.

### Paginación, concurrencia y volumen

Preparar fixtures sintéticos identificados en las suites de contrato/integración: 51 disponibles más bloqueadas, antecedente fuera de página, filtros sin coincidencias y dos contextos compatibles de la misma entidad/fecha con las mismas coordenadas visibles. Las entidades/periodos distintos se aíslan entre conjuntos o se prueban como lote rechazado. Los fixtures de pruebas pueden usar las vías de compatibilidad de la API; no se reintroduce esa carga en la interfaz.

Comprobar recuentos y selección global, revisiones de cursor, respuesta antigua tras cambiar contexto, pérdida de respuesta, reintento de la misma operación, cancelación/timeout, cierre de workspace y cambio de base durante worker.

El caso de 100.000 seleccionables prueba transporte compacto y páginas. Identificar si se preparó un bundle sintético en la infraestructura de pruebas o se recorrió importación/simulación: no presentar el primero como recorrido integral del segundo. Medir tamaños de cuerpos y respuestas, páginas hidratadas en navegador, cuota/pico de estado, duración y posibilidad de cancelar. Ninguna petición JSON supera 1 MiB; no hay arrays globales en la UI nueva. Comprobar también hasta un millón de posiciones mínimas y rechazo del exceso, sin afirmar un millón de escrituras disponibles.

Aplicar por referencia y por arrays antiguos deben conservar resultados equivalentes en casos pequeños; enviar las dos formas simultáneamente debe rechazarse. Cubre SC-005–006 y regresiones SC-009.

## 4. FINREP: recorrido positivo

Descargar la nueva demo FINREP desde la aplicación. Comprobar fuente y hashes contra el [contrato FINREP](contracts/finrep-f0101.md), con datos y reglas identificados como sintéticos.

1. Crear conjunto nuevo. Cargar el catálogo propio y el informe visual FINREP. Contexto: entidad sintética, fecha de referencia 2025-12-31, EUR, escala 0, precisión 2; perfil FINREP F_01.01 del layout 4.0.
2. Inspeccionar. Se reconocen las 38 coordenadas, incluyendo los códigos no consecutivos. Confirmar la cobertura/exclusiones que procedan. La cabecera y formulario identifican FINREP.
3. Validar: cinco resultados, **2 pasa / 3 falla**. Las dos igualdades tienen destino único; dos desigualdades y un condicional son solo validación.
4. Guardar los dos destinos y simular. Deben aparecer **r0010: 90 → 100** y **r0380: 105 → 120**, ambas seleccionadas inicialmente. El valor 110 en el segundo destino sería un fallo de dependencias.
5. Revisar, aceptar y aplicar. Se crea una nueva versión y la validación queda en **4 pasa / 1 falla**; FIN_GREATER_FAIL sigue fallando deliberadamente.
6. Descargar los informes de la versión aplicada y abrir el Excel. Comprobar cuadrícula, etiquetas, estilos, importes y Contexto. Las partes/hojas excluidas conservadas no se consideran validadas.
7. En otro conjunto nuevo, cargar el Excel descargado con el mismo catálogo. Comprobar las 38 coordenadas y los mismos valores, contexto de negocio y cinco resultados finales. No exigir que coincidan identificadores transitorios de sesión/archivo.
8. Repetir desde una versión histórica y después de más de una aplicación, contrastando los valores de la versión solicitada y que no reaparezcan importes antiguos.

### FINREP: límites y preservación

- Mapping de 38 posiciones, 144 anclajes, ausencia/cero, decimales largos, escalas 0/3/6, precisión declarada y texto decimal exacto.
- Celda desplazada, código modificado, merges inesperados, fórmula en hoja seleccionada, porcentaje/fecha/hora en importe: rechazo antes de publicar.
- Libro completo con candidatos COREP y FINREP: elección requerida o contexto válido; nunca prioridad silenciosa de registro. Elección ajena o índice/hash de archivo obsoleto: rechazo.
- Libro con hojas adicionales y valores centinela: aceptación explícita de exclusiones y comparación de bytes descomprimidos de partes no autorizadas a cambiar.
- Contexto del formulario/libro incompatible, hoja reservada Contexto ajena y fuente alterada, faltante o de otro informe/workspace: error sin exportación alternativa silenciosa.
- Fórmulas permitidas en hojas excluidas: conservación como contenido opaco, sin ejecución. Macros, enlaces externos y demás prohibiciones globales mantienen su rechazo.
- Cuotas comprimidas/expandidas, CRC, cancelación y error del escritor: no dejar archivos parciales publicados ni reservas sin liberar.

Cubre SC-007–008. Repetir COREP y Texto y fechas para SC-009.

## 5. Rendimiento y cierre

Conservar el protocolo de validación de 003 como referencia, sin reutilizar sus tiempos como resultados de 004. Ejecutar el benchmark existente, con destino nuevo bajo `.cache/benchmark/004-reference/` y las opciones reales documentadas por `scripts/benchmark.mjs`. Registrar commit, entorno, hashes, carga auditada, muestras y resultados. La búsqueda mantiene el umbral de 1.000 ms desde la última entrada; la validación de referencia se mide con su protocolo de 500 reglas/100.000 lecturas y aceptación de al menos 9 de 10 ensayos ≤30 s, con los 10 ≤60 s.

Desde el commit limpio de la implementación, usar una carpeta de referencia nueva:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','prepare','.cache/benchmark/004-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','pilot','.cache/benchmark/004-reference')
```

Examinar el piloto y sus datos auditados. Si es válido, ejecutar la cohorte completa:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','cohort','.cache/benchmark/004-reference')
```

El protocolo mantiene su identificación `003-api-seeded-validation` porque se reutiliza para regresión; el directorio y commit identifican la entrega 004. Conservar los diez ensayos, incluidos fallos. Si ya existe la referencia, elegir otro directorio sin sobrescribirla.

Las medidas nuevas de selección se registran por separado. Un rechazo de cuota esperado demuestra conservación/diagnóstico, no éxito de un ensayo de capacidad.

Crear durante implementación `docs/verification-004.md` con:
- commit y herramientas, comandos ejecutados y resultados;
- correspondencia SC-001–009 con evidencia, incluidas negativas;
- hashes de fuentes, demos y salidas, y comparación de partes;
- tiempos, memoria/transporte y límites observados;
- incidencias pendientes y qué no se ha probado.

## 6. Observación humana SC-010

Con el producto disponible, pedir a Diego que complete una demo sin ayuda previa sobre dónde continuar. Registrar por separado si identifica la etapa recomendada tras carga, guardado y aplicación; resuelve y cambia un conflicto; desmarca una propuesta preseleccionada; y encuentra la descarga de la versión aplicada.

Anotar las acciones efectivamente observadas, la ayuda recibida y las incidencias. Una respuesta general favorable se registra como valoración global; no se convierte en prueba de cada paso. Esta observación queda pendiente durante planificación.
