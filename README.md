# ConsolidationEngine

Aplicación local para validar informes Excel con reglas EBA, explicar los resultados y proponer
recálculos con dependencias. Angular Material presenta los datos; Node.js ejecuta el motor con
ANTLR JavaScript, aritmética exacta y ordenamiento topológico de Kahn. El analista revisa los
destinos, selecciona los cambios y confirma su aplicación. El sistema conserva versiones
anteriores y vuelve a validar después de aplicar.

La iteración 004 incorpora guía visual de etapas, acciones principales verdes, decisiones de conflictos editables, selección múltiple persistente y FINREP F 01.01. Su [registro de verificación](docs/verification-004.md) distingue pruebas ejecutadas, medidas y observación humana SC-010. Los resultados de [002](docs/verification-002.md), [003](docs/verification-003.md) y la [aceptación global de 001](docs/verification.md) se conservan como evidencia histórica; no acreditan por sí solos la interfaz ni los perfiles nuevos.

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
3. En **Recalcular**, simular y comparar **Anterior → Propuesto**. Las propuestas disponibles comienzan seleccionadas; se pueden desmarcar, seleccionar todas las disponibles del filtro o limpiar la selección completa. La selección se conserva al navegar y recargar. Si faltan antecedentes, se muestran para que el analista decida. La aceptación comienza desmarcada y se invalida al editar la selección. Aplicar publica una versión y vuelve a validar el conjunto.
4. En **Descargar**, guardar resultados o informes de una versión. El realce de la etapa completa indica dónde continuar tras confirmar la carga, guardar destinos utilizables o aplicar cambios: tres pulsos suaves de 1,5 segundos, o realce estático con movimiento reducido. Las acciones principales son verdes. La descarga de informes aplicados toma la versión del recibo y respeta la elección del selector histórico.

La cobertura regulatoria visual fijada es **COREP de fondos propios 4.0, C_01.00 / CA1** (110 posiciones) y **FINREP 4.0, F_01.01 / hoja 1.1** (38 posiciones). Se admiten los extractos empaquetados y el libro oficial reconocido. Si contiene varias plantillas compatibles, se pide elegir una por archivo. Las hojas excluidas requieren aceptación explícita; no se importan ni validan sus datos. Las demás tablas, tablas abiertas y cobertura general COREP/FINREP/DPM-XL quedan fuera del alcance. `FINREP_F0101_4.0` es un alias local de este layout, no un módulo XBRL oficial.

## Demostraciones

En **Cargar → Demostraciones guiadas**, descargar catálogo e informe del mismo ejemplo. Todos los
datos son sintéticos. Descargar una guía o cambiar de ejemplo no importa datos ni configura reglas.

| Ejemplo | Reglas | Resultado inicial | Recálculo |
|---|---:|---|---|
| COREP CA1 | Cinco procedentes del catálogo EBA y once sintéticas | 7 pasan, 8 fallan y 1 no aplica | Conservar `v0174_m` en r0070 y omitir el grupo r0200 deja cinco productores oficiales. Después pasan 14 reglas, falla 1 y 1 no aplica. |
| FINREP F 01.01 | 5 sintéticas | 2 pasan y 3 fallan | Dos cambios encadenados: 90 → 100 y 105 → 120. Después pasan 4 y falla 1 deliberadamente. |
| Texto y fechas | 8 sintéticas | 6 pasan y 2 fallan | Sólo validación, sin destinos ni propuestas. |

Son **29 reglas: cinco de origen EBA y veinticuatro sintéticas**. El ejemplo COREP muestra dos ramas
de dependencias con tres niveles. Los fallos deliberados se explican en la
[guía de demos](docs/visual-demos.md), que contiene los pasos, cinco cambios y resultados por regla.

En el perfil nuevo, las reglas que contienen condicionales, texto o fechas son **sólo de validación**,
incluso si su resultado es numérico o el tipo aparece en una rama no ejecutada. Las desigualdades
tampoco ofrecen destino porque no son igualdades. Las comprobaciones se repiten en API y motor.

La interfaz ofrece COREP, FINREP F 01.01 y el ejemplo tipado. Los conflictos se resuelven con opciones excluyentes y confirmación local; las decisiones pueden reabrirse y cambiarse. La API de compatibilidad conserva `ce-report-1` para pruebas y consumidores existentes. El rechazo FINREP registrado en 003 es evidencia histórica del punto de partida; el soporte y las comprobaciones actuales se documentan en [verificación de 004](docs/verification-004.md).

## Exportación, límites y sesión

`report.zip` contiene un libro por informe de la versión elegida y `changes.json`/`changes.xlsx`.
COREP y el ejemplo tipado usan plantillas saneadas: CA1 y Datos respectivamente. FINREP conserva el libro original, modifica solo los importes seleccionados y su contexto, y verifica la salida antes de publicarla. Sus hojas excluidas se conservan sin considerarlas validadas; si falta el original o ha cambiado, la exportación falla sin sustituirlo por una reconstrucción.
Los importes conservan su valor exacto y escala; una cifra que no pueda representarse con seguridad
como número Excel se escribe como texto decimal exacto. Texto, fechas civiles, vacío informado y
sin dato permanecen diferenciados. La salida anterior sigue usando `ce-report-1`.

En COREP las hojas excluidas no se reconstruyen. Son archivos de trabajo local reimportables, no ficheros
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

La medición de **004** con 500 reglas y 100.000 lecturas pasa **10/10 auditorías y ejecuciones ≤30 s**: rango **14,28–15,80 s**, mediana **15,05 s**, desde fin de carga hasta resultados visibles y cobertura comprobada. La carga se mide aparte: **28,50–30,54 s**. Es una referencia sintética `ce-report-1`, distinta de los recorridos visuales FINREP. La búsqueda automática de 500 reglas tarda **304–313 ms** en las cuatro comprobaciones. [Verificación y límites de 004](docs/verification-004.md) describe el protocolo, equipo, memoria, aviso de bundle y pendiente humano SC-010. Las mediciones de [002](docs/verification-002.md) y [001](docs/performance.md) se conservan como evidencia histórica.

## Documentos y desarrollo

- [Especificación 004](specs/004-flujo-claro-finrep/spec.md), [plan](specs/004-flujo-claro-finrep/plan.md), [tareas](specs/004-flujo-claro-finrep/tasks.md), [recorrido de comprobación](specs/004-flujo-claro-finrep/quickstart.md) y [verificación](docs/verification-004.md).
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
