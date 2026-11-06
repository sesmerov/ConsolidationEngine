# ConsolidationEngine

Aplicación local para validar informes Excel con reglas EBA, explicar los resultados y proponer
recálculos con dependencias. Angular Material presenta los datos; Node.js ejecuta el motor con
ANTLR JavaScript, aritmética exacta y ordenamiento topológico de Kahn. El analista revisa los
destinos, selecciona los cambios y confirma su aplicación. El sistema conserva versiones
anteriores y vuelve a validar después de aplicar.

Las funcionalidades US1–US4 de la iteración 002 están implementadas y tienen evidencia por
incrementos en [verificación 002](docs/verification-002.md). Pasan **1.430 pruebas**, incluidos
33 recorridos de navegador, además de typecheck, build y generación ANTLR reproducible. La nueva
medición de rendimiento cumple SC-007; la aceptación humana SC-008 sigue pendiente. Los resultados y la
aceptación global de la iteración 001 se conservan como [evidencia histórica](docs/verification.md);
no acreditan por sí solos la interfaz ni los perfiles nuevos.

## Instalación y arranque

Desde la raíz del repositorio, en PowerShell de Windows x64, con Java 11 o superior disponible
mediante `java` (la generación registrada usa Java 17):

```powershell
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','prepare:templates')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','fixtures')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','build')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

El bootstrap prepara Node **24.22.2** y npm **11.19.1** en `.tools/`, sin cambiar instalaciones
globales. Material/CDK **22.2.4** están fijados en los manifests y el lockfile. La primera preparación
requiere descargar dependencias y el JAR ANTLR verificado. `prepare:templates` reproduce las
plantillas saneadas a partir de las fuentes versionadas; debe preceder a `fixtures`, que genera
los ejemplos. Build genera el parser, compila API y Angular y empaqueta plantillas, demos y mappings.
Las descargas del producto no consultan la web ni necesitan los libros originales en runtime.

Abrir `http://127.0.0.1:3000`; ese proceso sirve web y API. Para detenerlo, usar Ctrl+C en su terminal.
Para desarrollo, una vez detenido el servidor propio anterior, ejecutar:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','dev')
```

Abrir `http://127.0.0.1:4200`. Angular recarga el frontend; los cambios del backend requieren
reiniciar el comando. No detener un proceso con datos de otra sesión para ejecutar pruebas.

## Cuatro etapas de trabajo

1. En **Cargar**, seleccionar catálogo e informes, revisar su contexto y confirmar las hojas que se importarán. La cabecera muestra el contexto único como texto y permite elegir cuando hay varios. La búsqueda por código alcanza todo el catálogo.
2. En **Validar**, consultar el resultado y abrir **Ver cálculo y origen** para revisar las entradas. **Preparar revisión de destinos** sugiere la celda cuando solo hay un lado elegible. El analista puede omitirla. Cuando hay dos lados posibles, elige el lado o la omisión. Si varias reglas apuntan a la misma celda, decide cuál conservar o si omitir el grupo. **Guardar configuración** publica esas decisiones.
3. En **Recalcular**, simular, comparar **Anterior → Propuesto** y seleccionar cada cambio y sus predecesores. La confirmación aparece con la primera selección y cuenta las propuestas de todas las páginas. Aplicar publica una versión con los valores elegidos y vuelve a validar el conjunto.
4. En **Descargar**, guardar resultados o informes de una versión. **Siguiente paso** señala la etapa disponible tras publicar la carga, guardar destinos utilizables o aplicar cambios. La descarga de informes aplicados toma la versión del recibo y respeta la elección del selector histórico.

La cobertura regulatoria visual es **COREP de fondos propios 4.0, C_01.00 / CA1**: 110 posiciones.
Se admite el extracto saneado o el libro oficial completo reconocido. En este último se incluye
CA1 y se muestran **190 hojas excluidas**, cuya cobertura parcial hay que aceptar. No se importan
las otras tablas. FINREP, tablas abiertas y cobertura general de COREP/DPM-XL quedan fuera del alcance.

## Demostraciones

En **Cargar → Demostraciones guiadas**, descargar catálogo e informe del mismo ejemplo. Todos los
datos son sintéticos. Descargar una guía o cambiar de ejemplo no importa datos ni configura reglas.

| Ejemplo | Reglas | Resultado inicial | Recálculo |
|---|---:|---|---|
| COREP CA1 | Cinco procedentes del catálogo EBA y once sintéticas | 7 pasan, 8 fallan y 1 no aplica | Conservar `v0174_m` en r0070 y omitir el grupo r0200 deja cinco productores oficiales. Después pasan 14 reglas, falla 1 y 1 no aplica. |
| Texto y fechas | 8 sintéticas | 6 pasan y 2 fallan | Sólo validación, sin destinos ni propuestas. |

Son **24 reglas: cinco de origen EBA y diecinueve sintéticas**. El ejemplo COREP muestra dos ramas
de dependencias con tres niveles. Los fallos deliberados se explican en la
[guía de demos](docs/visual-demos.md), que contiene los pasos, cinco cambios y resultados por regla.

