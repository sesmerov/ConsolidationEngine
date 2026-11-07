# Investigación y decisiones — 004

Fecha: 2026-11-07. Base de código: `d6bef6a`. Resultado: incógnitas de planificación resueltas; implementación y validación del comportamiento pendientes. [Especificación](spec.md).

Se revisaron el producto y sus contratos mediante lectura directa: el checkout no tiene índice CodeGraph, el inicializador `gentle-ai` no está disponible y la consulta de la fase anterior confirmó que no podía consultar este proyecto. Las investigaciones se dividieron entre interfaz/conflictos, selección y FINREP. No se han ejecutado revisiones con recibos ni cambiado su estado `disabled/unmanaged`.

## D1. Mantener las dependencias fijadas y el reparto actual

**Decisión**: conservar Angular/Material/CDK 22.2.4, CLI/build 22.2.5, RxJS 7.8.2, Node 24.22.2, npm 11.19.1, TypeScript 6.0.3, Fastify 5.12.7 y ANTLR 4.13.2. Reutilizar stores, API local, workers, snapshots, presupuestos y motor puro.

**Motivo**: los cambios requieren nuevas capacidades de presentación y selección, no una nueva plataforma. Se contrastaron los manifiestos actuales, la constitución y el plan 003. El servidor mantiene autoridad sobre elegibilidad, dependencias y publicación.

**Alternativas consideradas**: nueva librería de estado, nueva base de datos o actualización de dependencias; añaden migración sin resolver el problema solicitado.

Fuentes: [package.json](../../package.json), [web](../../apps/web/package.json), [API](../../apps/api/package.json), [motor](../../packages/engine/package.json), [constitución](../../.specify/memory/constitution.md).

## D2. Jerarquía visual y animación breve

**Decisión**: una acción principal verde por estado, usando un estilo compartido y los overrides públicos del botón Material instalado. Base `#146c43` con texto blanco; interacción `#105835`; realce de navegación `#e9f5ee`, borde/texto `#146c43`, foco `#175caa`. Mantener el tema base. La siguiente etapa recibe tres pulsos suaves de 1,5 s y después realce estático; con movimiento reducido no hay animación. Deduplicar por operación, conjunto y versión mediante el store de navegación existente.

**Motivo**: la acción se reconoce mediante texto, contraste y jerarquía, sin confundirla con el resultado de cumplimiento. El contraste calculado es 6,45:1 para verde/blanco y 5,76:1 para verde/fondo de navegación; se comprobará además la presentación final. La API Sass local usa `mat.button-overrides` y tokens `button-filled-container-color` / `button-filled-label-text-color`.

**Ajuste documentado de especificación**: la duración de seis segundos fue una decisión inicial de diseño, no un requisito temporal del usuario. Se reduce a 4,5 s para mantener la señal breve y por debajo del umbral de cinco segundos descrito por WCAG para ciertos contenidos automáticos en movimiento, evitando añadir un control de pausa. Se actualizan US1, FR-002 y SC-001; se mantienen los tres pulsos y la señal estática.

**Alternativas consideradas**: parpadeo indefinido, etiqueta secundaria y cambio automático de pantalla; generan distracción o repiten el problema señalado. Un tema verde global perdería la distinción entre acción principal y secundaria.

