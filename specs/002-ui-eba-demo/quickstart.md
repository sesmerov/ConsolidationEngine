# Guía de validación de la iteración 002

US1–US4 están implementadas: interfaz Material, inspección COREP, validación tipada y exportación
visual por versión. La [evidencia por incrementos](../../docs/verification-002.md) distingue
pruebas automáticas, fixtures controlados y recorrido humano. El cierre automatizado global pasa
1.430 pruebas, incluidos 33 E2E. La medición SC-007 cumple el criterio y la aceptación humana SC-008
sigue pendiente; la aceptación de 001
permanece como evidencia histórica independiente.

## Preparación y arranque

Desde la raíz del repositorio, PowerShell y toolchain fijada:

```powershell
.\scripts\bootstrap-toolchain.ps1
.\scripts\run-with-toolchain.ps1 -NpmArguments @('ci')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','prepare:templates')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','fixtures')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','build')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('start')
```

Node 24.22.2/npm 11.19.1 y Material/CDK 22.2.4 están fijados. Java 11 o superior permite generar
ANTLR; la generación registrada utiliza Java 17. Preparar las plantillas **antes** de `fixtures`,
que genera también las demos. El build empaqueta los mappings, las plantillas saneadas y las cuatro
descargas demo. Runtime no descarga plantillas ni depende de la caché de planificación.

Abrir `http://127.0.0.1:3000`. Conservar cualquier proceso con datos del usuario; las pruebas usan
procesos propios. El servidor E2E usa **3318**, con `reuseExistingServer:false`; el benchmark usa
**3317** y comprueba que escucha su propio proceso. La sesión de la aplicación sigue siendo efímera.

## Recorrido principal

La aplicación presenta **Cargar → Validar → Recalcular → Descargar**. Crear un conjunto de prueba
y seguir la [guía de demostraciones](../../docs/visual-demos.md), que contiene los pasos exactos,
las cinco selecciones y todos los resultados esperados. Cambiar de guía o descargar archivos no
importa datos ni configura destinos.

| Demo | Entrada | Validación inicial | Resultado tras aplicar |
|---|---|---|---|
| COREP | CA1: 110 posiciones, 15 valores y 95 blancos; EUR, unidades, dos decimales | 16 reglas: 7 pasan, 8 fallan y 1 no aplica | Cinco cambios explícitos; 14 pasan, 1 falla y 1 no aplica. |
| Texto y fechas | Libro propio Instrucciones/Datos/Contexto, seis campos | 8 reglas: 6 pasan y 2 fallan | Sólo validación; cero destinos, propuestas y parches. |

El corpus total tiene cinco reglas procedentes del catálogo EBA y diecinueve sintéticas; todos
los datos son sintéticos. Los condicionales COREP también son sólo de validación y se revalidan
tras cambiar otros datos. Las desigualdades no son igualdades recalculables. La
[matriz independiente](contracts/demo-corpus.md) y su [JSON](contracts/demo-corpus.json) fijan las
expectativas; la UI no las suministra como resultados del motor.

En Cargar, usar **Contexto del libro**, inspeccionar y revisar antes de confirmar. Para un libro
sin contexto de negocio completo, el formulario permite declarar entidad, fechas e indicadores;
COREP añade moneda, escala y precisión. El servidor determina el perfil y las coordenadas. Una
inspección lista dura 15 minutos; editar archivos/contexto requiere descartar y repetir la revisión.

En Validar/Recalcular, comprobar la tabla compacta y **Anterior → Propuesto**. El detalle
**Ver cálculo y origen** muestra las lecturas efectivas y distingue valores simulados de valores
recalculados por una aplicación anterior. Seleccionar v0172_m sin antecedentes debe informar las
cuatro dependencias; consultarlas no las selecciona. Cada una requiere elección expresa.

En Descargar, elegir una versión y consultar su resumen de perfiles, contexto y exclusiones.
Después de aplicar, **Descargar esta versión** usa `receipt.newVersionId`, aunque el histórico
conserve otra selección. Reimportar los libros descargados con el mismo catálogo en otro conjunto
de prueba: datos, tipos, presencia y resultados deben coincidir. Se crean fuentes/localizadores
nuevos, sin restaurar el historial de recibos. Los resultados incompletos se exportan con su estado.

## Cobertura del libro y formato anterior

La cobertura regulatoria visual se limita a **COREP_OF_4.0, C_01.00 / CA1**. Probar tanto el extracto
saneado como el libro oficial completo reconocido: una hoja incluida y **190 excluidas**. Sin
aceptar esa cobertura parcial no se publica. No se consumen datos de otras tablas ni destinos
externos. No se afirma soporte operativo de FINREP ni de todo COREP/DPM-XL.

