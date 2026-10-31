# Investigación y decisiones de diseño

Fecha: 2026-10-31. Fase 0 de `$speckit-plan`. Las decisiones siguientes son el diseño de la
primera versión; no acreditan instalaciones, generación ANTLR ni pruebas del producto.
Se contrastaron la especificación, la constitución, los originales locales y documentación
primaria mediante dos investigaciones: stack/importación y lenguaje/semántica.

## R1. Versiones y organización

**Decisión.** Monorepo con npm workspaces: `apps/web`, `apps/api`, `packages/engine` y
`packages/contracts`. TypeScript estricto para el código propio; JavaScript ESM generado por ANTLR.
Las dependencias directas se fijarán sin rangos y las transitivas mediante `package-lock.json`.

| Componente | Versión objetivo |
| --- | --- |
| Node.js / npm | 24.22.2 / 11.19.1 |
| Angular core, common, compiler, compiler-cli, forms, router, platform-browser | 22.2.4 |
| Angular CLI y build | 22.2.5 |
| TypeScript / RxJS | 6.0.3 / 7.8.2 |
| Fastify | 5.12.7 |
| @fastify/multipart / @fastify/static | 10.1.6 / 10.1.8 |
| ANTLR herramienta y runtime `antlr4` | 4.13.2 / 4.13.2 |
| read-excel-file / write-excel-file | 9.3.14 / 4.1.1 |
| yauzl / sax | 3.4.0 / 1.6.1 |
| Vitest / jsdom / @playwright/test | 5.0.5 / 30.1.3 / 1.64.1 |

**Motivo.** Angular 22 admite Node 24 desde 24.15 y TypeScript 6.0; no se elige TypeScript 7 por
ser incompatible con ese intervalo. Fastify 5 y los plugins elegidos son compatibles entre sí.
Node objetivo incorpora un parche posterior al instalado. Se comprobó localmente Node 24.18.0,
npm 11.16.0 y Java 17.0.8; el objetivo Node/npm aún no está instalado. Java se usa solo para generar
el parser: ANTLR exige Java 11 o superior y el JDK 17 disponible satisface ese requisito funcional.
El manifiesto de generación registrará la versión exacta de Java utilizada.

**Alternativas.** Nx, microservicios y una base de datos añaden operaciones innecesarias a una
aplicación local de un analista. Express es viable, pero Fastify aporta validación de contratos
y pruebas HTTP por inyección sin un servidor externo. No se añade una librería de estado global
al frontend: componentes standalone, Signals y HttpClient cubren el flujo previsto. Angular 22
usa detección zoneless por defecto; no se añade zone.js.