Fuentes primarias consultadas: [Material radio](https://github.com/angular/components/blob/main/src/material/radio/radio.md), [Material button theme](https://github.com/angular/components/blob/main/src/material/button/_button-theme.scss), contrastadas con los archivos instalados 22.2.4; [contraste mínimo WCAG](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html), [animación por interacción](https://www.w3.org/WAI/WCAG22/Understanding/animation-from-interactions.html), [pausar, detener y ocultar](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html).

## D3. Quitar información interna y conservar la explicación de negocio

**Decisión**: retirar los bloques técnicos del inventario de la especificación y las apariciones equivalentes de identificadores en comparación, aplicación y exportación. Mostrar versión legible, reglas, coordenadas, origen, importes exactos y explicación del redondeo/intervalo cuando intervengan. Los diagnósticos tienen mensajes de negocio; la trazabilidad interna y los contratos de exportación no se destruyen.

**Motivo**: sustituir un panel técnico por otro desplegable no atiende la petición de eliminarlo. El usuario necesita saber por qué cambia un importe y qué error puede resolver.

**Alternativas consideradas**: tooltips con todo el contenido o eliminación de toda explicación; el primero conserva la sobrecarga y el segundo impide revisar el cambio.

Fuentes: `import-page.component.html`, `workspace-shell.component.html`, `validation-page.component.html`, `preview-page.component.html`, `calculation-detail.component.html`, `comparison.component.html`, `apply.component.html` y `exports.component.html` bajo `apps/web/src/app/`.

## D4. Conflictos estables y editables

**Decisión**: separar el catálogo estable de candidatos por destino de los productores activos. Exponer por páginas los grupos que tuvieron un conflicto real durante la revisión, incluidos los resueltos u omitidos, y sus candidatos. Las descripciones y expresiones se proyectan bajo demanda; una lectura individual permite ampliar los textos truncados. La elección de radio queda local hasta «Confirmar elección»; después aparece un resumen editable. Guardar configuración requiere que no queden elecciones locales sin confirmar.

**Motivo**: actualmente `resolveGroup` elimina los miembros activos y el grupo desaparece; `readRows(groupId)` solo devuelve miembros activos y resolver de nuevo exige al menos dos. Cambiar únicamente los botones impediría revisar la decisión.

**Regla de integridad**: un candidato activo en otro destino no se mueve implícitamente al resolver este grupo. La API responde con conflicto identificable; el usuario debe cambiar primero su destino en la tabla. Resolver omite únicamente productores activos del destino tratado. Pertenencia y decisión incluyen contexto completo.

**Alternativas consideradas**: mantener una copia de las páginas visitadas en el navegador o elegir el primer código; no cubren candidatos ocultos, recuperación ni decisiones correctas de negocio.

Fuentes: [índice de revisión](../../packages/engine/src/recalculation/direction-review-index.ts), [revisión de destinos](../../packages/engine/src/recalculation/direction-review.ts), [presentación de reglas](../../apps/api/src/presentation/rule-presentation.ts). El contrato de diseño será `contracts/ui.md`.

## D5. Selección compacta en servidor

**Decisión**: crear un registro de selección al publicar una nueva simulación. Usa un índice ordinal estable y máscaras de disponibles, seleccionadas y dependencias faltantes, almacenadas como bloques JSON/base64 acotados. Solo se publican resúmenes y páginas, incluidas las dependencias de una propuesta y las secciones de su explicación; las filas no ocultan arrays globales anidados. Leer o recuperar una simulación no inicializa ni restaura la selección. Las simulaciones antiguas sin registro admiten inicialización explícita vacía.

**Motivo**: la API actual admite conceptualmente un millón de identificadores, pero limita el cuerpo JSON a 1 MiB; el frontend obtiene todos los detalles seleccionados y el cierre actual se calcula síncronamente. Paginar para acabar reuniéndolo todo en el navegador no resuelve estas restricciones.

**Decisiones de edición**: selección individual, selección de todas las coincidencias y limpieza global se procesan como trabajos cancelables con revisión esperada y publicación atómica. Los filtros de estado, código, tabla y contexto usan el mismo criterio en ambas consultas. El cambio de filtro no altera el conjunto elegido. Desmarcar un antecedente no lo recupera automáticamente.

**Alternativas consideradas**: arrays masivos, un conjunto de identificadores solo en el navegador o subir el límite de petición; aumentan el consumo, impiden la recuperación segura y no dan una representación adecuada de las selecciones fuera de pantalla.

Fuentes: [store de selección](../../apps/web/src/app/recalculation/preview.store.ts), [store de aplicación](../../apps/web/src/app/recalculation/apply.store.ts), [API](../../apps/api/src/app.ts), [modelo anterior](../003-simplificar-flujo/data-model.md). El contrato de diseño será `contracts/proposal-selection.md`.

## D6. Aplicación por revisión inmutable y transporte acotado

**Decisión**: ampliar la petición de aplicación mediante una alternativa estricta `selectionRef:{id,revision}` con huella del cierre. Se conserva la petición antigua de identificadores explícitos. El servidor reserva la revisión y comprueba de nuevo base, elegibilidad y dependencias en el worker; los reintentos consultan primero la idempotencia. La UI recibe recibos compactos, páginas de seleccionadas y páginas de dependencias faltantes.

**Motivo**: el recibo actual repite todos los `acceptedIds`, incluso en las comparaciones. El nuevo recorrido no debe reintroducir un array masivo después de aplicar. La selección automática nunca equivale a la aceptación explícita para escribir.

**Recursos**: 60 s por trabajo, worker de 256 MiB, una operación activa, hasta 1.000.000 de posiciones/aristas, 10.000.000 de lecturas y cuotas existentes de 512 MiB/20 snapshots. Contabilizar el pico de estado anterior y candidato antes de publicar; no retener typed arrays ni Maps en registros canónicos JSON. El máximo de destinos disponibles diferentes queda además limitado por las 100.000 coordenadas de entrada. El caso de volumen real será 100.000 seleccionables; un millón de posiciones se usa para comprobar representación y límites, no para prometer un millón de cambios aplicables.

**Alternativas consideradas**: convertir la referencia a un array antes de aceptar la petición HTTP o reemplazar el contrato antiguo; la primera vuelve a bloquear el servidor y la segunda rompe clientes existentes.

## D7. FINREP F 01.01 con identificación de alcance explícita

**Decisión**: añadir `eba-finrep-4.0-f0101-v1`, con framework `FINREP` e identificador local `FINREP_F0101_4.0`. Este identificador nombra el perfil de presentación del proyecto; no afirma ser un módulo XBRL oficial. La interfaz muestra «FINREP · F 01.01 · plantilla 4.0». El catálogo propio usa esa identidad de forma consistente.

**Motivo**: el anexo oficial fijado contiene la cuadrícula de F 01.01. El paquete anotado 4.0 disponible en el proyecto no aporta FINREP. El catálogo oficial de diciembre de 2025 menciona módulos FINREP9/FINREP9DP de otra versión; no acredita un nombre FINREP9_4.0. Se evita fabricar esa equivalencia. La arquitectura EBA identifica FINREP9 como FINancial REPorting (IFRS9), pero no basta para asignar una versión de módulo al anexo local.

**Cuadrícula y precisión**: 38 posiciones F8:F45 de la hoja `1.1`, columna 0010, códigos y etiquetas reales de la fuente. Escala decimal declarada s en 0/3/6; precisión p en −18…18 o INF, con precisión normalizada p−s dentro de los límites del motor. Importes como racionales exactos; los estilos no determinan escala ni precisión. Las fechas, horas, porcentajes y valores inválidos en celdas monetarias se diagnostican.

**Reconocimiento**: perfil seleccionado por archivo únicamente entre candidatos verificados. Un único candidato puede resolverse automáticamente; un libro con COREP y FINREP requiere una elección identificada o contexto válido que la resuelva. Nunca elegir por el orden de los perfiles ni por el código de una regla del catálogo.

**Alternativas consideradas**: declarar soporte FINREP por cuatro celdas en coordenadas, reutilizar COREP_OF_4.0 o incorporar toda una taxonomía; no corresponden al alcance solicitado.

Fuentes: [manifiesto local](../../tests/fixtures/eba/source-manifest.json), [evidencia contrastada](evidencia.md), [arquitectura EBA/EIOPA](https://eba.europa.eu/sites/default/files/2024-12/8fdac0fc-ddf7-4244-831c-20be53b2605a/EBA%20and%20EIOPA%20taxonomy%20architecture%20v2.0-20241218.pdf). La fuente local conserva SHA-256 `f3c4aad1a313e3568ba56d62124c554300c94caee444e837531725b543f4cfa7`. El contrato de diseño será `contracts/finrep-f0101.md`.

## D8. Exportación FINREP conservando el libro inspeccionado

**Decisión**: resolver por el servidor el original retenido, verificar su huella y binding, volver a comprobar su estructura y parchear exclusivamente los importes autorizados en el libro. Conservar las demás partes y hojas seguras; añadir o actualizar la hoja de contexto admitida con divisa, escala y precisión explícitas para reimportar sin la sesión original. Un contexto ajeno o incompatible se rechaza, no se sobrescribe.

**Motivo**: el exportador COREP actual reconstruye su plantilla y descarta hojas excluidas. FR-019 exige conservarlas en FINREP. Copiar ese comportamiento no cumpliría el requisito.

**Límite de seguridad**: el preflight sigue examinando el paquete completo. Una exclusión de cálculo no permite macros, enlaces externos ni contenido que la política actual rechaza. No se ejecutan fórmulas, macros o enlaces. El contrato fija qué partes pueden cambiar y cómo comprobar las demás. La ruta COREP conserva su contrato existente.

**Alternativas consideradas**: reconstruir solo F 01.01 o volver a serializar todas las celdas; la primera pierde hojas y la segunda puede alterar presentación y contenido ajeno al cálculo.

## Cierre de investigación

Las decisiones anteriores resuelven identificación FINREP, alcance de preservación, selección masiva, recuperación, conflictos editables y accesibilidad. No quedan decisiones de producto pendientes para preparar el modelo y los contratos. La capacidad y tiempos reales de las nuevas rutas se medirán durante implementación, con rechazo atómico al superar las cuotas. Las observaciones humanas de SC-010 siguen pendientes hasta disponer de la interfaz.

## Precisión de alcance verificada al desglosar tareas

La lectura de [import-workspace.ts](../../apps/api/src/import/import-workspace.ts) confirmó el rechazo INCOMPATIBLE_ENTITY_OR_DATE dentro de un mismo conjunto y la deduplicación por coordenada de negocio. Se mantiene esta restricción: los contextId por archivo no permiten mezclar entidades/periodos ni duplicar F_01.01. Las pruebas de separación se realizan entre conjuntos o con contextos compatibles en la misma entidad/fecha. Se precisan modelo, contrato y supuestos de la especificación para evitar atribuir a la cota de veinte archivos una capacidad que el producto no ofrece.
