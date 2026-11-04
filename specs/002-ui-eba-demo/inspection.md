# Inspección de interfaz, plantillas y cobertura

Fecha: 2026-11-04. Base inspeccionada: `6488b57`. Este documento recoge observaciones
y decisiones para la especificación 002; no acredita implementación ni pruebas de las
nuevas capacidades. La aceptación de la versión anterior sigue siendo histórica.

## Interfaz observada

Se inspeccionó la aplicación abierta en `http://127.0.0.1:3000/`, con el conjunto
`TEST UAT`, una aplicación completada y la versión 3 vigente. Se navegaron las etapas
de carga, propuestas y exportación y se leyeron los resultados y la comparación.
No se cargaron archivos ni se modificaron los datos, la configuración o las selecciones.
También se contrastaron las dos capturas aportadas por el usuario.

| Observación | Cambio propuesto | Información que debe conservarse |
|---|---|---|
| Todas las etapas se acumulan en una página larga; la franja lateral queda vacía al bajar. | Navegación persistente entre etapas y contenido centrado en la tarea activa. | Entidad, periodo, versión y acceso al histórico. |
| Una propuesta ocupa muchos párrafos para comunicar dos valores. | Tabla con regla, concepto/celda, **anterior → propuesto**, estado, dependencias y acción de detalle. | Valor exacto, unidad y aviso cuando el redondeo tenga efecto. |
| «Procedencia y lecturas» muestra listas de archivos y claves JSON con hashes. | «Ver cálculo y origen», con entradas legibles y sin claves internas en la vista de trabajo. | Fuentes, expresión, lecturas y decisiones completas en detalle/exportación. |
| Se repiten precisión e intervalos puntuales como `[24, 24]`. | Mostrar el cambio principal, y llevar precisión, intervalo y nominal al detalle. | Aviso visible si esos datos explican un bloqueo o una diferencia. |
| «Pasa · Severidad error» parece contradictorio. | Separar estado del resultado de severidad de la regla, con etiquetas explícitas. | No cambiar severidades ni estados para mejorar la apariencia. |
| Cobertura, filas, variantes e instancias compiten con los resultados. | Resumen principal de reglas evaluadas, fallos y problemas; desglose de cobertura secundario. | No confundir sintaxis admitida con cumplimiento. |
| Antes y después repiten expresión y todos los datos leídos. | Tabla de cambios y transición de estado, mostrando inicialmente lo que cambió. | Acceso a datos sin cambio y a las dos versiones completas. |
| Tras aplicar siguen visibles selección y confirmación deshabilitadas. | Estado de consulta con comparación y descarga de la versión resultante. | Recibo y detalles de lo aplicado. |
| La descarga conserva «Versión 1 · histórica» aunque la vigente es la 3. | Acción inequívoca «Descargar esta versión» tras aplicar; histórico como elección explícita. | No cambiar a escondidas una selección histórica del usuario. |
| Instrucciones principales exponen `presence=null`, XML, JSON y `ce-report-1`. | Lenguaje de negocio y ayuda contextual; límites técnicos en información ampliada. | Errores accionables y alcance real del producto. |

Ejemplo de presentación propuesto, basado en la demo anterior y no en una regla EBA:

| Regla | Celda | Cambio | Dependencia | Estado |
|---|---|---|---|---|
| SYNTHETIC_A | C 01.00 · fila 0230 · columna 0010 | 11,00 → **12,00 EUR** | — | Aplicada |
| SYNTHETIC_D | C 01.00 · fila 0270 · columna 0010 | 22,00 → **24,00 EUR** | SYNTHETIC_A | Aplicada |

La flecha debe acompañarse de etiquetas accesibles «anterior» y «propuesto/después».
Las dependencias no se pueden seleccionar automáticamente ni ocultar al filtrar.
El orden de presentación no debe confundirse con el orden de ejecución.

## Angular Material

El usuario solicita Angular Material y sustituir el CSS actual. La aplicación tiene
Angular 22.2.4 y no declara todavía Material. Los estilos globales actuales de botones,
campos y tablas requieren revisión durante la migración; no bastará con instalar una
biblioteca. El plan fijará versiones compatibles y un tema común de color, tipografía,
espaciado, foco y densidad.

