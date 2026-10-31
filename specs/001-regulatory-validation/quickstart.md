# Guía de validación de la primera versión

Estado a 2026-10-31: **diseño preparado, producto todavía no implementado**. Las rutas, scripts y
fixtures de aplicación descritos aquí son contratos para las siguientes fases. Hoy no hay
`package.json`, servidor, frontend ni parser generado; los comandos npm inferiores aún no son ejecutables.

## Comprobaciones que sí pueden hacerse ahora

Desde la raíz del repositorio, en PowerShell:

```powershell
specify integration status --json
.\.specify\scripts\powershell\check-prerequisites.ps1 -Json -RequireSpec
git status --short
```

La integración debe ser Codex y no informar archivos administrados ausentes/modificados. La
comprobación de prerrequisitos debe encontrar spec.md y plan.md. No se requiere tasks.md en esta fase.
Estas comprobaciones no prueban ninguna funcionalidad del motor.

## Entorno y preparación futuros

Instalar Node 24.22.2 con npm 11.19.1 y un JDK compatible con ANTLR (Java 11 o superior;
generación de referencia con JDK 17, registrando su versión exacta). El entorno observado tenía
Node 24.18.0/npm 11.16.0/Java 17.0.8; no se ha actualizado en esta fase.
Las versiones restantes están fijadas en [research.md](research.md), R1.

Después de que la implementación cree los manifiestos, lockfile, scripts y fixtures:

```powershell
npm ci
npm run generate:parser
npm run typecheck
npm run test:unit
npm run test:integration
npm run test:contract
npm run build
npm exec playwright install chromium
npm run test:e2e
npm run dev
```

`generate:parser` preparará copias de las gramáticas, verificará sus hashes y el checksum fijado
del jar ANTLR 4.13.2, y generará JavaScript ESM reproducible. No editará `grammar/`.
Los artefactos generados se excluirán de Git y se regenerarán antes de construir el motor.
La descarga inicial de dependencias/jar/navegador requiere red; el funcionamiento normal del
producto no enviará informes a terceros. El checksum exacto del jar se fijará al incorporar el
artefacto oficial durante implementación, antes de ejecutar la generación.

`dev` iniciará servicios en `http://127.0.0.1:4200` (web) y `http://127.0.0.1:3000` (API).
La API solo acepta la sesión local. El build de producción servirá web y API desde el puerto 3000.

## Fixtures y resultados esperados

Los futuros archivos de `tests/fixtures/` se crearán como datos sintéticos, salvo las expresiones
reales extraídas del catálogo con celda, versión y hash de origen. No usar informes privados.
El libro EBA completo supera el límite de 500 registros: no es el archivo de carga del recorrido.

