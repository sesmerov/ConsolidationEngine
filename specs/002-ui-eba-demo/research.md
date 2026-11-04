# Investigación y decisiones de diseño

Fecha: 2026-11-04. Base: `d91a350` y aclaración `b65ae6e`. Fase 0 de Spec Kit.
Se inspeccionaron código, contratos anteriores, fuentes XLSX y documentación primaria.
Las decisiones siguientes están cerradas para planificar; no acreditan implementación.

## R1. Condicionales, texto y fechas: solo validación

**Decisión:** crear el perfil `ce-dpmxl-0.9-closed-v2`. Clasificar estáticamente toda
la expresión y precondición formal antes de resolver cualquier dirección. La presencia
de un condicional, literal u operación de texto/fecha, o referencia a una coordenada de
esos tipos excluye la regla entera del recálculo, incluso en una rama inactiva o con
resultado numérico. La razón estable será `RULE_VALIDATION_ONLY`, con motivos
`CONDITIONAL`, `TEXT`, `DATE`. No se inspeccionan descripciones ni fechas administrativas.

**Motivo:** instrucción explícita del usuario. El servidor decide la elegibilidad;
ocultar controles en Angular no basta. `resolveDirection` se comparte entre consulta,
configuración y cálculo, pero la simulación actual genera propuestas bloqueadas para
direcciones inválidas. Para obtener cero propuestas de estas reglas se rechazará la
configuración completa antes de construir el grafo, también al simular y aplicar.
La revalidación posterior sí vuelve a evaluar las reglas excluidas sobre los nuevos datos.

**Alternativas descartadas:** permitir una rama numérica, detectar palabras en texto,
examinar solo el destino, o publicar una propuesta bloqueada de una regla excluida.

## R2. Compatibilidad y tipos

**Decisión:** conservar `ce-dpmxl-0.9-closed-v1` para `ce-report-1` y sus resultados,
incluidos sus recálculos booleanos existentes. Los adaptadores nuevos seleccionan v2
en el servidor; el cliente no elige un perfil para eludir controles. V1 sigue rechazando
los nuevos nodos y datos. V2 permite recálculos numéricos simples elegibles; sus
condicionales, textos y fechas son solo de validación.

Los valores normalizados conservan `Rational | boolean` y añaden objetos inequívocos
`{kind:"text",value:string}` y `{kind:"date",value:"YYYY-MM-DD"}`. No se usan cadenas
sin tipo ni números binarios para importes. Texto/fecha llevan unidad y precisión vacías;
el tipo de un nulo sigue en su coordenada. Una fecha civil no es un instante horario.

**Motivo:** ampliar los contratos sin reinterpretar valores y fuentes anteriores. La
sesión es efímera: no hay migración de una base de datos ni restauración de snapshots
de otro proceso. Los perfiles y formatos se versionan, no se presentan como equivalentes.

**Alternativas descartadas:** modificar silenciosamente v1, aceptar cualquier cadena
como número/fecha, o reutilizar `ce-report-1` para que el usuario prepare hechos tipados.

## R3. Semántica ampliada acotada

**Decisión:** usar la gramática original sin cambios. Soportar `if … then … else … endif`,
literales de texto —incluido el literal vacío— y fechas `#YYYY-MM-DD#`. La forma temporal
con hora, aunque la gramática la reconozca, queda fuera. Los tipos de condición y ambas
ramas se comprueban estructuralmente; solo se ejecuta la rama elegida. Un error dinámico
como división por cero en la rama omitida no se ejecuta. Condición nula que impide decidir
produce `not_evaluable`; tipo incompatible produce diagnóstico. No se inventan variables
estándar EBA para entidad o fecha del contexto.

Texto: igualdad/desigualdad sensibles a mayúsculas, espacios y contenido Unicode, sin
normalización oculta; no regex, concatenación ni ordenación lingüística. Fechas civiles:
comparaciones de calendario, fecha válida obligatoria y sin conversiones de zona horaria.
Los límites de sintaxis, trabajo y racionales existentes se mantienen.

**Motivo:** la gramática reconoce estas construcciones, pero AST, tipos y evaluador
actuales no las implementan. Hace falta soporte y pruebas en todas las capas.

**Alternativas descartadas:** ejecutar expresiones como código, coerción implícita entre
texto/fecha/número, o contar un resultado no evaluable como demostración de soporte.

## R4. Fuente COREP y correspondencia de celdas

**Decisión:** perfil `eba-corep-of-4.0-ca1-v1`, hoja CA1 de la fuente ITS identificada en
[inspection.md](inspection.md). Son 110 posiciones: códigos B5:B114, conceptos D,
importes E. Se cruzaron por código con la hoja anotada C_01.00: las 110 tienen identificador
DPM y marcador monetario. Las etiquetas difieren entre fuentes en 17 posiciones; no se
usan etiquetas iguales como unión. El contrato incorpora el manifiesto completo y sus
fuentes. El libro anotado se usa para diseñar el adaptador, nunca como importes cargados.