En el perfil nuevo, las reglas que contienen condicionales, texto o fechas son **sólo de validación**,
incluso si su resultado es numérico o el tipo aparece en una rama no ejecutada. Las desigualdades
tampoco ofrecen destino porque no son igualdades. Las comprobaciones se repiten en API y motor.

La interfaz de carga ofrece el perfil visual COREP y el ejemplo tipado. La API de compatibilidad conserva `ce-report-1` para pruebas y consumidores existentes. En la prueba FINREP, la inspección del extracto F_01.01 terminó con `INVALID_WORKBOOK`. Sobre las mismas cuatro cifras en el formato de compatibilidad, el motor evaluó las dos reglas del catálogo propio y obtuvo los resultados previstos. [Ensayo FINREP](specs/003-simplificar-flujo/evidencia.md)

## Exportación, límites y sesión

`report.zip` contiene un libro por informe de la versión elegida y `changes.json`/`changes.xlsx`.
Los perfiles visuales usan plantillas saneadas: CA1 para COREP y Datos para el ejemplo tipado.
Los importes conservan su valor exacto y escala; una cifra que no pueda representarse con seguridad
como número Excel se escribe como texto decimal exacto. Texto, fechas civiles, vacío informado y
sin dato permanecen diferenciados. La salida anterior sigue usando `ce-report-1`.

Las hojas excluidas no se reconstruyen. Son extractos de trabajo local reimportables, no ficheros
oficiales de remisión. Para reimportarlos, extraer los informes y cargarlos con su catálogo;
se crean nuevas fuentes y localizadores, sin restaurar recibos históricos. `results.zip` contiene
los resultados de la ejecución elegida en JSON y XLSX, incluido su estado si quedó incompleta.

- Una entidad/fecha y un conjunto activo; hasta 500 filas de catálogo, 20 informes y
  100.000 coordenadas/hechos. Máximo 10 MiB por archivo, 50 MiB comprimidos por lote y
  100 MiB descomprimidos. Los perfiles visuales tienen además su estructura cerrada.
- Una inspección viva por conjunto, con 15 minutos desde que queda lista. Confirmarla exige
  la misma base y aceptar sus exclusiones. Una tarea activa, hasta 60 segundos de trabajo y
  120 segundos para recibir archivos. Los límites completos están en capacidades y contratos.
- La sesión local se recupera al refrescar el navegador, pero termina al cerrar el conjunto o
  reiniciar el servidor. Hasta 20 snapshots y cuotas separadas de 512 MiB de estado y de archivos.
  Las descargas guardadas por el usuario sobreviven al cierre.
- Un fallo o cancelación anterior a publicar conserva la versión vigente. Cancelar después no
  deshace una aplicación publicada. Una aceptación sin cambio se audita con `changed:false`.

La medición de la iteración 002 de 500 reglas y 100.000 datos pasó **10/10 ejecuciones ≤30 s**, con máximo
**15,78 s** desde fin de carga hasta resultados visibles; las diez auditorías completas pasan. La carga se mide
aparte: media **30,20 s**. Equipo Ryzen 5 3600X/32 GB, Windows 11. CA1, con 110 posiciones,
se mide por API de forma independiente: **0,84 s** para el extracto y **2,47 s** para el libro
completo hasta publicar. [Protocolo y límites](docs/verification-002.md) explican ambas medidas;
el [rendimiento de 001](docs/performance.md) se conserva como evidencia histórica.

## Documentos y desarrollo

- [Recorrido y comprobaciones de la iteración 003](specs/003-simplificar-flujo/quickstart.md), [revisión de destinos](specs/003-simplificar-flujo/contracts/direction-review.md) y [registro de verificación 003](docs/verification-003.md).
- [Inicio y comprobaciones 002](specs/002-ui-eba-demo/quickstart.md), [demos](docs/visual-demos.md)
  y [evidencia ejecutada](docs/verification-002.md).
- [Especificación 002](specs/002-ui-eba-demo/spec.md), [plan](specs/002-ui-eba-demo/plan.md),
  [tareas](specs/002-ui-eba-demo/tasks.md) y [modelo](specs/002-ui-eba-demo/data-model.md).
- Contratos de [HTTP](specs/002-ui-eba-demo/contracts/http-api.md),
  [libros y perfiles](specs/002-ui-eba-demo/contracts/workbook-profiles.md) y
  [lenguaje](specs/002-ui-eba-demo/contracts/language-profile.md).
- [Toolchain y scripts](scripts/README.md), [constitución](.specify/memory/constitution.md)
  y [guía histórica 001](specs/001-regulatory-validation/quickstart.md).

Spec Kit organiza el trabajo y Git conserva commits por funcionalidades verificadas. Los
originales EBA y las gramáticas permanecen intactos; la generación comprueba sus hashes.
Cargas, temporales, descargas y credenciales locales no se incorporan al repositorio.
La revisión por recibos permanece `disabled/unmanaged`; los checklists de Spec Kit son documentales.