| ID | Preparación y acción | Resultado esperado |
| --- | --- | --- |
| V01 | Plantilla válida y catálogo reducido; después cargar una copia con hecho duplicado. | Primera carga crea snapshot; segunda se rechaza con locador y conserva la versión anterior. |
| V02 | G169, v0190_m, COREP_OF_4.2, entidad SYNTHETIC, referencia/remisión 2026-06-30; filingIndicators `{"C_01.00":true,"C_05.01":true}`; valores 10.00 y 10.00, p=2. | Regla activa/aplicable y pasa. Segundo valor 10.02 hace fallar; 10.01 pasa por contacto de intervalos. |
| V03 | G113, v0002_h, COREP_OF_4.0, referencia/remisión 2025-12-31; filingIndicators `{"C_18.00":true}`; dos hojas finitas, total 12 y sumandos 5/7, p=2. | Una instancia por hoja; ambas pasan. Una hoja con total 11 falla sin afectar la otra. |
| V04 | Incluir variantes G169 y G170; elegir contexto 2026-06-30/4.2 e indicadores declarados de V02. | G169 aplica; G170 es inactiva/fuera de contexto. Permutar filas no cambia resultados. |
| V05 | Coordenada válida sin Facts, presence=null, valor 0, isnull/nvl/default y sum all-null. | Se conserva procedencia explícita/implícita; cero no es null; sum all-null es null con diagnóstico, no cero. |
| V06 | Puntuales A=11,B=5,C=7,D=22; igualdades A=B+C y D=A*2 con interval:false, destinos A/D elegidos. | Validación A falla; preview A12/D24; D requiere A; confirmar ambos crea nueva versión y conserva original. |
| V07 | A=1/3 p2, D=A*3 p2 con interval:true. Repetir A con interval:false. | Primer caso propone 0.33/0.99 y revalida; segundo no ofrece cambio aplicable porque 0.33 no satisface 1/3 puntual. |
| V08 | Ciclo A→B→A, consumidor C de B, rama E independiente; también A→A. | Ciclos identificados; C bloqueado por ciclo; E continúa. Ninguna iteración oculta. |
| V09 | Dos productores para A; productor fallido; productor cambia la precondición de D. | Conflicto incluso si valores coinciden; consumidores bloqueados sin fallback; condición reevaluada tras productor. |
| V10 | Crear preview, cambiar versión, aplicar preview anterior; repetir petición con misma Idempotency-Key. | 412 para preview obsoleta; reintento idéntico de aplicación válida devuelve mismo Job sin segunda escritura. |
| V11 | Cancelar/forzar timeout durante preview y aplicación antes de publicación. | Ningún cambio en snapshot vigente; Job cancelado/incompleto y temporales limpiados. |
| V12 | Expresión con time_shift, group by, error léxico al final y operación /0. | No evaluable para no soportadas; error para sintaxis/aritmética; ninguna aparece como pasa. |
| V13 | Fórmula, macro, XML con DOCTYPE, ZIP con ruta ascendente o expansión excesiva. | Rechazo antes de materializar datos; no acceso a red ni modificación del conjunto previo. |
| V14 | Valor textual 123456789012345678901234567890.123456789, cero y null; exportar/reimportar. | Igualdad exacta de valor/tipo/precisión/presencia y ceros en códigos. Valor numérico Excel en Facts se rechaza. |
| V15 | Bordes de intervalos, negativos, división puntual 1/3 y half-even de 1.005/1.015. | Resultados de language-profile; sin radio negativo ni radio espurio para puntos. |
| V16 | Exportar informe y resultados después de V06; cerrar workspace. | Nuevos archivos contienen versiones/cambios; originales intactos; temporales de sesión eliminados. |

Los alias A/B/C/D se materializarán como coordenadas de tablas sintéticas y expresiones válidas
del lexer, no se pasarán como si fueran sintaxis DPM-XL. Las fechas de V02–V04 se contrastaron con
las vigencias reales del catálogo; los demás datos son de prueba.

Las expresiones **y precondiciones** reales de G113/G169 se preservan intactas. Los mapas de
indicadores anteriores son declaraciones sintéticas del informe, no deducciones de sus hechos.
Para V02/V03 se preparan además variantes: indicadores true; false explícito que desactiva la
precondición (`not_applicable`); indicador necesario ausente (`not_evaluable` con
`MISSING_FILING_INDICATOR`); y true sin filas Facts. En esta última, el indicador y la precondición
siguen siendo true: el resultado de la expresión depende por separado de sus hechos/defaults,
sin presumir que la regla pasa. Comprobar también false and unknown determinista y que
exportar/reimportar conserva true/false/ausencia; un mapa inconsistente del mismo contexto rechaza
el lote, sin reemplazar el snapshot previo.

## Medición y recorrido del analista

El futuro `npm run bench` medirá 10 ejecuciones completas con 500 reglas admitidas y 100.000 hechos
desde fin de carga a resultado visible, registrando CPU, RAM, sistema operativo y versiones.
Objetivo SC-006: 9/10 en ≤30 segundos; ninguna ejecución supera 60 segundos sin terminar incompleta.
También registrar memoria, cuotas activadas y número de instancias expandidas. Un fixture que
excede cuotas no cuenta como benchmark satisfactorio del caso nominal.

Recorrer en navegador: plantilla → carga → cobertura → validación → detalle → destinos → preview →
clausura de dependencias → confirmación → comparación → exportación. Registrar los pasos y ayuda
necesaria para SC-007. El resultado debe mostrar entidad/periodo/versión y explicar la sesión efímera.

Al cerrar cada funcionalidad, ejecutar los scripts que correspondan a su alcance y registrar
resultados reales en su commit. Esta guía define expectativas; ninguna tabla anterior está marcada
como prueba ejecutada, conformidad regulatoria ni evidencia de rendimiento actual.
