# Guía de validación de la iteración 002

Estado: guía para ejecutar **después de implementar** las tareas. Las nuevas descargas,
inspecciones, perfiles y componentes no existen todavía en el producto. La planificación
y las pruebas históricas no acreditan la ampliación.

## Preparación y ejecución

Desde la raíz del repositorio, PowerShell y toolchain fijada:

```powershell
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','fixtures')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','build')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

Son comandos existentes. La implementación ampliará `fixtures` para producir los conjuntos
desde manifiestos/fuentes versionados, y el build empaquetará assets saneados. Material/CDK
22.2.4 deben estar fijados en manifests/lockfile antes de `npm ci`; esta fase no los instala.
No se descargan plantillas en runtime ni se depende de la caché de planificación.

Abrir `http://127.0.0.1:3000`. Si ese puerto contiene datos del usuario, conservarlo: las
pruebas requieren un proceso aislado o una ventana de ejecución acordada, nunca borrar
datos ni matar el servidor para liberar el puerto. La sesión continúa siendo efímera.

## Recorrido COREP

1. Crear un conjunto de prueba y descargar catálogo e informe de la nueva demo COREP.
   Son datos sintéticos sobre CA1, no un informe real de una entidad.
2. Elegir ambos archivos y usar Contexto del libro: SYNTHETIC, referencia/envío
   2025-12-31, framework COREP, módulo COREP_OF_4.0, EUR, unidades, dos decimales e
   indicador C_01.00 declarado. Revisar estos datos antes de confirmar.
3. Inspeccionar: 110 coordenadas, 15 valores y 95 blancos, sin cambiar el conjunto
   vigente. Confirmar carga y pasar a Validar.
4. Validar: **7 pasan, 8 fallan y 1 no aplica**, sin errores ni no evaluables en la demo
   normal. Contrastar cada regla con [la matriz](contracts/demo-corpus.md).
5. DEMO_IF_THEN y DEMO_IF_ELSE indican «Solo validación» y no ofrecen destinos. Las
   desigualdades tampoco ofrecen destinos; su motivo es no ser una igualdad.
6. Configurar únicamente las cinco reglas oficiales v0172_m, v0173_m, v0174_m, v0175_m
   y v0176_m hacia el lado izquierdo. Guardar y simular.
7. Revisar: r0070 **5 → 60,00**, r0030 **100 → 185,00**, r0150 **10 → 50,00**,
   r0130 **20 → 100,00**, r0020 **1000 → 285,00 EUR**. Fórmula, lecturas y origen están
   en detalle; la tabla principal no imprime hashes o claves JSON.
8. Seleccionar primero v0172_m: faltan sus cuatro antecedentes. Consultarlos y elegirlos
   expresamente. Cambiar etapa/filtros conserva selección válida; ninguna dependencia
   se acepta sola. Revisar el resumen completo y marcar la confirmación de aplicación.
9. Aplicar: cinco valores modificados, nueva versión y revalidación **14 pasan, 1 falla
   y 1 no aplica**. DEMO_LT_FAIL sigue fallando intencionadamente. Los condicionales
   se revalidan, pero no aparecen entre propuestas ni cambios aplicados.
10. Consultar comparación compacta y «Ver cálculo y origen». La confirmación anterior
    deja de aparecer como un trabajo pendiente después del éxito.
11. Pulsar «Descargar esta versión». Corresponde al newVersionId aplicado aunque el
    histórico tenga otra versión seleccionada. CA1 conserva su disposición y los cinco
    valores; se acompaña de Contexto/Instrucciones y registro de cambios.
12. Reimportar la salida en un conjunto de prueba independiente con el mismo catálogo y
    contexto: datos/resultados coinciden. No se restaura el historial de aplicaciones.

La guía utiliza un extracto saneado. Probar además el **libro oficial completo** con los
mismos valores CA1: una hoja incluida y 190 excluidas. Sin aceptar esa cobertura no se
publica; al aceptarla produce los mismos datos CA1. No consume valores de otras tablas
ni destinos externos. Registrar carga e inspección de ambos formatos por separado.

## Recorrido tipado, solo validación

Descargar catálogo e informe `ce-demo-types-1` y cargarlos por inspección, sustituyendo
solo el conjunto de prueba al confirmar. Contexto DEMO/DEMO_TYPES_1, datos y estados
Informado según su contrato. No se preparan columnas de coordenadas.

Esperado: **ocho reglas, seis pasan y dos fallan** por diferencias de mayúsculas y espacio
final. Texto vacío y ausencia se distinguen. 2024-02-29 y 2025-12-31 se interpretan como
fechas civiles sin desplazamientos horarios. Todas indican «Solo validación»; no hay
destinos, propuestas ni aplicación. Se exportan resultados e informe y se comprueba
reimportación exacta de valores/tipos/presencia.

## Casos negativos y controles del servidor

Usar fixtures separados, sin alterar los originales EBA:

- Condicional numérico a la derecha de una igualdad, anidado o en precondición, texto/
  fecha solo en una rama inactiva: ningún destino ni propuesta.
- Petición directa y dirección interna obsoleta: rechazo completo, sin propuestas
  bloqueadas de esas reglas ni parches parciales.
- Fecha inválida, serial 60 de 1900, hora no admitida, condición nula y tipos incompatibles:
  diagnóstico previsto. División por cero en una rama no elegida no se ejecuta.
- Fórmula en CA1, anclas desplazadas, duplicados, importe ambiguo, DTD, contenido activo,
  hojas no reconocidas y límites: rechazo localizable, conjunto anterior intacto.
- Inspeccionar y descartar/caducar; cambiar base; repetir commit con igual/distinta clave;
  cancelar/cerrar durante publicación: sin versiones duplicadas, datos parciales ni huérfanos.
  Usar reloj y fallos controlados en pruebas, distinguiéndolos de cargas reales.
- Exportar escalas 0/3/6, cifras largas, cero/blancos/texto vacío/fechas e históricos:
  roundtrip exacto y originales intactos.

## Comprobaciones automatizadas

Después de implementar, ejecutar las suites existentes ampliadas:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','typecheck')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:unit')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:integration')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:contract')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:e2e')
```

E2E necesita puerto/proceso aislado según su configuración y navegador Playwright local.
Los nombres de pruebas nuevas se concretarán en tasks.md. No se afirma que estas suites
hayan corrido durante planificación.

## Interfaz, rendimiento y aceptación

Guardar capturas y comprobar teclado/foco, formularios, tablas y detalles a 320, 390 y
1440 px. Sin desbordamiento de página; tabla ancha con desplazamiento propio identificado.
Revisar cifras largas, unidades/escala y estados independientes del color.

El benchmark existente se adaptará a la interfaz nueva:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','prepare','.cache/benchmark/002-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','pilot','.cache/benchmark/002-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','cohort','.cache/benchmark/002-reference')
```

Ruta nueva por referencia, hardware/commit/toolchain registrados, pilotos separados y
diez ejecuciones sin descartes. El conjunto de 100 000 datos usa formato anterior compatible;
CA1 no tiene 100 000 celdas reportables. Registrar aparte el recorrido del libro completo,
extracto e intercambio CA1.

La aceptación humana debe registrar identificación de dos cambios, demo completada,
versión descargada, ayuda e incidencias comunicadas. No inferir pasos o tiempos que el
usuario no haya observado o indicado.