`ce-demo-types-1` es un complemento propio, separado de EBA: texto exacto, fechas civiles sin hora,
y estados Informado/Sin dato para distinguir vacío informado y ausencia. Las reglas con texto,
fechas o condicionales nunca admiten recálculo, tampoco en ramas inactivas ni peticiones directas.

**Formato anterior ce-report-1** conserva la carga directa avanzada y el ejemplo antiguo de dos
reglas. Su [guía 001](../001-regulatory-validation/quickstart.md) documenta ese formato. El benchmark
masivo utiliza esta compatibilidad; CA1 sólo tiene 110 posiciones reportables.

## Límites y casos negativos

Límites generales: 500 filas de catálogo, 20 informes, 100.000 coordenadas/hechos; 10 MiB por archivo,
50 MiB comprimidos por lote y 100 MiB descomprimidos. Una tarea activa, 60 segundos de ejecución,
120 de recepción; 20 snapshots y cuotas separadas de 512 MiB para estado y archivos propios.
Los contratos detallan límites por perfil, grafo e instancias. Sesión y temporales se eliminan al
cerrar el conjunto o reiniciar el servidor; las descargas ya guardadas permanecen.

Usar fixtures separados y conservar los originales EBA:

- Peticiones directas, configuraciones obsoletas y selecciones mixtas con reglas excluidas:
  rechazo completo, sin propuestas bloqueadas de esas reglas ni parches parciales.
- Fechas inválidas, serial 60 de 1900, horas, condición nula y tipos incompatibles: diagnósticos
  previstos. La división por cero en una rama no elegida no se ejecuta.
- Fórmulas, anclas desplazadas, duplicados, importes ambiguos, DTD, contenido activo y cuotas:
  rechazo localizable y conjunto anterior intacto.
- Descarte/caducidad, cambio de base, replay con igual/distinta clave y cancelación/cierre:
  sin versiones duplicadas ni recursos huérfanos. Las pruebas indican cuándo usan reloj o fallos controlados.
- Exportación con escalas 0/3/6, cifras largas, cero, blanco, texto vacío, fechas y versiones históricas:
  roundtrip exacto y huellas de originales intactas. Los extractos exportados no son ficheros oficiales de remisión.

## Comprobaciones automatizadas

Tras preparar y compilar:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','typecheck')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:unit')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:integration','--','--maxWorkers=1','--no-file-parallelism')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:contract','--','--maxWorkers=1','--no-file-parallelism')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','test:e2e')
```

E2E necesita Chromium de Playwright instalado localmente. Los comandos anteriores describen cómo
verificar; los resultados realmente ejecutados se registran en [verificación 002](../../docs/verification-002.md).
No reutilizar cifras de la iteración anterior como cierre de estas suites.

## Rendimiento y aceptación

Comprobar teclado/foco, formularios, tablas y detalles a 320, 390 y 1440 px. La página no debe
desbordarse horizontalmente; las tablas anchas disponen de una región desplazable con teclado.
Revisar cifras largas, unidades/escala y estados comprensibles sin depender del color.

Para una referencia nueva del benchmark, elegir carpetas que todavía no existan.
Las rutas `002-reference` y `002-corep-load` de este checkout ya conservan la medición
cerrada; sustituirlas por nombres nuevos al repetir estos comandos:

```powershell
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','prepare','.cache/benchmark/002-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','pilot','.cache/benchmark/002-reference')
.\scripts\run-with-toolchain.ps1 -NpmArguments @('run','bench','--','cohort','.cache/benchmark/002-reference')
.\.tools\node\node-v24.22.2-win-x64\node.exe scripts/benchmark-corep.mjs .cache/benchmark/002-corep-load
```

Registrar hardware, commit y toolchain; separar piloto y diez ejecuciones sin descartes. SC-007
requiere al menos nueve ≤30 s y ninguna >60 s para 500 reglas/100.000 datos, con la carga medida
aparte. Medir por separado libro completo, extracto y recorrido CA1.

Resultado registrado: 10/10 ensayos auditados ≤30 s, máximo 15,778 s; carga media
30,204 s. La carga/publicación por API del extracto y libro completo CA1 fue 0,838 s
y 2,468 s, respectivamente, sin tiempo humano ni render del navegador.

SC-008 requiere que un analista identifique el valor anterior y posterior de dos cambios, complete
una demo y descargue la versión esperada. Registrar ayuda e incidencias comunicadas. Una aceptación
global sólo acredita aceptación global; no inferir pasos, tiempos u observaciones no comunicados.