**Fuentes.** [Compatibilidad Angular](https://angular.dev/reference/versions),
[pruebas Angular](https://angular.dev/guide/testing), [zoneless](https://angular.dev/guide/zoneless),
[versiones Node](https://nodejs.org/dist/index.json),
[actualización de seguridad Node](https://nodejs.org/en/blog/vulnerability/october-2026-security-releases).
Versiones y dependencias contrastadas en el registro primario:
[Angular core](https://registry.npmjs.org/@angular%2fcore/22.2.4),
[Angular build](https://registry.npmjs.org/@angular%2fbuild/22.2.5),
[TypeScript](https://registry.npmjs.org/typescript/6.0.3),
[Fastify](https://registry.npmjs.org/fastify/5.12.7),
[multipart](https://registry.npmjs.org/@fastify%2fmultipart/10.1.6),
[static](https://registry.npmjs.org/@fastify%2fstatic/10.1.8),
[Vitest](https://registry.npmjs.org/vitest/5.0.5),
[jsdom](https://registry.npmjs.org/jsdom/30.1.3),
[Playwright](https://registry.npmjs.org/@playwright%2ftest/1.64.1).

## R2. Generación y frontera del lenguaje

**Decisión.** Copiar las gramáticas originales a un directorio derivado con los nombres
`dpm_xlLexer.g4` y `dpm_xlParser.g4`; generar primero lexer y después parser con
`-Dlanguage=JavaScript -visitor -no-listener -encoding UTF-8 -Xexact-output-dir` y `-lib` apuntando
a la salida del lexer. Jar y runtime serán 4.13.2. Un visitor transformará el árbol a un AST
propio admitido por lista explícita. El evaluador no recorrerá código arbitrario ni ejecutará
`eval` o `Function`.

**Motivo.** Los nombres originales incluyen `-v0.9`, pero las declaraciones internas no.
La entrada `start` exige EOF; aun así, se registrarán errores tanto del lexer como del parser:
un árbol recuperado tras un error no autoriza evaluar. El catálogo admite una sola expresión
booleana por registro. La dirección del recálculo será configuración separada de una igualdad;
las sentencias `:=`, `<-` y los scripts quedan fuera de este perfil inicial.

**Alternativas.** Editar los originales impediría compararlos con la entrega EBA. Usar listeners
para calcular durante el parseo mezclaría errores sintácticos, resolución de referencias y datos.
Interpretar una igualdad como asignación no permite determinar un destino de escritura.

**Fuentes.** [ANTLR 4.13.2](https://github.com/antlr/antlr4/releases/tag/4.13.2),
[descargas](https://www.antlr.org/download.html),
[target JavaScript](https://github.com/antlr/antlr4/blob/4.13.2/doc/javascript-target.md),
[opciones](https://github.com/antlr/antlr4/blob/4.13.2/doc/tool-options.md).
Las fuentes locales y sus hashes están en [source-notes.md](source-notes.md).

## R3. Números, intervalos y discrepancia de documentación

**Decisión.** Perfil versionado `ce-dpmxl-0.9-closed-v1`: racionales exactos normalizados con
numerador/denominador `BigInt`, valor nominal separado del intervalo cerrado `[lo, hi]`.
Sin redondeo intermedio y sin convertir importes a `Number`. La precisión `p` produce radio
`10^-p / 2`; `INF` representa un punto exacto. Se admitirá `p` entero entre -18 y 18, o `INF`.
Es un límite local, no un límite atribuido a EBA.

**Motivo.** Information Model v0.9, página 15, describe números racionales. Una biblioteca decimal
de precisión fija tendría que redondear `1/3` antes de comparaciones posteriores. El tamaño de
numeradores y denominadores se limitará a 4096 bits para acotar el trabajo.

Se observó y verificó visualmente una inconsistencia en Operators v0.9, página 34: la fórmula
publicada de multiplicación puede producir un radio negativo para ciertos centros negativos;
la de división puede producir radio distinto de cero al dividir dos intervalos puntuales.
No se ha localizado una corrección oficial. No se modifica el PDF ni se afirma que la EBA haya
reconocido una errata.

El perfil usará suma/resta de extremos y mínimo/máximo de los cuatro productos o cocientes para
multiplicación/división. Un divisor cuyo intervalo contiene cero produce error. Esta elección
matemática está documentada como **diferencia explícita del perfil local**, no como transcripción
literal completa de DPM-XL v0.9. Las capacidades, resultados y exportaciones identificarán el perfil.
La arquitectura EBA/EIOPA remite al material de aritmética de intervalos Eurofiling, cuyo tutorial
muestra las cuatro combinaciones de extremos.

Las comparaciones, nulos, ámbitos, unidades y casos exactos se fijan en
[language-profile.md](contracts/language-profile.md). La igualdad de intervalos no es transitiva:
no se utilizará para claves, deduplicación ni ordenar el grafo.

**Alternativas.** Copiar literalmente las fórmulas inconsistentes produciría intervalos inválidos;
usar un epsilon global perdería la precisión declarada. Excluir todos los intervalos dejaría fuera
incluso reglas sencillas del catálogo. El perfil local delimita y hace visible la diferencia.

**Fuentes.** PDF locales Information Model p.15 y Operators pp.34, 39–43;
[EBA/EIOPA Taxonomy Architecture v2.0](https://www.eba.europa.eu/sites/default/files/2024-12/8fdac0fc-ddf7-4244-831c-20be53b2605a/EBA%20and%20EIOPA%20taxonomy%20architecture%20v2.0-20241218.pdf),
§9.5.8, p.39, y [tutorial Eurofiling](https://eurofiling.info/201606/Presentations/2016-06-03%20TUTORIALS.pdf),
p.63. No se ha comparado con una implementación normativa descargable ni probado conformidad.

## R4. Recálculos y dependencias

**Decisión.** Cada dirección elegida relaciona una instancia de igualdad con un destino único.
Las lecturas incluyen el lado calculado, precondiciones y selección de ámbito. Conflictos de
productores se detectan antes de ordenar. Kahn usa una cola estable por clave semántica;
Tarjan sobre el residuo identifica componentes cíclicos y separa sus consumidores bloqueados.
Una condición falsa, nula o fallida no permite sustituir silenciosamente el productor por su valor viejo.

El nominal calculado se cuantiza a la precisión declarada del destino con redondeo half-even,
política local visible en la propuesta. Los consumidores usan ese valor ya cuantizado, que es el
que se aplicaría. La propuesta conserva nominal exacto, intervalo derivado y redondeo. No se
ofrece un cambio si la regla originaria no queda satisfecha tras comprobar el candidato.

**Motivo.** El residuo de Kahn puede contener descendientes de un ciclo. La identidad no puede
depender de la fila del Excel. Aplicar el nominal exacto a consumidores y después redondear el
destino generaría una simulación distinta del informe finalmente guardado.

**Alternativas.** Resolver ecuaciones, iterar ciclos y elegir automáticamente un operando se
descartan por alcance. Una biblioteca de grafos no es necesaria para estos algoritmos acotados;
se probarán sus invariantes, ciclos, conflictos y orden estable.

## R5. XLSX y precisión de importación

**Decisión.** `read-excel-file` con `parseNumber: text => text` y `trim:false`, después de un
preflight ZIP/XML con `yauzl` y `sax`. `write-excel-file` generará plantilla y exportaciones.
Los importes de la plantilla se escribirán como cadenas decimales con tipo, unidad y precisión
separados. El formato completo se define en [workbook.md](contracts/workbook.md).

**Motivo.** El callback conserva el lexema numérico XML sin pasar por la precisión binaria de
JavaScript. Eso no puede recuperar dígitos ya perdidos al guardar números de más de 15 cifras
en Excel: la plantilla exigirá texto para los valores decimales. El preflight rechaza código,
relaciones externas de datos, XML inválido y expansión excesiva antes de materializar el libro.

**Alternativas.** Leer todo como `Number`, o usar un importador que ya lo convierta antes de
entregar el valor, perdería exactitud. No se selecciona el antiguo paquete `xlsx` del registro
npm ni un motor de fórmulas Excel; las reglas del producto se evalúan mediante DPM-XL.

**Fuentes.** [read-excel-file](https://github.com/catamphetamine/read-excel-file),
[write-excel-file](https://github.com/catamphetamine/write-excel-file),
[yauzl](https://github.com/thejoshwolfe/yauzl), [sax](https://github.com/isaacs/sax-js).
Versiones verificadas: [lector](https://registry.npmjs.org/read-excel-file/9.3.14),
[escritor](https://registry.npmjs.org/write-excel-file/4.1.1),
[ZIP](https://registry.npmjs.org/yauzl/3.4.0), [XML](https://registry.npmjs.org/sax/1.6.1).

## R6. Sesión local, concurrencia y publicación atómica

**Decisión.** Un workspace activo por proceso, snapshots inmutables en memoria y archivos temporales
locales identificados por UUID. No habrá base de datos ni recuperación de sesión entre reinicios.
La interfaz lo indicará y permitirá exportar. Cerrar el workspace cancela sus tareas y elimina sus
copias temporales; nunca elimina archivos originales ni exportaciones guardadas por el usuario.

Un único worker activo ejecutará importación, validación, simulación o aplicación. El hilo principal
posee el estado y publica un candidato solo tras comprobar su versión base, completar la revalidación
y verificar que no hubo cancelación. El cambio del puntero vigente es único y atómico. Una aplicación
completada puede contener reglas que fallan: no se confunde un resultado de validación con un fallo
de la operación técnica. Las ramas no aplicables al conjunto aceptado conservan sus valores.

**Motivo.** La carga es local y acotada; un worker mantiene la interfaz HTTP disponible y permite
terminar trabajo que excede el límite. `resourceLimits` no limita todos los buffers: cuotas de
bytes y complejidad siguen siendo obligatorias. La política de versión y selección cerrada se
concreta en [http-api.md](contracts/http-api.md).

**Alternativas.** Redis, colas externas y persistencia multiusuario exceden el primer alcance.
Ejecutar parseo y evaluación en el event loop impediría responder a cancelaciones a tiempo.
No se promete durabilidad de sesión frente a caída del proceso.

**Fuente.** [Node worker_threads](https://nodejs.org/api/worker_threads.html).

## R7. Verificación y cierre de incertidumbres

**Decisión.** Vitest para motor/API y componentes con jsdom; Playwright Chromium para recorridos
completos. Los fixtures combinarán reglas reales localizadas y datos sintéticos claramente rotulados.
La matriz de aceptación y los comandos futuros se recogen en [quickstart.md](quickstart.md).

**Motivo.** La corrección requiere comprobar semántica, versiones, importación/exportación y efectos
de aceptación/cancelación, además de compilar. Los objetivos de 500 reglas/100.000 hechos y 30 segundos
se medirán en un equipo descrito; no son resultados actuales.

**Alternativas.** Comprobar solo que ANTLR genera archivos o que el frontend renderiza no demuestra
la ejecución de reglas ni la integridad de los recálculos.

No quedan decisiones técnicas bloqueantes para esta fase. La diferencia de intervalos, el tratamiento
local de agregados vacíos, unidades, redondeo y almacenamiento efímero son decisiones explícitas del
perfil, no afirmaciones de equivalencia regulatoria. La implementación deberá contrastarlas con los
casos de aceptación; cualquier nueva fuente que cambie su significado requiere versionar el perfil.