La documentación oficial de [tablas](https://github.com/angular/components/blob/main/src/material/table/table.md)
y [temas](https://github.com/angular/components/blob/main/guides/theming.md) respalda
usar las APIs de componentes y temas. La ordenación, selección, paginación y accesibilidad
necesitan integración y verificación propias; no quedan resueltas por cambiar el aspecto.
En particular, una página recibida del servidor no debe presentarse como si fuese el
conjunto completo al ordenar o filtrar.

## Fuentes oficiales EBA localizadas

Base reproducible: [Reporting framework 4.0](https://www.eba.europa.eu/risk-and-data-analysis/reporting/reporting-frameworks/reporting-framework-40).
Se usa por su relación con el catálogo local; no se afirma que sea la última versión vigente.

1. [Paquete ITS de plantillas oficiales](https://www.eba.europa.eu/sites/default/files/2025-02/1b4c4008-4224-450f-aa7b-c6fe5284872a/ITS%20on%20supervisory%20reporting.zip).
   Contiene `C_2024_8389_1_ANNEX_EN_V3_P1_3682615.XLSX`.
2. [DPM Annotated Templates 4.0](https://www.eba.europa.eu/sites/default/files/2024-12/7ae0363a-ad3d-42d9-a192-34711416c039/annotated_templates.zip).
   Incluye `20241217 Annotated Table Layout  COREP_OFCOREP 4.0.xlsx`.

Copias públicas intactas, manifiesto y análisis de hojas disponibles en
`.cache/eba-template-research/`. El XLSX ITS se guardó como `official-annexes-4.0.xlsx`.
Los archivos de caché no son una dependencia permanente de compilación: el plan deberá
definir fuentes reproducibles y fixtures con procedencia para implementar el adaptador.

| Archivo | SHA-256 |
|---|---|
| ITS ZIP | `d9c3c7d80785c162d79e55629e567546dc01b3f8b96245614d9aa1eaefd60a3c` |
| ITS XLSX | `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7` |
| Annotated ZIP | `3b973e7e9dd06f9d855b9afe77a930b3881a3a84e64292c90f0ef8d397a5e57d` |
| Annotated COREP_OF XLSX | `610d72d283dd74a6d572c49e1959fba43a662548df4e5399dca2f4b3523c7e5f` |

Inspección directa de los paquetes XLSX:

| Tabla | Hoja de presentación | Códigos de fila | Importes | Alcance propuesto |
|---|---|---|---|---|
| COREP C_01.00 | CA1 | B5:B114 | E5:E114 | Primera entrega: 110 posiciones de fila; etiquetas en D. |
| FINREP F_01.01 | 1.1 | B8:B45 | F8:F45 | Localizada para ampliación posterior. |
| FINREP F_01.02 | 1.2 | B8:B37 | F8:F37 | Localizada para ampliación posterior. |
| FINREP F_01.03 | 1.3 | B7:B47 | F7:F47 | Localizada para ampliación posterior. |

Las cuatro hojas inspeccionadas carecen de fórmulas y protección de hoja. CA1 tiene
el título fusionado B2:E2. La columna regulatoria 0010 no está escrita como cabecera
en CA1; su correspondencia debe comprobarse con el material anotado y el perfil.

El libro ITS completo tiene **191 hojas, 72 fórmulas fuera de estas cuatro hojas y
22 partes externalLinks**. El libro anotado COREP_OF tiene 132 hojas; sus celdas de
datos contienen identificadores DPM y tipos, no importes. Ninguno puede tratarse
como el actual `ce-report-1`, y el libro anotado no es la demo cumplimentada.

La primera cobertura se acota a **COREP C_01.00, framework 4.0, hoja CA1**. La selección
de hojas admitidas, el contenido ajeno, las fórmulas y los vínculos necesitan un contrato
explícito de importación: nunca ejecutarlos, seguirlos ni usar una caché de fórmula
como un importe declarado. El límite actual de 64 hojas no permite admitir el libro
completo sin cambios. No se puede relajar globalmente la seguridad para resolverlo.

Entidad, periodo, divisa, escala, precisión y declaración de tablas se recogerán una
vez en la interfaz cuando el libro no los aporte de forma inequívoca. El formato de
visualización de Excel no demuestra la precisión regulatoria. Una exportación en
este diseño tampoco equivale a un fichero oficial de remisión.

## Motor y demostraciones

La gramática original reconoce `if … then … else … endif`, texto y fechas. El AST,
visitor y evaluador actuales no los implementan; las pruebas del parser comprueban
que se diagnostiquen como no soportados. Los contratos y la importación de hechos
solo admiten números y booleanos. Las fechas de contexto y vigencia no son hechos
fecha. Las desigualdades sí se evalúan, pero no determinan un recálculo único.

La ampliación debe cubrir todas las capas afectadas y probar valores importados,
ambas ramas, nulos, tipos incompatibles, fechas civiles y comparación textual.
No se ha identificado una variable de contexto estándar enlazada por este motor a
la entidad o fecha del informe; no se inventará una atribuyéndola a EBA.

Propuesta de demo: al menos **24 reglas distintas**, repartidas entre un ejemplo COREP
con al menos 16 y un complemento didáctico tipado con al menos 8. El complemento
usará campos legibles, se identificará como propio y no alterará el significado de
celdas monetarias oficiales. Los archivos se entregarán preparados, sin requerir
al usuario definir coordenadas técnicas.

El catálogo original contiene relaciones reales compatibles con C_01.00, por ejemplo:

- `v0174_m`: r0070 = r0080 + r0090 + r0091.
- `v0173_m`: r0030 = r0040 + r0060 + r0070 + r0092.
- `v0176_m`: r0150 = r0160 + r0170.
- `v0175_m`: r0130 = r0140 + r0150.

Estas son descripciones de relaciones, no expresiones completas copiables. Las variantes
COREP_OF_4.0 inspeccionadas incluyen `default:0`, `interval:true`, precondición
`{v_C_01.00}` y estado Active. Se conservarán expresión, módulo, fechas y procedencia;
el plan fijará un periodo compatible antes de elegirlas. Los datos serán sintéticos y
las reglas adicionales inventadas se distinguirán de las reglas oficiales.

La demo anterior solo tiene dos reglas y cuatro datos numéricos. Sus posiciones
r0230/r0250/r0260/r0270 son conceptos oficiales distintos, por lo que **no basta con
trasladar A, B, C y D a CA1 y presentar esas relaciones como regulatorias**.

## Evidencia y siguiente fase

Comprobado en esta fase: interfaz existente, código y pruebas declaradas, fuentes
públicas descargadas, estructura de libros y huellas de los originales. No se han
instalado dependencias, ejecutado suites ni implementado Material, nuevos formatos o
nuevas reglas. Las pruebas anteriores no acreditan las capacidades solicitadas ahora.

El plan debe concretar mapping de las 110 posiciones, política de hojas excluidas,
tipos/escala/precisión, contrato del ejemplo tipado y semántica de condicionales,
matriz de resultados esperados y recorrido visual. Después se generarán tareas y se
implementarán incrementos con pruebas y commits. Recibos: `disabled/unmanaged`.