Reconocimiento: perfil seleccionado/detectado más anclas estructurales de contenido
decodificado y posiciones, ignorando solo las celdas de datos permitidas. Nombres,
hash del archivo completo o colores solos no identifican un informe cumplimentado.
Filas insertadas o etiquetas/códigos modificados se rechazan en este perfil inicial.
Se admite el libro completo y un extracto CA1; la salida propia añade contexto legible.

**Motivo:** una cobertura concreta y reproducible evita interpretar cualquier Excel por
parecido. El framework 4.0 es una base del proyecto, no una afirmación sobre la versión
regulatoria más reciente. FINREP se localizó, pero está fuera de esta iteración.

**Alternativas descartadas:** inferir todas las tablas EBA, desplazar filas por heurísticas,
o trasladar las antiguas ecuaciones A/B/C/D a conceptos oficiales como si fueran reales.

## R5. Preflight del libro completo

**Decisión:** preflight específico y disperso para el perfil COREP; mantener el preflight
estricto de los formatos anteriores. El original tiene 191 hojas, 639 entradas ZIP,
7 905 907 bytes expandidos y 166 645 celdas físicas. Aunque CA1 termina en J114, otras
hojas contienen celdas en XFD: no sirve ampliar un bitmap de filas por columnas.

El perfil limita a 256 hojas, 1 024 filas por hoja, 16 384 columnas, 500 000 celdas
físicas por libro y 100 000 por hoja, con índice disperso y cuotas ZIP/XML existentes.
No se relajan tamaños de archivo/lote, CRC, rutas, DTD, profundidad, tiempo ni memoria.
Se inspeccionan todas las entradas de forma acotada, pero solo CA1 produce datos.

Las 72 fórmulas fuera de CA1 y los 22 XML de enlaces externos del original no se evalúan.
Sus relaciones `externalLinkPath` y `externalLinkLongPath` se aíslan: sin acceso a destinos
ni consumo de valores almacenados. Se rechazan fórmulas en celdas reportadas, DDE/OLE,
macros y contenido activo. La excepción de metadatos inertes pertenece solo a este perfil
reconocido; no es una autorización general para documentos externos.

**Motivo:** el original no cabe en el límite anterior de 64 hojas y contiene columnas
muy alejadas. El reconocimiento debe preceder a cualquier excepción y nunca a las
protecciones generales de ZIP/XML.

**Alternativas descartadas:** eliminar límites, aceptar enlaces arbitrarios globalmente,
copiar datos almacenados por fórmulas o mantener una matriz densa de presencia de celdas.

## R6. Inspección y publicación atómica

**Decisión:** nuevo recurso `ImportInspection` con un único lote retenido por workspace,
TTL fijo de 15 minutos y candidato privado inmutable contado en la cuota de estado.
Los archivos quedan bajo una lease del gestor de archivos, también contada. La inspección
es un Job que no publica snapshot. El usuario revisa contexto, tabla incluida y exclusiones;
el commit usa su hash, aceptación de cobertura, ETag y clave de idempotencia.

No se vuelve a interpretar el libro al confirmar: se verifica la identidad de las copias
retenidas y se transfiere el candidato mediante publicación atómica y comprobación final
de base/cancelación/cuotas. Si el commit se acepta antes de caducar, la lease pasa al Job
con su plazo de 60 segundos; no caduca a mitad. Replay se resuelve antes de exigir un
recurso vivo o la base actual. Cierre, descarte, caducidad y error liberan recursos propios.
La ruta anterior de importación queda reservada al formato anterior.

**Motivo:** revisar una carga no debe sustituir datos. Reutilizar candidato y archivos
verificados evita doble interpretación y condiciones de carrera. Se conserva un solo
Job no terminal total y 512 MiB de estado canónico más 512 MiB de archivos propios.

**Alternativas descartadas:** publicar antes de confirmar, retener objetos fuera de cuotas,
admitir staging ilimitado o permitir que el cliente suministre coordenadas/AST al commit.

## R7. Contexto y exportación visual

**Decisión:** recoger entidad, referencia, envío, módulo, divisa, escala y precisión en
un formulario y conservar su origen declarado. El formato visual de la celda no define
precisión regulatoria. El decimal crudo de OOXML se convierte exactamente; escala y
precisión tienen una definición en unidades base, especificada en el contrato de plantilla.

Exportar desde una plantilla saneada del producto derivada de la fuente verificada;
escribir solo datos y contexto declarados, conservar códigos, etiquetas y disposición
CA1 y acompañar registro de cambios/exclusiones. No copiar el paquete subido ni fórmulas
o enlaces ajenos. La salida se reconoce y reimporta sin restaurar recibos históricos.

**Motivo:** mantener un informe reconocible y una correspondencia exacta sin transportar
contenido no admitido. No se promete remisión oficial al supervisor.

**Alternativas descartadas:** reconstruir únicamente `Facts`, copiar íntegro el OOXML del
usuario, inferir divisa/precisión por formato visual o exportar importes arbitrarios como
números de Excel perdiendo cifras.

## R8. Interfaz Material y tablas

**Decisión:** fijar `@angular/material` y `@angular/cdk` en **22.2.4**; mantener Angular
22.2.4, TypeScript 6.0.3 y RxJS 7.8.2. El registro npm confirmó peers compatibles y
dependencia exacta Material→CDK. No se han instalado paquetes.

Tema SCSS mediante APIs públicas (`mat.theme`, overrides), densidad 0, fuentes de sistema
e iconos locales. Retirar reglas globales invasivas para controles. No elevar preventivamente
los presupuestos existentes de bundle: 700 kB aviso, 1 MB error. Un `WorkspaceShell` alberga
las cuatro etapas; stores y borradores viven durante el workspace, no durante una página.

Tablas Material con filas recibidas del servidor, paginador Anterior/Siguiente de 50 filas
y pila de cursores; sin nueva ordenación interactiva. No usar filtrado local de una sola
página como si fuera el conjunto. Propuestas conservan orden Kahn. Las selecciones se
mantienen al navegar, pero la confirmación se invalida al cambiar selección o base.

**Motivo:** adoptar Material no resuelve la jerarquía ni la vida del estado. Los stores
actuales están ligados a páginas y se borrarían al desmontar una etapa. Los cursores HMAC
existentes permiten paginar sin nuevas consultas globales ni acumular todo en DOM.

**Alternativas descartadas:** cambiar solo CSS, introducir una cuadrícula con navegación
no implementada, descargar todos los resultados para ordenar o cargar fuentes externas.

Fuentes primarias verificadas:
[Material 22.2.4](https://registry.npmjs.org/@angular/material/22.2.4),
[CDK 22.2.4](https://registry.npmjs.org/@angular/cdk/22.2.4),
[compiler-cli 22.2.4](https://registry.npmjs.org/@angular/compiler-cli/22.2.4),
[tablas](https://github.com/angular/components/blob/main/src/material/table/table.md),
[temas](https://github.com/angular/components/blob/main/guides/theming.md).

## R9. Demos y expectativas independientes

**Decisión:** 16 reglas COREP (cinco oficiales y once sintéticas) más ocho reglas tipadas
en `ce-demo-types-1`. Periodo/envío COREP: **2025-12-31**, dentro de la vigencia comprobada
2025-03-31 a 2026-03-30 de las variantes elegidas. Mantener todos sus campos EBA, incluida
precondición y políticas `default:0`/`interval:true`. Configurar únicamente las cinco
reglas oficiales numéricas con destino izquierdo. Cadena real de tres niveles:
v0174_m → v0173_m → v0172_m; la segunda rama pasa por v0176_m → v0175_m → v0172_m.

El complemento tipado usa campos etiquetados y un estado «Informado/Sin dato» para separar
texto vacío y nulo. Es propio, sin atribuir fechas/texto a importes COREP. Todas sus reglas
son solo de validación. La matriz describe valores y resultados esperados, no resultados
del motor nuevo. Casos negativos están separados de los libros principales.

**Motivo:** demostrar funciones con datos importados, conservar una demo que pueda
completarse y distinguir fallo intencionado de falta de soporte.

**Alternativas descartadas:** contar variantes duplicadas para llegar a 24, comparar solo
literales, atribuir reglas sintéticas a EBA o ajustar expectativas a la salida del motor.

## R10. Verificación y límites de esta fase

**Decisión:** registrar por separado sintaxis, oráculo de datos, implementación, pruebas
automatizadas, rendimiento y aceptación humana. El benchmark 500 reglas/100 000 datos
se repite sobre un formato capaz de ese volumen con la nueva interfaz; CA1, con 110
posiciones, tiene medición propia de carga completa y exclusiones. No repetir la aceptación
histórica como si acreditara la nueva experiencia.

**Motivo:** 931 pruebas históricas no demuestran las capacidades nuevas. Durante la
planificación solo se verifican fuentes, compatibilidad, coherencia y cálculos de referencia.
No se instala Material, no se cambia el producto ni se toca el workspace del usuario.

**Alternativas descartadas:** declarar todas las reglas aprobadas porque el Job terminó,
reutilizar mediciones anteriores o interpretar aceptación global como observación detallada.

No quedan decisiones de alcance sin resolver. Los artefactos de fase 1 concretan estos
contratos; tareas e implementación son fases posteriores. Recibos: `disabled/unmanaged`.
